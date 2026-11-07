"""Offline renderer: play a list of (start, end) sample segments back to back.

Contiguous runs are copied untouched; an equal-power crossfade is applied only where the
path actually jumps (fixes D8, where every beat boundary got a broken crossfade).
The crossfade is centred on the seam: the outgoing segment runs on for half the fade and
the incoming one starts half the fade early, so the beat grid is preserved exactly.
"""

import numpy as np

from saics.seams import GLIDE_BARS


def equal_power(n: int, rho: float = 0.0) -> tuple:
    """(fade_out, fade_in) keeping the summed power constant for signals with correlation rho.

    rho = 0: the classic equal-power pair (fo**2 + fi**2 == 1).
    rho = 1 (identical, in-phase audio, i.e. a good jump seam): fo + fi == 1, no +3 dB bump.
    """
    t = (np.arange(n) + 0.5) / n
    th = t * np.pi / 2
    fo, fi = np.cos(th), np.sin(th)
    norm = np.sqrt(1.0 + float(np.clip(rho, 0.0, 1.0)) * np.sin(2 * th))
    return (fo / norm).astype(np.float32), (fi / norm).astype(np.float32)


def merge_contiguous(segments: list) -> list:
    """Join segments where one ends exactly where the next starts (no jump between them)."""
    out = []
    for a, b in segments:
        if out and out[-1][1] == a:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def render_segments(y: np.ndarray, segments: list, sr: int, xfade_ms: float = 30.0) -> tuple:
    """Render segments of `y` (shape (n,) or (ch, n)).

    Returns (audio, seams) where seams are the output sample positions of each jump.
    Output length == sum of segment lengths."""
    mono = y.ndim == 1
    x = y[None] if mono else y
    n_total = x.shape[1]
    segs = merge_contiguous([(int(a), int(b)) for a, b in segments if b > a])
    out = np.zeros((x.shape[0], sum(b - a for a, b in segs)), np.float32)
    seams, pos = [], 0
    half = int(round(xfade_ms / 1000 * sr / 2))
    for k, (a, b) in enumerate(segs):
        out[:, pos : pos + b - a] = x[:, a:b]
        if k > 0 and half > 0:
            pa, pb = segs[k - 1]
            # Room on both sides of the seam in the source audio.
            h = min(half, b - a, pb - pa, n_total - pb, a)
            if h > 0:
                tail = x[:, pb - h : pb + h]  # outgoing audio continuing past its end
                head = x[:, a - h : a + h]  # incoming audio starting early
                den = float(np.sqrt(np.sum(tail**2) * np.sum(head**2))) + 1e-12
                fo, fi = equal_power(2 * h, rho=float(np.sum(tail * head)) / den)
                out[:, pos - h : pos + h] = tail * fo + head * fi
        if k > 0:
            seams.append(pos)
        pos += b - a
    return (out[0] if mono else out), seams


def _flush(y: np.ndarray, run: list, pieces: list, sr: int) -> float:
    """Render the pending segments of `y` into `pieces`; returns the seconds produced."""
    if not run:
        return 0.0
    audio, _ = render_segments(y, list(run), sr, xfade_ms=30.0)
    pieces.append(audio)
    run.clear()
    return audio.shape[1] / sr


def _bar_times(bundle, n_samples: int, sr: int) -> np.ndarray:
    """Bar start times; the last bar runs to the true end of the audio (outros finish)."""
    beats = np.asarray(bundle.beats)
    n_bars = len(bundle.downbeats) - 1
    bar_t = np.r_[beats[bundle.downbeats[: n_bars + 1]]]
    bar_t[-1] = n_samples / sr
    return bar_t


