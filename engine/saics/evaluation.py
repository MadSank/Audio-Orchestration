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

from saics.io import decode
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
    """Seam-clip ratings only (full-song ratings live in full-*.json)."""
    out = []
    for p in sorted(Path(results_dir).glob("*.json")):
        if p.name.startswith("full-"):
            continue
        out.extend(r for r in json.loads(p.read_text("utf-8")).get("ratings", []) if "clip_id" in r)
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
    if args.action == "build2":
        build_round2(Path(args.folder), Path(args.set), root / "round2", per_song=args.per_song)
        build_full(Path(args.folder), root / "full")
        return 0
    if args.action == "build2b":
        build_round2b(Path(args.folder), root)
        build_full(Path(args.folder), root / "full")
        return 0
    if args.action == "feedback":
        write_jump_feedback(Path(args.folder), root)
        return 0
    if args.action == "report":
        md = report(root / "clips", root / "results")
        if (root / "round2" / "manifest.json").exists():
            r2 = report(root / "round2", root / "results")
            md += "\n\n## Round 2 (15 s context)\n\n" + r2
        if (root / "full" / "manifest.json").exists():
            full = report_full(root / "full", root / "results")
            md += "\n\n## Full-song Forever test (P3 acceptance)\n\n" + full
        (root / "report.md").write_text(md + "\n", encoding="utf-8")
        print(md)
        return 0
    print("unknown action", file=sys.stderr)
    return 2


# ── round 2: 15 s seam clips with a reveal, full-song Forever renders ───────────

ROUND2_CTX_S = 15.0
FULL_SONGS = [  # P3 acceptance: Racing into the Night (original, Japanese side) + 4 from the set
    ("*Racing Into the Night*Split Audio*", 0),
    ("Maroon 5 - Memories (Lyrics).mp3", None),
    ("Passenger - Let Her Go (Feat*", None),
    ("Earth, Wind & Fire - September (Lyrics).mp3", None),
    ("from-downloads/Lady Gaga - Bad Romance (Lyrics).mp3", None),
]


def _bundle_for(folder: Path, rel: str):
    from saics.schema import TrackBundle

    lib = json.loads((folder / ".saics" / "library.json").read_text("utf-8"))
    tid = next(t["id"] for t in lib["tracks"] if t["file"] == rel.replace("\\", "/"))
    return TrackBundle.model_validate_json(
        (folder / ".saics" / "tracks" / f"{tid}.json").read_text("utf-8")
    )


def _place(b, t: float) -> str:
    """Section label ("B2:5") for a time in the song, from the bundle's bar grid."""
    from saics.structure import section_labels

    beats = np.asarray(b.beats)
    bar_t = beats[b.downbeats]
    bar = int(np.searchsorted(bar_t, t + 1e-3, side="right") - 1)
    labels = section_labels(b.sections)
    for k, s in enumerate(b.sections):
        if s.start_bar <= bar < s.end_bar:
            return f"{labels[k]}:{bar - s.start_bar + 1}"
    return "intro" if bar < 0 else "end"


def _seam_clip(y: np.ndarray, sr: int, t_from: float, t_to: float, xfade_ms: float) -> tuple:
    """15 s before the seam (up to t_from) + 15 s after (from t_to), stereo."""
    a0 = max(0, int((t_from - ROUND2_CTX_S) * sr))
    b1 = min(y.shape[1], int((t_to + ROUND2_CTX_S) * sr))
    out, seams = render_segments(y, [(a0, int(t_from * sr)), (int(t_to * sr), b1)], sr, xfade_ms)
    return out, (seams[0] / sr if seams else (t_from - a0 / sr))


def _mmss(t: float) -> str:
    return f"{int(t // 60)}:{int(t % 60):02d}"


