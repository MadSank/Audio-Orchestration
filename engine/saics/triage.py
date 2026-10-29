"""`saics triage`: separate sound effects, speech, junk and duplicates from songs.

REPORT-ONLY. This module reads audio files and writes a CSV report; it never moves,
renames, deletes or modifies anything in the music folder, and refuses to write the
report inside it. `--apply` / `--undo` are not implemented yet (hard rule 3: the owner
reviews the report first).

Classes: not_audio, unreadable, short, duplicate, variant, speech, sfx, music.
The sfx/speech rules are heuristics on cheap features and are tuned to be conservative:
a real song must never be flagged (P1 acceptance). Borderline files get `review` notes.
"""

import csv
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from saics.io import AUDIO_EXTS, chromaprint, decode, probe

SR = 22050
MIN_SONG_S = 45.0
LONG_S = 600.0
DUP_MIN_DURATION_RATIO = 0.75  # below this, a fingerprint match is an excerpt/compilation
MAX_DECODE_S = 600.0
FP_SECONDS = 120.0
DUP_BER = 0.20  # Chromaprint bit-error rate at or below this = same recording
SIMILAR_BER = 0.30  # reported as a note, not a duplicate
MIN_FP_OVERLAP = 100  # fingerprint items (~12 s)

SKIP_DIRS = {"_set_aside", ".saics"}
SKIP_FILES = {"desktop.ini", "thumbs.db", ".ds_store"}
VARIANT_RE = re.compile(
    r"\b(8d|bass\s*boost(?:ed)?|sped\s*up|speed\s*up|slowed|nightcore|reverb|lo-?fi)\b", re.I
)
JUNK_NAME_RE = re.compile(r"lyric|official|video|y2meta|getmp3|mp3cut|\(\d+ ?kbps\)|audio", re.I)
CODEC_EFFICIENCY = {"aac": 1.4, "opus": 2.0, "vorbis": 1.3, "mp3": 1.0}
LOSSLESS = {"flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_f32le"}


@dataclass
class Row:
    file: str
    cls: str = "music"
    keep: str = "yes"
    duplicate_of: str = ""
    reasons: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    variant_hint: str = ""
    codec: str = ""
    container: str = ""
    ext_mismatch: bool = False
    sample_rate: int = 0
    channels: int = 0
    bitrate_kbps: float = 0.0
    duration_s: float = 0.0
    bpm: float = 0.0
    beats: int = 0
    beat_cv: float = 0.0
    pulse_clarity: float = 0.0
    chroma_clarity: float = 0.0
    flatness: float = 0.0
    low_energy_ratio: float = 0.0


def iter_files(folder: Path):
    for p in sorted(folder.rglob("*")):
        if not p.is_file() or p.name.lower() in SKIP_FILES:
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(folder).parts):
            continue
        yield p


# ── per-file features ────────────────────────────────────────────────────────


def audio_features(y: np.ndarray, sr: int = SR) -> dict:
    """Cheap descriptors that separate songs from sfx/speech. y: mono float32."""
    import librosa

    hop = 512
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop)
    bt = librosa.frames_to_time(beats, sr=sr, hop_length=hop)
    ibi = np.diff(bt)
    beat_cv = float(ibi.std() / ibi.mean()) if len(ibi) >= 8 else 1.0

    # Pulse clarity: strongest onset-autocorrelation peak at a beat-like lag (0.25-2 s).
    o = onset - onset.mean()
    ac = np.correlate(o, o, mode="full")[len(o) - 1 :] if len(o) < 20000 else _fft_ac(o)
    lo, hi = int(0.25 * sr / hop), min(len(ac) - 1, int(2.0 * sr / hop))
    pulse = float(ac[lo:hi].max() / ac[0]) if ac[0] > 0 and hi > lo else 0.0

    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    rms = librosa.feature.rms(S=S)[0]
    active = rms > max(1e-4, 0.05 * rms.max())  # ignore digital silence / fades
    chroma = librosa.feature.chroma_stft(S=S**2, sr=sr)[:, active]
    clarity = (
        float(np.mean(chroma.max(axis=0) / (chroma.sum(axis=0) + 1e-9))) if chroma.size else 0.0
    )
    flat = librosa.feature.spectral_flatness(S=S)[0][active]
    r = rms[active]
    low_energy = float(np.mean(r < 0.5 * r.mean())) if r.size else 1.0
    return {
        "bpm": round(float(np.atleast_1d(tempo)[0]), 1),
        "beats": int(len(beats)),
        "beat_cv": round(beat_cv, 3),
        "pulse_clarity": round(pulse, 3),
        "chroma_clarity": round(clarity, 3),
        "flatness": round(float(np.median(flat)) if flat.size else 1.0, 4),
        "low_energy_ratio": round(low_energy, 3),
    }


