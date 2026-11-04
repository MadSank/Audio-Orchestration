"""P4a: the Mix Web as cross-song portals.

A portal from (song A, bar a) to (song B, bar b) means: instead of playing bar a of A, continue
at bar b of B, the same way a Forever jump works inside one song (saics.jumps): the 4 bars
leading in and the 4 bars leading out must match, compared on the same bar-slot features plus
absolute chroma (the songs have no shared repeat structure to lean on, and there is no key
shift or time-stretch until P4b).

Owner's rules (PLAN P4a):
* edges only between songs with close tempo (within TEMPO_TOL) and compatible keys (Camelot:
  same, +-1, relative) and the same meter;
* seams land on phrase boundaries of both songs, never across a sung line;
* same-section-type pairs (chorus -> chorus, break -> intro) and breaks are preferred;
* portals into another version of the same song group are kept but flagged: the walk only uses
  them when Forever is on.

Round 3 added: seams whose levels are too far apart for a landing trim to hide are rejected
(saics.seams measures them), each edge carries a landing nudge that lines the beats up, and Lofi
VHS files (too degraded for a transition) are out of the walk but stay pickable as versions.

Written to `<folder>/.saics/portals.json` (schema saics.portals/2, `schema.PortalGraph`), with
what the walk needs per song: section kinds, entries for fallback cuts, break exits, bar levels.
The phone reads this file and never does pairwise analysis.
"""

import csv
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from saics import seams
from saics.schema import PORTALS_SCHEMA, PortalEdge, PortalGraph, PortalTrack
from saics.structure import bar_slot_features, standardize

TEMPO_TOL = 0.05  # no time-stretch until P4b; 5% is where the graph connects (21 -> 115 songs)
CTX = 4  # bars before and after the seam
HARM_MIN = 0.72  # mean absolute-chroma similarity along the seam (same chords)
SIM_MIN = 0.12  # mean bar-slot similarity along the seam
VOCAL_EDGE_MAX = 0.3  # a sung line may not run across either side of the seam
SCORE_MIN = 0.60
LEVEL_MAX_DB = seams.TRIM_MAX_DB  # a level step the landing trim can't fully absorb is rejected
MIN_EXIT_S = 30.0  # exits this early can never be used (dwell rule)
MIN_LAND_LEFT_S = 60.0  # the landing must leave room to dwell before the song ends
PER_SONG = 16  # out-edges kept per song ...
PER_TARGET = 3  # ... at most this many into one target song
EXIT_SPACING = 4  # bars between kept exits from one song to one target
FEEDBACK_FILE = "portal_feedback.csv"

PAIR_PREF = {
    ("chorus", "chorus"): 1.0,
    ("break", "intro"): 1.0,
    ("break", "break"): 1.0,
    ("break", "chorus"): 0.8,
    ("verse", "verse"): 0.7,
    ("inst", "inst"): 0.7,
    ("intro", "intro"): 0.6,
    ("verse", "chorus"): 0.5,
    ("chorus", "verse"): 0.3,
}


def walkable(file: str) -> bool:
    return "lofi vhs" not in file.lower()


def camelot_compatible(a: str, b: str) -> bool:
    """Same key, a neighbour on the wheel (+-1, same letter), or the relative major/minor."""
    if not a or not b:
        return False
    na, la, nb, lb = int(a[:-1]), a[-1], int(b[:-1]), b[-1]
    if la == lb:
        return (na - nb) % 12 in (0, 1, 11)
    return na == nb


def tempo_close(a: float, b: float, tol: float = TEMPO_TOL) -> bool:
    return a > 0 and b > 0 and abs(a - b) / min(a, b) <= tol