def build_round2(folder: Path, set_file: Path, out_dir: Path, per_song: int = 5, log=print) -> dict:
    """Seam clips with 15 s context: P3 jumps (`current`) + one legacy anchor per song."""
    import librosa

    folder, out_dir = Path(folder), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    songs = [ln.strip().replace("\\", "/") for ln in Path(set_file).read_text("utf-8").splitlines()
             if ln.strip() and not ln.startswith("#")]  # fmt: skip
    r1 = json.loads((out_dir.parent / "clips" / "manifest.json").read_text("utf-8"))["clips"]
    manifest = {"round": 2, "context_s": ROUND2_CTX_S, "clips": []}
    for i, song in enumerate(songs, 1):
        b = _bundle_for(folder, song)
        y = decode(folder / song, sr=OUT_SR, mono=False)
        y = np.stack([y, y]) if y.ndim == 1 else y
        beats = np.asarray(b.beats)
        cur = sorted([j for j in b.jumps if j.kind != "end"], key=lambda j: -j.score)
        picked: list = []
        for j in cur:
            if all(abs(j.from_bar - p.from_bar) >= 8 for p in picked):
                picked.append(j)
            if len(picked) == per_song:
                break
        items = []
        for j in picked:
            t_from, t_to = float(beats[j.from_beat]), float(beats[j.to_beat])
            items.append(("current", t_from, t_to, j.xfade_ms, j.label, j.score))
        # Legacy anchor: the best-scored round-1 jump of this song, re-rendered with context.
        leg = [c for c in r1 if c["variant"] == "baseline" and c["song"].replace("\\", "/") == song]
        leg.sort(key=lambda c: -c["legacy_score"])
        if leg:
            ly, lsr = librosa.load(str(folder / song), mono=True, sr=None)
            _, fr = librosa.beat.beat_track(y=ly, sr=lsr, units="frames")
            lb = librosa.frames_to_time(fr, sr=lsr)
            c = leg[0]
            t_from = float(lb[min(c["src_beat"] + 1, len(lb) - 1)])
            t_to = float(lb[c["tgt_beat"]])
            label = f"{_place(b, t_from)} → {_place(b, t_to)}"
            items.append(("baseline", t_from, t_to, 30.0, label, c["legacy_score"]))
        for variant, t_from, t_to, xf, label, score in items:
            clip, seam_s = _seam_clip(y, OUT_SR, t_from, t_to, xf)
            mono = clip.mean(0)
            cid = secrets.token_hex(6)
            sf.write(out_dir / f"{cid}.wav", _normalise(clip.T, OUT_SR), OUT_SR, subtype="PCM_16")
            manifest["clips"].append({
                "id": cid, "kind": "jump", "round": 2, "song": song, "variant": variant,
                "seam_s": round(seam_s, 3), "duration_s": round(clip.shape[1] / OUT_SR, 3),
                "score": round(float(score), 4),
                "reveal": {"label": label, "from_s": round(t_from, 2), "to_s": round(t_to, 2),
                           "text": f"{label}  ({_mmss(t_from)} → {_mmss(t_to)} in the song, "
                                   f"{t_to - t_from:+.0f} s)"},
                "metrics": seam_metrics(mono, OUT_SR, seam_s, _beats(mono, OUT_SR)),
            })  # fmt: skip
        (out_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8"
        )
        log(f"[{i}/{len(songs)}] {song}: {len(items)} clips")
    return manifest


def _alternates(folder: Path, rel: str, limit: int = 3) -> list:
    """Other versions of the song's group with current-schema bundles: [(path, bundle, None)]."""
    from saics.schema import SCHEMA

    lib = json.loads((folder / ".saics" / "library.json").read_text("utf-8"))
    by_file = {t["file"]: t for t in lib["tracks"]}
    group = by_file[rel]["group"]
    out = []
    for t in lib["tracks"]:
        if t["group"] != group or t["file"] == rel:
            continue
        p = folder / ".saics" / "tracks" / f"{t['id']}.json"
        if json.loads(p.read_text("utf-8")).get("schema") == SCHEMA:
            out.append((folder / t["file"], _bundle_for(folder, t["file"]), None))
        if len(out) >= limit:
            break
    return out


FULL_TITLES = {
    "*Racing Into the Night*Split Audio*": (
        "YOASOBI - Racing into the Night (original, Japanese side of the split-audio file)"
    ),
}


def build_full(folder: Path, out_dir: Path, minutes: float = 7.0, seed: int = 0, log=print) -> dict:
    """P3 acceptance renders: one ~7-minute Forever version per FULL_SONGS entry."""
    from saics.render import render_forever, write_audio

    folder, out_dir = Path(folder), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"minutes": minutes, "renders": []}
    for pat, channel in FULL_SONGS:
        f = next(folder.glob(pat))
        rel = f.relative_to(folder).as_posix()
        b = _bundle_for(folder, rel)
        alts = _alternates(folder, rel)
        y, sr, jlog = render_forever(
            f, b, minutes, seed=seed, channel=channel, alternates=tuple(alts)
        )
        rid = secrets.token_hex(6)
        write_audio(out_dir / f"{rid}.mp3", y, sr)
        manifest["renders"].append({
            "id": rid, "song": rel, "channel": channel, "duration_s": round(y.shape[1] / sr, 2),
            "title": FULL_TITLES.get(pat, Path(rel).stem[:80]), "jumps": jlog,
            "loopable": b.loopable, "alternates": [str(p.relative_to(folder)) for p, _, _ in alts],
        })  # fmt: skip
        log(
            f"  {rel}: {y.shape[1] / sr / 60:.1f} min, "
            + "; ".join(
                f"{e['at_s']:.0f}s {e['from']}→{e['to']} [{e['kind']}/{e['why']}]" for e in jlog
            )
        )
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8"
    )
    return manifest