def _fft_ac(x: np.ndarray) -> np.ndarray:
    n = 1 << (2 * len(x) - 1).bit_length()
    f = np.fft.rfft(x, n)
    return np.fft.irfft(f * np.conj(f), n)[: len(x)]


def classify_features(row: Row) -> None:
    """Heuristic sfx/speech rules on a readable, long-enough file (mutates row)."""
    weak_grid = row.beats < 16 or row.beat_cv > 0.20 or row.pulse_clarity < 0.10
    noisy = row.flatness > 0.30 or row.chroma_clarity < 0.12
    speechy = row.low_energy_ratio > 0.45 and row.pulse_clarity < 0.15
    # Coloured (pink/brown) noise beds are not spectrally flat, but they have no pulse and
    # almost no pitch class. On the real library, songs had pulse >= 0.079, chroma >= 0.166.
    noise_bed = row.pulse_clarity < 0.04 and row.chroma_clarity < 0.15

    if row.duration_s > LONG_S:
        row.notes.append(
            f"review: long file ({row.duration_s / 60:.0f} min): compilation, extended loop or mix?"
        )
    if noise_bed:
        row.cls = "sfx"
        row.reasons.append(
            f"noise bed: no pulse ({row.pulse_clarity:.3f}) and no pitch content "
            f"(chroma {row.chroma_clarity:.3f})"
        )
    elif speechy and weak_grid:
        row.cls = "speech"
        row.reasons.append(
            f"speech-like: many pauses (low-energy {row.low_energy_ratio:.2f}) and no steady pulse"
        )
    elif weak_grid and noisy:
        row.cls = "sfx"
        row.reasons.append(
            f"no steady beat (cv {row.beat_cv:.2f}, pulse {row.pulse_clarity:.2f}) and "
            f"noise-like/atonal (flatness {row.flatness:.2f}, chroma {row.chroma_clarity:.2f})"
        )
    elif weak_grid:
        row.notes.append("review: weak beat grid (ambient/rubato/spoken intro?)")
    elif noisy:
        row.notes.append("review: noise-like spectrum")


def analyse_file(path_str: str, rel: str) -> tuple:
    """Worker: probe + features + fingerprint. Returns (Row as dict, fingerprint)."""
    path = Path(path_str)
    row = Row(file=rel)
    if path.suffix.lower() not in AUDIO_EXTS:
        row.cls, row.keep = "not_audio", "n/a"
        row.reasons.append(f"extension {path.suffix or '(none)'} is not an audio type")
        return asdict(row), np.zeros(0, np.uint32)

    m = VARIANT_RE.search(path.stem)
    row.variant_hint = m.group(0).lower() if m else ""

    p = probe(path)
    size = path.stat().st_size
    if not p.ok:
        row.cls, row.keep = "unreadable", "no"
        row.reasons.append(f"ffprobe: {p.error} (file is {size} bytes)")
        return asdict(row), np.zeros(0, np.uint32)
    row.codec, row.container = p.codec, p.container
    row.sample_rate, row.channels, row.bitrate_kbps = p.sample_rate, p.channels, p.bitrate_kbps
    row.ext_mismatch = p.ext_mismatch(path)
    if row.ext_mismatch:
        row.notes.append(f"extension {path.suffix} but codec {p.codec} in {p.container}")

    try:
        y = decode(path, sr=SR, max_seconds=MAX_DECODE_S)
    except (RuntimeError, OSError) as exc:
        row.cls, row.keep = "unreadable", "no"
        row.reasons.append(f"decode failed: {exc}")
        return asdict(row), np.zeros(0, np.uint32)
    row.duration_s = round(max(p.duration_s, len(y) / SR), 2)
    if len(y) < SR or float(np.max(np.abs(y))) < 1e-4:
        row.cls, row.keep = "unreadable", "no"
        row.reasons.append("decodes to <1 s of audio" if len(y) < SR else "digital silence")
        return asdict(row), np.zeros(0, np.uint32)

    try:
        for k, v in audio_features(y).items():
            setattr(row, k, v)
    except Exception as exc:  # features are advisory; never lose the row
        row.notes.append(f"feature extraction failed: {exc}")

    if row.duration_s < MIN_SONG_S:
        row.cls = "short"
        row.reasons.append(f"duration {row.duration_s:.1f} s < {MIN_SONG_S:.0f} s")
    else:
        classify_features(row)
    return asdict(row), chromaprint(path, FP_SECONDS)


