"""Deterministic test signal + fingerprints for the frozen version chains."""

import hashlib

import numpy as np

from saics import versions as v

SEED = 1234
DURATION_S = 10.0
RATES = (44100, 48000)

# Same dispatch as versions.render_audio_version, minus file I/O and MP3 export.
CHAINS = {
    "normal": lambda y, sr: y,
    "sped_up": lambda y, sr: v._apply_speed_change(y, sr, factor=1.25),
    "8d_audio": v._apply_8d_audio,
    "lofi_vhs": v._apply_lofi_vhs,
    "slowed_reverb": v._apply_slowed_reverb,
    "nightcore": v._apply_nightcore,
    "bass_boost": v._apply_bass_boost,
    "vinyl_crackle": v._apply_vinyl_crackle,
    "underwater": v._apply_underwater,
}


def test_signal(sr: int) -> np.ndarray:
    """10 s stereo: L = log sine sweep 50 Hz-12 kHz, R = 120 BPM clicks + noise burst."""
    n = int(DURATION_S * sr)
    t = np.arange(n) / sr
    f0, f1 = 50.0, 12000.0
    k = np.log(f1 / f0) / DURATION_S
    left = 0.4 * np.sin(2 * np.pi * f0 * (np.exp(k * t) - 1) / k)
    right = np.zeros(n)
    click = np.hanning(int(0.004 * sr))
    for start in range(0, n - len(click), int(0.5 * sr)):
        right[start : start + len(click)] += 0.8 * click
    rng = np.random.default_rng(0)
    b0, b1 = int(5 * sr), int(6 * sr)
    right[b0:b1] += 0.2 * rng.standard_normal(b1 - b0)
    return np.stack([left, right]).astype(np.float32)


def render(mode: str, sr: int) -> np.ndarray:
    np.random.seed(SEED)
    out = CHAINS[mode](test_signal(sr), sr)
    return v._normalize(np.asarray(out, dtype=np.float32), target_db=-1.0)


def exact_hash(y: np.ndarray) -> str:
    """SHA-256 of the output quantised to 1e-5 (robust to last-bit float noise)."""
    q = np.round(np.asarray(y, dtype=np.float64) * 1e5).astype(np.int64)
    return hashlib.sha256(q.tobytes() + str(q.shape).encode()).hexdigest()


def band_fingerprint(y: np.ndarray, sr: int) -> list:
    """Per channel, per 1 s frame: energy (dB) in 1/3-octave bands 25 Hz-16 kHz."""
    centres = 1000.0 * 2.0 ** (np.arange(-16, 13) / 3.0)
    lo, hi = centres * 2 ** (-1 / 6), centres * 2 ** (1 / 6)
    frame = sr
    out = []
    for ch in np.atleast_2d(y):
        rows = []
        for s in range(0, len(ch) - frame + 1, frame):
            spec = np.abs(np.fft.rfft(ch[s : s + frame] * np.hanning(frame))) ** 2
            freqs = np.fft.rfftfreq(frame, 1 / sr)
            rows.append(
                [
                    round(float(10 * np.log10(spec[(freqs >= a) & (freqs < b)].sum() + 1e-12)), 3)
                    for a, b in zip(lo, hi, strict=True)
                ]
            )
        out.append(rows)
    return out