def build_round2b(folder: Path, eval_dir: Path, log=print) -> dict:
    """Only the affected seam clips: current jumps of the round-2 songs that are new or moved
    since round 2 (same 15 s context and reveal as round 2)."""
    folder, eval_dir = Path(folder), Path(eval_dir)
    r2 = json.loads((eval_dir / "round2" / "manifest.json").read_text("utf-8"))["clips"]
    out_dir = eval_dir / "round2b"
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"round": "2b", "context_s": ROUND2_CTX_S, "clips": []}
    songs = sorted({c["song"] for c in r2})
    for song in songs:
        b = _bundle_for(folder, song)
        beats = np.asarray(b.beats)
        old = [(c["reveal"]["from_s"], c["reveal"]["to_s"]) for c in r2
               if c["song"] == song and c["variant"] == "current"]  # fmt: skip
        new = []
        for j in b.jumps:
            tf, tt = float(beats[j.from_beat]), float(beats[j.to_beat])
            if not any(abs(tf - a) < 0.3 and abs(tt - c) < 0.3 for a, c in old):
                new.append((j, tf, tt))
        if not new:
            continue
        y = decode(folder / song, sr=OUT_SR, mono=False)
        y = np.stack([y, y]) if y.ndim == 1 else y
        for j, t_from, t_to in new:
            clip, seam_s = _seam_clip(y, OUT_SR, t_from, t_to, j.xfade_ms)
            mono = clip.mean(0)
            cid = secrets.token_hex(6)
            sf.write(out_dir / f"{cid}.wav", _normalise(clip.T, OUT_SR), OUT_SR, subtype="PCM_16")
            manifest["clips"].append({
                "id": cid, "kind": "jump", "round": "2b", "song": song, "variant": "current",
                "seam_s": round(seam_s, 3), "duration_s": round(clip.shape[1] / OUT_SR, 3),
                "score": j.score,
                "reveal": {"label": j.label, "from_s": round(t_from, 2), "to_s": round(t_to, 2),
                           "text": f"{j.label}  ({_mmss(t_from)} → {_mmss(t_to)} in the song, "
                                   f"{t_to - t_from:+.0f} s)"},
                "metrics": seam_metrics(mono, OUT_SR, seam_s, _beats(mono, OUT_SR)),
            })  # fmt: skip
        log(f"  {song}: {len(new)} new/moved jumps")
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8"
    )
    return manifest


def report_full(full_dir: Path, results_dir: Path) -> str:
    """Per render: overall rating, 'felt wrong' marks, and how many marks fall near a jump."""
    renders = json.loads((Path(full_dir) / "manifest.json").read_text("utf-8"))["renders"]
    ratings = {}
    for p in sorted(Path(results_dir).glob("full-*.json")):
        for r in json.loads(p.read_text("utf-8"))["ratings"]:
            ratings[r["render_id"]] = r  # latest rating wins
    rows = [
        "| song | jumps | overall | marks | marks within 5 s of a jump |",
        "|---|---|---|---|---|",
    ]
    overall = []
    for r in renders:
        q = ratings.get(r["id"])
        jt = [j["at_s"] for j in r["jumps"]]
        name = Path(r["song"]).stem[:50]
        if q:
            near = sum(1 for m in q["marks"] if any(abs(m - t) <= 5 for t in jt))
            overall.append(q["overall"])
            rows.append(f"| {name} | {len(jt)} | {q['overall']} | {len(q['marks'])} | {near} |")
        else:
            rows.append(f"| {name} | {len(jt)} | – | – | – |")
    if overall:
        rows.append(
            f"\nMean overall: **{np.mean(overall):.2f}** over {len(overall)} of {len(renders)} "
            "renders (target >= 4.0, none below 3)."
        )
    return "\n".join(rows)


def write_jump_feedback(folder: Path, eval_dir: Path, rater: str = "owner", log=print) -> int:
    """Seam ratings from round 2 onward (15 s context, real jumps) ->
    `<folder>/.saics/jump_feedback.csv` (5 -> keep, <= 2 -> ban)."""
    import csv as _csv

    man = {}
    for sub in ("round2", "round2b"):
        p = Path(eval_dir) / sub / "manifest.json"
        if p.exists():
            man.update({c["id"]: c for c in json.loads(p.read_text("utf-8"))["clips"]})
    rows = []
    for r in load_ratings(Path(eval_dir) / "results"):
        c = man.get(r["clip_id"])
        if not c or c["variant"] != "current" or r.get("rater", "owner") != rater:
            continue
        action = "keep" if r["rating"] == 5 else "ban" if r["rating"] <= 2 else None
        if action:
            rv = c["reveal"]
            rows.append([action, c["song"], rv["from_s"], rv["to_s"], rv["label"], r["rating"]])
    out = Path(folder) / ".saics" / "jump_feedback.csv"
    with out.open("w", encoding="utf-8", newline="") as f:
        f.write(
            "# action,file,from_s,to_s,label,rating (saics eval feedback; keep=always, ban=never)\n"
        )
        _csv.writer(f).writerows(rows)
    log(f"{len(rows)} jump feedback rows -> {out}")
    return len(rows)
