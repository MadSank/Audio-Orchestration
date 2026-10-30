"""P3: structural jumps for the single-song infinite loop (Forever), and the Forever walk.

A jump from bar `a` to bar `b` means: instead of playing bar a, continue at bar b.
It is only allowed between *equivalent positions in two instances of the same repeat
group*: a diagonal stripe in the bar self-similarity matrix, so the 4 bars leading in and
the 4 bars leading out must match too. Owner's design (PLAN P3):

* no jumps within one section instance; distance >= one full section and >= 16 bars,
  >= 30 s preferred;
* **direct alignment** (round 2 near-misses): the target bar is the offset (within +-4 bars)
  that best aligns vocal-stem chroma + vocal onsets + mix chroma around the seam, and that
  offset must be a clear peak over its +-1 / +-2 bar neighbours, otherwise no jump;
* lyric/melody continuity: vocal-stem chroma of the bar after the seam vs the bar that
  would have played;
* breaks are anchors (break -> equivalent break);
* Forever pacing: one jump every 60-120 s, never two jumps within one section instance.

Forever endings (owner, round 2): there is no song-end -> post-intro jump. In order:
(a) a backward repeat jump before the outro, so the ending never arrives; (b) else a
break -> break loop; (c) else another version of the same song; (d) else "repeat one":
the outro finishes, a short gap, the song restarts. Songs marked not loopable go straight
to (c)/(d).
"""

from dataclasses import dataclass, field

import numpy as np

from saics.schema import Jump
from saics.structure import diagonal_similarity, section_labels, standardize

CONTEXT_BARS = 4  # bars that must match before and after the seam
MIN_JUMP_BARS = 16
PREFERRED_JUMP_S = 30.0
CTX_MEAN = 0.55  # mean similarity along the stripe ...
CTX_MIN = 0.20  # ... and no single bar pair below this
STRONG_STRIPE = 0.70  # a stripe this strong counts as a repeat even if segmentation disagrees
PER_SECONDS = 20.0  # keep about one jump source per 20 s of music
ALIGN_BARS = 4  # direct alignment searches the target within +-4 bars …
ALIGN_MARGIN = 0.04  # … and the best offset must beat its +-1/+-2 bar neighbours by this
REUSE_PENALTY = 0.3  # Forever walk: score penalty per earlier use of the same jump …
TAKE_MIN = 0.6  # … and a (penalised) jump below this is skipped: keep playing instead
REPEAT_ONE_GAP_S = 1.5  # (d) silence between the end and the restart
AVOID_MAX_USES = 2  # an "avoid the ending" loop is used at most twice (no short-loop circling)


@dataclass
class BarInfo:
    """Everything the jump finder needs."""

    bar_t: np.ndarray  # (n_bars + 1,) bar start times; last = end of the last bar
    feats: np.ndarray  # (n_bars, D) bar-slot features (chroma + MFCC1-13 + onset)
    vocal_chroma: np.ndarray  # (n_bars, 12) vocal-stem chroma
    vocal: np.ndarray  # (n_bars,) max vocal activity in the bar
    vocal_edge: np.ndarray  # (n_bars,) vocal activity on the last beat before the bar starts
    energy: np.ndarray  # (n_bars,)
    duration: float
    # Beat-level sequences for direct alignment (optional: without them, no alignment).
    downbeats: list = field(default_factory=list)
    beat_vchroma: np.ndarray | None = None  # (12, n_beats) vocal-stem chroma
    beat_vonset: np.ndarray | None = None  # (n_beats,) vocal-stem onset strength
    beat_chroma: np.ndarray | None = None  # (12, n_beats) mix chroma
    beat_vocal: np.ndarray | None = None  # (n_beats,) vocal activity
    # Owner feedback from eval ratings: (from_bar, to_bar) pairs always kept / never used.
    pin: list = field(default_factory=list)
    ban: list = field(default_factory=list)


