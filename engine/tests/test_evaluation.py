import json

import numpy as np

from saics.evaluation import report, seam_metrics
from saics.render import render_segments

SR = 22050


def _tone_bars(seconds=12, f=441.0, offset=0.0):
    """Tone plus a click on every beat (0.5 s), clicks shifted by `offset` seconds."""
    t = np.arange(int(seconds * SR)) / SR
    y = 0.3 * np.sin(2 * np.pi * f * t)
    click = np.hanning(int(0.004 * SR))
    for s in np.arange(offset, seconds - 0.01, 0.5):
        i = int(s * SR)
        y[i : i + len(click)] += 0.6 * click[: len(y) - i]
    return y.astype(np.float32)


def test_clean_seam_scores_low_and_bad_seam_scores_high():
    y = _tone_bars()
    good, (s1,) = render_segments(y, [(0, 6 * SR), (2 * SR, 8 * SR)], SR)  # in phase
    bad = np.concatenate([y[: 6 * SR], 0.1 * _tone_bars(6, 300.0, offset=0.21)])  # off-beat cut
    g = seam_metrics(good, SR, s1 / SR, beats=np.arange(0, 12, 0.5))
    b = seam_metrics(bad, SR, 6.0, beats=np.r_[np.arange(0, 6, 0.5), np.arange(6.21, 12, 0.5)])
    assert g["loudness_step_db"] < 0.5 < 10 < b["loudness_step_db"]
    assert g["chroma_jump"] < b["chroma_jump"]
    assert g["beat_phase_ms"] < 6 and 150 < b["beat_phase_ms"] < 260  # criterion is 10 ms


def test_report_joins_blind_ratings(tmp_path):
    clips, results = tmp_path / "clips", tmp_path / "results"
    clips.mkdir()
    results.mkdir()
    m = {"flux_spike": 1.0, "chroma_jump": 0.0, "loudness_step_db": 0.2, "beat_phase_ms": 3.0}
    manifest = {"clips": [
        {"id": "a1", "variant": "legacy", "metrics": dict(m, beat_phase_ms=40.0)},
        {"id": "b2", "variant": "baseline", "metrics": m},
    ]}  # fmt: skip
    (clips / "manifest.json").write_text(json.dumps(manifest))
    (results / "r.json").write_text(json.dumps({"ratings": [
        {"clip_id": "a1", "rating": 2}, {"clip_id": "b2", "rating": 5}, {"clip_id": "b2", "rating": 4},
    ]}))  # fmt: skip
    md = report(clips, results)
    assert "| baseline | 1 | 1 | 4.50 | 100% |" in md
    assert "| legacy | 1 | 1 | 2.00 | 0% |" in md and "40.0 | 1 |" in md
