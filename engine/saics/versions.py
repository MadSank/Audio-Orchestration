"""
version_renderer.py — SAICS Server-Side Audio Version Renderer
================================================================
Renders audio files with DSP effect chains at full quality,
then exports as 320 kbps MP3.

Modes: normal, sped_up, 8d_audio, lofi_vhs, slowed_reverb,
       nightcore, bass_boost, vinyl_crackle, underwater
"""

import os, tempfile, logging
import numpy as np
import librosa
import soundfile as sf
from scipy import signal as scipy_signal
from scipy.signal import sosfilt, sosfilt_zi, butter, lfilter

log = logging.getLogger("saics.renderer")

VALID_MODES = [
    "normal", "sped_up", "8d_audio", "lofi_vhs", "slowed_reverb",
    "nightcore", "bass_boost", "vinyl_crackle", "underwater",
]


def render_audio_version(filepath: str, mode: str) -> str:
    """
    Render a full-quality version of the audio file with the given mode's
    DSP chain applied. Returns path to a 320 kbps MP3 file.

    Parameters
    ----------
    filepath : str
        Path to the input audio file.
    mode : str
        One of VALID_MODES.

    Returns
    -------
    str
        Path to the output MP3 file.
    """
    if mode not in VALID_MODES:
        raise ValueError(f"Unknown mode: {mode!r}. Valid: {VALID_MODES}")

    # Load at native sample rate for maximum quality
    y, sr = librosa.load(filepath, mono=False, sr=None)

    # librosa returns (n_channels, n_samples) for stereo, (n_samples,) for mono
    is_mono = y.ndim == 1
    if is_mono:
        y = y[np.newaxis, :]  # shape: (1, n_samples)

    log.info("Rendering mode=%s | sr=%d | channels=%d | duration=%.1fs",
             mode, sr, y.shape[0], y.shape[1] / sr)

    # Apply DSP chain
    if mode == "normal":
        out = y
    elif mode == "sped_up":
        out = _apply_speed_change(y, sr, factor=1.25)
    elif mode == "8d_audio":
        out = _apply_8d_audio(y, sr)
    elif mode == "lofi_vhs":
        out = _apply_lofi_vhs(y, sr)
    elif mode == "slowed_reverb":
        out = _apply_slowed_reverb(y, sr)
    elif mode == "nightcore":
        out = _apply_nightcore(y, sr)
    elif mode == "bass_boost":
        out = _apply_bass_boost(y, sr)
    elif mode == "vinyl_crackle":
        out = _apply_vinyl_crackle(y, sr)
    elif mode == "underwater":
        out = _apply_underwater(y, sr)
    else:
        out = y

    # Normalize to -1 dB headroom
    out = _normalize(out, target_db=-1.0)

    # Write to temp WAV first
    wav_fd, wav_path = tempfile.mkstemp(suffix=".wav", prefix="saics_ver_")
    os.close(wav_fd)

    # Transpose for soundfile: (channels, samples) -> (samples, channels)
    if out.shape[0] == 1:
        sf.write(wav_path, out[0], sr, subtype="PCM_16")
    else:
        sf.write(wav_path, out.T, sr, subtype="PCM_16")

    # Convert to 320 kbps MP3 via pydub
    mp3_path = _wav_to_mp3(wav_path, bitrate="320k")

    # Clean up intermediate WAV
    try:
        os.remove(wav_path)
    except OSError:
        pass

    log.info("Rendered: %s (%.1f KB)", mp3_path, os.path.getsize(mp3_path) / 1024)
    return mp3_path


# ── DSP Chains ────────────────────────────────────────────────────────


def _apply_speed_change(y: np.ndarray, sr: int, factor: float) -> np.ndarray:
    """Varispeed: resample so playback is `factor`x faster (pitch changes with speed)."""
    return librosa.resample(y, orig_sr=sr, target_sr=int(sr / factor), axis=-1)


def _apply_8d_audio(y: np.ndarray, sr: int) -> np.ndarray:
    """
    8D Audio: Sinusoidal panning LFO that modulates stereo balance
    over a 10-second period, plus a lush reverb tail.
    """
    # Mix down to mono for panning source
    mono = y.mean(axis=0) if y.shape[0] > 1 else y[0]
    n = len(mono)

    # Sinusoidal panning LFO — 10-second period (0.1 Hz)
    lfo_freq = 0.1  # Hz — full rotation every 10 seconds
    t = np.arange(n, dtype=np.float64) / sr
    pan = np.sin(2 * np.pi * lfo_freq * t)  # range [-1, 1]

    # Constant-power panning law
    # pan=-1 → full left, pan=+1 → full right
    angle = (pan + 1) * 0.5 * (np.pi / 2)  # [0, π/2]
    left_gain = np.cos(angle).astype(np.float32)
    right_gain = np.sin(angle).astype(np.float32)

    left = mono * left_gain
    right = mono * right_gain

    # Add reverb (algorithmic Schroeder reverb)
    reverbed_l = _schroeder_reverb(left, sr, decay=0.6, mix=0.35)
    reverbed_r = _schroeder_reverb(right, sr, decay=0.6, mix=0.35)

    return np.stack([reverbed_l, reverbed_r])


