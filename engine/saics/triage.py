"""`saics triage`: separate sound effects, speech, junk and duplicates from songs, and
group every version of the same song (see `saics.groups`).

REPORT-ONLY. This module reads audio files and writes a CSV report; it never moves,
renames, deletes or modifies anything in the music folder, and refuses to write the
report inside it. `--apply` / `--undo` are not implemented yet (hard rule 3: the owner
reviews the report first).

Classes: not_audio, unreadable, long (> 15 min), short, duplicate, speech, sfx, music.
Versions (slowed, nightcore, 8D, lyric video, covers, language versions …) are NEVER
duplicates: they get a `group` and a `version` label. A duplicate is a byte-identical
file, or the same version of the same song in another encoding (same group + same
version label + Chromaprint match + same length); the best copy is recommended.
The sfx/speech rules are heuristics on cheap features and are tuned to be conservative:
a real song must never be flagged (P1 acceptance). Borderline files get `review` notes.
"""

import csv
import hashlib
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from saics.groups import audio_signature, build_groups, parse_name, read_overrides
from saics.groups import similarity_matrix as audio_matrix
from saics.io import AUDIO_EXTS, chromaprint, decode, probe

SR = 22050
MIN_SONG_S = 45.0
LONG_CLASS_S = 900.0  # over 15 min: compilation / playlist / loop -> class "long"
LONG_S = 600.0
DUP_MAX_LENGTH_DIFF_S = 2.0  # same version in another encoding: lengths within 2 s / 1 %
MAX_DECODE_S = 600.0
FP_SECONDS = 120.0
DUP_BER = 0.20  # Chromaprint bit-error rate at or below this = same recording
MIN_FP_OVERLAP = 100  # fingerprint items (~12 s)

SKIP_DIRS = {"_set_aside", ".saics"}
SKIP_FILES = {"desktop.ini", "thumbs.db", ".ds_store"}
JUNK_NAME_RE = re.compile(r"lyric|official|video|y2meta|getmp3|mp3cut|\(\d+ ?kbps\)|audio", re.I)
CODEC_EFFICIENCY = {"aac": 1.4, "opus": 2.0, "vorbis": 1.3, "mp3": 1.0}
LOSSLESS = {"flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_f32le"}


@dataclass
class Row:
    file: str
    cls: str = "music"
    keep: str = "yes"
    duplicate_of: str = ""
    group: str = ""
    version: str = ""
    group_evidence: str = ""
    reasons: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    tag_title: str = ""
    sha256: str = ""
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


NO_FP = np.zeros(0, np.uint32)
NO_SIG = np.zeros((36, 0), np.float16)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def analyse_file(path_str: str, rel: str, long_s: float = LONG_CLASS_S) -> tuple:
    """Worker: probe + features + fingerprint + group signature.

    Returns (Row as dict, Chromaprint fingerprint, beat-chroma signature)."""
    path = Path(path_str)
    row = Row(file=rel)
    if path.suffix.lower() not in AUDIO_EXTS:
        row.cls, row.keep = "not_audio", "n/a"
        row.reasons.append(f"extension {path.suffix or '(none)'} is not an audio type")
        return asdict(row), NO_FP, NO_SIG

    row.sha256 = _sha256(path)
    p = probe(path)
    size = path.stat().st_size
    if not p.ok:
        row.cls, row.keep = "unreadable", "no"
        row.reasons.append(f"ffprobe: {p.error} (file is {size} bytes)")
        return asdict(row), NO_FP, NO_SIG
    row.codec, row.container = p.codec, p.container
    row.tag_title = p.tags.get("title", "")
    row.sample_rate, row.channels, row.bitrate_kbps = p.sample_rate, p.channels, p.bitrate_kbps
    row.ext_mismatch = p.ext_mismatch(path)
    if row.ext_mismatch:
        row.notes.append(f"extension {path.suffix} but codec {p.codec} in {p.container}")

    try:
        y = decode(path, sr=SR, max_seconds=MAX_DECODE_S)
    except (RuntimeError, OSError) as exc:
        row.cls, row.keep = "unreadable", "no"
        row.reasons.append(f"decode failed: {exc}")
        return asdict(row), NO_FP, NO_SIG
    row.duration_s = round(max(p.duration_s, len(y) / SR), 2)
    if len(y) < SR or float(np.max(np.abs(y))) < 1e-4:
        row.cls, row.keep = "unreadable", "no"
        row.reasons.append("decodes to <1 s of audio" if len(y) < SR else "digital silence")
        return asdict(row), NO_FP, NO_SIG
    if row.duration_s > long_s:
        # Compilations, playlists, hour-long loops: not analysed, grouped, or used by stations.
        row.cls, row.keep = "long", "no"
        row.reasons.append(f"duration {row.duration_s / 60:.1f} min > {long_s / 60:.0f} min")
        return asdict(row), NO_FP, NO_SIG

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
    try:
        sig = audio_signature(y, SR)
    except Exception as exc:
        row.notes.append(f"group signature failed: {exc}")
        sig = NO_SIG
    return asdict(row), chromaprint(path, FP_SECONDS), sig


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