def section_kinds(sections: list, energy: np.ndarray, vocal: np.ndarray, breaks: list,
                  bar_t: np.ndarray) -> list:  # fmt: skip
    """Functional label per section from repeats, energy and vocals (no labelled model yet):

    chorus = the repeated group(s) with the highest energy; intro/outro = a first/last section
    that doesn't repeat; break = a section holding a detected break or a sharp energy dip;
    verse = other sung sections; inst = the rest."""
    n = len(energy)
    if not sections:
        return []
    groups: dict = {}
    for s in sections:
        groups.setdefault(s["group"], []).append(s)

    def mean(arr, s):
        x = arr[s["start_bar"] : min(s["end_bar"], n)]
        return float(x.mean()) if len(x) else 0.0

    typical = float(np.median(energy)) if n else 0.0
    rep = {g: float(np.mean([mean(energy, s) for s in ss]))
           for g, ss in groups.items() if len(ss) >= 2}  # fmt: skip
    top = max(rep.values(), default=0.0)
    chorus = {g for g, e in rep.items() if e >= 0.92 * top and e >= typical * 0.95}
    br_bars = set()
    for b in breaks:
        br_bars.add(int(np.searchsorted(bar_t, b["start_s"], side="right") - 1))
    out = []
    for k, s in enumerate(sections):
        e, v = mean(energy, s), mean(vocal, s)
        repeats = len(groups[s["group"]]) >= 2
        has_break = any(s["start_bar"] <= b < s["end_bar"] for b in br_bars)
        if k == 0 and not repeats and s["end_bar"] - s["start_bar"] <= 16 and e < typical * 1.1:
            kind = "intro"
        elif k == len(sections) - 1 and not repeats:
            kind = "outro"
        elif has_break or (e < 0.55 * typical and v < 0.3):
            kind = "break"
        elif s["group"] in chorus:
            kind = "chorus"
        elif v >= 0.3:
            kind = "verse"
        else:
            kind = "inst"
        out.append(kind)
    return out


@dataclass
class Song:
    id: str
    file: str
    group: str
    bpm: float
    camelot: str
    meter: int
    stable: bool
    bar_t: np.ndarray  # (n + 1,)
    x: np.ndarray  # (n, D) standardised bar-slot features
    chroma: np.ndarray  # (n, 12) unit bar chroma
    vocal_edge: np.ndarray  # (n,)
    energy: np.ndarray  # (n,)
    kinds: list  # per section
    bar_kind: list  # per bar
    phrase: np.ndarray  # bars on a phrase boundary
    exits: np.ndarray  # phrase bars usable as exits
    lands: np.ndarray  # phrase bars usable as landings
    entries: list  # landing bars for fallback cuts, best first
    break_exits: list  # bars where a cut into a break is natural
    down: np.ndarray | None = None  # beat index of each downbeat
    beats: np.ndarray | None = None
    beats_fine: np.ndarray | None = None  # saics.seams; None when not measured yet
    level_out: np.ndarray | None = None
    level_in: np.ndarray | None = None
    env: np.ndarray | None = None


