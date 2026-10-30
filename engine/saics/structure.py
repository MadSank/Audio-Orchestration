"""Musical structure helpers: meter/bar grid, tempo stability, key, bar features, sections.

Pure functions on arrays (no I/O), shared by `analysis` and `jumps`.
"""

import numpy as np

from saics.schema import Section

PITCHES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Key profiles: Krumhansl-Kessler and Temperley (2001); both are averaged after z-scoring.
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
TP_MAJOR = np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
TP_MINOR = np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])
CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]
SLOTS = 4  # beat slots per bar in bar features (keeps within-bar order)


def _z(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std() + 1e-9)


# ── meter / bar grid (D24) ────────────────────────────────────────────────────


def meter_from_downbeats(downbeats: list) -> tuple:
    """(beats_per_bar, confidence) from the raw spacing of downbeat indices."""
    gaps = np.diff(downbeats)
    if len(gaps) < 2:
        return 4, 0.0
    vals, counts = np.unique(gaps, return_counts=True)
    k = int(np.argmax(counts))
    return int(vals[k]), round(float(counts[k] / len(gaps)), 3)


def _phase_votes(raw_set: set, lo: int, hi: int, m: int, strength: np.ndarray) -> np.ndarray:
    """Per phase (0..m-1): raw downbeats in [lo, hi) on that phase, + a small onset tie-break."""
    votes = np.zeros(m)
    for i in range(max(lo, 0), min(hi, len(strength))):
        if i in raw_set:
            votes[i % m] += 1.0
        votes[i % m] += 0.01 * float(strength[i])
    return votes


def regularize_downbeats(raw: list, n_beats: int, beat_strength: np.ndarray | None = None) -> tuple:
    """(downbeats, beats_per_bar, confidence) on a usable bar grid. Never assumes 4/4.

    Raw downbeats are trusted when their spacing is consistent (>= 0.9) with 3-7 beats per
    bar. Otherwise a 4- (or clearly 3-) beat grid is tracked through the song: the bar phase
    is voted over a sliding window of raw downbeats and only changes when the new phase wins
    clearly, so half-bar detections ("2") don't move it, but a real shift (a missed or extra
    beat in the beat list, an odd bar) is followed instead of misaligning everything after it.
    """
    bpb, conf = meter_from_downbeats(raw)
    if conf >= 0.9 and 3 <= bpb <= 7:
        return list(raw), bpb, conf
    raw_arr = np.asarray(raw, dtype=int)
    raw_set = set(raw_arr.tolist())
    strength = beat_strength if beat_strength is not None else np.ones(n_beats)
    if n_beats == 0:
        return [], 4, 0.0
    agree = {}
    for m in (4, 3):
        agree[m] = (
            max(float(np.mean((raw_arr - ph) % m == 0)) for ph in range(m)) if len(raw_arr) else 0.0
        )
    m = 3 if agree[3] > agree[4] + 0.15 else 4  # 3 must beat 4 clearly before we call a waltz
    window = 8 * m
    phase = int(np.argmax(_phase_votes(raw_set, 0, window, m, strength)))
    grid = [phase]
    pos = phase
    while True:
        nxt = pos + m
        if nxt >= n_beats:
            break
        votes = _phase_votes(raw_set, nxt, nxt + window, m, strength)
        best = int(np.argmax(votes))
        if best != nxt % m and votes[best] >= votes[nxt % m] + 2:
            # Shift to the winning phase at the closest position (an odd-length bar).
            shift = (best - nxt) % m
            nxt = nxt + shift if shift <= m // 2 else nxt + shift - m
            nxt = max(nxt, pos + 2)  # never a bar shorter than 2 beats
        grid.append(nxt)
        pos = nxt
    grid_set = set(grid)
    on_grid = float(np.mean([r in grid_set for r in raw_arr])) if len(raw_arr) else 0.0
    return grid, m, round(on_grid, 3)


# ── tempo (D25) ───────────────────────────────────────────────────────────────


