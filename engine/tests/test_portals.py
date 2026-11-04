"""P4a: the portal finder's rules on synthetic songs, and the walk's rules on synthetic graphs."""

from types import SimpleNamespace

import numpy as np

from saics.mixwalk import MixWalk, Move, TrackInfo, walk_path
from saics.portals import Song, camelot_compatible, match_pair, section_kinds, tempo_close


def test_camelot_compatibility():
    assert camelot_compatible("8A", "8A")
    assert camelot_compatible("8A", "9A") and camelot_compatible("12B", "1B")
    assert camelot_compatible("8A", "8B")  # relative major/minor
    assert not camelot_compatible("8A", "10A") and not camelot_compatible("8A", "9B")


def test_tempo_close():
    assert tempo_close(120, 125) and not tempo_close(120, 127)
    assert not tempo_close(120, 240)  # no half/double time until P4b


def _song(seed, n=40, shared=None, vocal_edge=None, kind="chorus"):
    rng = np.random.default_rng(seed)
    x = rng.standard_normal((n, 20))
    chroma = rng.random((n, 12))
    if shared is not None:
        start, sx, sc = shared
        x[start : start + len(sx)] = sx
        chroma[start : start + len(sc)] = sc
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    chroma /= np.linalg.norm(chroma, axis=1, keepdims=True)
    phrase = np.arange(0, n, 4)
    usable = phrase[(phrase >= 4) & (phrase < n - 4)]
    return Song(id=f"s{seed}", file=f"s{seed}.mp3", group=f"g{seed}", bpm=120.0, camelot="8A", meter=4,
                stable=True, bar_t=np.arange(n + 1) * 2.0, x=x, chroma=chroma,
                vocal_edge=np.zeros(n) if vocal_edge is None else vocal_edge, energy=np.full(n, 0.5),
                kinds=[kind], bar_kind=[kind] * n, phrase=phrase, exits=usable, lands=usable,
                entries=[0], break_exits=[])  # fmt: skip


def _shared(seed=99, k=8):
    rng = np.random.default_rng(seed)
    return rng.standard_normal((k, 20)), np.abs(rng.standard_normal((k, 12)))


def test_portal_found_where_8_bars_around_the_seam_match():
    sx, sc = _shared()
    a = _song(1, shared=(12, sx, sc))  # the seam is bar 16 of a (4 bars each side of it)
    b = _song(2, shared=(20, sx, sc))  # ... and bar 24 of b
    found = match_pair(a, b)
    assert found and (found[0][1], found[0][2]) == (16, 24)


def test_no_portal_across_a_sung_line():
    sx, sc = _shared()
    edge = np.zeros(40)
    edge[16] = 0.9  # a line runs into bar 16 of a
    a = _song(1, shared=(12, sx, sc), vocal_edge=edge)
    b = _song(2, shared=(20, sx, sc))
    assert all(f[1] != 16 for f in match_pair(a, b))


def test_owner_bans_and_pins():
    sx, sc = _shared()
    a = _song(1, shared=(12, sx, sc))
    b = _song(2, shared=(20, sx, sc))
    assert all(
        (f[1], f[2]) != (16, 24) for f in match_pair(a, b, {"ban": {(16, 24)}, "keep": set()})
    )


def test_section_kinds():
    sections = [{"start_bar": 0, "end_bar": 8, "group": 0}, {"start_bar": 8, "end_bar": 16, "group": 1},
                {"start_bar": 16, "end_bar": 24, "group": 2}, {"start_bar": 24, "end_bar": 32, "group": 1},
                {"start_bar": 32, "end_bar": 40, "group": 2}, {"start_bar": 40, "end_bar": 44, "group": 3},
                {"start_bar": 44, "end_bar": 52, "group": 2}, {"start_bar": 52, "end_bar": 60, "group": 4}]  # fmt: skip
    energy = np.array(
        [0.3] * 8
        + [0.5] * 8
        + [0.9] * 8
        + [0.5] * 8
        + [0.9] * 8
        + [0.1] * 4
        + [0.9] * 8
        + [0.4] * 8
    )
    vocal = np.array([0.0] * 8 + [0.8] * 32 + [0.0] * 4 + [0.8] * 8 + [0.0] * 8)
    kinds = section_kinds(sections, energy, vocal, [], np.arange(61) * 2.0)
    assert kinds == ["intro", "verse", "chorus", "verse", "chorus", "break", "chorus", "outro"]


# ── the walk ─────────────────────────────────────────────────────────────────────


def _edge(fr, to, tb, score=0.9, same=False, pair="chorus → chorus"):
    return SimpleNamespace(
        from_bar=fr,
        to=to,
        to_bar=tb,
        score=score,
        pair=pair,
        same_group=same,
        two_way=False,
        offset_ms=0.0,
    )