# ── duplicates ───────────────────────────────────────────────────────────────


def _planes(fp: np.ndarray) -> np.ndarray:
    bits = (fp[None, :] >> np.arange(32, dtype=np.uint32)[:, None]) & 1
    return bits.astype(np.float32) * 2.0 - 1.0  # (32, n) of +-1


def min_ber(a: np.ndarray, b: np.ndarray, min_overlap: int = MIN_FP_OVERLAP) -> float:
    """Lowest Chromaprint bit-error rate over all alignments with enough overlap."""
    from scipy.signal import fftconvolve

    if len(a) < min_overlap or len(b) < min_overlap:
        return 1.0
    agree = fftconvolve(_planes(a), _planes(b)[:, ::-1], axes=1).sum(axis=0)
    overlap = np.convolve(np.ones(len(a)), np.ones(len(b)))
    ok = overlap >= min_overlap
    ber = (1.0 - agree[ok] / (32.0 * overlap[ok])) / 2.0
    return float(ber.min())


def _quality(r: dict) -> tuple:
    """Higher is better: effective bitrate, cleaner filename, completeness, rate."""
    if r["codec"] in LOSSLESS:
        eff = 10_000.0
    else:
        eff = r["bitrate_kbps"] * CODEC_EFFICIENCY.get(r["codec"], 1.0)
    return (round(eff, -1), -len(JUNK_NAME_RE.findall(r["file"])), round(r["duration_s"]),
            r["sample_rate"], -len(r["file"]))  # fmt: skip


def _duration_ratio(a: dict, b: dict) -> float:
    lo, hi = sorted((a["duration_s"], b["duration_s"]))
    return lo / hi if hi > 0 else 0.0


def mark_duplicates(rows: list, fps: list, progress=None) -> None:
    """Group same-recording copies (Chromaprint match + similar length).

    In each group the best copy is kept. Members whose filename marks an effect version
    (8D, slowed, nightcore…) become `variant` (for review) rather than `duplicate`.
    Matches with very different lengths are excerpts, compilations or long loops: they
    only get a note.
    """
    idx = [i for i, fp in enumerate(fps) if len(fp) >= MIN_FP_OVERLAP]
    parent = {i: i for i in idx}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    best_match: dict = {}
    ber_of: dict = {}
    for pos, i in enumerate(idx):
        for j in idx[pos + 1 :]:
            ber = min_ber(fps[i], fps[j])
            if ber > SIMILAR_BER:
                continue
            ratio = _duration_ratio(rows[i], rows[j])
            if ber <= DUP_BER and ratio >= DUP_MIN_DURATION_RATIO:
                parent[find(j)] = find(i)
                ber_of[(i, j)] = ber_of[(j, i)] = ber
            elif ber <= DUP_BER:
                for a, b in ((i, j), (j, i)):
                    rows[a]["notes"].append(
                        f"review: contains/overlaps {rows[b]['file']} (BER {ber:.2f}, "
                        f"{rows[a]['duration_s']:.0f} s vs {rows[b]['duration_s']:.0f} s): "
                        "excerpt, compilation or loop?"
                    )
            else:
                for a, b in ((i, j), (j, i)):
                    if ber < best_match.get(a, (1.0, None))[0]:
                        best_match[a] = (ber, b)
        if progress:
            progress(pos + 1, len(idx))

    groups: dict = {}
    for i in idx:
        groups.setdefault(find(i), []).append(i)
    for members in groups.values():
        if len(members) < 2:
            continue
        plain = [m for m in members if not rows[m]["variant_hint"]] or members
        keep = max(plain, key=lambda k: _quality(rows[k]))
        others = ", ".join(rows[m]["file"] for m in members if m != keep)
        rows[keep]["notes"].append(f"best copy among same-recording files (also: {others})")
        kept = rows[keep]
        for m in members:
            if m == keep:
                continue
            r = rows[m]
            ber = ber_of.get((m, keep)) or min_ber(fps[m], fps[keep])
            r["duplicate_of"] = kept["file"]
            if r["variant_hint"] and not kept["variant_hint"]:
                if r["cls"] == "music":
                    r["cls"] = "variant"
                r["keep"] = "review"
                r["reasons"].append(
                    f"'{r['variant_hint']}' version of {kept['file']} (Chromaprint BER "
                    f"{ber:.2f}); the app can render this version itself"
                )
                continue
            if r["cls"] in ("music", "speech", "sfx"):
                r["cls"] = "duplicate"
            r["keep"] = "no"
            r["reasons"].append(
                f"same recording as {kept['file']} (Chromaprint BER {ber:.2f}); keep that "
                f"copy: {kept['codec']} {kept['bitrate_kbps']:.0f} kbps, "
                f"{kept['duration_s']:.0f} s vs {r['codec']} {r['bitrate_kbps']:.0f} kbps, "
                f"{r['duration_s']:.0f} s"
            )
    for i, (ber, j) in best_match.items():
        if rows[i]["cls"] not in ("duplicate", "variant") and find(i) != find(j):
            rows[i]["notes"].append(f"similar to {rows[j]['file']} (BER {ber:.2f}; variant?)")


