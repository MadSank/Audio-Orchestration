"""Forever analysis that can run on the phone: the reference for the app's Kotlin port.

Written against plain numpy so that every step has an exact Kotlin twin, with golden values in
`engine/tests/golden/lite.json`. Same bar grid, sections and jump finder as saics.analysis, except:

* beats from Beat This! `small0` through ONNX, not `final0`;
* chroma from an STFT, not a CQT;
* no Demucs: without a vocal stem the jump finder can't check that a sung line continues, so it
  asks for a stronger repeat instead (LITE_CTX_MEAN). The laptop's bundle replaces this one when
  the song is next analysed there.
"""

import numpy as np

from saics.jumps import BarInfo, find_jumps, outro_bar
from saics.structure import bar_slot_features, regularize_downbeats, sections_from_bars

BEAT_SR = 22050
BEAT_FFT = 1024
BEAT_HOP = 441
BEAT_FPS = 50
N_MELS = 128
F_MIN, F_MAX = 30.0, 11000.0
CHUNK = 1500
BORDER = 6

FEAT_FFT = 4096
FEAT_HOP = 512
N_MFCC = 14  # the first is dropped: 13 values, as saics.analysis
MFCC_MELS = 128
LITE_CTX_MEAN = 0.62


def halve(y44: np.ndarray) -> np.ndarray:
    """44.1 kHz -> 22.05 kHz with a Hann-windowed sinc low-pass (cheap, and easy to match)."""
    taps = 63
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(n * 0.45) * 0.45 * (0.5 + 0.5 * np.cos(2 * np.pi * n / (taps - 1)))
    h /= h.sum()
    return np.convolve(y44, h, mode="same")[::2].astype(np.float32)


def _hann(n: int) -> np.ndarray:
    return 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)  # periodic


