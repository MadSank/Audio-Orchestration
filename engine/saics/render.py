"""Offline renderer: play a list of (start, end) sample segments back to back.

Contiguous runs are copied untouched; an equal-power crossfade is applied only where the
path actually jumps (fixes D8, where every beat boundary got a broken crossfade).
The crossfade is centred on the seam: the outgoing segment runs on for half the fade and
the incoming one starts half the fade early, so the beat grid is preserved exactly.
"""

import numpy as np


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


def render_forever(audio_path, bundle, minutes: float, seed: int = 0, channel: int | None = None,
                   sr: int = 44100) -> tuple:  # fmt: skip
    """Offline Forever render of one song: (audio (2, n) float32, sr, jump log).

    Follows the bundle's structural jumps with the P3 pacing rules (`jumps.forever_path`).
    channel=0/1 renders a single input channel to both outputs (e.g. one side of a
    split-language file)."""
    from saics.io import decode
    from saics.jumps import forever_path

    y = decode(audio_path, sr=sr, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    if channel is not None:
        y = np.stack([y[channel], y[channel]])
    beats = np.asarray(bundle.beats)
    n_bars = len(bundle.downbeats) - 1
    bar_t = np.r_[beats[bundle.downbeats[: n_bars + 1]]]
    bar_t[-1] = min(bar_t[-1], y.shape[1] / sr)
    segs_s, log = forever_path(bar_t, bundle.sections, bundle.jumps, minutes, seed=seed)
    segs = [(int(a * sr), int(b * sr)) for a, b in segs_s]
    out, seams = render_segments(y.astype(np.float32), segs, sr, xfade_ms=30.0)
    for entry, seam in zip(log, seams, strict=False):
        entry["at_s"] = round(seam / sr, 2)  # exact output time of each jump
    return out, sr, log


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