def load_song(t: dict, saics_dir: Path) -> Song | None:
    bpath = saics_dir / "tracks" / f"{t['id']}.json"
    fpath = saics_dir / "features" / f"{t['id']}.npz"
    if not bpath.exists() or not fpath.exists():
        return None
    d = json.loads(bpath.read_text(encoding="utf-8"))
    down, beats = d["downbeats"], np.asarray(d["beats"], float)
    f = np.load(fpath)
    bars = bar_slot_features(np.asarray(f["beat_feats"]), down)
    n = len(bars)
    if n < 2 * CTX + 2 or not d["sections"]:
        return None
    ab = list(zip(down[:-1], down[1:], strict=True))[:n]
    vocal = np.asarray(d["vocal_activity"], float)
    ch = np.asarray(f["chroma"])
    chroma = np.array([ch[:, a:b].mean(1) if b > a else np.zeros(12) for a, b in ab])
    chroma = chroma / (np.linalg.norm(chroma, axis=1, keepdims=True) + 1e-9)
    bar_t = beats[down[: n + 1]]
    if len(bar_t) == n:
        bar_t = np.r_[bar_t, d["track"]["duration_s"]]
    bar_t = bar_t.copy()
    bar_t[-1] = max(bar_t[-1], d["track"]["duration_s"])
    energy = np.asarray(d["bar_energy"], float)[:n]
    vbar = np.array([vocal[a:b].max() if b > a else 0.0 for a, b in ab])
    kinds = section_kinds(d["sections"], energy, vbar, d.get("breaks", []), bar_t)
    bar_kind = ["inst"] * n
    phrase = set()
    for s, k in zip(d["sections"], kinds, strict=True):
        for b in range(s["start_bar"], min(s["end_bar"], n)):
            bar_kind[b] = k
            if (b - s["start_bar"]) % 4 == 0:
                phrase.add(b)
    phrase_a = np.array(sorted(phrase))
    exits = phrase_a[(phrase_a >= CTX) & (phrase_a < n - CTX) & (bar_t[phrase_a] >= MIN_EXIT_S)]
    lands = phrase_a[(phrase_a >= CTX) & (phrase_a < n - CTX)
                     & (bar_t[-1] - bar_t[phrase_a] >= MIN_LAND_LEFT_S)]  # fmt: skip
    # Fallback landings: where the music comes back after a break, chorus starts, then the top.
    entries = []
    for br in d.get("breaks", []):
        if br.get("ramp_up"):
            b = int(np.searchsorted(bar_t, br["end_s"], side="left"))
            if 0 <= b < n and bar_t[-1] - bar_t[b] >= MIN_LAND_LEFT_S:
                entries.append(b)
    for s, k in zip(d["sections"], kinds, strict=True):
        if k == "chorus" and bar_t[-1] - bar_t[s["start_bar"]] >= MIN_LAND_LEFT_S:
            entries.append(s["start_bar"])
    entries = sorted(set(entries), key=entries.index) + [0]
    break_exits = sorted({int(np.searchsorted(bar_t, br["start_s"], side="right") - 1)
                          for br in d.get("breaks", [])} & set(range(n)))  # fmt: skip
    sp = saics_dir / "seams" / f"{t['id']}.npz"
    seam = np.load(sp) if sp.exists() else None
    return Song(
        id=t["id"], file=t["file"], group=t.get("group", ""), bpm=float(d["tempo"]["bpm"]),
        camelot=d["key"]["camelot"], meter=int(d["meter"]["beats_per_bar"]),
        stable=bool(d["tempo"]["stable"]), bar_t=bar_t, x=standardize(bars), chroma=chroma,
        vocal_edge=np.array([vocal[a - 1] if a > 0 else 0.0 for a in down[:n]]), energy=energy,
        kinds=kinds, bar_kind=bar_kind, phrase=phrase_a, exits=exits, lands=lands,
        entries=[int(x) for x in entries[:6]], break_exits=break_exits,
        down=np.asarray(down), beats=beats,
        beats_fine=None if seam is None else np.asarray(seam["beats_fine"]),
        level_out=None if seam is None else np.asarray(seam["level_out"], float),
        level_in=None if seam is None else np.asarray(seam["level_in"], float),
        env=None if seam is None else np.asarray(seam["env"]),
    )  # fmt: skip


def compatible(a: Song, b: Song) -> bool:
    return (a.id != b.id and a.stable and b.stable and a.meter == b.meter
            and tempo_close(a.bpm, b.bpm) and camelot_compatible(a.camelot, b.camelot))  # fmt: skip


def landing_offset_ms(a: Song, from_bar: int, b: Song, to_bar: int) -> float:
    """seams.landing_offset_ms for this seam; 0 until both songs are measured."""
    if a.beats_fine is None or b.beats_fine is None:
        return 0.0
    ba, bb = int(a.down[from_bar]), int(b.down[to_bar])
    ibi = float(np.median(np.diff(a.beats)))
    lag, peak = seams.onset_lag_ms(a.env, float(a.beats[ba]), b.env, float(b.beats[bb]),
                                   seams.XCORR_BEATS * ibi)  # fmt: skip
    return seams.landing_offset_ms(
        seams.grid_error_out(a.beats, a.beats_fine, ba),
        seams.grid_error_in(b.beats, b.beats_fine, bb),
        lag,
        peak,
    )


