"""Forever walk: pacing and the owner's ending priority, on a synthetic song.

Song: 64 bars of 2 s (128 s), sections of 8 bars: A B A B C A B D(outro).
"""

import numpy as np

from saics.jumps import AVOID_MAX_USES, forever_path, outro_bar
from saics.schema import Jump, Section


def _jump(a, b, kind="repeat", score=0.9):
    return Jump(from_beat=4 * a, to_beat=4 * b, from_bar=a, to_bar=b, score=score, kind=kind,
                xfade_ms=30, label=f"S:{a} → S:{b}", context=0.9, lyric=1.0, distance_s=2.0 * abs(a - b))  # fmt: skip


def _song():
    n = 64
    bar_t = np.arange(n + 1) * 2.0
    groups = [0, 1, 0, 1, 2, 0, 1, 3]
    sections = [Section(start_bar=8 * k, end_bar=8 * k + 8, group=g) for k, g in enumerate(groups)]
    return bar_t, sections


def _played(segs):
    return sum(b - a for a, b in segs if not isinstance(a, str))


def test_outro_is_the_last_unrepeated_section():
    _, sections = _song()
    assert outro_bar(sections, 64) == 56


def _passes(log: list) -> list:
    """The jump log split at each repeat-one: one list per time through the song."""
    out = [[]]
    for e in log:
        if e["kind"] == "repeat_one":
            out.append([])
        else:
            out[-1].append(e)
    return out


def test_pacing_and_ending_avoidance():
    bar_t, sections = _song()
    jumps = [_jump(20, 4), _jump(44, 28), _jump(52, 20)]  # 52 -> 20: last backward before outro
    for seed in range(5):
        segs, log = forever_path(bar_t, sections, jumps, minutes=8, seed=seed, outro=56)
        assert _played(segs) >= 8 * 60 - 2  # reached the target length
        paced = [e["at_s"] for e in log if e["why"] == "pacing"]
        assert all(b - a >= 60 for a, b in zip(paced[:-1], paced[1:], strict=True)), paced
        for one in _passes(log):  # each time through the song, from the top
            avoid = [e for e in one if e["why"] == "avoid the ending"]
            assert len(avoid) <= AVOID_MAX_USES  # avoided, but never circled forever
            pairs = [(e["from"], e["to"]) for e in one]
            assert len(pairs) == len(set(pairs)), one  # no jump twice in one pass (owner)
        assert any(e["why"] == "avoid the ending" for e in log)
        times = [e["at_s"] for e in log]
        assert all(b - a >= 30 for a, b in zip(times[:-1], times[1:], strict=True)), log


def test_break_loop_when_there_is_no_repeat_jump():
    bar_t, sections = _song()
    _, log = forever_path(bar_t, sections, [_jump(50, 10, "break", 0.7)], minutes=6, outro=56)
    assert log[0]["kind"] == "break" and log[0]["why"] == "avoid the ending"
    assert all([e["kind"] for e in one].count("break") <= AVOID_MAX_USES for one in _passes(log))


def test_version_switch_then_repeat_one():
    bar_t, sections = _song()
    segs, log = forever_path(bar_t, sections, [], minutes=6, outro=56, has_versions=True)
    assert log[-1]["kind"] == "switch" and segs[-1] == ("switch", None)
    segs, log = forever_path(bar_t, sections, [], minutes=6, outro=56, has_versions=False)
    assert [e["kind"] for e in log][:2] == ["repeat_one", "repeat_one"]
    assert ("gap", 1.5) in segs


def test_not_loopable_forces_switch_or_repeat_one():
    bar_t, sections = _song()
    jumps = [_jump(52, 20)]
    _, log = forever_path(bar_t, sections, jumps, minutes=6, outro=56, loopable=False)
    assert not any(e["why"] == "avoid the ending" for e in log)
    assert any(e["kind"] == "repeat_one" for e in log)


def test_no_ping_pong_at_the_last_chance():
    bar_t, sections = _song()
    # 30 -> 50 lands right on the last backward jump (50 -> 26): taking it would ping-pong.
    jumps = [_jump(30, 50, score=0.95), _jump(50, 26)]
    for seed in range(5):
        _, log = forever_path(bar_t, sections, jumps, minutes=8, seed=seed, outro=56)
        times = [e["at_s"] for e in log]
        assert all(b - a >= 30 for a, b in zip(times[:-1], times[1:], strict=True)), log


def test_short_ending_loop_is_not_circled_forever():
    bar_t, sections = _song()
    _, log = forever_path(bar_t, sections, [_jump(52, 36)], minutes=10, outro=56, has_versions=True)
    avoid = [e for e in log if e["why"] == "avoid the ending"]
    assert len(avoid) == AVOID_MAX_USES and log[-1]["kind"] == "switch"


def _one_block_song(n=80, rep=(10, 46), length=24, seed=0):
    """n bars of random features in ONE section, with bars rep[0]..+length repeated at rep[1]."""
    from saics.jumps import BarInfo
    from saics.schema import Section

    rng = np.random.default_rng(seed)
    feats = rng.normal(size=(n, 30))
    a, b = rep
    feats[b : b + length] = feats[a : a + length] + 0.05 * rng.normal(size=(length, 30))
    info = BarInfo(
        bar_t=np.arange(n + 1) * 2.0, feats=feats, vocal_chroma=np.ones((n, 12)),
        vocal=np.zeros(n), vocal_edge=np.zeros(n), energy=np.full(n, 0.8), duration=2.0 * n,
    )  # fmt: skip
    return info, [Section(start_bar=0, end_bar=n, group=0)], list(range(0, 4 * n + 1, 4))


def test_the_fallback_finds_a_repeat_the_sections_hid(monkeypatch):
    from saics import jumps as J

    info, sections, downbeats = _one_block_song()
    monkeypatch.setattr(J, "FALLBACK_CTX_MEAN", None)
    assert J.find_jumps(info, sections, [], downbeats) == []  # one section: nothing allowed
    monkeypatch.setattr(J, "FALLBACK_CTX_MEAN", 0.45)
    found = J.find_jumps(info, sections, [], downbeats)
    assert found and all(abs(abs(j.to_bar - j.from_bar) - 36) <= 1 for j in found)


def test_the_fallback_leaves_songs_with_jumps_alone(monkeypatch):
    from saics import jumps as J
    from saics.schema import Section

    info, _, downbeats = _one_block_song()
    sections = [Section(start_bar=0, end_bar=10, group=0), Section(start_bar=10, end_bar=34, group=1),
                Section(start_bar=34, end_bar=46, group=2), Section(start_bar=46, end_bar=70, group=1),
                Section(start_bar=70, end_bar=80, group=3)]  # fmt: skip
    monkeypatch.setattr(J, "FALLBACK_CTX_MEAN", None)
    normal = J.find_jumps(info, sections, [], downbeats)
    monkeypatch.setattr(J, "FALLBACK_CTX_MEAN", 0.45)
    assert normal and J.find_jumps(info, sections, [], downbeats) == normal
