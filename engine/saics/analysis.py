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
from saics.jumps import MIN_JUMP_BARS, BarInfo, find_jumps, outro_bar
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

from saics.structure import (  # noqa: E402  (re-exported)
    CAMELOT_MAJOR,
    CAMELOT_MINOR,
    PITCHES,
    bar_slot_features,
    key_from_chroma,
    meter_from_downbeats,
    regularize_downbeats,
    sections_from_bars,
    tempo_from_beats,
)
from saics.structure import KK_MAJOR as MAJOR  # noqa: E402
from saics.structure import KK_MINOR as MINOR  # noqa: E402

__all__ = ["CAMELOT_MAJOR", "CAMELOT_MINOR", "MAJOR", "MINOR", "PITCHES", "bar_slot_features",
           "key_from_chroma", "meter_from_downbeats", "regularize_downbeats",
           "sections_from_bars", "tempo_from_beats"]  # fmt: skip

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


BREAK_DB = -15.0  # a break is at least this far below the track's typical level …
SILENCE_DB = -30.0  # … and a "silence" at least this far
BREAK_MIN_S = 0.25
EDGE_S = 1.0  # leading/trailing silence is not a break
RETURN_DB = -8.0  # music counts as back once the 4 s after a break average above this


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


def vocal_ratio_per_beat(stereo44: np.ndarray, beats: np.ndarray) -> tuple:
    """(vocal-stem RMS / mix RMS per beat interval, vocal stem mono) via Demucs htdemucs."""
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
    return np.array(out), voc


# ── per-track analysis ────────────────────────────────────────────────────────


def compute_jumps(beats, downbeats, sections, breaks, bar_energy, vocal, duration, feats,
                  feedback: list | None = None) -> list:  # fmt: skip
    """Structural jumps from bundle fields + cached beat-level features (see saics.jumps)."""
    beats = np.asarray(beats, dtype=float)
    bars = bar_slot_features(np.asarray(feats["beat_feats"]), downbeats)
    n_bars = len(bars)
    if n_bars < 2 * MIN_JUMP_BARS or not sections:
        return []
    vocal = np.asarray(vocal, dtype=float)
    bars_ab = list(zip(downbeats[:-1], downbeats[1:], strict=True))[:n_bars]
    vb = np.asarray(feats["vchroma"])
    bar_t = np.r_[beats[downbeats[: n_bars + 1]]]
    if len(bar_t) == n_bars:  # last bar ends at the end of the audio
        bar_t = np.r_[bar_t, duration]
    nb = vb.shape[1]
    info = BarInfo(
        bar_t=bar_t, feats=bars,
        vocal_chroma=np.array([vb[:, a:b].mean(1) for a, b in bars_ab]),
        vocal=np.array([vocal[a:b].max() if b > a else 0 for a, b in bars_ab]),
        vocal_edge=np.array([vocal[a - 1] if a > 0 else 0 for a in downbeats[:n_bars]]),
        energy=np.asarray(bar_energy, dtype=float), duration=duration,
        downbeats=list(downbeats), beat_vchroma=vb, beat_vonset=np.asarray(feats["vonset"]),
        beat_chroma=np.asarray(feats["chroma"]), beat_vocal=vocal[:nb],
    )  # fmt: skip
    for action, t_from, t_to in feedback or []:  # times in the song -> nearest bars
        pair = (int(np.argmin(np.abs(bar_t - t_from))), int(np.argmin(np.abs(bar_t - t_to))))
        (info.pin if action == "keep" else info.ban).append(pair)
    return find_jumps(info, sections, breaks, downbeats)