def render_forever(audio_path, bundle, minutes: float, seed: int = 0, channel: int | None = None,
                   sr: int = 44100, alternates: tuple = ()) -> tuple:  # fmt: skip
    """Offline Forever render: (audio (2, n) float32, sr, log).

    Follows the bundle's structural jumps with the P3 pacing and ending rules
    (`jumps.forever_path`). `alternates` = [(path, bundle, channel)] other versions of the
    song group, used when the ending can't be avoided (owner's (c)); without them the song
    repeats with a short gap (d). channel=0/1 renders one input channel to both outputs."""
    from pathlib import Path

    from saics.io import decode
    from saics.jumps import forever_path

    def load(path, ch):
        y = decode(path, sr=sr, mono=False)
        y = np.stack([y, y]) if y.ndim == 1 else y
        return (np.stack([y[ch], y[ch]]) if ch is not None else y).astype(np.float32)

    queue = [(audio_path, bundle, channel), *alternates]
    pieces, log, t_out, k = [], [], 0.0, 0
    remaining = minutes * 60.0
    while remaining > 1.0:
        path, b, ch = queue[k % len(queue)]
        y = load(path, ch)
        bar_t = _bar_times(b, y.shape[1], sr)
        others = len(queue) > 1
        segs_s, wlog = forever_path(bar_t, b.sections, b.jumps, remaining / 60, seed=seed + k,
                                    outro=b.outro_bar or None, loopable=b.loopable,
                                    has_versions=others)  # fmt: skip
        run: list = []
        switched = False
        produced = 0.0
        for seg in segs_s:
            if seg[0] == "gap":
                produced += _flush(y, run, pieces, sr)
                pieces.append(np.zeros((2, int(seg[1] * sr)), np.float32))
                produced += seg[1]
            elif seg[0] == "switch":
                switched = True
            else:
                run.append((int(seg[0] * sr), int(seg[1] * sr)))
        produced += _flush(y, run, pieces, sr)
        for e in wlog:
            log.append({**e, "at_s": round(e["at_s"] + t_out, 2), "song": Path(str(path)).name})
        t_out += produced
        remaining -= produced
        if not switched:
            break
        k += 1
    out = np.concatenate(pieces, axis=1) if pieces else np.zeros((2, 0), np.float32)
    return out[:, : int(minutes * 60 * sr)], sr, log


def write_audio(path, y: np.ndarray, sr: int, lufs: float = -14.0) -> None:
    """Loudness-normalise and write WAV or MP3 (320k via ffmpeg) depending on the suffix."""
    import subprocess
    import tempfile
    from pathlib import Path

    import pyloudnorm as pyln
    import soundfile as sf

    x = y.T if y.ndim == 2 else y
    cur = pyln.Meter(sr).integrated_loudness(x)
    if np.isfinite(cur):
        x = x * 10 ** ((lufs - cur) / 20)
    pk = float(np.abs(x).max())
    if pk > 0.98:
        x = x / pk * 0.98
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".mp3":
        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "x.wav"
            sf.write(wav, x.astype(np.float32), sr, subtype="PCM_16")
            cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-b:a", "320k", str(path)]
            subprocess.run(cmd, check=True)
    else:
        sf.write(path, x.astype(np.float32), sr, subtype="PCM_16")


# ── P4a: rendering a walk across songs ──────────────────────────────────────────


def join_seam(pieces: list, prev: tuple, next_: tuple, half: int) -> None:
    """Append the crossfaded seam between two (audio, end/start sample) sides to `pieces`.

    Centred on the seam as in render_segments: the outgoing audio runs on `half` samples past
    its end, the incoming starts `half` samples early (correlation-aware equal power)."""
    ya, pb = prev
    yb, a = next_
    h = min(half, ya.shape[1] - pb, pb, a, yb.shape[1] - a)
    if h <= 0:
        return
    tail, head = ya[:, pb - h : pb + h], yb[:, a - h : a + h]
    den = float(np.sqrt(np.sum(tail**2) * np.sum(head**2))) + 1e-12
    fo, fi = equal_power(2 * h, rho=float(np.sum(tail * head)) / den)
    pieces.append(tail * fo + head * fi)


def trim_envelope(n: int, seams: list) -> np.ndarray:
    """Gain over `n` output samples from landing trims: (seam sample, half crossfade, trim dB,
    glide samples). The gain ramps to the trim across the crossfade, then glides back to 0 dB; a
    later move replaces whatever glide is still running."""
    db = np.zeros(n, np.float32)
    for at, h, trim, glide in seams:
        a, b = max(0, at - h), min(n, at + h)
        start = float(db[a]) if a < n else 0.0
        db[a:] = 0.0
        db[a:b] = np.linspace(start, trim, b - a, endpoint=False)
        end = min(n, b + glide)
        if end > b:
            db[b:end] = np.linspace(trim, 0.0, glide, endpoint=False)[: end - b]
    return 10 ** (db / 20)


