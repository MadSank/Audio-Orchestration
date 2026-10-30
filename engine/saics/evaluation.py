"""P2 evaluation harness: blind listening tests + automatic seam metrics.

`saics eval build <folder> --set eval/set.txt` renders jump clips (5 s either side of the
seam) for every song in the set, in several variants of the same jumps:

* `legacy`   - legacy jump graph + legacy renderer (documents D8),
* `baseline` - legacy jump graph + the clean renderer (`saics.render`): the bar P3 must beat,
* `current`  - added by P3 (new jump finder).

Clip files get random ids; the variant is stored only in the manifest, so ratings on the
eval page are blind. `saics eval report` joins ratings (eval/results/*.json) with metrics.
"""

import json
import secrets
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from saics.render import render_segments

OUT_SR = 44100
CTX_S = 5.0
CLIP_LUFS = -16.0


# ── seam metrics ──────────────────────────────────────────────────────────────


def seam_metrics(y: np.ndarray, sr: int, seam_s: float, beats: np.ndarray | None = None) -> dict:
    """Automatic seam quality metrics for a mono clip with a seam at `seam_s` seconds."""
    import librosa

    hop = 256
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tf = librosa.frames_to_time(np.arange(len(onset)), sr=sr, hop_length=hop)
    near = np.abs(tf - seam_s) <= 0.05
    away = np.abs(tf - seam_s) > 0.5
    flux = float(onset[near].max() / (np.median(onset[away]) + 1e-9)) if near.any() else 0.0

    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop)
    tc = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)

    def cdist(t):
        a = chroma[:, (tc >= t - 1) & (tc < t)].mean(1)
        b = chroma[:, (tc >= t) & (tc < t + 1)].mean(1)
        return 1 - float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

    others = [cdist(t) for t in np.arange(1.0, len(y) / sr - 1.0, 0.5) if abs(t - seam_s) > 1.0]
    chroma_jump = cdist(seam_s) - (float(np.median(others)) if others else 0.0)

    def db(a, b):
        seg = y[int(a * sr) : int(b * sr)]
        return 10 * np.log10(np.mean(seg**2) + 1e-12)

    loud_step = abs(db(seam_s - 1.0, seam_s) - db(seam_s, seam_s + 1.0))

    phase_ms = float("nan")
    if beats is not None and len(beats) >= 6:
        beats = refine_beats(y, sr, np.asarray(beats, dtype=float))
        pre = beats[beats < seam_s - 0.1]
        post = beats[beats > seam_s + 0.1][:8]
        if len(pre) >= 4 and len(post) >= 2:
            ibi = float(np.median(np.diff(pre)))
            k = np.round((post - pre[-1]) / ibi)
            phase_ms = float(np.median(np.abs(post - (pre[-1] + k * ibi))) * 1000)
    return {
        "flux_spike": round(flux, 3),
        "chroma_jump": round(chroma_jump, 4),
        "loudness_step_db": round(float(loud_step), 2),
        "beat_phase_ms": round(phase_ms, 1),
    }