# ── report ───────────────────────────────────────────────────────────────────

COLUMNS = ["file", "class", "keep", "duplicate_of", "reasons", "notes", "variant_hint", "codec",
           "container", "ext_mismatch", "sample_rate", "channels", "bitrate_kbps", "duration_s",
           "bpm", "beats", "beat_cv", "pulse_clarity", "chroma_clarity", "flatness",
           "low_energy_ratio"]  # fmt: skip


def write_report(rows: list, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8-sig") as f:  # BOM: opens cleanly in Excel
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for r in rows:
            r = dict(r, **{"class": r["cls"]})
            r["reasons"], r["notes"] = "; ".join(r["reasons"]), "; ".join(r["notes"])
            w.writerow([r[c] for c in COLUMNS])


def triage(folder: Path, out: Path, workers: int = 4, limit: int = 0, log=print) -> list:
    folder, out = folder.resolve(), out.resolve()
    if out == folder or folder in out.parents:
        raise ValueError(f"refusing to write the report inside the music folder: {out}")
    files = list(iter_files(folder))[: limit or None]
    log(f"triage (report-only): {len(files)} files in {folder}")
    t0 = time.time()
    results: dict = {}
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {
            ex.submit(analyse_file, str(p), str(p.relative_to(folder))): k
            for k, p in enumerate(files)
        }
        for n, fut in enumerate(as_completed(futs), 1):
            k = futs[fut]
            try:
                results[k] = fut.result()
            except Exception as exc:
                row = Row(file=str(files[k].relative_to(folder)), cls="unreadable", keep="no")
                row.reasons.append(f"analysis crashed: {exc}")
                results[k] = (asdict(row), np.zeros(0, np.uint32))
            if n % 10 == 0 or n == len(files):
                log(f"  features {n}/{len(files)}  ({time.time() - t0:.0f} s)")
    rows = [results[k][0] for k in range(len(files))]
    fps = [results[k][1] for k in range(len(files))]
    log("  comparing Chromaprint fingerprints for duplicates…")
    mark_duplicates(rows, fps)
    write_report(rows, out)
    counts: dict = {}
    for r in rows:
        counts[r["cls"]] = counts.get(r["cls"], 0) + 1
    log(f"done in {time.time() - t0:.0f} s -> {out}")
    log("  " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    return rows


def run_triage(args) -> int:
    if args.apply or args.undo:
        print("--apply/--undo are not implemented yet: triage is report-only.", file=sys.stderr)
        return 2
    try:
        triage(Path(args.folder), Path(args.out), workers=args.workers, limit=args.limit)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    return 0