def _stft_mag(y: np.ndarray, n_fft: int, hop: int) -> np.ndarray:
    """(frames, n_fft // 2 + 1): centred, reflect-padded, Hann window."""
    pad = n_fft // 2
    x = np.pad(y.astype(np.float64), pad, mode="reflect")
    frames = 1 + (len(x) - n_fft) // hop
    win = _hann(n_fft)
    out = np.empty((frames, n_fft // 2 + 1), np.float32)
    for i in range(frames):
        out[i] = np.abs(np.fft.rfft(x[i * hop : i * hop + n_fft] * win))
    return out


def _hz_to_mel(f):
    """Slaney's mel scale: linear below 1 kHz, log above."""
    f = np.asarray(f, float)
    return np.where(
        f < 1000, 3 * f / 200, 15 + 27 * np.log(np.maximum(f, 1e-9) / 1000) / np.log(6.4)
    )


def _mel_to_hz(m):
    m = np.asarray(m, float)
    return np.where(m < 15, 200 * m / 3, 1000 * 6.4 ** ((m - 15) / 27))


def mel_filters(n_fft: int, sr: int, n_mels: int, fmin: float, fmax: float) -> np.ndarray:
    """(n_mels, n_fft // 2 + 1) triangles, unnormalised (torchaudio's norm=None)."""
    freqs = np.arange(n_fft // 2 + 1) * sr / n_fft
    pts = _mel_to_hz(np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2))
    fb = np.zeros((n_mels, len(freqs)))
    for m in range(n_mels):
        lo, mid, hi = pts[m], pts[m + 1], pts[m + 2]
        up = (freqs - lo) / (mid - lo)
        down = (hi - freqs) / (hi - mid)
        fb[m] = np.maximum(0, np.minimum(up, down))
    return fb


def log_mel(y22: np.ndarray) -> np.ndarray:
    """Beat This!'s input, (frames, 128)."""
    mag = _stft_mag(y22, BEAT_FFT, BEAT_HOP) / np.sqrt(BEAT_FFT)
    fb = mel_filters(BEAT_FFT, BEAT_SR, N_MELS, F_MIN, F_MAX)
    return np.log1p(1000 * (mag @ fb.T)).astype(np.float32)


def chunk_starts(frames: int) -> list:
    """Where the model's chunks start: consecutive ones overlap by the discarded border."""
    starts = list(range(-BORDER, frames - BORDER, CHUNK - 2 * BORDER))
    if frames > CHUNK - 2 * BORDER:
        starts[-1] = frames - (CHUNK - BORDER)
    return starts


def frames_to_logits(spect: np.ndarray, run) -> tuple:
    """Run the model over a whole song; `run(chunk)` -> (beat, downbeat) logits for (T, 128).

    Overlaps keep the earlier chunk's prediction, as Beat This!'s keep_first."""
    n = len(spect)
    beat, down = np.full(n, -1000.0), np.full(n, -1000.0)
    for start in reversed(chunk_starts(n)):
        a, b = max(start, 0), min(start + CHUNK, n)
        left, right = max(0, -start), max(0, min(BORDER, start + CHUNK - n))
        x = np.pad(spect[a:b], ((left, right), (0, 0)))
        lb, ld = run(x)
        lo = start + BORDER
        m = len(lb) - 2 * BORDER
        idx = np.arange(lo, lo + m)
        keep = (idx >= 0) & (idx < n)
        beat[idx[keep]] = lb[BORDER : BORDER + m][keep]
        down[idx[keep]] = ld[BORDER : BORDER + m][keep]
    return beat, down


def _peaks(logits: np.ndarray) -> np.ndarray:
    """Frames of maxima within +-3 frames with logit > 0; adjacent ones merge to their mean."""
    n = len(logits)
    hits = [
        i
        for i in range(n)
        if logits[i] > 0 and logits[i] == logits[max(0, i - 3) : min(n, i + 4)].max()
    ]
    out: list = []
    run: list = []
    for i in hits:
        if run and i - run[-1] > 1:
            out.append(sum(run) / len(run))
            run = []
        run.append(i)
    if run:
        out.append(sum(run) / len(run))
    return np.array(out, float)


def beats_from_logits(beat: np.ndarray, down: np.ndarray) -> tuple:
    """(beat times, indices of the beats that are downbeats)."""
    b = _peaks(beat) / BEAT_FPS
    d = _peaks(down) / BEAT_FPS
    if len(b) == 0:
        return b, []
    idx = sorted({int(np.argmin(np.abs(b - t))) for t in d})
    return b, idx


# ── features ──────────────────────────────────────────────────────────────────


def chroma_filters() -> np.ndarray:
    """(12, bins): each STFT bin from 55 Hz to 5 kHz votes for its nearest pitch class."""
    freqs = np.arange(FEAT_FFT // 2 + 1) * BEAT_SR / FEAT_FFT
    fb = np.zeros((12, len(freqs)))
    for k, f in enumerate(freqs):
        if 55 <= f <= 5000:
            semis = 12 * np.log2(f / 440.0) + 9  # relative to C
            fb[int(np.round(semis)) % 12, k] = 1.0
    return fb


def _dct_matrix(n_out: int, n_in: int) -> np.ndarray:
    k = np.arange(n_out)[:, None]
    i = np.arange(n_in)[None, :]
    m = np.cos(np.pi * k * (2 * i + 1) / (2 * n_in)) * np.sqrt(2.0 / n_in)
    m[0] /= np.sqrt(2.0)
    return m


def beat_features(y22: np.ndarray, beats: np.ndarray) -> dict:
    """Per beat: chroma, MFCC1-13, onset strength and rms. Keys as saics.analysis uses them."""
    mag = _stft_mag(y22, FEAT_FFT, FEAT_HOP)
    power = mag**2
    chroma = power @ chroma_filters().T
    chroma = chroma / (chroma.max(axis=1, keepdims=True) + 1e-9)
    mel = power @ mel_filters(FEAT_FFT, BEAT_SR, MFCC_MELS, 0.0, BEAT_SR / 2).T
    logmel = 10 * np.log10(np.maximum(mel, 1e-10))
    mfcc = logmel @ _dct_matrix(N_MFCC, MFCC_MELS).T
    mfcc = mfcc[:, 1:]
    flux = np.r_[0.0, np.maximum(0.0, np.diff(logmel, axis=0)).mean(axis=1)]
    rms = np.sqrt(power.sum(axis=1)) / FEAT_FFT

    frames = np.round(np.asarray(beats) * BEAT_SR / FEAT_HOP).astype(int)
    edges = np.r_[np.clip(frames, 0, len(mag)), len(mag)]
    nb = len(beats)

    def sync(m: np.ndarray) -> np.ndarray:
        out = np.zeros((nb,) + m.shape[1:], np.float32)
        for i in range(nb):
            a, b = edges[i], edges[i + 1]
            if b > a:
                out[i] = m[a:b].mean(axis=0)
        return out

    return {"chroma": sync(chroma).T, "mfcc": sync(mfcc).T, "onset": sync(flux), "rms": sync(rms)}


def integrated_lufs(stereo44: np.ndarray) -> float:
    """BS.1770 integrated loudness of (2, n) at 44.1 kHz: K-weighting, -70 and -10 LU gates."""
    from scipy.signal import lfilter

    sos = (
        ([1.53084, -2.65010, 1.16927], [1.0, -1.66365, 0.71265]),  # high shelf at 44.1 kHz
        ([1.0, -2.0, 1.0], [1.0, -1.98916, 0.98919]),  # high pass
    )
    power = np.zeros(stereo44.shape[1])
    for ch in stereo44:
        x = ch.astype(np.float64)
        for b, a in sos:
            x = lfilter(b, a, x)
        power += x**2
    win, hop = int(0.4 * 44100), int(0.1 * 44100)
    if len(power) < win:
        return -70.0
    c = np.r_[0.0, np.cumsum(power)]
    blocks = (c[win:] - c[:-win])[::hop] / win
    loud = -0.691 + 10 * np.log10(blocks + 1e-12)
    keep = blocks[loud > -70.0]
    if len(keep) == 0:
        return -70.0
    rel = -0.691 + 10 * np.log10(keep.mean()) - 10.0
    keep = blocks[loud > max(rel, -70.0)]
    return float(-0.691 + 10 * np.log10(keep.mean())) if len(keep) else -70.0


# ── the whole analysis ────────────────────────────────────────────────────────


def analyse(y22: np.ndarray, duration: float, beats: np.ndarray, raw_down: list) -> dict:
    """Bundle fields from audio and a beat list."""
    if len(beats) < 8:
        return {"beats": beats, "downbeats": [], "sections": [], "jumps": [], "outro_bar": 0}
    f = beat_features(y22, beats)
    onset, chroma, mfcc, rms = f["onset"], f["chroma"], f["mfcc"], f["rms"]
    downbeats, bpb, conf = regularize_downbeats(raw_down, len(beats), onset)
    beat_feats = np.vstack([chroma, mfcc / 10.0, onset[None] / (onset.max() + 1e-9)])
    bars = bar_slot_features(beat_feats, downbeats)
    sections = sections_from_bars(bars) if len(bars) else []
    n = len(bars)
    spans = list(zip(downbeats[:-1], downbeats[1:], strict=True))[:n]
    bar_rms = np.array([rms[a:b].mean() for a, b in spans]) if n else np.zeros(0)
    ref = float(np.percentile(bar_rms, 95)) if n else 1.0
    energy = np.clip(bar_rms / (ref + 1e-9), 0, 1)
    bar_t = beats[downbeats[: n + 1]]
    if len(bar_t) == n:
        bar_t = np.r_[bar_t, duration]
    info = BarInfo(
        bar_t=bar_t, feats=bars, vocal_chroma=np.zeros((n, 12)), vocal=np.zeros(n),
        vocal_edge=np.zeros(n), energy=energy, duration=duration, downbeats=list(downbeats),
        beat_vchroma=np.zeros((12, len(beats))), beat_vonset=np.zeros(len(beats)),
        beat_chroma=chroma, beat_vocal=np.zeros(len(beats)),
    )  # fmt: skip
    jumps = find_jumps(info, sections, [], list(downbeats), ctx_mean=LITE_CTX_MEAN)
    return {
        "beats": beats, "downbeats": downbeats, "beats_per_bar": bpb, "meter_confidence": conf,
        "sections": sections, "jumps": jumps, "outro_bar": outro_bar(sections, n),
    }  # fmt: skip