def _section_index(sections: list, n_bars: int) -> np.ndarray:
    idx = np.full(n_bars, -1)
    for k, s in enumerate(sections):
        idx[s.start_bar : min(s.end_bar, n_bars)] = k
    return idx


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def _colcos(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    num = (x * y).sum(0)
    return num / (np.linalg.norm(x, axis=0) * np.linalg.norm(y, axis=0) + 1e-9)


def align_scores(info: BarInfo, a: int, b: int, search: int = ALIGN_BARS) -> dict:
    """{bar offset k: score} for jumping from bar a to bar b+k (k in -search..search).

    Compares the beats of the 4 bars before and after the seam at `a` with those around
    `b + k`: vocal-stem chroma weighted by vocal activity on both sides, vocal-onset
    correlation, and mix chroma. Bars, not beats, are shifted: jumps stay on downbeats."""
    db = info.downbeats
    if info.beat_chroma is None or not db:
        return {}
    n_beats = info.beat_chroma.shape[1]
    bpb = int(np.median(np.diff(db))) if len(db) > 1 else 4
    w = CONTEXT_BARS * bpb
    A = db[a] if a < len(db) else None
    if A is None or A - w < 0 or A + w > n_beats:
        return {}
    out = {}
    for k in range(-search, search + 1):
        bk = b + k
        if bk < 0 or bk >= len(db):
            continue
        B = db[bk]
        if B - w < 0 or B + w > n_beats or abs(B - A) < MIN_JUMP_BARS * bpb // 2:
            continue
        sa, sb = slice(A - w, A + w), slice(B - w, B + w)
        mix = float(np.mean(_colcos(info.beat_chroma[:, sa], info.beat_chroma[:, sb])))
        wv = np.minimum(info.beat_vocal[sa], info.beat_vocal[sb])
        if wv.sum() > 0.5 * bpb:  # enough sung beats on both sides to compare melodies
            cc = _colcos(info.beat_vchroma[:, sa], info.beat_vchroma[:, sb])
            voc = float(np.sum(cc * wv) / wv.sum())
            oa, ob = info.beat_vonset[sa], info.beat_vonset[sb]
            ons = float(np.corrcoef(oa, ob)[0, 1]) if oa.std() > 0 and ob.std() > 0 else 0.0
            out[k] = 0.5 * voc + 0.2 * ons + 0.3 * mix
        else:
            out[k] = mix
    return out


def best_alignment(info: BarInfo, a: int, b: int) -> tuple:
    """(offset k, clear): move the target only when another bar offset aligns clearly better.

    Round-2 study (owner's ratings): misalignment explained 1 of 6 near-misses, and a strict
    "clear peak or no jump" rule would have dropped 12 of the 51 jumps rated 5 (repetitive
    passages align equally well at several offsets). So alignment *corrects* (k != 0 only if
    it beats offset 0 by ALIGN_MARGIN and its own +-1/+-2 neighbours) and never vetoes."""
    s = align_scores(info, a, b)
    if not s or 0 not in s:
        return 0, True  # no beat-level features: keep the stripe's offset
    k = max(s, key=s.get)
    if k == 0 or s[k] - s[0] < ALIGN_MARGIN:
        return 0, True
    rivals = [s[k + d] for d in (-2, -1, 1, 2) if (k + d) in s]
    if rivals and s[k] - max(rivals) < ALIGN_MARGIN / 2:
        return 0, True  # no clear peak elsewhere either: keep the stripe's offset
    return k, True


def find_jumps(info: BarInfo, sections: list, breaks: list, downbeats: list) -> list:
    """Structural jump candidates, aligned, scored and pruned (see module doc)."""
    n = len(info.feats)
    if n < 2 * MIN_JUMP_BARS or not sections:
        return []
    x = standardize(info.feats)
    ssm = x @ x.T
    sec = _section_index(sections, n)
    labels = section_labels(sections)
    sec_len = np.array([s.end_bar - s.start_bar for s in sections])
    if not info.downbeats:
        info.downbeats = list(downbeats)

    def label(bar: int) -> str:
        k = sec[bar] if 0 <= bar < n else -1
        return f"{labels[k]}:{bar - sections[k].start_bar + 1}" if k >= 0 else f"end:{bar}"

    def lyric(a: int, b: int) -> float:
        va, vb = info.vocal[a] > 0.3, info.vocal[b] > 0.3
        if not va and not vb:
            return 1.0  # instrumental on both sides: nothing to break
        if va != vb:
            return 0.3  # a sung line appears or disappears at the seam
        return max(0.0, _cos(info.vocal_chroma[a], info.vocal_chroma[b]))

    cands = []
    for a in range(CONTEXT_BARS, n - CONTEXT_BARS):
        for b in range(CONTEXT_BARS, n - CONTEXT_BARS):
            dist_bars = abs(a - b)
            if dist_bars < MIN_JUMP_BARS or sec[a] == sec[b] or sec[a] < 0 or sec[b] < 0:
                continue
            if dist_bars < max(sec_len[sec[a]], sec_len[sec[b]]):
                continue  # at least one full section away
            diag = diagonal_similarity(ssm, a, b, CONTEXT_BARS, CONTEXT_BARS)
            if len(diag) < 2 * CONTEXT_BARS:
                continue
            m, lo = float(diag.mean()), float(diag.min())
            same_group = sections[sec[a]].group == sections[sec[b]].group
            if lo < CTX_MIN or m < (CTX_MEAN if same_group else STRONG_STRIPE):
                continue
            cands.append((a, b, m, lo))

    # Direct alignment: move the target to the clearly best-aligned bar, or drop the jump.
    scored = []
    seen = set()
    for a, b, m, lo in cands:
        k, clear = best_alignment(info, a, b)
        if not clear:
            continue
        b2 = b + k
        if (a, b2) in seen or not (0 <= b2 < n) or abs(a - b2) < MIN_JUMP_BARS or sec[b2] == sec[a]:
            continue
        seen.add((a, b2))
        ly = lyric(a, b2)
        # A vocal phrase running across the seam must continue as the same line.
        if info.vocal_edge[a] > 0.3 and info.vocal[a] > 0.3 and ly < 0.7:
            continue
        dist_s = abs(info.bar_t[b2] - info.bar_t[a])
        dist_pref = min(1.0, dist_s / PREFERRED_JUMP_S)
        step = abs(float(info.energy[a]) - float(info.energy[b2]))
        score = 0.45 * m + 0.15 * lo + 0.2 * ly + 0.1 * dist_pref + 0.1 * (1 - min(1, 3 * step))
        scored.append((score, a, b2, "repeat", m, ly, dist_s))

    # Breaks: equivalent break -> break (same position relative to the break), relaxed lead-in.
    bstart = {}
    for br in breaks:
        bar = int(np.searchsorted(downbeats, br.end_beat, side="right") - 1)
        if 0 <= bar < n and br.ramp_up:
            bstart[bar] = br
    for a in bstart:
        for b in bstart:
            if a == b or abs(a - b) < MIN_JUMP_BARS:
                continue
            after = diagonal_similarity(ssm, a, b, 0, CONTEXT_BARS)
            if len(after) == CONTEXT_BARS and after.mean() >= CTX_MEAN - 0.1:
                dist_s = abs(info.bar_t[b] - info.bar_t[a])
                score = 0.6 * float(after.mean()) + 0.25 + 0.1 * min(1.0, dist_s / PREFERRED_JUMP_S)
                scored.append((score, a, b, "break", float(after.mean()), lyric(a, b), dist_s))

    # Owner feedback (eval ratings): banned pairs never appear; pinned pairs always do.
    bans = {tuple(x) for x in info.ban}
    scored = [c for c in scored if (c[1], c[2]) not in bans]
    pinned = []
    for a, b in info.pin:
        hit = [c for c in scored if (c[1], c[2]) == (a, b)]
        if hit:
            pinned.append(hit[0])
        elif 0 <= a < n and 0 <= b < n:
            diag = diagonal_similarity(ssm, a, b, CONTEXT_BARS, CONTEXT_BARS)
            m = float(diag.mean()) if len(diag) else 0.0
            pinned.append(
                (max(0.7, m), a, b, "repeat", m, lyric(a, b), abs(info.bar_t[b] - info.bar_t[a]))
            )

    # Prune: best target per source bar, then about one source per 20 s, spread out.
    best: dict = {}
    for c in sorted(scored, reverse=True):
        best.setdefault(c[1], c)
    keep_n = max(2, int(info.duration / PER_SECONDS))
    chosen: list = list(pinned)
    for c in sorted(best.values(), reverse=True):
        if any(abs(c[1] - o[1]) < 4 for o in chosen):
            continue
        chosen.append(c)
        if len(chosen) >= keep_n + len(pinned):
            break

    out = []
    for score, a, b, kind, ctx, ly, dist_s in sorted(chosen, key=lambda c: c[1]):
        out.append(Jump(
            from_beat=int(downbeats[a]), to_beat=int(downbeats[b]), from_bar=int(a), to_bar=int(b),
            score=round(float(score), 4), kind=kind, xfade_ms=10.0 if kind == "break" else 30.0,
            label=f"{label(a)} → {label(b)}", context=round(ctx, 3), lyric=round(ly, 3),
            distance_s=round(float(dist_s), 2),
        ))  # fmt: skip
    return out


def outro_bar(sections: list, n_bars: int) -> int:
    """Bar where the ending starts: the last section if it never repeats, else the song end."""
    if len(sections) >= 3:
        last = sections[-1]
        if sum(s.group == last.group for s in sections) == 1:
            return last.start_bar
    return n_bars


# ── Forever walk ──────────────────────────────────────────────────────────────


def forever_path(bar_t: np.ndarray, sections: list, jumps: list, minutes: float, seed: int = 0,
                 pace=(60.0, 120.0), outro: int | None = None, loopable: bool = True,
                 has_versions: bool = False) -> tuple:  # fmt: skip
    """Bars to play for a Forever render of `minutes`, and the jump log.

    Returns (segments, log); a segment is (start_s, end_s), ("gap", seconds) or
    ("switch", None). The ending follows the owner's priority (module doc): a backward repeat
    jump before the outro, else a break loop, else a version switch (`has_versions`), else
    repeat-one.
    """
    rng = np.random.default_rng(seed)
    n = len(bar_t) - 1
    outro = n if outro is None else outro
    sec = _section_index(sections, n)
    by_from: dict = {}
    for j in jumps:
        if j.kind in ("repeat", "break"):
            by_from.setdefault(j.from_bar, []).append(j)
    # Last chance to avoid the ending: the latest backward jump whose source is before the
    # outro (a repeat jump if any, else a break loop).
    back = [j for js in by_from.values() for j in js if j.to_bar < j.from_bar <= outro]
    last_back = max((j.from_bar for j in back if j.kind == "repeat"), default=None)
    if last_back is None:
        last_back = max((j.from_bar for j in back if j.kind == "break"), default=None)
    if not loopable:
        last_back = None  # owner override: endings go straight to (c)/(d)

    target = minutes * 60.0
    segs, log = [], []
    state = {"bar": 0, "start": 0, "landed": -2, "next": rng.uniform(*pace)}
    t = 0.0
    recent: list = []  # (out_time, bar) of played bars, to avoid landing in the last 60 s
    used: dict = {}  # jump label -> times taken; reuse is penalised so the walk explores

    def take(j: Jump, why: str):
        bar = state["bar"]
        segs.append((bar_t[state["start"]], bar_t[min(bar, n)]))
        src, _, dst = j.label.partition(" → ")
        log.append({"at_s": round(t, 2), "from": src, "to": dst or src, "kind": j.kind,
                    "why": why, "from_s": round(float(bar_t[min(bar, n)]), 2),
                    "to_s": round(float(bar_t[j.to_bar]), 2)})  # fmt: skip
        used[j.label] = used.get(j.label, 0) + 1
        state.update(
            bar=j.to_bar, start=j.to_bar, landed=sec[j.to_bar], next=t + rng.uniform(*pace)
        )

    while t < target:
        bar = state["bar"]
        here = by_from.get(bar, [])
        fresh = {b for (tt, b) in recent if t - tt < 60.0}
        # (a)/(b) The last backward jump before the outro is always taken: no ending.
        if last_back is not None and bar == last_back:
            # A loop that is used up (taken AVOID_MAX_USES times) is no longer an option: the
            # ending then falls through to (c) another version / (d) repeat-one.
            usable = [j for j in here if j.to_bar < bar and used.get(j.label, 0) < AVOID_MAX_USES]
            options = [j for j in usable if j.to_bar not in fresh] or usable
            if options:
                # Prefer repeat over break, then less-used and farther-back targets (variety).
                def pref(j, bar=bar):
                    reuse = REUSE_PENALTY * used.get(j.label, 0)
                    return (j.kind == "repeat", j.score - reuse + 0.002 * (bar - j.to_bar))

                take(max(options, key=pref), "avoid the ending")
                continue
        if t >= state["next"] and here and bar < n and sec[bar] != state["landed"]:
            # Never land within a minute of the last chance to avoid the ending (or of the
            # end): that would force another jump right away and ping-pong.
            limit = last_back if last_back is not None else n
            options = [j for j in here if j.to_bar not in fresh
                       and j.score - REUSE_PENALTY * used.get(j.label, 0) >= TAKE_MIN
                       and bar_t[limit] - bar_t[j.to_bar] >= pace[0]]  # fmt: skip
            if options:
                j = max(options, key=lambda j: j.score - REUSE_PENALTY * used.get(j.label, 0)
                        + rng.uniform(0, 0.02))  # fmt: skip
                take(j, "pacing")
                continue
        if bar >= n:  # the ending arrived: (c) another version, else (d) repeat one
            segs.append((bar_t[state["start"]], bar_t[n]))
            if has_versions:
                log.append({"at_s": round(t, 2), "from": "end", "to": "another version",
                            "kind": "switch", "why": "song end"})  # fmt: skip
                segs.append(("switch", None))
                return segs, log
            log.append({"at_s": round(t, 2), "from": "end", "to": "start", "kind": "repeat_one",
                        "why": "song end"})  # fmt: skip
            segs.append(("gap", REPEAT_ONE_GAP_S))
            t += REPEAT_ONE_GAP_S
            state.update(bar=0, start=0, landed=-2, next=t + rng.uniform(*pace))
            continue
        recent.append((t, bar))
        t += bar_t[bar + 1] - bar_t[bar]
        state["bar"] = bar + 1
    segs.append((bar_t[state["start"]], bar_t[min(state["bar"], n)]))
    return segs, log
