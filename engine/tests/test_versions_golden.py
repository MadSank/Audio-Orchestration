"""Golden tests: the version chains' sound is frozen (CLAUDE.md hard rule 5)."""

import json
from pathlib import Path

import golden_util as g
import numpy as np
import pytest

GOLDEN = json.loads((Path(__file__).parent / "golden" / "versions.json").read_text())
CASES = [(m, sr) for sr in g.RATES for m in g.CHAINS]


@pytest.fixture(scope="module")
def rendered():
    return {}


def _get(rendered, mode, sr):
    key = f"{mode}@{sr}"
    if key not in rendered:
        rendered[key] = g.render(mode, sr)
    return rendered[key]


@pytest.mark.parametrize("mode,sr", CASES)
def test_shape_and_spectrum_unchanged(rendered, mode, sr):
    ref = GOLDEN[f"{mode}@{sr}"]
    y = _get(rendered, mode, sr)
    assert list(y.shape) == ref["shape"]
    got = np.array(g.band_fingerprint(y, sr))
    want = np.array(ref["bands_db"])
    # Ignore bands that are near-silent in the reference (numerically meaningless).
    mask = want > -80
    assert np.max(np.abs(got - want)[mask]) < 0.5, "spectral fingerprint drifted (>0.5 dB)"


@pytest.mark.parametrize("mode,sr", CASES)
def test_exact_output_unchanged(rendered, mode, sr):
    assert g.exact_hash(_get(rendered, mode, sr)) == GOLDEN[f"{mode}@{sr}"]["sha256"]


def test_all_modes_covered():
    from saics.versions import VALID_MODES

    assert set(VALID_MODES) == set(g.CHAINS)
