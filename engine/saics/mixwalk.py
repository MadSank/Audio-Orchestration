"""P4a: the Infinite Ride walk over the portal graph (the phone's MixWalk.kt mirrors this; keep
the two in step). Decides, one bar at a time, what follows the bar now playing.

Owner's rules (PLAN P4a):
* dwell: stay at least 60-90 s, or for a full chorus (never under MIN_DWELL_S), before leaving;
* no portal into another version of the same song group unless Forever is on (and then only
  those); a song-group no-repeat window, by count and by time;
* dead ends (no usable portal ahead): loop the song with the Forever walk, then leave through
  a fallback: back through the portal it came in on, a cut into a break, a version switch, and
  as a last resort a cut on a phrase. The walk can never get trapped;
* Next = take the next portal now (at the next phrase); Stay = skip the portal on offer.
"""

from dataclasses import dataclass, field

import numpy as np

from saics.jumps import AVOID_MAX_USES, REPEAT_ONE_GAP_S, REUSE_PENALTY, TAKE_MIN

DWELL = (60.0, 90.0)
MIN_DWELL_S = 30.0  # even a full chorus doesn't end the visit before this
NO_REPEAT_COUNT = 8  # song groups ...
NO_REPEAT_S = 20 * 60.0  # ... and seconds before one may come back
PORTAL_SCORE_MIN = 0.6
EXITS_BONUS = 0.05
CUT_POOL = 12  # fallback cuts go to one of this many closest-tempo songs that have exits
BREAK_AFTER_S = 30.0  # dead end: seconds of looping before each fallback opens
VERSION_AFTER_S = 60.0
CUT_AFTER_S = 90.0
BACK_REACH_BARS = 4
NEXT_REACH_BARS = 8  # Next: an upcoming portal this close is taken at its own bar
STAY_HOLD_S = 45.0  # after Stay, no fallback for this long


@dataclass
class TrackInfo:
    """What the walk needs per song (bundle + portals.json)."""

    id: str
    group: str
    bar_t: np.ndarray  # (n + 1,)
    sections: list  # [(start_bar, end_bar, group, kind)]
    jumps: list  # [(from_bar, to_bar, score, kind, label)]
    portals: list  # [PortalEdge-like with from_bar, to, to_bar, score, pair, same_group]
    entries: list = field(default_factory=lambda: [0])
    break_exits: list = field(default_factory=list)
    outro_bar: int | None = None
    loopable: bool = True
    bpm: float = 0.0

    @property
    def exits(self) -> int:
        """Portals out of this song to other song groups."""
        return sum(1 for e in self.portals if not e.same_group)

    @property
    def n(self) -> int:
        return len(self.bar_t) - 1

    def section_at(self, bar: int):
        for s in self.sections:
            if s[0] <= bar < s[1]:
                return s
        return None

    def is_phrase(self, bar: int) -> bool:
        s = self.section_at(bar)
        return bar == 0 or (s is not None and (bar - s[0]) % 4 == 0)

    def next_phrase(self, bar: int) -> int:
        for b in range(bar + 1, self.n):
            if self.is_phrase(b):
                return b
        return self.n