def _apply_lofi_vhs(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Lofi VHS: 0.92× speed, warm low-pass at 3.5kHz, gentle tape
    saturation for harmonic warmth, and slow wow/flutter vibrato.
    """
    # Speed down to 0.92×
    y_slow = librosa.resample(y, orig_sr=sr, target_sr=int(sr / 0.92), axis=-1)

    out_channels = []
    for ch in range(y_slow.shape[0]):
        signal = y_slow[ch].copy()
        nyq = sr / 2.0

        # Low-pass filter at 3.5kHz — 3rd-order Butterworth
        # Preserves instrument body while removing digital harshness
        cutoff = min(3500.0, nyq * 0.95)
        sos = butter(3, cutoff / nyq, btype='low', output='sos')
        signal = sosfilt(sos, signal).astype(np.float32)

        # Gentle tape saturation (tanh soft-clip with mild drive)
        # This adds harmonic warmth without destroying the signal
        drive = 1.8
        signal = np.tanh(signal * drive) / np.tanh(drive)

        # Wow/flutter: slow VHS-style pitch wobble (2 Hz, ±1ms depth)
        signal = _apply_vibrato(signal, sr, rate_hz=2.0, depth_ms=1.0)

        out_channels.append(signal)

    return np.stack(out_channels)


def _apply_slowed_reverb(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Slowed + Reverb: 0.8× speed with a lush, large reverb tail
    and subtle chorus for width.
    """
    # Speed down to 0.8×
    y_slow = librosa.resample(y, orig_sr=sr, target_sr=int(sr / 0.8), axis=-1)

    out_channels = []
    for ch in range(y_slow.shape[0]):
        signal = y_slow[ch]

        # Large reverb (room size 0.7 equivalent)
        signal = _schroeder_reverb(signal, sr, decay=0.7, mix=0.4)

        # Subtle chorus: delayed copy with slow modulation
        signal = _apply_chorus(signal, sr, rate_hz=0.8, depth_ms=4.0, mix=0.25)

        out_channels.append(signal)

    return np.stack(out_channels)


def _apply_nightcore(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Nightcore: 1.3× speed + pitch shift up ~4 semitones.
    Speed increase naturally raises pitch; we tune it to hit +4 semitones total.
    """
    # 1.3× speed via resample (raises pitch by ~+4.5 semitones naturally)
    # cents = 1200 * log2(1.3) ≈ 454 cents ≈ 3.78 semitones
    # Close enough to +4 semitones — we'll use 1.3× directly
    out = librosa.resample(y, orig_sr=sr, target_sr=int(sr / 1.3), axis=-1)

    # Slight high-shelf boost for that airy nightcore shimmer
    for ch in range(out.shape[0]):
        nyq = sr / 2.0
        # High-shelf via high-pass + blend
        cutoff = min(6000.0, nyq * 0.9)
        sos = butter(2, cutoff / nyq, btype='high', output='sos')
        highs = sosfilt(sos, out[ch]).astype(np.float32)
        out[ch] = out[ch] + highs * 0.15  # subtle brightness

    return out


def _apply_bass_boost(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Bass Boost: Low-shelf +12dB at 80Hz with soft-knee limiter.
    """
    out_channels = []
    for ch in range(y.shape[0]):
        signal = y[ch].copy()
        nyq = sr / 2.0

        # Extract low frequencies (below 80Hz) with 4th-order Butterworth
        cutoff = min(80.0, nyq * 0.9)
        sos_lo = butter(4, cutoff / nyq, btype='low', output='sos')
        lows = sosfilt(sos_lo, signal).astype(np.float32)

        # +12dB boost = 10^(12/20) ≈ 3.98× gain on the low end
        boost = 10 ** (12.0 / 20.0)
        signal = signal + lows * (boost - 1.0)

        # Sub-bass emphasis: additional gentle boost at 40Hz
        cutoff_sub = min(40.0, nyq * 0.9)
        sos_sub = butter(2, cutoff_sub / nyq, btype='low', output='sos')
        subs = sosfilt(sos_sub, y[ch]).astype(np.float32)
        signal = signal + subs * 1.5

        # Soft-knee limiter to prevent clipping
        signal = _soft_clip(signal, threshold=0.85)

        out_channels.append(signal)

    return np.stack(out_channels)


def _apply_vinyl_crackle(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Vinyl Crackle: Band-pass warmth filter, pink noise crackle overlay,
    and subtle wow/flutter modulation for vintage turntable feel.
    """
    out_channels = []
    for ch in range(y.shape[0]):
        signal = y[ch].copy()
        n = len(signal)
        nyq = sr / 2.0

        # Band-pass: 200Hz – 8kHz for vinyl warmth
        lo = min(200.0, nyq * 0.9)
        hi = min(8000.0, nyq * 0.9)
        sos_bp = butter(3, [lo / nyq, hi / nyq], btype='band', output='sos')
        filtered = sosfilt(sos_bp, signal).astype(np.float32)

        # Blend: 70% filtered + 30% original (keep some body)
        signal = 0.7 * filtered + 0.3 * signal

        # Pink noise crackle layer
        crackle = _generate_vinyl_crackle(n, sr)
        signal = signal + crackle * 0.03  # subtle crackle

        # Wow/flutter: very slow pitch modulation (0.5 Hz, ±1.5ms)
        signal = _apply_vibrato(signal, sr, rate_hz=0.5, depth_ms=1.5)

        # Gentle low-pass at 12kHz to soften digital edges
        cutoff = min(12000.0, nyq * 0.95)
        sos_lp = butter(2, cutoff / nyq, btype='low', output='sos')
        signal = sosfilt(sos_lp, signal).astype(np.float32)

        out_channels.append(signal)

    return np.stack(out_channels)


def _apply_underwater(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Underwater: 4th-order Butterworth low-pass at 400Hz with a slow
    modulated cutoff, plus a washy reverb tail.

    The filter is a precise 4th-order Butterworth implemented via
    second-order sections (SOS) for numerical stability.
    """
    out_channels = []
    for ch in range(y.shape[0]):
        signal = y[ch].copy()
        n = len(signal)
        nyq = sr / 2.0

        # ── Modulated low-pass filter ──
        # Base cutoff at 400Hz, modulated ±200Hz by a 0.15Hz LFO
        # We process in overlapping blocks to smoothly vary the cutoff
        block_size = int(sr * 0.05)  # 50ms blocks
        num_blocks = (n + block_size - 1) // block_size
        out_signal = np.zeros_like(signal)

        t_blocks = np.arange(num_blocks) * block_size / sr
        lfo = np.sin(2 * np.pi * 0.15 * t_blocks)  # 0.15 Hz modulation
        cutoffs = 400.0 + 200.0 * lfo  # range: 200–600 Hz

        zi = None
        for i in range(num_blocks):
            start = i * block_size
            end = min(start + block_size, n)
            block = signal[start:end]

            # 4th-order Butterworth low-pass — SOS form
            fc = np.clip(cutoffs[i], 20.0, nyq * 0.95)
            sos = butter(4, fc / nyq, btype='low', output='sos')

            if zi is None:
                zi = sosfilt_zi(sos) * block[0]

            filtered_block, zi = sosfilt(sos, block, zi=zi)
            out_signal[start:end] = filtered_block

        # ── Washy reverb tail ──
        out_signal = _schroeder_reverb(out_signal, sr, decay=0.75, mix=0.5)

        # ── Subtle pitch wobble for immersion ──
        out_signal = _apply_vibrato(out_signal, sr, rate_hz=0.3, depth_ms=3.0)

        out_channels.append(out_signal.astype(np.float32))

    return np.stack(out_channels)


# ── DSP Utilities ────────────────────────────────────────────────────


def _schroeder_reverb(signal: np.ndarray, sr: int,
                      decay: float = 0.5, mix: float = 0.3) -> np.ndarray:
    """
    Simple Schroeder reverb using 4 parallel comb filters + 2 allpass filters.
    Provides a lush, diffuse tail suitable for music processing.
    """
    # Comb filter delay times (in ms) — prime-ish ratios for density
    comb_delays_ms = [29.7, 37.1, 41.1, 43.7]
    # Allpass delay times
    ap_delays_ms = [5.0, 1.7]

    out = np.zeros_like(signal, dtype=np.float64)

    # Parallel comb filters
    for delay_ms in comb_delays_ms:
        delay_samples = int(delay_ms * sr / 1000.0)
        g = decay ** (delay_ms / 50.0)  # feedback gain scaled to delay
        comb_out = np.zeros_like(signal, dtype=np.float64)
        buf = np.zeros(delay_samples, dtype=np.float64)
        wp = 0
        for i in range(len(signal)):
            delayed = buf[wp]
            comb_out[i] = delayed
            buf[wp] = signal[i] + delayed * g
            wp = (wp + 1) % delay_samples
        out += comb_out

    out /= len(comb_delays_ms)

    # Series allpass filters for diffusion
    for delay_ms in ap_delays_ms:
        delay_samples = max(1, int(delay_ms * sr / 1000.0))
        g = 0.7
        buf = np.zeros(delay_samples, dtype=np.float64)
        wp = 0
        for i in range(len(out)):
            delayed = buf[wp]
            inp = out[i]
            buf[wp] = inp + delayed * g
            out[i] = delayed - inp * g
            wp = (wp + 1) % delay_samples

    # Wet/dry mix
    result = (1.0 - mix) * signal.astype(np.float64) + mix * out
    return result.astype(np.float32)


def _apply_vibrato(signal: np.ndarray, sr: int,
                   rate_hz: float = 5.0, depth_ms: float = 2.0) -> np.ndarray:
    """Vibrato via modulated fractional delay line."""
    n = len(signal)
    depth_samples = depth_ms * sr / 1000.0
    t = np.arange(n, dtype=np.float64) / sr
    mod = depth_samples * np.sin(2 * np.pi * rate_hz * t)

    indices = np.arange(n, dtype=np.float64) - mod
    indices = np.clip(indices, 0, n - 1)

    # Linear interpolation
    idx_floor = np.floor(indices).astype(int)
    idx_ceil = np.minimum(idx_floor + 1, n - 1)
    frac = (indices - idx_floor).astype(np.float32)

    return signal[idx_floor] * (1 - frac) + signal[idx_ceil] * frac


def _apply_chorus(signal: np.ndarray, sr: int,
                  rate_hz: float = 0.8, depth_ms: float = 4.0,
                  mix: float = 0.3) -> np.ndarray:
    """Chorus effect via modulated delay mixed with dry signal."""
    delayed = _apply_vibrato(signal, sr, rate_hz=rate_hz, depth_ms=depth_ms)
    return (1 - mix) * signal + mix * delayed


def _generate_vinyl_crackle(n_samples: int, sr: int) -> np.ndarray:
    """
    Generate realistic vinyl crackle noise:
    sparse impulses + filtered noise bursts.
    """
    crackle = np.zeros(n_samples, dtype=np.float32)

    # Random sparse pops (about 8 per second)
    n_pops = int(8 * n_samples / sr)
    pop_positions = np.random.randint(0, n_samples, size=n_pops)
    pop_amplitudes = np.random.exponential(0.5, size=n_pops).astype(np.float32)
    pop_amplitudes = np.clip(pop_amplitudes, 0, 1)

    for pos, amp in zip(pop_positions, pop_amplitudes):
        # Short burst (0.5–2ms)
        burst_len = int(np.random.uniform(0.0005, 0.002) * sr)
        end = min(pos + burst_len, n_samples)
        burst = np.random.randn(end - pos).astype(np.float32) * amp
        # Apply envelope
        env = np.linspace(1, 0, len(burst), dtype=np.float32)
        crackle[pos:end] += burst * env

    # Continuous low-level hiss (filtered white noise)
    hiss = np.random.randn(n_samples).astype(np.float32) * 0.08
    nyq = sr / 2.0
    lo = min(800.0, nyq * 0.9)
    hi = min(5000.0, nyq * 0.9)
    sos = butter(2, [lo / nyq, hi / nyq], btype='band', output='sos')
    hiss = sosfilt(sos, hiss).astype(np.float32)

    return crackle + hiss


def _soft_clip(signal: np.ndarray, threshold: float = 0.85) -> np.ndarray:
    """Soft-knee clipper using tanh saturation above threshold."""
    out = signal.copy()
    above = np.abs(signal) > threshold
    if np.any(above):
        # Tanh saturation for values above threshold
        excess = (np.abs(signal[above]) - threshold) / (1.0 - threshold + 1e-8)
        soft = threshold + (1.0 - threshold) * np.tanh(excess)
        out[above] = np.sign(signal[above]) * soft
    return out


def _normalize(y: np.ndarray, target_db: float = -1.0) -> np.ndarray:
    """Normalize peak to target dB."""
    peak = np.max(np.abs(y))
    if peak > 0:
        target_linear = 10 ** (target_db / 20.0)
        y = y * (target_linear / peak)
    return y


def _wav_to_mp3(wav_path: str, bitrate: str = "320k") -> str:
    """Convert WAV to MP3 using pydub (requires ffmpeg)."""
    from pydub import AudioSegment

    mp3_fd, mp3_path = tempfile.mkstemp(suffix=".mp3", prefix="saics_ver_")
    os.close(mp3_fd)

    audio = AudioSegment.from_wav(wav_path)
    audio.export(mp3_path, format="mp3", bitrate=bitrate)

    return mp3_path
