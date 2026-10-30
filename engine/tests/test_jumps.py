"""Forever walk pacing on a synthetic song (bars of 2 s, sections of 8 bars)."""

import numpy as np

from saics.jumps import forever_path
from saics.schema import Jump, Section


def _jump(a, b, kind="repeat", score=0.9):
    return Jump(from_beat=4 * a, to_beat=4 * b, from_bar=a, to_bar=b, score=score, kind=kind,
                xfade_ms=30, label=f"S:{a} → S:{b}", context=0.9, lyric=1.0, distance_s=2.0 * abs(a - b))  # fmt: skip


def _song():
    n = 64  # 64 bars x 2 s = 128 s; A B A B C A B D
    bar_t = np.arange(n + 1) * 2.0
    groups = [0, 1, 0, 1, 2, 0, 1, 3]
    sections = [Section(start_bar=8 * k, end_bar=8 * k + 8, group=g) for k, g in enumerate(groups)]
    jumps = [_jump(20, 4), _jump(44, 28), _jump(52, 20), _jump(36, 4), _jump(56, 8, "end", 0.5)]
    return bar_t, sections, jumps


def test_pacing_and_no_double_jump_in_a_section():
    bar_t, sections, jumps = _song()
    for seed in range(5):
        segs, log = forever_path(bar_t, sections, jumps, minutes=8, seed=seed)
        out_len = sum(b - a for a, b in segs)
        assert out_len >= 8 * 60 - 2  # reached the target length
        times = [e["at_s"] for e in log]
        assert all(b - a >= 60 for a, b in zip(times[:-1], times[1:], strict=True)), times
        for seg_a, seg_b in segs:
            assert seg_b > seg_a


def test_song_end_loops_back_to_post_intro():
    bar_t, sections, jumps = _song()
    _, log = forever_path(bar_t, sections, [j for j in jumps if j.kind == "end"], minutes=5)
    assert log and all(e["kind"] == "end" for e in log)