def match_pair(a: Song, b: Song, feedback: dict | None = None) -> list:
    """Scored portals a -> b (see module doc), best first: (score, from_bar, to_bar, ctx, harm)."""
    ex = a.exits[a.vocal_edge[a.exits] <= VOCAL_EDGE_MAX]
    la = b.lands[b.vocal_edge[b.lands] <= VOCAL_EDGE_MAX]
    if not len(ex) or not len(la):
        return []
    aa, bb = np.meshgrid(ex, la, indexing="ij")
    aa, bb = aa.ravel(), bb.ravel()
    k = np.arange(-CTX, CTX)
    ia, ib = aa[:, None] + k, bb[:, None] + k  # (pairs, 8)
    sim = np.sum(a.x[ia] * b.x[ib], axis=2)
    harm = np.sum(a.chroma[ia] * b.chroma[ib], axis=2)
    m_sim, m_harm, lo_harm = sim.mean(1), harm.mean(1), harm.min(1)
    if a.level_out is not None and b.level_in is not None:
        gap = np.abs(a.level_out[aa] - b.level_in[bb])
        step = gap / (3 * LEVEL_MAX_DB)  # 0 .. 1/3, the range the energy step below is scaled to
    else:
        gap = np.zeros(len(aa))
        step = np.abs(a.energy[aa] - b.energy[bb])
    out = []
    bans = (feedback or {}).get("ban", set())
    pins = (feedback or {}).get("keep", set())
    for i in range(len(aa)):
        fa, tb = int(aa[i]), int(bb[i])
        ka, kb = a.bar_kind[fa], b.bar_kind[tb]
        pref = PAIR_PREF.get((ka, kb), 0.0)
        pinned = (fa, tb) in pins
        if (fa, tb) in bans or (not pinned and gap[i] > LEVEL_MAX_DB):
            continue
        # The silence of a break carries the change: harmony and timbre matter less there.
        relaxed = ka == "break" and kb in ("intro", "break", "chorus")
        if not pinned and not relaxed and (m_harm[i] < HARM_MIN or m_sim[i] < SIM_MIN):
            continue
        score = (0.30 * min(1.0, max(0.0, float(m_sim[i])) / 0.5)
                 + 0.30 * max(0.0, float(m_harm[i]))
                 + 0.10 * max(0.0, float(lo_harm[i]))
                 + 0.20 * pref
                 + 0.10 * (1 - min(1.0, 3 * float(step[i]))))  # fmt: skip
        if relaxed:
            score = max(score, 0.62 + 0.2 * pref)
        if score < SCORE_MIN and not pinned:
            continue
        out.append(
            (max(score, 0.7) if pinned else score, fa, tb, float(m_sim[i]), float(m_harm[i]))
        )
    out.sort(reverse=True)
    return out


def read_feedback(saics_dir: Path, songs: dict) -> dict:
    """(from_id, to_id) -> {keep: {(a, b)}, ban: {(a, b)}} from .saics/portal_feedback.csv."""
    out: dict = {}
    p = Path(saics_dir) / FEEDBACK_FILE
    if not p.exists():
        return out
    by_file = {s.file: s for s in songs.values()}
    with p.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if len(row) < 5 or row[0] not in ("keep", "ban"):
                continue
            a, b = by_file.get(row[1]), by_file.get(row[3])
            if a and b:
                bars = (int(np.argmin(np.abs(a.bar_t - float(row[2])))),
                        int(np.argmin(np.abs(b.bar_t - float(row[4])))))  # fmt: skip
                out.setdefault((a.id, b.id), {"keep": set(), "ban": set()})[row[0]].add(bars)
    return out


