"""Volume and timing of cross-song seams, on synthetic signals with known answers."""

import numpy as np

from saics import seams
from saics.mixwalk import MixWalk, TrackInfo, move_trim_db, walk_path
from saics.portals import walkable
from saics.render import portal_join, trim_envelope

SR = 22050


def _clicks(beats, n, sr=SR):
    y = np.zeros(n, np.float32)
    burst = np.exp(-np.arange(int(0.02 * sr)) / (0.004 * sr)) * np.sin(
        2 * np.pi * 2000 * np.arange(int(0.02 * sr)) / sr
    )
    for b in beats:
        i = int(b * sr)
        y[i : i + len(burst)] += burst[: len(y) - i].astype(np.float32)
    return y


def test_levels_read_the_second_either_side_and_the_gain():
    t = np.arange(4 * SR) / SR
    y = 0.1 * np.sin(2 * np.pi * 1000 * t)
    y[2 * SR :] *= 0.5  # -6 dB from the second half on
    out, into = seams.seam_levels(y, SR, np.array([2.0]))
    assert abs((out[0] - into[0]) - 6.02) < 0.05
    out2, _ = seams.seam_levels(y, SR, np.array([2.0]), gain_db=3.0)
    assert abs(out2[0] - out[0] - 3) < 1e-6


def test_trim_makes_up_the_step_but_never_more_than_the_limit():
    a = np.full(8, -14.0)
    assert seams.seam_trim_db(a, 4, np.full(8, -18.0), 4) == 4.0  # B is quieter: boost it
    assert seams.seam_trim_db(a, 4, np.full(8, -11.0), 4) == -3.0
    assert seams.seam_trim_db(a, 4, np.full(8, -40.0), 4) == seams.TRIM_MAX_DB
    assert seams.seam_trim_db(a, 4, np.full(8, -14.2), 4) == 0.0  # inaudible: leave it
    assert seams.seam_trim_db(a, 4, np.full(8, -30.0), 0) == 0.0  # the top of a song
    assert seams.seam_trim_db([], 4, np.full(8, -30.0), 4) == 0.0  # not measured


def _songs_with_a_known_shift():
    # A's real beats sit 12 ms after what the tracker said, B's 25 ms before it.
    ibi = 0.5
    tracked_a = np.arange(40) * ibi + 0.1
    tracked_b = np.arange(40) * ibi + 0.2
    ya, yb = _clicks(tracked_a + 0.012, 22 * SR), _clicks(tracked_b - 0.025, 22 * SR)
    return tracked_a, ya, tracked_b, yb


def test_both_estimates_find_a_known_shift_and_the_nudge_uses_them():
    ta, ya, tb, yb = _songs_with_a_known_shift()
    fa, fb = seams.snap_beats(ya, SR, ta), seams.snap_beats(yb, SR, tb)
    eo, ei = seams.grid_error_out(ta, fa, 16), seams.grid_error_in(tb, fb, 20)
    assert abs((ei - eo) * 1000 + 37) < 4
    lag, peak = seams.onset_lag_ms(seams.onset_env(ya), ta[16], seams.onset_env(yb), tb[20], 1.0)
    assert abs(lag + 37) < 4 and peak > 0.8
    assert abs(seams.landing_offset_ms(eo, ei, lag, peak) + 37) < 4


def test_no_nudge_unless_the_two_estimates_agree_on_something_clear():
    assert seams.landing_offset_ms(0.0, -0.030, -30.0, 0.5) == -30.0
    assert seams.landing_offset_ms(0.0, -0.030, 20.0, 0.5) == 0.0  # they disagree
    assert seams.landing_offset_ms(0.0, -0.030, -30.0, 0.1) == 0.0  # the onsets don't correlate
    assert seams.landing_offset_ms(None, -0.030, -30.0, 0.5) == 0.0  # no grid before the seam
    assert seams.landing_offset_ms(0.0, None, -30.0, 0.5) == 0.0  # no grid after it


def test_no_clear_beat_means_no_grid():
    rng = np.random.default_rng(0)
    beats = np.arange(40) * 0.5
    noisy = beats + rng.uniform(-0.08, 0.08, 40)
    assert seams.grid_error_in(beats, noisy, 10) is None
    assert seams.grid_error_out(beats, noisy, 20) is None


def test_envelope_ramps_across_the_crossfade_then_glides_home():
    env = trim_envelope(1000, [(100, 10, 6.0, 400)])
    assert env[50] == 1.0
    assert abs(20 * np.log10(env[110]) - 6.0) < 0.05
    assert abs(20 * np.log10(env[310]) - 3.0) < 0.05
    assert env[600] == 1.0
    assert np.all(np.abs(np.diff(20 * np.log10(env))) < 0.31)  # never a jump


def test_a_later_move_takes_over_a_running_glide_without_a_jump():
    env = trim_envelope(1000, [(100, 10, 6.0, 800), (300, 10, -3.0, 200)])
    assert abs(20 * np.log10(env[310]) + 3.0) < 0.05
    assert env[700] == 1.0
    assert np.all(np.abs(np.diff(20 * np.log10(env))) < 1.0)


