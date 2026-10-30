import numpy as np

from saics.render import equal_power, render_segments


def test_contiguous_path_is_bit_exact():
    rng = np.random.default_rng(0)
    y = rng.standard_normal(44100).astype(np.float32)
    beats = list(range(0, 44100, 11025)) + [44100]
    segs = list(zip(beats[:-1], beats[1:], strict=True))
    out, seams = render_segments(y, segs, 44100)
    assert np.array_equal(out, y) and seams == []  # D8: no crossfade without a jump


def test_length_preserved_and_seam_reported():
    y = np.zeros((2, 10 * 44100), np.float32)
    out, seams = render_segments(y, [(44100, 3 * 44100), (6 * 44100, 8 * 44100)], 44100)
    assert out.shape == (2, 4 * 44100) and seams == [2 * 44100]


def test_equal_power_sums_to_one():
    fo, fi = equal_power(1323)
    assert np.allclose(fo**2 + fi**2, 1.0, atol=1e-6)  # uncorrelated: power constant
    fo, fi = equal_power(1323, rho=1.0)
    assert np.allclose(fo + fi, 1.0, atol=1e-6)  # identical audio: amplitude constant


def test_uncorrelated_seam_keeps_power():
    rng = np.random.default_rng(1)
    y = rng.standard_normal(4 * 44100).astype(np.float32)
    out, (seam,) = render_segments(y, [(0, 2 * 44100), (3 * 44100, 4 * 44100)], 44100, 60)
    win = out[seam - 1000 : seam + 1000]
    assert abs(10 * np.log10(np.mean(win**2) / np.mean(y**2))) < 0.5  # no dip, no bump


def test_jump_between_identical_bars_is_seamless():
    sr, f = 44100, 441.0  # 441 Hz: exactly 100 cycles per second, so 1 s bars repeat in phase
    t = np.arange(8 * sr) / sr
    y = (0.5 * np.sin(2 * np.pi * f * t)).astype(np.float32)
    out, (seam,) = render_segments(y, [(0, 4 * sr), (1 * sr, 3 * sr)], sr, xfade_ms=30)
    ref = (0.5 * np.sin(2 * np.pi * f * np.arange(len(out)) / sr)).astype(np.float32)
    assert np.max(np.abs(out - ref)) < 1e-3  # equal-power fade of correlated audio stays flat