def portal_join(
    ya: np.ndarray, pb: int, yb: np.ndarray, a: int, ctx: int, trim_db: float, glide: int, sr: int,
    xfade_ms: float = 30.0,
) -> tuple:  # fmt: skip
    """`ctx` samples of A up to the seam + `ctx` of B from the landing, joined by the plain short
    crossfade, with B carrying the landing trim. Returns (audio, seam sample)."""
    s = pb - max(0, pb - ctx)
    n = s + min(yb.shape[1] - a, ctx)

    def side(y, at):  # the song on the clip's timeline, zero where it has run out
        lo = at - s
        out = np.zeros((2, n), np.float32)
        i0, i1 = max(0, lo), min(y.shape[1], lo + n)
        out[:, i0 - lo : i1 - lo] = y[:, i0:i1]
        return out

    ta, tb = side(ya, pb), side(yb, a)
    tb = tb * trim_envelope(n, [(s, 0, trim_db, glide)])
    if trim_db:
        tb[:, :s] *= float(10 ** (trim_db / 20))  # the overlap before the seam: at the trim too
    half = int(round(xfade_ms / 1000 * sr / 2))
    window = (ta[:, s - half : s + half], tb[:, s - half : s + half])
    den = float(np.sqrt(np.sum(window[0] ** 2) * np.sum(window[1] ** 2))) + 1e-12
    rho = float(np.sum(window[0] * window[1])) / den
    fo, fi = np.ones(n), np.zeros(n)
    fo[s - half : s + half], fi[s - half : s + half] = equal_power(2 * half, rho=rho)
    fo[s + half :], fi[s + half :] = 0.0, 1.0
    return (ta * fo + tb * fi).astype(np.float32), s


def render_walk(
    segments: list, tracks: dict, sr: int = 44100, xfade_ms: float = 30.0
) -> np.ndarray:
    """Render saics.mixwalk.walk_path segments to stereo audio at each song's gain_db.

    tracks: id -> (path, gain_db, bar_times(n_samples) -> seconds per bar). Decoded songs are
    cached while they may still be needed (a walk can come back through a portal). The landing
    shift moves the seam in the incoming song and the early shift moves it in both; the trim is
    applied on the finished output, as the phone's renderer does."""
    from saics.io import decode

    cache: dict = {}

    def load(tid):
        if tid not in cache:
            path, gain, _ = tracks[tid]
            y = decode(path, sr=sr, mono=False)
            y = np.stack([y, y]) if y.ndim == 1 else y
            if len(cache) >= 4:
                cache.pop(next(iter(cache)))
            cache[tid] = y.astype(np.float32) * float(10 ** (gain / 20))
        return cache[tid]

    half = int(round(xfade_ms / 1000 * sr / 2))
    pieces: list = []
    prev = None  # (audio, end sample) of the previous segment
    seams: list = []
    for seg in segments:
        if seg[0] == "gap":
            if prev is not None:
                pieces.append(prev[0][:, prev[2] : prev[1]])
            pieces.append(np.zeros((2, int(seg[1] * sr)), np.float32))
            prev = None
            continue
        tid, s, e, *seam = seg
        y = load(tid)
        bt = tracks[tid][2](y.shape[1])
        a = 0 if s == 0 else int(bt[s] * sr)  # bar 0 = the top of the song, pickup included
        early = int(round(seam[2] / 1000 * sr)) if len(seam) > 2 and s > 0 else 0
        if seam and s > 0:
            a = max(0, a + int(round(seam[0] / 1000 * sr)) + early)
        b = int(bt[min(e, len(bt) - 1)] * sr)
        h = half if prev is not None else 0
        if prev is not None:
            leave = prev[1] + early
            pieces.append(prev[0][:, prev[2] : leave - h])
            before = len(pieces)
            join_seam(pieces, (prev[0], leave), (y, a), half)
            if len(pieces) == before:  # no room for a crossfade
                pieces.append(prev[0][:, leave - h : leave])
                h = 0
        if seam:
            at = sum(p.shape[1] for p in pieces) - h
            glide = int((bt[min(s + GLIDE_BARS, len(bt) - 1)] - bt[s]) * sr)
            seams.append((at, h, seam[1], glide))
        prev = (y, b, a + h)
    if prev is not None:
        pieces.append(prev[0][:, prev[2] : prev[1]])
    out = np.concatenate(pieces, axis=1) if pieces else np.zeros((2, 0), np.float32)
    return out * trim_envelope(out.shape[1], seams) if seams else out
