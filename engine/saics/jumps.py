"""P3: structural jumps for the single-song infinite loop (Forever), and the Forever walk.

A jump from bar `a` to bar `b` means: instead of playing bar a, continue at bar b.
It is only allowed between *equivalent positions in two instances of the same repeat
group*, which shows up as a diagonal stripe in the bar self-similarity matrix, so the
4 bars leading in and the 4 bars leading out must match too. Owner's design (PLAN P3):

* no jumps within one section instance; distance >= one full section and >= 16 bars,
  >= 30 s preferred;
* lyric/melody continuity: vocal-stem chroma of the bar after the seam vs the bar that
  would have played;
* breaks are anchors (break -> equivalent break), plus song end -> post-intro;
* Forever pacing: one jump every 60-120 s, never two jumps within one section instance.
"""

from dataclasses import dataclass

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


@dataclass
class BarInfo:
    """Everything the jump finder needs, per bar."""

    bar_t: np.ndarray  # (n_bars + 1,) bar start times; last = end of the last bar
    feats: np.ndarray  # (n_bars, D) bar-slot features (chroma + MFCC1-13 + onset)
    vocal_chroma: np.ndarray  # (n_bars, 12) vocal-stem chroma
    vocal: np.ndarray  # (n_bars,) max vocal activity in the bar
    vocal_edge: np.ndarray  # (n_bars,) vocal activity on the last beat before the bar starts
    energy: np.ndarray  # (n_bars,)
    duration: float


def _section_index(sections: list, n_bars: int) -> np.ndarray:
    idx = np.full(n_bars, -1)
    for k, s in enumerate(sections):
        idx[s.start_bar : min(s.end_bar, n_bars)] = k
    return idx


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def find_jumps(info: BarInfo, sections: list, breaks: list, downbeats: list) -> list:
    """Structural jump candidates, scored and pruned (see module doc)."""
    n = len(info.feats)
    if n < 2 * MIN_JUMP_BARS or not sections:
        return []
    x = standardize(info.feats)
    ssm = x @ x.T
    sec = _section_index(sections, n)
    labels = section_labels(sections)
    sec_len = np.array([s.end_bar - s.start_bar for s in sections])

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
            ly = lyric(a, b)
            # A vocal phrase running across the seam must continue as the same line.
            across = info.vocal_edge[a] > 0.3 and info.vocal[a] > 0.3
            if across and ly < 0.7:
                continue
            dist_s = abs(info.bar_t[b] - info.bar_t[a])
            dist_pref = min(1.0, dist_s / PREFERRED_JUMP_S)
            step = abs(float(info.energy[a]) - float(info.energy[b]))
            score = 0.45 * m + 0.15 * lo + 0.2 * ly + 0.1 * dist_pref + 0.1 * (1 - min(1, 3 * step))
            cands.append((score, a, b, "repeat", m, ly, dist_s))

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
                cands.append((score, a, b, "break", float(after.mean()), lyric(a, b), dist_s))

    # Song end -> post-intro: from the last bar boundary back to the first bar after the intro.
    if len(sections) >= 3:
        post_intro = sections[1].start_bar
        last = sections[-1]
        end_from = last.start_bar if sum(s.group == last.group for s in sections) == 1 else n
        dist_s = info.bar_t[min(end_from, n)] - info.bar_t[post_intro]
        if dist_s >= PREFERRED_JUMP_S:
            cands.append((0.5, end_from, post_intro, "end", 0.0, 1.0, dist_s))

    # Prune: best target per source bar, then about one source per 20 s, spread out.
    best: dict = {}
    for c in sorted(cands, reverse=True):
        best.setdefault(c[1], c)
    keep_n = max(2, int(info.duration / PER_SECONDS))
    chosen: list = []
    for c in sorted(best.values(), reverse=True):
        if c[3] != "end" and any(abs(c[1] - o[1]) < 4 for o in chosen):
            continue
        chosen.append(c)
        if len(chosen) >= keep_n:
            break
    if not any(c[3] == "end" for c in chosen):
        chosen += [c for c in cands if c[3] == "end"]

    out = []
    for score, a, b, kind, ctx, ly, dist_s in sorted(chosen, key=lambda c: c[1]):
        fb = downbeats[a] if a < len(downbeats) else downbeats[-1]
        out.append(Jump(
            from_beat=int(fb), to_beat=int(downbeats[b]), from_bar=int(a), to_bar=int(b),
            score=round(float(score), 4), kind=kind, xfade_ms=10.0 if kind == "break" else 30.0,
            label=f"{label(a)} → {label(b)}", context=round(ctx, 3), lyric=round(ly, 3),
            distance_s=round(float(dist_s), 2),
        ))  # fmt: skip
    return out


# ── Forever walk ──────────────────────────────────────────────────────────────


def forever_path(bar_t: np.ndarray, sections: list, jumps: list, minutes: float,
                 seed: int = 0, pace=(60.0, 120.0)) -> tuple:  # fmt: skip
    """Bars to play for a Forever render of `minutes`, and the jump log.

    Returns (segments [(start_s, end_s)], log [{at_s, from, to, kind, from_s, to_s}]).
    """
    rng = np.random.default_rng(seed)
    n = len(bar_t) - 1
    sec = _section_index(sections, n)
    by_from: dict = {}
    for j in jumps:
        by_from.setdefault(j.from_bar, []).append(j)
    target = minutes * 60.0
    segs, log = [], []
    bar, start_bar, t = 0, 0, 0.0
    next_jump = rng.uniform(*pace)
    landed_in = -2  # section instance we last landed in (no second jump inside it)
    recent: list = []  # (out_time, bar) of played bars, to avoid landing in the last 60 s
    while t < target:
        options = []
        if t >= next_jump and bar in by_from and (bar >= n or sec[bar] != landed_in):
            fresh = {b for (tt, b) in recent if t - tt < 60.0}
            options = [j for j in by_from[bar] if j.to_bar not in fresh]
        if bar >= n and not options:
            options = [j for j in by_from.get(n, [])]
            if not options:
                break  # song ended with nowhere to go
        if options:
            j = max(options, key=lambda j: j.score + rng.uniform(0, 0.02))
            segs.append((bar_t[start_bar], bar_t[min(bar, n)]))
            log.append({"at_s": round(t, 2), "from": j.label.split(" → ")[0],
                        "to": j.label.split(" → ")[1], "kind": j.kind,
                        "from_s": round(float(bar_t[min(bar, n)]), 2),
                        "to_s": round(float(bar_t[j.to_bar]), 2)})  # fmt: skip
            bar = start_bar = j.to_bar
            landed_in = sec[bar]
            next_jump = t + rng.uniform(*pace)
            continue
        if bar >= n:
            break
        recent.append((t, bar))
        t += bar_t[bar + 1] - bar_t[bar]
        bar += 1
    segs.append((bar_t[start_bar], bar_t[min(bar, n)]))
    return segs, log
