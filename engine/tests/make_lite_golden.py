"""Writes tests/golden/lite.json: what saics.lite gives on a synthetic song, for the Kotlin port.

The song is a closed-form signal both languages can generate (see LiteTest.kt), and the beat list
is given, so everything except the model itself is compared. Run from `engine/`.
"""

import json
from pathlib import Path

import numpy as np

from saics import lite
from saics.jumps import _section_index  # noqa: F401  (documents what the labels index)

SR = 44100
BEAT_S = 0.5
BPB = 4
PLAN = "IIAAAABBBBCCAAAABBBBDDAAAABBBBOO"  # 2 bars... each letter is 4 bars
ROOT = {"I": 110.0, "A": 220.0, "B": 277.18, "C": 174.61, "D": 311.13, "O": 146.83}


def song() -> np.ndarray:
    n_bars = 4 * len(PLAN)
    n = int(n_bars * BPB * BEAT_S * SR)
    t = np.arange(n) / SR
    beat = np.floor(t / BEAT_S).astype(int)
    letter = np.array(
        [PLAN[min(b // (4 * BPB), len(PLAN) - 1)] for b in range(int(beat.max()) + 1)]
    )
    f = np.array([ROOT[c] for c in letter])[beat]
    step = (beat % BPB) * 0.25  # the chord moves within the bar, so that order counts
    phase_t = t - beat * BEAT_S
    click = np.exp(-phase_t * 30.0) * np.sin(2 * np.pi * 1800.0 * phase_t)
    y = 0.3 * np.sin(2 * np.pi * f * (1 + step) * t) + 0.15 * np.sin(2 * np.pi * f * 1.5 * t)
    y = y + 0.2 * click * (1.0 + (beat % BPB == 0))
    return y


def main() -> None:
    y44 = song().astype(np.float32)
    y22 = lite.halve(y44)
    spect = lite.log_mel(y22)
    n_beats = int(len(y44) / SR / BEAT_S)
    beats = np.arange(n_beats) * BEAT_S
    raw = list(range(0, n_beats, BPB))
    f = lite.beat_features(y22, beats)
    res = lite.analyse(y22, len(y44) / SR, beats, raw)
    st = np.stack([y44, y44])
    logits = np.array([-2.0, -1, 3, -1, -5, 1, 2, 2, 1, -3, -3, -3, 0.5, -1, -1, -1, -1, 4.0])
    out = {
        "plan": PLAN,
        "y22_len": len(y22),
        "y22_at": {str(i): float(y22[i]) for i in (0, 1000, 123456, 2000000)},
        "mel_frames": len(spect),
        "mel": {str(i): [round(float(x), 5) for x in spect[i]] for i in (0, 100, 5000)},
        "chunk_starts": lite.chunk_starts(4000),
        "chunk_starts_short": lite.chunk_starts(800),
        "peaks": [float(x) for x in lite._peaks(logits)],
        "chroma_b": {str(i): [round(float(x), 5) for x in f["chroma"][:, i]] for i in (3, 200)},
        "mfcc_b": {str(i): [round(float(x), 3) for x in f["mfcc"][:, i]] for i in (3, 200)},
        "onset_b": {str(i): round(float(f["onset"][i]), 5) for i in (3, 200)},
        "rms_b": {str(i): round(float(f["rms"][i]), 6) for i in (3, 200)},
        "downbeats": [int(x) for x in res["downbeats"]],
        "sections": [[s.start_bar, s.end_bar, s.group] for s in res["sections"]],
        "jumps": [[j.from_bar, j.to_bar, round(j.score, 4), j.kind, j.label] for j in res["jumps"]],
        "outro_bar": res["outro_bar"],
        "lufs": round(lite.integrated_lufs(st), 3),
        "regularize": {
            "raw": [0, 4, 8, 10, 12, 16, 20, 25, 29, 33, 37, 41],
            "out": [],
        },
    }
    from saics.structure import regularize_downbeats

    grid, m, conf = regularize_downbeats(out["regularize"]["raw"], 46, np.ones(46))
    out["regularize"]["out"] = [int(x) for x in grid]
    out["regularize"]["bpb"] = m
    path = Path(__file__).parent / "golden" / "lite.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    print(path, "jumps", len(res["jumps"]), "sections", len(res["sections"]))


if __name__ == "__main__":
    main()