def analyse_track(path: Path, rel: str, meta: dict) -> tuple:
    """(TrackBundle, beat-level features for the cache) for one audio file."""
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

    import librosa

    beats, dbt = _beat_model()(y, SR)
    beats = np.asarray(beats, dtype=float)
    raw_db = downbeat_indices(beats, np.asarray(dbt, dtype=float))
    bpm, stable, tconf = tempo_from_beats(beats)

    yf = librosa.resample(y, orig_sr=SR, target_sr=FEAT_SR)
    hop = 512
    # 36 bins/octave: 12-bin CQT smears energy into neighbouring semitones (D23).
    cqt = np.abs(librosa.cqt(yf, sr=FEAT_SR, hop_length=hop, n_bins=252, bins_per_octave=36))
    chroma = librosa.feature.chroma_cqt(C=cqt, sr=FEAT_SR, hop_length=hop, bins_per_octave=36)
    bass = librosa.feature.chroma_cqt(
        C=cqt[:72], sr=FEAT_SR, hop_length=hop, n_octaves=2, bins_per_octave=36
    )
    mfcc = librosa.feature.mfcc(y=yf, sr=FEAT_SR, n_mfcc=14, hop_length=hop)[1:]  # drop MFCC0
    onset = librosa.onset.onset_strength(y=yf, sr=FEAT_SR, hop_length=hop)[None]
    rms = librosa.feature.rms(y=yf, hop_length=hop)
    nfr = min(chroma.shape[1], mfcc.shape[1], onset.shape[1], rms.shape[1])
    beat_frames = librosa.time_to_frames(beats, sr=FEAT_SR, hop_length=hop)

    def per_beat(m):  # (d, n_beats): frames from each beat to the next
        return librosa.util.sync(m[:, :nfr], beat_frames, aggregate=np.mean)[:, 1 : len(beats) + 1]

    chroma_b, bass_b, mfcc_b = per_beat(chroma), per_beat(bass), per_beat(mfcc)
    onset_b, rms_b = per_beat(onset)[0], per_beat(rms)[0]
    downbeats, bpb, meter_conf = regularize_downbeats(raw_db, len(beats), onset_b)  # D24
    nb = chroma_b.shape[1]  # can be one short of len(beats) when the last beat ends the audio
    starts = np.zeros(nb, bool)
    starts[[d for d in downbeats if d < nb]] = True
    tonic, mode, camelot, kconf = key_from_chroma(chroma_b, bass_b, starts)  # D23

    beat_feats = np.vstack([chroma_b, mfcc_b / 10.0, onset_b[None] / (onset_b.max() + 1e-9)])
    bars = bar_slot_features(beat_feats, downbeats)
    sections = sections_from_bars(bars) if len(bars) else []
    n_bars = len(bars)
    bars_ab = list(zip(downbeats[:-1], downbeats[1:], strict=True))[:n_bars]  # beat spans
    bar_rms = np.array([rms_b[a:b].mean() for a, b in bars_ab])
    ref = float(np.percentile(bar_rms, 95)) if len(bar_rms) else 1.0
    bar_energy = np.round(np.clip(bar_rms / (ref + 1e-9), 0, 1), 3)

    vocal = np.zeros(len(beats))
    vb = np.zeros((12, nb))
    vonset = np.zeros(nb)
    if len(beats):
        ratio, voc = vocal_ratio_per_beat(stereo, beats)
        vocal = smooth_activity(ratio)
        vf = librosa.resample(voc, orig_sr=SR, target_sr=FEAT_SR)
        vchroma = librosa.feature.chroma_cqt(y=vf, sr=FEAT_SR, hop_length=hop)
        von = librosa.onset.onset_strength(y=vf, sr=FEAT_SR, hop_length=hop)[None]
        vb = librosa.util.sync(vchroma, beat_frames, aggregate=np.mean)[:, 1 : nb + 1]
        vonset = librosa.util.sync(von, beat_frames, aggregate=np.mean)[0, 1 : nb + 1]
    breaks = detect_breaks(y, SR, beats)
    feats = {"beat_feats": beat_feats, "vchroma": vb, "vonset": vonset, "chroma": chroma_b}
    jumps = compute_jumps(beats, downbeats, sections, breaks, bar_energy, vocal, duration, feats,
                          meta.get("feedback"))  # fmt: skip

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
        bar_energy=bar_energy.tolist(),
        vocal_activity=[round(float(v), 3) for v in vocal],
        breaks=breaks,
        jumps=jumps,
        outro_bar=outro_bar(sections, n_bars),
        loopable=bool(meta.get("loopable", True)),
    ), {k: np.asarray(v, dtype=np.float32) for k, v in feats.items()}


def _worker(path_str: str, rel: str, meta: dict) -> tuple:
    try:
        b, feats = analyse_track(Path(path_str), rel, meta)
        return rel, b.dump(), "", feats
    except Exception as exc:  # one bad file never stops the batch
        return rel, "", f"{type(exc).__name__}: {exc}", None


def _init():
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    try:
        from threadpoolctl import threadpool_limits

        threadpool_limits(2)
    except ImportError:
        pass


# ── library run ───────────────────────────────────────────────────────────────


FOREVER_OVERRIDES = "forever_overrides.csv"
JUMP_FEEDBACK = "jump_feedback.csv"


def read_jump_feedback(saics_dir: Path) -> dict:
    """file -> [(keep|ban, from_s, to_s)] from `<folder>/.saics/jump_feedback.csv`."""
    import csv as _csv

    p = Path(saics_dir) / JUMP_FEEDBACK
    out: dict = {}
    if p.exists():
        with p.open(encoding="utf-8-sig", newline="") as f:
            for row in _csv.reader(f):
                if len(row) >= 4 and row[0] in ("keep", "ban"):
                    out.setdefault(row[1].replace("\\", "/"), []).append(
                        (row[0], float(row[2]), float(row[3]))
                    )
    return out


def read_forever_overrides(saics_dir: Path) -> set:
    """Files the owner marked not loopable: lines `not_loopable,<file>` (# comments allowed)."""
    p = Path(saics_dir) / FOREVER_OVERRIDES
    out = set()
    if p.exists():
        for line in p.read_text(encoding="utf-8-sig").splitlines():
            parts = [x.strip() for x in line.split(",", 1)]
            if len(parts) == 2 and parts[0].lower() == "not_loopable" and not line.startswith("#"):
                out.add(parts[1].replace("\\", "/"))
    return out