class ForeverSteps:
    """Incremental jumps.forever_path for one song (same rules; see ForeverWalk.kt)."""

    def __init__(self, t: TrackInfo, rng, pace=(60.0, 120.0)):
        self.t, self.rng, self.pace = t, rng, pace
        n = t.n
        self.sec = np.full(n, -1)
        for k, s in enumerate(t.sections):
            self.sec[s[0] : min(s[1], n)] = k
        self.by_from: dict = {}
        for j in t.jumps:
            self.by_from.setdefault(j[0], []).append(j)
        outro = t.outro_bar or n
        back = [j for j in t.jumps if j[1] < j[0] <= outro]
        self.last_back = None
        if t.loopable:
            rep = [j[0] for j in back if j[3] == "repeat"]
            brk = [j[0] for j in back if j[3] == "break"]
            self.last_back = max(rep) if rep else (max(brk) if brk else None)
        self.time = 0.0
        self.landed = -2
        self.next_at = self._pace()
        self.recent: list = []
        self.used: dict = {}

    def _pace(self) -> float:
        return float(self.rng.uniform(*self.pace))

    def _played(self, bar: int) -> None:
        self.recent.append((self.time, bar))
        self.time += float(self.t.bar_t[bar + 1] - self.t.bar_t[bar])

    def plain(self, bar: int) -> None:
        """Bar played without a walk decision (keeps the clock and the recent list right)."""
        self._played(bar)

    def land(self, bar: int) -> None:
        self.landed = int(self.sec[bar]) if 0 < bar < self.t.n else -2
        self.next_at = self.time + self._pace()

    def step(self, bar: int):
        """Returns the jump tuple taken, None to carry on, or "end"."""
        t = self.t
        here = self.by_from.get(bar, [])
        self.recent = [(a, b) for a, b in self.recent if self.time - a < 60.0]
        fresh = {b for _, b in self.recent}
        use = lambda j: self.used.get(j[4], 0)  # noqa: E731
        if self.last_back is not None and bar == self.last_back:
            usable = [j for j in here if j[1] < bar and use(j) < AVOID_MAX_USES]
            options = [j for j in usable if j[1] not in fresh] or usable
            if options:
                j = max(
                    options,
                    key=lambda j: (
                        j[3] == "repeat",
                        j[2] - REUSE_PENALTY * use(j) + 0.002 * (bar - j[1]),
                    ),
                )
                return self._take(j)
        if self.time >= self.next_at and here and bar < t.n and self.sec[bar] != self.landed:
            limit = self.last_back if self.last_back is not None else t.n
            options = [
                j
                for j in here
                if j[1] not in fresh
                and j[2] - REUSE_PENALTY * use(j) >= TAKE_MIN
                and t.bar_t[limit] - t.bar_t[j[1]] >= self.pace[0]
            ]
            if options:
                return self._take(
                    max(
                        options,
                        key=lambda j: (
                            j[2] - REUSE_PENALTY * use(j) + float(self.rng.uniform(0, 0.02))
                        ),
                    )
                )
        if bar >= t.n:
            return "end"
        self._played(bar)
        return None

    def _take(self, j):
        self.used[j[4]] = self.used.get(j[4], 0) + 1
        self.landed = int(self.sec[j[1]])
        self.next_at = self.time + self._pace()
        self._played(j[1])
        return j


@dataclass
class Move:
    """Leave this song: at bar `at`, continue at `to_bar` of track `to`."""

    kind: str  # portal | back | break | version | cut | end
    to: str
    to_bar: int
    at: int
    pair: str = ""
    score: float = 0.0


