"""
library_analyzer.py — SAICS v5 cross-track recommendation engine.

Scores pairs of tracks on BPM compatibility (Camelot harmonic mixing),
key compatibility (Circle of Fifths), spectral similarity, and energy
profile correlation.
"""

import logging
import numpy as np
from typing import List, Dict, Tuple
from .models import TrackFingerprint

log = logging.getLogger(__name__)

# Camelot wheel compatibility matrix.
# Compatible keys: same number (harmonic), ±1 number, same number opposite letter.
# We store Circle-of-Fifths distances (0-6) for scoring.
CIRCLE_OF_FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]


def key_distance(a: int, b: int) -> int:
    """Circle-of-fifths distance between two pitch classes (0-11)."""
    pos_a = CIRCLE_OF_FIFTHS.index(a % 12)
    pos_b = CIRCLE_OF_FIFTHS.index(b % 12)
    d = abs(pos_a - pos_b)
    return min(d, 12 - d)


def bpm_compatibility(bpm_a: float, bpm_b: float) -> float:
    """
    BPM compatibility score (0-1).
    Considers half-time and double-time relationships.
    """
    if bpm_a <= 0 or bpm_b <= 0:
        return 0.5

    ratios = [bpm_a / bpm_b, (bpm_a * 2) / bpm_b, bpm_a / (bpm_b * 2)]
    best = min(abs(r - 1.0) for r in ratios)

    if best < 0.03:
        return 1.0
    elif best < 0.06:
        return 0.85
    elif best < 0.10:
        return 0.65
    elif best < 0.15:
        return 0.40
    else:
        return max(0.1, 1.0 - best * 2)


def spectral_similarity(mfcc_a: np.ndarray, mfcc_b: np.ndarray) -> float:
    """Cosine similarity of mean MFCC vectors."""
    na = np.linalg.norm(mfcc_a)
    nb = np.linalg.norm(mfcc_b)
    if na < 1e-9 or nb < 1e-9:
        return 0.5
    return float(np.clip(np.dot(mfcc_a, mfcc_b) / (na * nb), 0, 1))


def energy_correlation(e_a: np.ndarray, e_b: np.ndarray) -> float:
    """Pearson correlation of energy profiles, resampled to same length."""
    target_len = 32
    if len(e_a) < 2 or len(e_b) < 2:
        return 0.5
    a = np.interp(np.linspace(0, 1, target_len), np.linspace(0, 1, len(e_a)), e_a)
    b = np.interp(np.linspace(0, 1, target_len), np.linspace(0, 1, len(e_b)), e_b)
    if np.std(a) < 1e-9 or np.std(b) < 1e-9:
        return 0.5
    return float(np.clip((np.corrcoef(a, b)[0, 1] + 1) / 2, 0, 1))


def score_pair(fp_a: TrackFingerprint, fp_b: TrackFingerprint) -> Dict:
    """
    Composite compatibility score between two tracks.
    Returns dict with overall score and component scores.
    """
    bpm_sc  = bpm_compatibility(fp_a.tempo, fp_b.tempo)
    key_d   = key_distance(fp_a.key_idx, fp_b.key_idx)
    key_sc  = max(0, 1.0 - key_d / 6.0)
    spec_sc = spectral_similarity(fp_a.mean_mfcc, fp_b.mean_mfcc)
    nrg_sc  = energy_correlation(fp_a.energy_profile, fp_b.energy_profile)

    # Weighted composite
    overall = (
        0.35 * bpm_sc +
        0.30 * key_sc +
        0.20 * spec_sc +
        0.15 * nrg_sc
    )

    return {
        "score":          round(float(overall), 4),
        "bpm_compat":     round(float(bpm_sc), 4),
        "key_compat":     round(float(key_sc), 4),
        "spectral_compat": round(float(spec_sc), 4),
        "energy_compat":  round(float(nrg_sc), 4),
        "key_distance":   key_d,
        "bpm_a":          round(fp_a.tempo, 2),
        "bpm_b":          round(fp_b.tempo, 2),
        "camelot_a":      fp_a.camelot_key,
        "camelot_b":      fp_b.camelot_key,
    }


def rank_library(
    fingerprints: Dict[str, TrackFingerprint],
    current_id: str,
) -> List[Dict]:
    """
    Rank all library tracks by compatibility with the current track.
    Returns sorted list of {track_id, ...score_components}.
    """
    current = fingerprints.get(current_id)
    if not current:
        return []

    results = []
    for tid, fp in fingerprints.items():
        if tid == current_id:
            continue
        sc = score_pair(current, fp)
        sc["track_id"] = tid
        results.append(sc)

    results.sort(key=lambda x: x["score"], reverse=True)
    return results


def score_all_pairs(
    fingerprints: Dict[str, TrackFingerprint],
) -> List[Dict]:
    """
    Score all unique ordered pairs. Returns list sorted by score descending.
    """
    ids = list(fingerprints.keys())
    results = []
    seen = set()
    for i, id_a in enumerate(ids):
        for j, id_b in enumerate(ids):
            if i == j:
                continue
            pair_key = tuple(sorted([id_a, id_b]))
            if pair_key in seen:
                continue
            seen.add(pair_key)
            sc = score_pair(fingerprints[id_a], fingerprints[id_b])
            sc["track_a_id"] = id_a
            sc["track_b_id"] = id_b
            results.append(sc)

    results.sort(key=lambda x: x["score"], reverse=True)
    return results