def tempo_from_beats(beats: np.ndarray) -> tuple:
    """(bpm, stable, confidence). Stable: >= 90% of 16-beat windows within 4% of the median."""
    ibi = np.diff(np.asarray(beats, dtype=float))
    if len(ibi) < 4:
        return 0.0, False, 0.0
    med = float(np.median(ibi))
    bpm = 60.0 / med
    win = 16 if len(ibi) >= 16 else len(ibi)
    local = np.array([np.median(ibi[i : i + win]) for i in range(0, len(ibi) - win + 1, win // 2)])
    within = float(np.mean(np.abs(local / med - 1) <= 0.04))
    return round(bpm, 2), within >= 0.9, round(within, 3)


# ── key (D23) ─────────────────────────────────────────────────────────────────


def key_scores(chroma: np.ndarray) -> list:
    """[(score, tonic, mode)] for a 12-dim chroma profile, best first."""
    c = _z(np.asarray(chroma, dtype=float))
    out = []
    for mode, profs in (("major", (KK_MAJOR, TP_MAJOR)), ("minor", (KK_MINOR, TP_MINOR))):
        for t in range(12):
            r = np.mean([float(c @ _z(np.roll(pr, t))) / 12 for pr in profs])
            out.append((r, t, mode))
    return sorted(out, reverse=True)


def key_from_chroma(chroma_beats: np.ndarray, bass_beats: np.ndarray | None = None,
                    bar_start_mask: np.ndarray | None = None) -> tuple:  # fmt: skip
    """(tonic, mode, camelot, confidence).

    chroma_beats: (12, n) beat-synchronous chroma (or a single 12-vector).
    bass_beats: (12, n) chroma of the lowest two octaves; used to settle major vs relative
    minor, which share all their notes and differ mainly in which tonic the bass leans on.
    """
    cb = np.asarray(chroma_beats, dtype=float)
    if cb.ndim == 1:
        cb = cb[:, None]
    prof = (cb / (cb.max(axis=0, keepdims=True) + 1e-9)).mean(axis=1)
    scores = key_scores(prof)
    best, tonic, mode = scores[0]
    rel_tonic, rel_mode = (
        ((tonic + 9) % 12, "minor") if mode == "major" else ((tonic + 3) % 12, "major")
    )
    rel = next(s for s in scores if s[1] == rel_tonic and s[2] == rel_mode)
    if bass_beats is not None and best - rel[0] < 0.08:
        bb = np.asarray(bass_beats, dtype=float)
        if bar_start_mask is not None and bar_start_mask.any():
            bb = bb[:, bar_start_mask]
        bp = bb.mean(axis=1)
        if bp[rel_tonic] > bp[tonic] * 1.15:  # the bass leans on the other tonic
            best, tonic, mode = rel
    second = next(s[0] for s in scores if (s[1], s[2]) != (tonic, mode))
    num = (CAMELOT_MAJOR if mode == "major" else CAMELOT_MINOR)[tonic]
    camelot = f"{num}{'B' if mode == 'major' else 'A'}"
    conf = round(max(0.0, min(1.0, (best - second) * 4 + max(0.0, best) * 0.5)), 3)
    return PITCHES[tonic], mode, camelot, conf


# ── bar features + sections ───────────────────────────────────────────────────


def bar_slot_features(beat_feats: np.ndarray, downbeats: list) -> np.ndarray:
    """(n_bars, SLOTS * d): each bar's beats resampled to 4 slots, so order within the bar
    counts (two bars with the same chords in a different rhythm differ)."""
    d, n = beat_feats.shape
    out = []
    for a, b in zip(downbeats[:-1], downbeats[1:], strict=True):
        if b <= a or b > n:
            continue
        idx = np.linspace(a, b - 1, SLOTS).round().astype(int)
        out.append(beat_feats[:, idx].T.reshape(-1))
    return np.array(out) if out else np.zeros((0, SLOTS * d))


def standardize(bar_feats: np.ndarray) -> np.ndarray:
    x = (bar_feats - bar_feats.mean(0)) / (bar_feats.std(0) + 1e-9)
    return x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)


def diagonal_similarity(ssm: np.ndarray, a: int, b: int, before: int, after: int) -> np.ndarray:
    """SSM values along the diagonal through (a, b): bars a-before..a+after-1 vs b-... ."""
    n = len(ssm)
    vals = [ssm[a + k, b + k] for k in range(-before, after) if 0 <= a + k < n and 0 <= b + k < n]
    return np.array(vals)


def sections_from_bars(bar_feats: np.ndarray, min_len: int = 4, kernel: int = 8) -> list:
    """Novelty segmentation of bar features; repeat groups by aligned diagonal similarity."""
    n = len(bar_feats)
    if n < 2 * min_len:
        return [Section(start_bar=0, end_bar=max(1, n), group=0)]
    x = standardize(bar_feats)
    ssm = x @ x.T
    k = min(kernel, n // 2)
    half = k // 2
    sign = np.sign(np.arange(-half, half) + 0.5)
    taper = np.exp(-((np.arange(-half, half) + 0.5) ** 2) / (2 * (half / 2) ** 2))
    check = np.outer(sign, sign) * np.outer(taper, taper)
    pad = np.pad(ssm, half, mode="edge")
    nov = np.array([np.sum(pad[i : i + 2 * half, i : i + 2 * half] * check) for i in range(n)])
    nov = np.maximum(nov, 0)
    bounds = [0]
    thr = np.percentile(nov, 70)
    for i in np.argsort(-nov):
        if nov[i] < thr:
            break
        if all(abs(i - b) >= min_len for b in bounds) and n - i >= min_len:
            bounds.append(int(i))
    bounds = sorted(bounds) + [n]
    segs = [(a, b) for a, b in zip(bounds[:-1], bounds[1:], strict=True) if b > a]
    # Two segments repeat each other when their bars match position by position.
    groups: list = []
    for i, (a, b) in enumerate(segs):
        g = None
        for j in range(i):
            c, d = segs[j]
            length = min(b - a, d - c)
            if length < 2:
                continue
            diag = np.array([ssm[a + t, c + t] for t in range(length)])
            if np.mean(diag) >= 0.45 and abs((b - a) - (d - c)) <= max(2, length // 2):
                g = groups[j]
                break
        groups.append(g if g is not None else (max(groups) + 1 if groups else 0))
    return [
        Section(start_bar=a, end_bar=b, group=g) for (a, b), g in zip(segs, groups, strict=True)
    ]


def section_labels(sections: list) -> list:
    """Human labels per section: repeat group letter + instance number, e.g. B2."""
    count: dict = {}
    out = []
    for s in sections:
        count[s.group] = count.get(s.group, 0) + 1
        out.append(f"{chr(65 + s.group % 26)}{count[s.group]}")
    return out