class MixWalk:
    def __init__(
        self, graph: dict, start: str, seed: int = 0, forever: bool = False, pool: set | None = None
    ):
        self.graph = graph  # id -> TrackInfo
        self.rng = np.random.default_rng(seed)
        self.forever = forever
        self.pool = pool
        self.history: list = []  # (group or id, leave time)
        self.t = 0.0
        self.jumps_taken = 0
        self.enter(start, 0, None)

    # ── visits ───────────────────────────────────────────────────────────────

    def enter(self, track: str, bar: int, came_from: tuple | None) -> None:
        """Arrived at `bar` of `track`; came_from = (track, its bar, this landing bar)."""
        self.cur = self.graph[track]
        self.came_from = came_from
        self.visit_t = 0.0
        self.dwell = float(self.rng.uniform(*DWELL))
        self.chorus_done = False
        self.chorus_from = None  # section start where a whole chorus began in this visit
        self.dead_since = None
        self.hold_until = 0.0
        self.stays: set = set()
        self.walk = ForeverSteps(self.cur, self.rng)
        if bar > 0:
            self.walk.land(bar)
        self.jumps_taken = 0
        self.fallback = self._pick_target()

    def _key(self, t: TrackInfo) -> str:
        return t.group or t.id

    def _allowed(self, tid: str) -> bool:
        t = self.graph.get(tid)
        if t is None or (self.pool is not None and tid not in self.pool):
            return False
        recent = [g for g, at in self.history[-NO_REPEAT_COUNT:] if self.t - at < NO_REPEAT_S]
        return self._key(t) not in recent and self._key(t) != self._key(self.cur)

    def _dwelled(self, extra: float = 0.0) -> bool:
        vt = self.visit_t + extra
        return vt >= self.dwell or (self.chorus_done and vt >= MIN_DWELL_S)

    def _edge_ok(self, e) -> bool:
        if (e.from_bar, e.to, e.to_bar) in self.stays or e.score < PORTAL_SCORE_MIN:
            return False
        if self.forever:  # Forever stays in the song: only other versions of it
            return e.same_group and e.to in self.graph
        return not e.same_group and self._allowed(e.to)

    def _rank(self, e) -> float:
        """Portal preference: its score, and a song with its own exits beats a dead end."""
        t = self.graph.get(e.to)
        return e.score + (EXITS_BONUS if t is not None and t.exits > 0 else 0.0)

    def _portals_from(self, bar: int) -> list:
        return [e for e in self.cur.portals if e.from_bar == bar and self._edge_ok(e)]

    def peek(self, bar: int) -> Move | None:
        """The next portal the walk would take after `bar` (shown on Now Playing)."""
        c = self.cur
        for b in range(bar + 1, c.n):
            if not self._dwelled(float(c.bar_t[b] - c.bar_t[bar])):
                continue
            opts = self._portals_from(b)
            if opts:
                e = max(opts, key=self._rank)
                return Move("portal", e.to, e.to_bar, b, e.pair, e.score)
        return None

    def stay(self, m: Move | None) -> None:
        """Skip this portal and keep the song (owner: Stay)."""
        if m is not None:
            self.stays.add((m.at, m.to, m.to_bar))
        self.hold_until = self.t + STAY_HOLD_S
        self.dead_since = None

    # ── one bar ──────────────────────────────────────────────────────────────

    def step(self, bar: int):
        """What to play instead of / as `bar`: a Move, a jump tuple, or None to carry on."""
        c = self.cur
        if self._dwelled():
            opts = self._portals_from(bar)
            if opts:
                e = max(opts, key=lambda e: self._rank(e) + float(self.rng.uniform(0, 0.02)))
                return Move("portal", e.to, e.to_bar, bar, e.pair, e.score)
        if self.forever:  # Forever keeps the song: loops, then the version/repeat ending
            return self._forever_bar(bar)
        ahead = any(self._edge_ok(e) and e.from_bar > bar for e in c.portals)
        if self._dwelled() and not ahead and self.t >= self.hold_until:
            if self.dead_since is None:
                self.dead_since = self.t
        elif ahead:
            self.dead_since = None
        if self.dead_since is not None:
            m = self._fallback(bar, self.t - self.dead_since)
            if m is not None:
                return m
            return self._forever_bar(bar)
        if bar >= c.n:
            return self._song_end(bar)
        self._track_chorus(bar)
        self.walk.plain(bar)
        self._advance(bar)
        return None

    def _forever_bar(self, bar: int):
        r = self.walk.step(bar)
        if r == "end":
            return self._song_end(bar)
        if r is None:
            self._track_chorus(bar)
            self._advance(bar)
            return None
        self.jumps_taken += 1
        self._advance(r[1])
        return r

    def _advance(self, bar: int) -> None:
        dt = float(self.cur.bar_t[bar + 1] - self.cur.bar_t[bar])
        self.t += dt
        self.visit_t += dt

    def _track_chorus(self, bar: int) -> None:
        s = self.cur.section_at(bar)
        if s is None or s[3] != "chorus":
            self.chorus_from = None
            return
        if bar == s[0]:
            self.chorus_from = s[0]
        if bar == s[1] - 1 and self.chorus_from == s[0]:
            self.chorus_done = True

    def _pick_target(self) -> str | None:
        """Fallback destination: not recently played if possible; the walk must always leave."""
        ids = [i for i in sorted(self.graph) if self._allowed(i)]
        if not ids:  # everything was played recently: the least recent other song
            others = [
                i
                for i in sorted(self.graph)
                if i != self.cur.id
                and self._key(self.graph[i]) != self._key(self.cur)
                and (self.pool is None or i in self.pool)
            ]
            if not others:
                return None
            last = {g: at for g, at in self.history}
            return min(others, key=lambda i: last.get(self._key(self.graph[i]), -1.0))
        # Back into the connected part of the graph, at the closest tempos.
        with_exits = [i for i in ids if self.graph[i].exits > 0] or ids
        with_exits.sort(key=lambda i: abs(self.graph[i].bpm - self.cur.bpm))
        near = with_exits[:CUT_POOL]
        return near[int(self.rng.integers(len(near)))]

    def _cut(self, kind: str, bar: int) -> Move | None:
        tid = self.fallback if self.fallback in self.graph else self._pick_target()
        if tid is None:
            return None
        return Move(kind, tid, self.graph[tid].entries[0], bar, "cut")

    def _versions(self) -> list:
        g = self.cur.group
        return (
            [] if not g else [i for i, t in self.graph.items() if t.group == g and i != self.cur.id]
        )

    def _fallback(self, bar: int, looped: float) -> Move | None:
        c = self.cur
        cf = self.came_from
        # The seam matched over the 4 bars after it, so any of them can go back, at that offset.
        if cf is not None and 0 <= bar - cf[2] < BACK_REACH_BARS and cf[0] in self.graph:
            return Move("back", cf[0], cf[1] + bar - cf[2], bar, "back", 0.0)
        if looped >= BREAK_AFTER_S and bar in c.break_exits:
            return self._cut("break", bar)
        if looped >= VERSION_AFTER_S and c.is_phrase(bar):
            vs = self._versions()
            if vs:
                v = vs[int(self.rng.integers(len(vs)))]
                other = self.graph[v]
                land = int(round(bar * (other.n / max(1, c.n))))
                return Move("version", v, min(land, other.n - 1), bar, "version")
        if looped >= CUT_AFTER_S and c.is_phrase(bar):
            return self._cut("cut", bar)
        return None

    def _song_end(self, bar: int) -> Move:
        vs = self._versions() if self.forever or self.dead_since is not None else []
        if vs:
            return Move("version", vs[int(self.rng.integers(len(vs)))], 0, bar, "version")
        m = None if self.forever else self._cut("cut", bar)  # Forever: repeat-one (d)
        if m is not None:
            m.to_bar = 0  # the song ended: the next one plays from its top
            return m
        return Move("end", self.cur.id, 0, bar, "repeat")  # a one-song pool: repeat it

    def next_now(self, bar: int) -> Move | None:
        """Next: the next portal now: a close one at its own bar, else a cut on the next phrase."""
        c = self.cur
        for b in range(bar + 1, min(c.n, bar + 1 + NEXT_REACH_BARS)):
            opts = self._portals_from(b)
            if opts:
                e = max(opts, key=self._rank)
                return Move("portal", e.to, e.to_bar, b, e.pair, e.score)
        at = c.next_phrase(bar)
        later = [e for e in c.portals if self._edge_ok(e) and e.from_bar > bar]
        if later:
            e = max(later, key=self._rank)
            return Move("cut", e.to, e.to_bar, at, e.pair, e.score)
        return self._cut("cut", at)

    def new_song(self, bar: int) -> Move | None:
        """Next x2 in Forever: a completely different song, now (Forever stays on and loops it).

        A portal if one is on the next two bars, else a cut on the next downbeat, into a portal's
        landing if this song has one, else the fallback song's best entry."""
        others = [
            e
            for e in self.cur.portals
            if not e.same_group and e.score >= PORTAL_SCORE_MIN and self._allowed(e.to)
        ]
        at = max(0, bar + 1)
        close = [e for e in others if e.from_bar in (at, at + 1)]
        if close:
            e = max(close, key=self._rank)
            return Move("portal", e.to, e.to_bar, e.from_bar, e.pair, e.score)
        if others:
            e = max(others, key=self._rank)
            return Move("cut", e.to, e.to_bar, at, e.pair, e.score)
        return self._cut("cut", at)

    # ── moving ───────────────────────────────────────────────────────────────

    def arrive(self, m: Move) -> None:
        self.history.append((self._key(self.cur), self.t))
        came = (self.cur.id, m.at, m.to_bar) if m.kind == "portal" else None
        self.enter(m.to, m.to_bar, came)