def _tone(hz, n, sr=44100):
    y = 0.2 * np.sin(2 * np.pi * hz * np.arange(n) / sr)
    return np.stack([y, y]).astype(np.float32)


def _band(y, hz, sr=44100):
    n = np.arange(len(y)) / sr
    return 2 * np.hypot(
        np.mean(y * np.sin(2 * np.pi * hz * n)), np.mean(y * np.cos(2 * np.pi * hz * n))
    )


def test_the_join_has_a_at_the_start_and_b_at_the_end_at_the_right_length():
    sr = 44100
    ya, yb = _tone(1000, 20 * sr), _tone(3000, 20 * sr)
    ctx = 5 * sr
    y, s = portal_join(ya, 10 * sr, yb, 8 * sr, ctx, 0.0, 0, sr)
    assert y.shape == (2, 2 * ctx) and s == ctx
    assert np.isfinite(y).all()
    mono = y.mean(0)
    assert _band(mono[: 2 * sr], 1000) > 0.15 > 0.01 > _band(mono[: 2 * sr], 3000)
    assert _band(mono[-2 * sr :], 3000) > 0.15 > 0.01 > _band(mono[-2 * sr :], 1000)


def test_the_trim_lands_on_b_only_and_glides_back():
    sr = 44100
    ya, yb = _tone(1000, 20 * sr), _tone(1000, 20 * sr)
    y, s = portal_join(ya, 10 * sr, yb, 10 * sr, 5 * sr, 6.0, 2 * sr, sr)
    mono = y.mean(0)
    rms = lambda a: float(np.sqrt(np.mean(a**2)))  # noqa: E731
    assert abs(20 * np.log10(rms(mono[s - sr // 4 : s]) / rms(ya.mean(0)))) < 0.3
    assert 20 * np.log10(rms(mono[s + 2000 : s + 4000]) / rms(ya.mean(0))) > 5
    assert abs(20 * np.log10(rms(mono[s + 3 * sr :]) / rms(ya.mean(0)))) < 0.1


def _track(tid, portals=(), db=-14.0, group="", walk=True):
    return TrackInfo(
        id=tid, group=group or tid, bar_t=np.arange(121) * 2.0,
        sections=[(0, 120, 0, "chorus")], jumps=[], portals=list(portals),
        entries=[8], level_out=[db] * 120, level_in=[db] * 120, walkable=walk,
    )  # fmt: skip


class _Edge:
    def __init__(self, f, to, b, off=0.0, same=False):
        self.from_bar, self.to, self.to_bar, self.offset_ms = f, to, b, off
        self.score, self.pair, self.same_group = 0.8, "chorus → chorus", same


def test_lofi_vhs_is_not_walkable_but_other_files_are():
    assert not walkable("y2mate.com - x self cover (Lofi VHS).mp3")
    assert not walkable("YOASOBI _ racing_Sped up (lofi vhs).mp3")
    assert walkable("Lofi Girl - something.mp3")


def test_the_walk_never_lands_on_an_unwalkable_song():
    g = {
        "a": _track("a", [_Edge(40, "lofi", 8), _Edge(48, "b", 8)]),
        "b": _track("b"),
        "lofi": _track("lofi", walk=False),
    }
    for seed in range(5):
        w = MixWalk(g, "a", seed=seed)
        assert w.fallback != "lofi"
        segs, _ = walk_path(g, "a", 6, seed=seed)
        assert all(s[0] != "lofi" for s in segs)


def test_a_portal_move_carries_its_nudge_and_trim_and_back_undoes_them():
    g = {"a": _track("a", [_Edge(40, "b", 8, off=12.5)]), "b": _track("b", db=-18.0)}
    w = MixWalk(g, "a", seed=1)
    m = None
    for bar in range(120):
        m = w.step(bar)
        if m is not None and not isinstance(m, tuple):
            break
    assert m.kind == "portal" and m.offset_ms == 12.5
    assert move_trim_db(g, w.cur, m) == 4.0
    w.arrive(m)
    assert w.came_from == ("a", 40, 8, 12.5)
    back = w._fallback(8, 0.0)
    assert back.kind == "back" and back.offset_ms == -12.5
    assert move_trim_db(g, w.cur, back) == -4.0


def test_a_song_that_ran_out_gets_no_trim():
    g = {"a": _track("a"), "b": _track("b", db=-30.0)}
    w = MixWalk(g, "a", seed=1)
    m = w._song_end(120)
    assert m.to_bar == 0 and move_trim_db(g, w.cur, m) == 0.0


def test_walk_segments_after_a_move_carry_the_seam():
    g = {"a": _track("a", [_Edge(40, "b", 8, off=-9.0)]), "b": _track("b", db=-16.0)}
    segs, log = walk_path(g, "a", 3, seed=1)
    i = next(k for k, s in enumerate(segs) if s[0] == "b")
    assert len(segs[0]) == 3
    assert segs[i][3] == -9.0 and segs[i][4] == 2.0