def _same_length(a: dict, b: dict) -> bool:
    diff = abs(a["duration_s"] - b["duration_s"])
    return diff <= max(DUP_MAX_LENGTH_DIFF_S, 0.01 * max(a["duration_s"], b["duration_s"]))


def mark_duplicates(rows: list, fps: list) -> None:
    """Duplicates = byte-identical files, or the same version of the same song in another
    encoding (same group + version, Chromaprint BER <= DUP_BER, same length).
    Different versions of a song are never duplicates."""
    parent = list(range(len(rows)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    why: dict = {}
    by_sha: dict = {}
    for i, r in enumerate(rows):
        if r["sha256"]:
            by_sha.setdefault(r["sha256"], []).append(i)
    for members in by_sha.values():
        for m in members[1:]:
            parent[find(m)] = find(members[0])
            why[(m, members[0])] = why[(members[0], m)] = "byte-identical"
    buckets: dict = {}
    for i, r in enumerate(rows):
        if r["group"] and len(fps[i]) >= MIN_FP_OVERLAP:
            buckets.setdefault((r["group"], r["version"]), []).append(i)
    for members in buckets.values():
        for pos, i in enumerate(members):
            for j in members[pos + 1 :]:
                if not _same_length(rows[i], rows[j]):
                    continue
                ber = min_ber(fps[i], fps[j])
                if ber <= DUP_BER:
                    parent[find(j)] = find(i)
                    why.setdefault((i, j), f"same version, Chromaprint BER {ber:.2f}")
                    why.setdefault((j, i), why[(i, j)])

    clusters: dict = {}
    for i in range(len(rows)):
        clusters.setdefault(find(i), []).append(i)
    for members in clusters.values():
        if len(members) < 2:
            continue
        keep = max(members, key=lambda k: _quality(rows[k]))
        kept = rows[keep]
        others = ", ".join(rows[m]["file"] for m in members if m != keep)
        kept["notes"].append(f"best copy among duplicates (also: {others})")
        for m in members:
            if m == keep:
                continue
            r = rows[m]
            if r["cls"] in ("music", "speech", "sfx", "short"):
                r["cls"] = "duplicate"
            r["keep"], r["duplicate_of"] = "no", kept["file"]
            reason = why.get((m, keep)) or "same recording (via another copy)"
            r["reasons"].append(
                f"{reason}; keep {kept['file']}: {kept['codec']} {kept['bitrate_kbps']:.0f} kbps, "
                f"{kept['duration_s']:.0f} s vs {r['codec']} {r['bitrate_kbps']:.0f} kbps, "
                f"{r['duration_s']:.0f} s"
            )


def assign_groups(rows: list, sigs: list, overrides: list, workers: int, log=print):
    """Fill group / version / group_evidence on every decodable row."""
    idx = [i for i, r in enumerate(rows) if r["cls"] not in ("not_audio", "unreadable", "long")]
    names = [parse_name(Path(rows[i]["file"]).stem, rows[i]["tag_title"]) for i in idx]
    sub = [sigs[i] for i in idx]
    log(f"  grouping {len(idx)} files (audio similarity on {workers} processes)…")
    matrix = audio_matrix(sub, workers=workers, log=log)
    g = build_groups([rows[i]["file"] for i in idx], names, sub,
                     [rows[i]["duration_s"] for i in idx],
                     audio_fn=lambda a, b: float(matrix[a, b]), overrides=overrides)  # fmt: skip
    for k, i in enumerate(idx):
        rows[i]["group"], rows[i]["version"] = g.group[k], g.version[k]
        rows[i]["group_evidence"] = g.evidence[k]
        rows[i]["notes"].extend(g.notes[k])
    return g, idx, matrix


# ── report ───────────────────────────────────────────────────────────────────

COLUMNS = ["file", "class", "keep", "duplicate_of", "group", "version", "reasons", "notes",
           "group_evidence", "codec", "container", "ext_mismatch", "sample_rate", "channels",
           "bitrate_kbps", "duration_s", "bpm", "beats", "beat_cv", "pulse_clarity",
           "chroma_clarity", "flatness", "low_energy_ratio"]  # fmt: skip
REVIEW_COLUMNS = ["group", "group_name", "group_size", "check", "version", "file", "class",
                  "duration_s", "evidence", "notes"]  # fmt: skip


def write_report(rows: list, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8-sig") as f:  # BOM: opens cleanly in Excel
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for r in rows:
            r = dict(r, **{"class": r["cls"]})
            r["reasons"], r["notes"] = "; ".join(r["reasons"]), "; ".join(r["notes"])
            w.writerow([r[c] for c in COLUMNS])


def write_groups_review(rows: list, g, idx: list, matrix: np.ndarray, out: Path) -> None:
    """One row per file, sorted by group, with a `check` flag on groups worth a look."""
    members: dict = {}
    for k, i in enumerate(idx):
        members.setdefault(rows[i]["group"], []).append((k, i))
    flagged: dict = {}
    for gid, ms in members.items():
        flags = []
        if len(ms) > 1:
            ks = [k for k, _ in ms]
            for k, i in ms:
                if max(float(matrix[k, k2]) for k2 in ks if k2 != k) < 0.12:
                    flags.append(f"no audio match: {rows[i]['file'][:50]}")
            sub = matrix[np.ix_(ks, ks)]
            if len(ks) > 2 and sub[np.triu_indices(len(ks), 1)].min() < 0.05:
                flags.append("chained: some members don't match each other")
            if len(ms) > 20:
                flags.append(f"large group ({len(ms)})")
        flagged[gid] = "; ".join(flags)
    order = sorted(members, key=lambda gid: (-len(members[gid]), gid))
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(REVIEW_COLUMNS)
        for gid in order:
            ms = sorted(members[gid], key=lambda x: (rows[x[1]]["version"], rows[x[1]]["file"]))
            for _, i in ms:
                r = rows[i]
                w.writerow([gid, g.names.get(gid, ""), len(ms), flagged[gid], r["version"],
                            r["file"], r["cls"], r["duration_s"], r["group_evidence"],
                            "; ".join(r["notes"])])  # fmt: skip


OVERRIDES_TEMPLATE = """# Song-group overrides for `saics triage` / `saics analyze`.
# Save as <MusicFolder>/.saics/groups_overrides.csv (or pass --groups-file).
# One action per line: action,file (relative to the music folder),value
#   merge,<file>,<other file>   put <file> in the same group as <other file>
#   split,<file>,               give <file> its own group
#   name,<group id>,<name>      display name for a group (group id from the review CSV)
#   version,<file>,<label>      fix a version label (original, slowed+reverb, english …)
# Examples:
# merge,Nightcore - Dancin.mp3,Aaron Smith - Dancin (KRONO Remix).mp3
# split,yt1s.com - night dancer x racing into the night_320kbps.mp3,
# name,racing-into-the-night,YOASOBI - Racing into the Night
"""


def triage(folder: Path, out: Path, workers: int = 4, limit: int = 0, log=print,
           groups_file: Path | None = None) -> list:  # fmt: skip
    folder, out = folder.resolve(), out.resolve()
    if out == folder or folder in out.parents:
        raise ValueError(f"refusing to write the report inside the music folder: {out}")
    files = list(iter_files(folder))[: limit or None]
    log(f"triage (report-only): {len(files)} files in {folder}")
    t0 = time.time()
    results: dict = {}
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {
            ex.submit(analyse_file, str(p), p.relative_to(folder).as_posix(), LONG_CLASS_S): k
            for k, p in enumerate(files)
        }
        for n, fut in enumerate(as_completed(futs), 1):
            k = futs[fut]
            try:
                results[k] = fut.result()
            except Exception as exc:
                row = Row(file=files[k].relative_to(folder).as_posix(), cls="unreadable", keep="no")
                row.reasons.append(f"analysis crashed: {exc}")
                results[k] = (asdict(row), NO_FP, NO_SIG)
            if n % 10 == 0 or n == len(files):
                log(f"  features {n}/{len(files)}  ({time.time() - t0:.0f} s)")
    rows = [results[k][0] for k in range(len(files))]
    fps = [results[k][1] for k in range(len(files))]
    sigs = [results[k][2] for k in range(len(files))]
    groups_file = Path(groups_file) if groups_file else folder / ".saics" / "groups_overrides.csv"
    overrides = read_overrides(groups_file)
    if overrides:
        log(f"  {len(overrides)} group overrides from {groups_file}")
    g, idx, matrix = assign_groups(rows, sigs, overrides, workers, log)
    log("  checking duplicates (same version only)…")
    mark_duplicates(rows, fps)
    write_report(rows, out)
    review = out.with_name("song_groups_review.csv")
    write_groups_review(rows, g, idx, matrix, review)
    template = out.with_name("groups_overrides.example.csv")
    if not template.exists():
        template.write_text(OVERRIDES_TEMPLATE, encoding="utf-8")
    gids = [rows[i]["group"] for i in idx]
    multi = sum(1 for gid in set(gids) if gids.count(gid) > 1)
    log(f"  {len(set(gids))} song groups ({multi} with several versions) -> {review}")
    counts: dict = {}
    for r in rows:
        counts[r["cls"]] = counts.get(r["cls"], 0) + 1
    log(f"done in {time.time() - t0:.0f} s -> {out}")
    log("  " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    return rows


SET_ASIDE_MANIFEST = Path(".saics") / "set_aside_manifest.json"
NEVER_SET_ASIDE = {"music"}  # versions and real songs are never moved


def set_aside(folder: Path, report: Path, classes: set, log=print) -> list:
    """Move files of the given triage classes into <folder>/_set_aside/<class>/ (moves only).

    Reads the classes from an existing report, keeps sub-folders, and records every move in
    <folder>/.saics/set_aside_manifest.json so `--undo` restores them exactly."""
    from saics.consolidate import move_files

    bad = classes & NEVER_SET_ASIDE
    if bad:
        raise ValueError(f"refusing to set aside class(es) {sorted(bad)}")
    folder = folder.resolve()
    with Path(report).open(encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f) if r["class"] in classes]
    by_dest: dict = {}
    for r in rows:
        rel = Path(r["file"].replace("\\", "/"))
        dest = folder / "_set_aside" / r["class"] / rel.parent
        by_dest.setdefault(dest, []).append(folder / rel)
    moved = []
    note = f"saics triage --apply ({', '.join(sorted(classes))})"
    for dest, srcs in by_dest.items():
        moved += move_files(srcs, dest, folder / SET_ASIDE_MANIFEST, note=note)
    for m in moved:
        log(f"  set aside: {m['source']} -> {m['dest']}")
    log(f"{len(moved)} files moved; undo with: saics triage {folder} --undo")
    return moved


def run_triage(args) -> int:
    from saics.consolidate import undo

    folder = Path(args.folder)
    try:
        if args.undo:
            for rec in undo(folder / SET_ASIDE_MANIFEST):
                print(f"restored {rec['source']}")
            return 0
        if args.apply:
            if not args.classes:
                print("--apply needs --classes, e.g. --classes long", file=sys.stderr)
                return 2
            classes = {c.strip() for c in args.classes.split(",") if c.strip()}
            set_aside(folder, Path(args.out), classes)
            return 0
        triage(folder, Path(args.out), workers=args.workers, limit=args.limit,
               groups_file=args.groups_file)  # fmt: skip
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    return 0