def walk_path(
    graph: dict, start: str, minutes: float, seed: int = 0, pool: set | None = None
) -> tuple:
    """A whole walk: (segments, log). A segment is (track, start_bar, end_bar); log entries are
    the moves and loops with the time they happen at."""
    w = MixWalk(graph, start, seed=seed, pool=pool)
    segs: list = []
    log: list = []
    seg_start, bar = 0, 0
    target = minutes * 60.0
    guard = 0
    while w.t < target and guard < 200000:
        guard += 1
        r = w.step(bar)
        if isinstance(r, Move):
            if bar > seg_start:
                segs.append((w.cur.id, seg_start, bar))
            if r.kind == "end":
                segs.append(("gap", REPEAT_ONE_GAP_S, 0))
                w.t += REPEAT_ONE_GAP_S
            log.append(
                {
                    "at_s": round(w.t, 2),
                    "kind": r.kind,
                    "from": w.cur.id,
                    "from_bar": bar,
                    "to": r.to,
                    "to_bar": r.to_bar,
                    "pair": r.pair,
                    "score": round(r.score, 3),
                }
            )
            w.arrive(r)
            seg_start = bar = r.to_bar
            continue
        if isinstance(r, tuple):  # a Forever jump inside the song
            if bar > seg_start:
                segs.append((w.cur.id, seg_start, bar))
            log.append(
                {
                    "at_s": round(w.t, 2),
                    "kind": "jump",
                    "from": w.cur.id,
                    "from_bar": bar,
                    "to": w.cur.id,
                    "to_bar": r[1],
                    "pair": r[4],
                    "score": round(r[2], 3),
                }
            )
            seg_start = r[1]
            bar = r[1] + 1
            continue
        bar += 1
    if bar > seg_start:
        segs.append((w.cur.id, seg_start, bar))
    return segs, log