def refine_beats(y: np.ndarray, sr: int, beats: np.ndarray, win_s: float = 0.03) -> np.ndarray:
    """Snap each beat to the strongest onset within +-30 ms at ~1.5 ms resolution.

    Beat This! reports beats on a 20 ms frame grid, too coarse for the 10 ms phase criterion.
    """
    import librosa

    hop = max(1, sr // 700)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, n_fft=1024)
    out = []
    for b in beats:
        lo, hi = int((b - win_s) * sr / hop), int((b + win_s) * sr / hop) + 1
        lo, hi = max(lo, 0), min(hi, len(env))
        if hi - lo < 3 or env[lo:hi].max() <= 0:
            out.append(b)
            continue
        out.append((lo + int(np.argmax(env[lo:hi]))) * hop / sr)
    return np.asarray(out)


def _beats(y: np.ndarray, sr: int) -> np.ndarray:
    from saics.analysis import _beat_model

    b, _ = _beat_model()(y, sr)
    return np.asarray(b, dtype=float)


def _normalise(y: np.ndarray, sr: int) -> np.ndarray:
    import pyloudnorm as pyln

    lufs = pyln.Meter(sr).integrated_loudness(y)
    if not np.isfinite(lufs):
        return y
    out = y * 10 ** ((CLIP_LUFS - lufs) / 20)
    pk = np.abs(out).max()
    return out / pk * 0.98 if pk > 0.98 else out


# ── clip building ─────────────────────────────────────────────────────────────


def pick_jumps(edges: list, beats: list, n: int) -> list:
    """Best-scoring legacy edges, at most one per source beat, spread through the song."""
    chosen, used = [], set()
    for e in sorted(edges, key=lambda e: -e.score):
        if e.source in used or any(abs(e.source - s) < 16 for s in used):
            continue
        chosen.append(e)
        used.add(e.source)
        if len(chosen) == n:
            break
    return chosen


def legacy_jump_clips(path: Path, n: int) -> list:
    """For one song: [(edge, {variant: (mono clip at OUT_SR, seam_s)})] for up to n jumps."""
    import librosa

    from saics.legacy.audio_processor import AudioContinuityProcessor

    proc = AudioContinuityProcessor(str(path))
    proc.load_and_extract()
    proc.build_similarity_graph()
    sr, bts = proc.sr, proc.beats
    ibi = 60.0 / max(proc.tempo, 1.0)
    k = max(2, int(round(CTX_S / ibi)))  # beats of context either side
    out = []
    for e in pick_jumps(proc.edges, bts, n):
        if e.source - k < 0 or e.target + k + 1 >= len(bts):
            continue
        pre = bts[e.source - k : e.source + 1]  # play up to and including the source beat
        post = bts[e.target : e.target + k + 1]
        variants = {}
        # legacy renderer: seam = output length of the prefix (its write pointer)
        y_leg = proc.synthesise(pre + post)
        seam_leg = len(proc.synthesise(pre)) / sr
        variants["legacy"] = (y_leg, seam_leg)
        segs = [
            (pre[0].sample, bts[e.source + 1].sample),
            (post[0].sample, bts[e.target + k + 1].sample),
        ]
        y_base, (seam,) = render_segments(proc.y.astype(np.float32), segs, sr, xfade_ms=30)
        variants["baseline"] = (y_base, seam / sr)
        clips = {}
        for v, (yy, s) in variants.items():
            if sr != OUT_SR:
                yy = librosa.resample(yy, orig_sr=sr, target_sr=OUT_SR)
            clips[v] = (yy.astype(np.float32), s)
        out.append((e, clips))
    return out


def build(folder: Path, set_file: Path, out_dir: Path, per_song: int = 10, log=print) -> dict:
    folder, out_dir = Path(folder), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    songs = [ln.strip() for ln in Path(set_file).read_text(encoding="utf-8").splitlines()
             if ln.strip() and not ln.startswith("#")]  # fmt: skip
    manifest_path = out_dir / "manifest.json"
    manifest = (
        json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {"clips": []}
    )
    done = {(c["song"], c["variant"]) for c in manifest["clips"]}
    t0 = time.time()
    for i, song in enumerate(songs, 1):
        if (song, "baseline") in done:
            log(f"[{i}/{len(songs)}] {song}: cached")
            continue
        try:
            jumps = legacy_jump_clips(folder / song, per_song)
        except Exception as exc:
            log(f"[{i}/{len(songs)}] {song}: FAILED {type(exc).__name__}: {exc}")
            continue
        for e, clips in jumps:
            for variant, (y, seam_s) in clips.items():
                y = _normalise(y, OUT_SR)
                cid = secrets.token_hex(6)
                sf.write(out_dir / f"{cid}.wav", y, OUT_SR, subtype="PCM_16")
                manifest["clips"].append({
                    "id": cid, "kind": "jump", "song": song, "variant": variant,
                    "src_beat": e.source, "tgt_beat": e.target, "legacy_score": round(e.score, 4),
                    "seam_s": round(seam_s, 4), "duration_s": round(len(y) / OUT_SR, 3),
                    "metrics": seam_metrics(y, OUT_SR, seam_s, _beats(y, OUT_SR)),
                })  # fmt: skip
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8")
        log(f"[{i}/{len(songs)}] {song}: {len(jumps)} jumps ({time.time() - t0:.0f} s)")
    return manifest


# ── ratings + report ──────────────────────────────────────────────────────────


def load_ratings(results_dir: Path) -> list:
    out = []
    for p in sorted(Path(results_dir).glob("*.json")):
        out.extend(json.loads(p.read_text("utf-8")).get("ratings", []))
    return out


def report(clips_dir: Path, results_dir: Path) -> str:
    manifest = json.loads((Path(clips_dir) / "manifest.json").read_text("utf-8"))
    by_id = {c["id"]: c for c in manifest["clips"]}
    ratings: dict = {}
    jitter: dict = {}
    for r in load_ratings(results_dir):
        if r["clip_id"] in by_id:
            ratings.setdefault(r["clip_id"], []).append(r["rating"])
            jit = bool(r.get("jittery")) or r["rating"] == 1
            jitter.setdefault(r["clip_id"], []).append(jit)
    rows = []
    variants = sorted({c["variant"] for c in manifest["clips"]})
    for v in variants:
        cs = [c for c in manifest["clips"] if c["variant"] == v]
        rated = [np.mean(ratings[c["id"]]) for c in cs if c["id"] in ratings]
        jittery = [any(jitter[c["id"]]) for c in cs if c["id"] in jitter]
        m = {k: np.nanmedian([c["metrics"][k] for c in cs]) for k in cs[0]["metrics"]}
        phase = [c["metrics"]["beat_phase_ms"] for c in cs]
        over10 = sum(1 for p in phase if np.isfinite(p) and p > 10)
        if rated:
            row = (f"| {v} | {len(cs)} | {len(rated)} | {np.mean(rated):.2f} | "
                   f"{np.mean([x >= 4 for x in rated]) * 100:.0f}% | "
                   f"{np.mean(jittery) * 100:.0f}% | ")  # fmt: skip
        else:
            row = f"| {v} | {len(cs)} | 0 | – | – | – | "
        row += (
            f"{m['flux_spike']:.2f} | {m['chroma_jump']:.3f} | {m['loudness_step_db']:.2f} | "
            f"{m['beat_phase_ms']:.1f} | {over10} |"
        )
        rows.append(row)
    head = (
        "| variant | clips | rated | mean rating | rated ≥4 | jittery | median flux spike | "
        "median chroma jump | median loudness step (dB) | median beat-phase err (ms) | "
        "clips >10 ms |\n|---|---|---|---|---|---|---|---|---|---|---|"
    )
    return head + "\n" + "\n".join(rows)


def run_eval(args) -> int:
    root = Path(args.eval_dir)
    if args.action == "build":
        build(Path(args.folder), Path(args.set), root / "clips", per_song=args.per_song)
        return 0
    if args.action == "report":
        md = report(root / "clips", root / "results")
        (root / "report.md").write_text(md + "\n", encoding="utf-8")
        print(md)
        return 0
    print("unknown action", file=sys.stderr)
    return 2