def prune(cands: list, pins: set = frozenset()) -> list:
    """Per song: best target spread, PER_TARGET per target, EXIT_SPACING between exits. Portals
    the owner rated 5 (`pins`: (from_bar, to, to_bar)) always stay."""
    kept: list = []
    per_target: dict = {}
    used: dict = {}
    key = lambda c: ((c["from_bar"], c["to"], c["to_bar"]) not in pins, -c["score"])  # noqa: E731
    for c in sorted(cands, key=key):
        t = c["to"]
        pinned = (c["from_bar"], t, c["to_bar"]) in pins
        if not pinned and per_target.get(t, 0) >= PER_TARGET:
            continue
        if not pinned and any(abs(c["from_bar"] - x) < EXIT_SPACING for x in used.get(t, [])):
            continue
        per_target[t] = per_target.get(t, 0) + 1
        used.setdefault(t, []).append(c["from_bar"])
        kept.append(c)
        if len(kept) >= PER_SONG:
            break
    return sorted(kept, key=lambda c: c["from_bar"])


def build_graph(folder: Path, log=print) -> PortalGraph:
    folder = Path(folder).resolve()
    sd = folder / ".saics"
    lib = json.loads((sd / "library.json").read_text(encoding="utf-8"))
    songs: dict = {}
    for t in lib["tracks"]:
        if t.get("class", "music") == "music":
            s = load_song(t, sd)
            if s:
                songs[s.id] = s
    feedback = read_feedback(sd, songs)
    log(f"portals: {len(songs)} songs loaded")
    edges: dict = {sid: [] for sid in songs}
    pairs = 0
    for a in songs.values():
        for b in songs.values():
            if not compatible(a, b) or not walkable(b.file):
                continue
            pairs += 1
            for score, fa, tb, ctx, harm in match_pair(a, b, feedback.get((a.id, b.id))):
                edges[a.id].append({
                    "from_bar": fa, "to": b.id, "to_bar": tb, "score": round(score, 4),
                    "pair": f"{a.bar_kind[fa]} → {b.bar_kind[tb]}", "context": round(ctx, 3),
                    "harmony": round(harm, 3), "same_group": bool(a.group) and a.group == b.group,
                    "two_way": False,
                })  # fmt: skip
    pins = {sid: {(fa, to, tb) for (a, to), fb in feedback.items() if a == sid
                  for fa, tb in fb["keep"]} for sid in songs}  # fmt: skip
    kept = {sid: prune(cs, pins[sid]) for sid, cs in edges.items()}
    for sid, es in kept.items():
        for e in es:
            e["offset_ms"] = round(
                landing_offset_ms(songs[sid], e["from_bar"], songs[e["to"]], e["to_bar"]), 1
            )
    index = {(sid, e["from_bar"], e["to"], e["to_bar"]) for sid, es in kept.items() for e in es}
    for sid, es in kept.items():
        for e in es:
            e["two_way"] = (e["to"], e["to_bar"], sid, e["from_bar"]) in index
    n_edges = sum(len(es) for es in kept.values())
    log(f"portals: {pairs} compatible song pairs, {n_edges} portals kept")
    return PortalGraph(
        schema=PORTALS_SCHEMA, generated=time.strftime("%Y-%m-%dT%H:%M:%S"),
        tracks={s.id: PortalTrack(
            file=s.file, group=s.group, bpm=round(s.bpm, 2), camelot=s.camelot,
            sections=s.kinds, bars=len(s.x), entries=s.entries, break_exits=s.break_exits,
            portals=[PortalEdge(**e) for e in kept[s.id]],
            level_out=[] if s.level_out is None else [round(float(x), 1) for x in s.level_out],
            level_in=[] if s.level_in is None else [round(float(x), 1) for x in s.level_in],
            walkable=walkable(s.file),
        ) for s in songs.values()},
    )  # fmt: skip


def write_graph(folder: Path, log=print) -> PortalGraph:
    g = build_graph(folder, log=log)
    out = Path(folder).resolve() / ".saics" / "portals.json"
    out.write_text(g.model_dump_json(by_alias=True), encoding="utf-8")
    log(f"wrote {out} ({out.stat().st_size // 1024} KB)")
    return g


def read_graph(folder: Path) -> PortalGraph:
    p = Path(folder) / ".saics" / "portals.json"
    return PortalGraph.model_validate_json(p.read_text(encoding="utf-8"))