def load_walk_graph(folder) -> dict:
    """id -> TrackInfo from the bundles and `.saics/portals.json` (skips what a walk can't use)."""
    import json
    from pathlib import Path

    from saics.portals import read_graph

    folder = Path(folder)
    pg = read_graph(folder)
    out = {}
    for tid, t in pg.tracks.items():
        p = folder / ".saics" / "tracks" / f"{tid}.json"
        d = json.loads(p.read_text(encoding="utf-8"))
        beats = np.asarray(d["beats"], float)
        down = d["downbeats"]
        bar_t = beats[down].copy()
        bar_t[-1] = max(bar_t[-1], d["track"]["duration_s"])
        out[tid] = TrackInfo(
            id=tid,
            group=t.group,
            bar_t=bar_t,
            sections=[
                (s["start_bar"], s["end_bar"], s["group"], k)
                for s, k in zip(d["sections"], t.sections, strict=True)
            ],
            jumps=[
                (j["from_bar"], j["to_bar"], j["score"], j["kind"], j["label"]) for j in d["jumps"]
            ],
            portals=t.portals,
            entries=t.entries,
            break_exits=t.break_exits,
            bpm=t.bpm,
            outro_bar=d.get("outro_bar") or None,
            loopable=d.get("loopable", True),
        )
    return out