def recompute_jumps(folder: Path, only: set | None = None, log=print) -> int:
    """Re-run jump finding + Forever fields from cached features (no audio decoding)."""
    folder = Path(folder).resolve()
    out_dir = folder / ".saics"
    not_loopable = read_forever_overrides(out_dir)
    feedback = read_jump_feedback(out_dir)
    lib = json.loads((out_dir / "library.json").read_text(encoding="utf-8"))
    done = 0
    for t in lib["tracks"]:
        if only is not None and t["file"] not in only:
            continue
        bpath, fpath = (
            out_dir / "tracks" / f"{t['id']}.json",
            out_dir / "features" / f"{t['id']}.npz",
        )
        if not fpath.exists():
            continue  # analysed before features were cached: needs `saics analyze`
        d = json.loads(bpath.read_text(encoding="utf-8"))
        feats = dict(np.load(fpath))
        from saics.schema import Break, Section

        sections = [Section(**x) for x in d["sections"]]
        breaks = [Break(**x) for x in d.get("breaks", [])]
        jumps = compute_jumps(d["beats"], d["downbeats"], sections, breaks, d["bar_energy"],
                              d["vocal_activity"], d["track"]["duration_s"], feats,
                              feedback.get(t["file"]))  # fmt: skip
        d["jumps"] = [j.model_dump() for j in jumps]
        d["outro_bar"] = outro_bar(sections, len(d["downbeats"]) - 1)
        d["loopable"] = t["file"] not in not_loopable
        d["schema"] = SCHEMA
        bpath.write_text(TrackBundle.model_validate(d).dump(), encoding="utf-8")
        done += 1
    log(f"recomputed jumps for {done} tracks")
    return done


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
            log=print, only: set | None = None) -> dict:  # fmt: skip
    folder = folder.resolve()
    out_dir = folder / ".saics"
    tracks_dir = out_dir / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    tri = read_triage(triage_report)
    not_loopable = read_forever_overrides(out_dir)
    feedback = read_jump_feedback(out_dir)
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
        meta = dict(tri.get(rel, {"class": "music"}))
        meta["loopable"] = rel not in not_loopable
        meta["feedback"] = feedback.get(rel)
        if tri and meta["class"] not in PLAYABLE:
            continue
        st = p.stat()
        c = cache.get(rel)
        if (
            c
            and c["size"] == st.st_size
            and c["mtime_ns"] == st.st_mtime_ns
            and _schema_of(tracks_dir / f"{c['id']}.json") == SCHEMA
        ):
            keep.append((rel, c, meta))  # unchanged: reuse the bundle, refresh group labels
            continue
        if (
            c is None
            and rel in on_disk
            and _schema_of(tracks_dir / f"{on_disk[rel]}.json") == SCHEMA
        ):
            c = {"id": on_disk[rel], "size": st.st_size, "mtime_ns": st.st_mtime_ns,
                 "group": "", "version": ""}  # fmt: skip
            keep.append((rel, c, meta))
            continue
        if only is not None and rel not in only:
            if c:  # leave other cached bundles untouched (even if older schema)
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
            _, js, err, feats = fut.result()
            if err:
                errors.append((rel, err))
                log(f"  ! {rel}: {err}")
            else:
                b = TrackBundle.model_validate_json(js)  # validate on write
                (tracks_dir / f"{b.track.id}.json").write_text(js, encoding="utf-8")
                feat_dir = out_dir / "features"
                feat_dir.mkdir(exist_ok=True)
                np.savez_compressed(feat_dir / f"{b.track.id}.npz", **feats)
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


def _schema_of(path: Path) -> str:
    """Schema tag of a bundle on disk ('' if missing/unreadable). Reads only the head."""
    try:
        with path.open(encoding="utf-8") as f:
            head = f.read(64)
        return json.loads(head.split(",")[0] + "}").get("schema", "")
    except (OSError, ValueError):
        return ""


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
    """Older-schema bundles can't be patched (/8 jumps need audio features); they stay as they
    are until re-analysed, and the app plays those tracks plainly meanwhile."""
    return 0


def _relabel(path: Path, meta: dict) -> None:
    if not meta.get("group") or _schema_of(path) != SCHEMA:
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
        only = None
        if args.only:
            lines = Path(args.only).read_text(encoding="utf-8").splitlines()
            only = {
                ln.strip().replace("\\", "/")
                for ln in lines
                if ln.strip() and not ln.startswith("#")
            }
        analyze(Path(args.folder), Path(args.triage) if args.triage else None,
                workers=args.workers, limit=args.limit, only=only)  # fmt: skip
    except Exception as exc:
        print(f"analyze failed: {exc}", file=sys.stderr)
        return 1
    return 0


assert SCHEMA == "saics.analysis/9"
