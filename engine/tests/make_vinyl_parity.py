"""Writes tests/golden/vinyl_parity.json: the envelope the app's live Vinyl chain must match.

The app ports versions.py `_apply_vinyl_crackle` sample by sample (hard rule 5), but the pops
and hiss are random, so the two can't match exactly. Instead this renders the Python chain
with SEEDS different random streams and records, per channel, per 1 s frame and per 1/3-octave
band, the min/max energy across them (golden_util.band_fingerprint after the same -1 dB peak
normalisation). The Kotlin parity test (app/modules/saics-player, VinylParityTest) renders
the same deterministic input and must land inside [min - 1 dB, max + 1 dB] at least as often
as the Python chain does with SEEDS fresh seeds (`max_miss_rate`).

The input is golden_util's test signal without the random noise burst (not reproducible in
Kotlin): L = log sweep 50 Hz-12 kHz, R = 120 BPM Hann clicks.

    python tests/make_vinyl_parity.py
"""

import json
from pathlib import Path

import golden_util as g
import numpy as np

from saics import versions as v

SEEDS = 12
TOL_DB = 1.0


def signal(sr: int) -> np.ndarray:
    n = int(g.DURATION_S * sr)
    t = np.arange(n) / sr
    f0, f1 = 50.0, 12000.0
    k = np.log(f1 / f0) / g.DURATION_S
    left = 0.4 * np.sin(2 * np.pi * f0 * (np.exp(k * t) - 1) / k)
    right = np.zeros(n)
    click = np.hanning(int(0.004 * sr))
    for start in range(0, n - len(click), int(0.5 * sr)):
        right[start : start + len(click)] += 0.8 * click
    return np.stack([left, right]).astype(np.float32)


def main() -> None:
    out = {}
    for sr in g.RATES:
        x = signal(sr)
        prints = []
        for seed in range(SEEDS):
            np.random.seed(seed)
            y = v._normalize(np.asarray(v._apply_vinyl_crackle(x, sr), np.float32), target_db=-1.0)
            prints.append(np.array(g.band_fingerprint(y, sr)))
        p = np.stack(prints)  # (seeds, ch, frames, bands)
        lo, hi = p.min(0), p.max(0)
        # How often the Python chain itself (SEEDS fresh seeds) falls outside this envelope:
        # the Kotlin chain may miss no more often than the worst of them.
        mask = hi > -80
        rates = []
        for seed in range(SEEDS, 2 * SEEDS):
            np.random.seed(seed)
            y = v._normalize(np.asarray(v._apply_vinyl_crackle(x, sr), np.float32), target_db=-1.0)
            f = np.array(g.band_fingerprint(y, sr))
            rates.append(float((((f < lo - TOL_DB) | (f > hi + TOL_DB)) & mask).sum() / mask.sum()))
        out[str(sr)] = {"min": np.round(lo, 3).tolist(), "max": np.round(hi, 3).tolist(),
                        "tol_db": TOL_DB, "max_miss_rate": round(max(rates), 4)}  # fmt: skip
    path = Path(__file__).parent / "golden" / "vinyl_parity.json"
    path.write_text(json.dumps(out))
    print("wrote", path)


if __name__ == "__main__":
    main()