def _track(tid, group=None, n=80, portals=(), jumps=(), breaks=(), entries=(0,)):
    secs = [
        (i, min(i + 16, n), i // 16, "chorus" if (i // 16) % 2 else "verse")
        for i in range(0, n, 16)
    ]
    return TrackInfo(id=tid, group=group if group is not None else tid, bar_t=np.arange(n + 1) * 2.0,
                     sections=secs, jumps=list(jumps), portals=list(portals), entries=list(entries),
                     break_exits=list(breaks))  # fmt: skip


def _ring(k=12):
    """Songs wired in a ring: each has portals into the next at several bars."""
    ids = [f"s{i}" for i in range(k)]
    return {tid: _track(tid, portals=[_edge(b, ids[(i + 1) % k], 16) for b in (32, 48, 64)])
            for i, tid in enumerate(ids)}  # fmt: skip


def test_dwell_at_least_a_minute_or_a_chorus():
    for seed in range(10):
        _, log = walk_path(_ring(), "s0", 30, seed=seed)
        moves = [e for e in log if e["kind"] == "portal"]
        assert moves
        last = 0.0
        for e in moves:
            assert e["at_s"] - last >= 30.0  # MIN_DWELL_S; a chorus can end a visit before 60 s
            last = e["at_s"]


def test_no_group_repeat_inside_the_window():
    _, log = walk_path(_ring(12), "s0", 30, seed=1)
    seq = [e["to"] for e in log if e["kind"] == "portal"]
    for i, s in enumerate(seq):
        assert s not in seq[max(0, i - 7) : i]


def test_same_group_portals_only_with_forever():
    g = {"a": _track("a", "song", portals=[_edge(40, "b", 40, same=True), _edge(48, "c", 16)]),
         "b": _track("b", "song"), "c": _track("c", "other")}  # fmt: skip
    w = MixWalk(g, "a", seed=1)
    w.visit_t = 100.0
    assert w.step(40) is None  # another version: not without Forever
    m = w.step(48)
    assert isinstance(m, Move) and m.to == "c"
    w = MixWalk(g, "a", seed=1, forever=True)
    w.visit_t = 100.0
    m = w.step(40)
    assert isinstance(m, Move) and m.to == "b"
    assert not isinstance(w.step(48), Move)  # Forever never leaves the song group


def test_the_walk_can_never_get_trapped():
    """Songs with no portals, one-way traps, tiny pools: every walk keeps changing songs."""
    g = {f"s{i}": _track(f"s{i}", n=60, jumps=[(50, 20, 0.9, "repeat", f"j{i}")]) for i in range(6)}
    g["s0"].portals = [_edge(32, "s1", 16)]  # a one-way door into dead ends
    for seed in range(20):
        segs, log = walk_path(g, "s0", 40, seed=seed)
        seen = [s[0] for s in segs if s[0] != "gap"]
        assert len(set(seen)) >= 3
        at = [e["at_s"] for e in log if e["kind"] != "jump"]
        assert (
            at and max(b - a for a, b in zip([0, *at], at, strict=False)) < 400.0
        )  # bounded visits


def test_dead_end_leaves_back_through_the_portal_it_came_in_on():
    g = {"a": _track("a", portals=[_edge(40, "b", 8)]),
         "b": _track("b", n=64, jumps=[(40, 8, 0.9, "repeat", "loop")]),
         "c": _track("c")}  # fmt: skip
    w = MixWalk(g, "a", seed=3)
    w.arrive(Move("portal", "b", 8, 40))
    assert w.came_from == ("a", 40, 8, 0.0)
    w.visit_t = w.dwell + 1
    assert w.step(8).kind == "back"


def test_stay_skips_the_portal_and_holds_the_fallbacks():
    g = {"a": _track("a", portals=[_edge(40, "b", 8)]), "b": _track("b")}
    w = MixWalk(g, "a", seed=3)
    w.visit_t = 100.0
    m = w.peek(38)
    assert m is not None and m.to == "b"
    w.stay(m)
    assert w.peek(38) is None
    assert not isinstance(w.step(40), Move)


def test_next_takes_a_close_portal_at_its_own_bar_else_cuts_on_the_phrase():
    g = {
        "a": _track("a", portals=[_edge(40, "b", 8), _edge(70, "c", 8)]),
        "b": _track("b"),
        "c": _track("c"),
    }
    w = MixWalk(g, "a", seed=3)  # dwell doesn't apply to Next
    m = w.next_now(36)
    assert (m.kind, m.at, m.to) == ("portal", 40, "b")
    m = w.next_now(50)
    assert (
        m.kind == "cut" and m.to == "c" and m.at == 52 and m.to_bar == 8
    )  # next phrase, 4-bar grid


def test_double_next_in_forever_goes_to_a_different_song():
    g = {
        "a": _track(
            "a",
            "song",
            portals=[_edge(40, "v", 8, same=True), _edge(40, "c", 8), _edge(70, "d", 16)],
        ),
        "v": _track("v", "song"),
        "c": _track("c"),
        "d": _track("d"),
        "e": _track("e"),
    }
    w = MixWalk(g, "a", seed=3, forever=True)
    m = w.new_song(38)  # a real portal on the next two bars: taken at its own bar
    assert (m.kind, m.at, m.to) == ("portal", 40, "c")
    m = w.new_song(10)  # none close: a cut on the next downbeat, still not another version
    assert m.kind == "cut" and m.at == 11 and m.to in ("c", "d")
    lone = {"a": _track("a", "song"), "v": _track("v", "song"), "e": _track("e")}
    m = MixWalk(lone, "a", seed=3, forever=True).new_song(10)
    assert m.to == "e" and m.at == 11  # no portals at all: still leaves the song group
