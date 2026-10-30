"""`saics analyze`: write `<MusicFolder>/.saics/` analysis bundles (schema saics.analysis/7).

Per track: beats + downbeats (Beat This!), meter from the downbeat spacing (never assume
4/4), tempo, key (Krumhansl-Kessler major/minor -> Camelot), sections + repeat groups
(bar-level self-similarity), bar energy, vocal activity (Demucs vocal stem), loudness
(BS.1770 -> gain to -14 LUFS), breaks (silences / near-silent breakdowns).
Jumps (P3) and cues (P4) are left empty. Bundles from an older schema are upgraded in place
(only the new fields are computed).

Writes ONLY inside `<folder>/.saics/` (CLAUDE.md hard rule 3). Cached by track id and
file size/mtime, so re-runs only process new or changed files.
"""

import csv
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from saics.io import AUDIO_EXTS, decode, probe
from saics.schema import (
    SCHEMA,
    Break,
    Group,
    Key,
    Library,
    LibraryGroup,
    LibraryTrack,
    Loudness,
    Meter,
    Section,
    Tempo,
    Track,
    TrackBundle,
    Triage,
)

SR = 44100  # engine rate: every file is decoded to this (fixes the D15 class of bug)
FEAT_SR = 22050
TARGET_LUFS = -14.0
ID_SECONDS = 30.0
PLAYABLE = {"music", "short"}  # classes that get a bundle

PITCHES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Krumhansl-Kessler key profiles.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
# Camelot number per tonic pitch class.
CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]


# ── pure helpers (unit-tested) ────────────────────────────────────────────────


def track_id(y44: np.ndarray, duration_s: float) -> str:
    """SHA-1 of the first 30 s of decoded mono audio (44.1 kHz float32) + duration (ms)."""
    head = np.ascontiguousarray(y44[: int(ID_SECONDS * SR)], dtype="<f4")
    h = hashlib.sha1(head.tobytes())
    h.update(str(round(duration_s * 1000)).encode())
    return h.hexdigest()[:20]


def downbeat_indices(beats: np.ndarray, downbeat_times: np.ndarray, tol: float = 0.07) -> list:
    """Map downbeat times onto the nearest beat index (within `tol` seconds)."""
    if len(beats) == 0:
        return []
    out = []
    for t in downbeat_times:
        i = int(np.argmin(np.abs(beats - t)))
        if abs(beats[i] - t) <= tol and (not out or i > out[-1]):
            out.append(i)
    return out


def meter_from_downbeats(downbeats: list) -> tuple:
    """(beats_per_bar, confidence) from the spacing of downbeat indices. Never assumes 4/4."""
    gaps = np.diff(downbeats)
    if len(gaps) < 2:
        return 4, 0.0
    vals, counts = np.unique(gaps, return_counts=True)
    k = int(np.argmax(counts))
    return int(vals[k]), round(float(counts[k] / len(gaps)), 3)


def tempo_from_beats(beats: np.ndarray) -> tuple:
    """(bpm, stable, confidence) from inter-beat intervals."""
    ibi = np.diff(beats)
    if len(ibi) < 4:
        return 0.0, False, 0.0
    bpm = 60.0 / float(np.median(ibi))
    # Local tempo drift: compare 8-beat windows rather than raw jitter.
    w = np.convolve(ibi, np.ones(8) / 8, mode="valid") if len(ibi) >= 8 else ibi
    drift = float(np.std(w) / np.mean(w))
    cv = float(np.std(ibi) / np.mean(ibi))
    return round(bpm, 2), drift < 0.02, round(max(0.0, 1.0 - 5 * cv), 3)


def key_from_chroma(chroma_mean: np.ndarray) -> tuple:
    """(tonic, mode, camelot, confidence) by correlating with major/minor profiles."""
    scores = []
    for mode, prof in (("major", MAJOR), ("minor", MINOR)):
        for t in range(12):
            r = np.corrcoef(chroma_mean, np.roll(prof, t))[0, 1]
            scores.append((float(r), t, mode))
    scores.sort(reverse=True)
    (best, tonic, mode), (second, *_rest) = scores[0], scores[1]
    num = (CAMELOT_MAJOR if mode == "major" else CAMELOT_MINOR)[tonic]
    camelot = f"{num}{'B' if mode == 'major' else 'A'}"
    conf = round(max(0.0, min(1.0, (best - second) * 5 + max(0.0, best) * 0.5)), 3)
    return PITCHES[tonic], mode, camelot, conf


def sections_from_bars(bar_feats: np.ndarray, min_len: int = 4, kernel: int = 8) -> list:
    """Novelty-based segmentation of bar-level features + repeat groups by clustering."""
    n = len(bar_feats)
    if n < 2 * min_len:
        return [Section(start_bar=0, end_bar=max(1, n), group=0)]
    x = (bar_feats - bar_feats.mean(0)) / (bar_feats.std(0) + 1e-9)
    x /= np.linalg.norm(x, axis=1, keepdims=True) + 1e-9
    ssm = x @ x.T
    k = min(kernel, n // 2)
    half = k // 2
    sign = np.sign(np.arange(-half, half) + 0.5)
    check = np.outer(sign, sign) * np.exp(
        -((np.arange(-half, half) + 0.5) ** 2) / (2 * (half / 2) ** 2)
    )
    pad = np.pad(ssm, half, mode="edge")
    nov = np.array([np.sum(pad[i : i + 2 * half, i : i + 2 * half] * check) for i in range(n)])
    nov = np.maximum(nov, 0)
    bounds = [0]
    thr = np.percentile(nov, 70)
    for i in np.argsort(-nov):
        if nov[i] < thr:
            break
        if all(abs(i - b) >= min_len for b in bounds) and n - i >= min_len:
            bounds.append(int(i))
    bounds = sorted(bounds) + [n]
    segs = [(a, b) for a, b in zip(bounds[:-1], bounds[1:], strict=True) if b > a]
    means = np.array([x[a:b].mean(0) for a, b in segs])
    means /= np.linalg.norm(means, axis=1, keepdims=True) + 1e-9
    groups, protos = [], []
    for m in means:  # greedy clustering: same group if cosine >= 0.6 with a prototype
        sims = [float(m @ p) for p in protos]
        if sims and max(sims) >= 0.6:
            groups.append(int(np.argmax(sims)))
        else:
            protos.append(m)
            groups.append(len(protos) - 1)
    return [
        Section(start_bar=a, end_bar=b, group=g) for (a, b), g in zip(segs, groups, strict=True)
    ]


BREAK_DB = -15.0  # a break is at least this far below the track's typical level …
SILENCE_DB = -30.0  # … and a "silence" at least this far
BREAK_MIN_S = 0.25
RETURN_DB = -8.0  # music counts as back once the 4 s after a break average above this
EDGE_S = 1.0  # leading/trailing silence is not a break


def short_term_db(y: np.ndarray, sr: int, win_s: float = 0.4, hop_s: float = 0.05) -> tuple:
    """(times, level dB) of mean-square energy in sliding windows (centre times)."""
    win, hop = int(win_s * sr), int(hop_s * sr)
    if len(y) < win:
        return np.zeros(0), np.zeros(0)
    c = np.concatenate([[0.0], np.cumsum(y.astype(np.float64) ** 2)])
    starts = np.arange(0, len(y) - win + 1, hop)
    ms = (c[starts + win] - c[starts]) / win
    return (starts + win / 2) / sr, 10 * np.log10(ms + 1e-12)


def detect_breaks(y: np.ndarray, sr: int, beats: np.ndarray) -> list:
    """Silences and near-silent breakdowns, relative to the track's typical level."""
    t, db = short_term_db(y, sr)
    if len(t) == 0 or len(beats) < 2:
        return []
    ref = float(np.median(db[db > db.max() - 60]))  # typical level, ignoring digital silence
    low = db < ref + BREAK_DB
    out = []
    i, n, hop = 0, len(t), t[1] - t[0] if len(t) > 1 else 0.05
    while i < n:
        if not low[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and (low[j + 1] or (j + 2 < n and low[j + 2])):  # bridge 1-frame blips
            j += 1
        start, end = t[i] - hop / 2, t[j] + hop / 2
        depth = float(db[i : j + 1].min() - ref)
        i = j + 1
        if end - start < BREAK_MIN_S or start < EDGE_S or end > t[-1] - EDGE_S:
            continue
        after = db[(t >= end) & (t < end + 4.0)]
        ret = float(np.mean(after) - ref) if len(after) else -99.0
        ramp = ret >= RETURN_DB
        out.append(Break(
            start_beat=int(np.argmin(np.abs(beats - start))),
            end_beat=int(np.argmin(np.abs(beats - end))),
            start_s=round(float(start), 3), end_s=round(float(end), 3),
            depth_db=round(depth, 1), kind="silence" if depth <= SILENCE_DB else "breakdown",
            ramp_up=ramp, return_db=round(ret, 1),
        ))  # fmt: skip
    return out


def smooth_activity(ratio: np.ndarray, on: float = 0.35, off: float = 0.2) -> np.ndarray:
    """Vocal activity 0..1 per beat: clipped vocal/mix ratio, gated with hysteresis."""
    act = np.clip(ratio / 0.6, 0, 1)
    gate, state = np.zeros_like(act), False
    for i, r in enumerate(ratio):
        state = r >= on if not state else r >= off
        gate[i] = 1.0 if state else 0.0
    out = act * gate
    if len(out) >= 3:  # 3-beat median removes single-beat blips
        out = np.median(np.stack([np.r_[out[:1], out[:-1]], out, np.r_[out[1:], out[-1:]]]), 0)
    return np.round(out, 3)


# ── models (one copy per worker process) ──────────────────────────────────────

_MODELS: dict = {}


def _device() -> str:
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def _beat_model():
    if "beats" not in _MODELS:
        from beat_this.inference import Audio2Beats

        _MODELS["beats"] = Audio2Beats(checkpoint_path="final0", device=_device(), dbn=False)
    return _MODELS["beats"]


def _demucs():
    if "demucs" not in _MODELS:
        from demucs.pretrained import get_model

        m = get_model("htdemucs")
        m.to(_device()).eval()
        _MODELS["demucs"] = m
    return _MODELS["demucs"]


def vocal_ratio_per_beat(stereo44: np.ndarray, beats: np.ndarray) -> np.ndarray:
    """Vocal-stem RMS / mix RMS per beat interval (Demucs htdemucs)."""
    import torch
    from demucs.apply import apply_model

    model = _demucs()
    vi = model.sources.index("vocals")
    chunk = 300 * SR  # 5-minute chunks bound RAM/VRAM on hour-long loops and compilations
    voc = np.zeros(stereo44.shape[1], np.float32)
    for a in range(0, stereo44.shape[1], chunk):
        x = torch.tensor(stereo44[None, :, a : a + chunk], dtype=torch.float32)
        with torch.no_grad():
            src = apply_model(model, x, device=_device(), split=True, overlap=0.1, progress=False)
        voc[a : a + x.shape[-1]] = src[0, vi].mean(0).cpu().numpy()
        del src
    mix = stereo44.mean(0)
    edges = np.r_[(beats * SR).astype(int), len(mix)]
    out = []
    for a, b in zip(edges[:-1], edges[1:], strict=True):
        if b <= a:
            out.append(0.0)
            continue
        v = float(np.sqrt(np.mean(voc[a:b] ** 2)))
        m = float(np.sqrt(np.mean(mix[a:b] ** 2))) + 1e-6
        out.append(v / m)
    return np.array(out)


# ── per-track analysis ────────────────────────────────────────────────────────


def analyse_track(path: Path, rel: str, meta: dict) -> TrackBundle:
    import librosa
    import pyloudnorm as pyln

    p = probe(path)
    if not p.ok:
        raise RuntimeError(p.error)
    stereo = decode(path, sr=SR, mono=False)
    if stereo.ndim == 1:
        stereo = np.stack([stereo, stereo])
    y = stereo.mean(0)
    duration = len(y) / SR
    tid = track_id(y, duration)

    beats, dbt = _beat_model()(y, SR)
    beats = np.asarray(beats, dtype=float)
    downbeats = downbeat_indices(beats, np.asarray(dbt, dtype=float))
    bpb, meter_conf = meter_from_downbeats(downbeats)
    bpm, stable, tconf = tempo_from_beats(beats)

    yf = librosa.resample(y, orig_sr=SR, target_sr=FEAT_SR)
    hop = 512
    cqt = np.abs(librosa.cqt(yf, sr=FEAT_SR, hop_length=hop, n_bins=84, bins_per_octave=12))
    chroma = librosa.feature.chroma_cqt(C=cqt, sr=FEAT_SR, hop_length=hop)
    tonic, mode, camelot, kconf = key_from_chroma(chroma.mean(1))

    # Bar-level features for sections and energy (bars = downbeat to downbeat).
    bar_times = beats[downbeats] if len(downbeats) >= 2 else beats[::4]
    bar_frames = librosa.time_to_frames(bar_times, sr=FEAT_SR, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=yf, sr=FEAT_SR, n_mfcc=14, hop_length=hop)[1:]  # drop MFCC0
    onset = librosa.onset.onset_strength(y=yf, sr=FEAT_SR, hop_length=hop)[None]
    rms = librosa.feature.rms(y=yf, hop_length=hop)
    feats = np.vstack([chroma, mfcc, onset[:, : chroma.shape[1]]])
    bars = librosa.util.sync(feats, bar_frames, aggregate=np.mean).T[1:-1]  # inside the grid
    sections = sections_from_bars(bars) if len(bars) else []
    bar_rms = librosa.util.sync(rms, bar_frames, aggregate=np.mean)[0][1:-1]
    ref = float(np.percentile(bar_rms, 95)) if len(bar_rms) else 1.0
    bar_energy = np.round(np.clip(bar_rms / (ref + 1e-9), 0, 1), 3).tolist()

    vocal = smooth_activity(vocal_ratio_per_beat(stereo, beats)).tolist() if len(beats) else []

    meter = pyln.Meter(SR)
    lufs = float(meter.integrated_loudness(stereo.T))
    lufs = lufs if np.isfinite(lufs) else -70.0

    return TrackBundle(
        track=Track(
            id=tid,
            file=rel.replace("\\", "/"),
            title=p.tags.get("title", ""),
            artist=p.tags.get("artist", ""),
            duration_s=round(duration, 3),
            codec=p.codec,
            native_sample_rate=p.sample_rate,
            decoder_offset_ms=round(p.start_time_s * 1000, 3),
        ),  # fmt: skip
        triage=Triage(**{"class": meta.get("class", "music"), "reasons": meta.get("reasons", [])}),
        group=Group(
            id=meta.get("group") or tid,
            version=meta.get("version") or "original",
            evidence=meta.get("evidence", ""),
        ),  # fmt: skip
        loudness=Loudness(integrated_lufs=round(lufs, 2), gain_db=round(TARGET_LUFS - lufs, 2)),
        tempo=Tempo(bpm=bpm, stable=stable, confidence=tconf),
        meter=Meter(beats_per_bar=bpb, confidence=meter_conf),
        key=Key(tonic=tonic, mode=mode, camelot=camelot, confidence=kconf),
        beats=[round(float(b), 4) for b in beats],
        downbeats=downbeats,
        sections=sections,
        bar_energy=bar_energy,
        vocal_activity=vocal,
        breaks=detect_breaks(y, SR, beats),
    )


def _worker(path_str: str, rel: str, meta: dict) -> tuple:
    try:
        b = analyse_track(Path(path_str), rel, meta)
        return rel, b.dump(), ""
    except Exception as exc:  # one bad file never stops the batch
        return rel, "", f"{type(exc).__name__}: {exc}"


def _init():
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    try:
        from threadpoolctl import threadpool_limits

        threadpool_limits(2)
    except ImportError:
        pass


# ── library run ───────────────────────────────────────────────────────────────


def read_triage(report: Path) -> dict:
    """file -> {class, group, version, evidence, reasons} from a triage_report.csv."""
    if not report or not Path(report).exists():
        return {}
    out = {}
    with open(report, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            out[r["file"].replace("\\", "/")] = {
                "class": r["class"], "group": r.get("group", ""), "version": r.get("version", ""),
                "evidence": (r.get("group_evidence") or "").split(":")[0],
                "reasons": [x for x in r.get("reasons", "").split("; ") if x],
            }  # fmt: skip
    return out


def analyze(folder: Path, triage_report: Path | None = None, workers: int = 3, limit: int = 0,
            log=print) -> dict:  # fmt: skip
    folder = folder.resolve()
    out_dir = folder / ".saics"
    tracks_dir = out_dir / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    tri = read_triage(triage_report)
    lib_path = out_dir / "library.json"
    old = json.loads(lib_path.read_text(encoding="utf-8")) if lib_path.exists() else {}
    cache = {t["file"]: t for t in old.get("tracks", [])}
    # Bundles written by a run that was stopped before library.json: reuse them too.
    on_disk = _bundles_by_file(tracks_dir)

    todo, keep = [], []
    for p in sorted(folder.rglob("*")):
        rel = p.relative_to(folder).as_posix()
        if (
            not p.is_file()
            or p.suffix.lower() not in AUDIO_EXTS
            or rel.startswith(("_set_aside/", ".saics/"))
        ):
            continue
        meta = tri.get(rel, {"class": "music"})
        if tri and meta["class"] not in PLAYABLE:
            continue
        st = p.stat()
        c = cache.get(rel)
        if (
            c
            and c["size"] == st.st_size
            and c["mtime_ns"] == st.st_mtime_ns
            and (tracks_dir / f"{c['id']}.json").exists()
        ):
            keep.append((rel, c, meta))  # unchanged: reuse the bundle, refresh group labels
            continue
        if c is None and rel in on_disk:
            c = {"id": on_disk[rel], "size": st.st_size, "mtime_ns": st.st_mtime_ns,
                 "group": "", "version": ""}  # fmt: skip
            keep.append((rel, c, meta))
            continue
        todo.append((p, rel, meta, st))
    todo = todo[: limit or None]
    log(f"analyze: {len(todo)} to analyse, {len(keep)} cached, device={_device()}")

    entries, errors, t0 = [], [], time.time()
    upgraded = 0
    for rel, c, meta in keep:
        upgraded += _upgrade(tracks_dir / f"{c['id']}.json", folder / rel)
        _relabel(tracks_dir / f"{c['id']}.json", meta)
        entries.append(LibraryTrack(id=c["id"], file=rel, size=c["size"], mtime_ns=c["mtime_ns"],
                                    group=meta.get("group") or c["group"],
                                    version=meta.get("version") or c["version"],
                                    **{"class": meta.get("class", "music")}))  # fmt: skip
    if upgraded:
        log(f"  upgraded {upgraded} cached bundles to {SCHEMA}")
    with ProcessPoolExecutor(max_workers=workers, initializer=_init) as ex:
        futs = {ex.submit(_worker, str(p), rel, meta): (rel, st) for p, rel, meta, st in todo}
        for n, fut in enumerate(as_completed(futs), 1):
            rel, st = futs[fut]
            _, js, err = fut.result()
            if err:
                errors.append((rel, err))
                log(f"  ! {rel}: {err}")
            else:
                b = TrackBundle.model_validate_json(js)  # validate on write
                (tracks_dir / f"{b.track.id}.json").write_text(js, encoding="utf-8")
                entries.append(LibraryTrack(id=b.track.id, file=rel, size=st.st_size,
                                            mtime_ns=st.st_mtime_ns, group=b.group.id,
                                            version=b.group.version,
                                            **{"class": b.triage.cls}))  # fmt: skip
            if n % 10 == 0 or n == len(todo):
                el = time.time() - t0
                left = el / n * (len(todo) - n) / 60
                log(f"  {n}/{len(todo)}  {el:.0f} s  (~{left:.0f} min left)")

    groups: dict = {}
    names = _group_names(triage_report)
    for e in entries:
        g = groups.setdefault(e.group, {"name": names.get(e.group, e.group), "tracks": []})
        g["tracks"].append({"id": e.id, "version": e.version})
    lib = Library(generated=time.strftime("%Y-%m-%dT%H:%M:%S"), tracks=entries,
                  groups={k: LibraryGroup(**v) for k, v in groups.items()})  # fmt: skip
    lib_path.write_text(lib.model_dump_json(by_alias=True, indent=1), encoding="utf-8")
    if errors:
        (out_dir / "analyze_errors.csv").write_text(
            "file,error\n" + "".join(f'"{f}","{e}"\n' for f, e in errors), encoding="utf-8"
        )
    stale = {f.stem for f in tracks_dir.glob("*.json")} - {e.id for e in entries}
    for tid in stale:  # e.g. files now classed long/sfx, or removed from the library
        (tracks_dir / f"{tid}.json").unlink()
    if stale:
        log(f"  removed {len(stale)} bundles of files no longer in the library")
    took = time.time() - t0
    log(f"done: {len(entries)} bundles ({len(errors)} errors) in {took:.0f} s -> {lib_path}")
    return {"bundles": len(entries), "errors": errors}


def _bundles_by_file(tracks_dir: Path) -> dict:
    """file (relative, forward slashes) -> track id, read from the bundles themselves."""
    out = {}
    for f in tracks_dir.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            out[d["track"]["file"]] = d["track"]["id"]
        except (ValueError, KeyError):
            continue
    return out


def _upgrade(path: Path, audio: Path) -> int:
    """Bring a cached bundle from an older schema to SCHEMA by computing only new fields."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") == SCHEMA:
        return 0
    if data.get("schema") == "saics.analysis/6":  # /6 -> /7: add breaks
        y = decode(audio, sr=SR)
        data["breaks"] = [b.model_dump() for b in detect_breaks(y, SR, np.asarray(data["beats"]))]
        data["schema"] = SCHEMA
        path.write_text(TrackBundle.model_validate(data).dump(), encoding="utf-8")
        return 1
    raise ValueError(f"cannot upgrade {path.name} from {data.get('schema')}")


def _relabel(path: Path, meta: dict) -> None:
    if not meta.get("group"):
        return
    b = TrackBundle.model_validate_json(path.read_text(encoding="utf-8"))
    if (b.group.id, b.group.version) != (meta["group"], meta.get("version") or b.group.version):
        b.group = Group(id=meta["group"], version=meta.get("version") or b.group.version,
                        evidence=meta.get("evidence", ""))  # fmt: skip
        path.write_text(b.dump(), encoding="utf-8")


def _group_names(report) -> dict:
    review = Path(report).with_name("song_groups_review.csv") if report else None
    if not review or not review.exists():
        return {}
    with review.open(encoding="utf-8-sig", newline="") as f:
        return {r["group"]: r["group_name"] for r in csv.DictReader(f)}


def run_analyze(args) -> int:
    try:
        analyze(Path(args.folder), Path(args.triage) if args.triage else None,
                workers=args.workers, limit=args.limit)  # fmt: skip
    except Exception as exc:
        print(f"analyze failed: {exc}", file=sys.stderr)
        return 1
    return 0


assert SCHEMA == "saics.analysis/7"
