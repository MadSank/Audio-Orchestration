"""Every jump the owner rated 5 in eval rounds 2 and 2b must stay selected (owner, 2026-10-30/31).

Runs against the real library's bundles (skipped elsewhere). Refresh the bundles first with
`saics jumps <MusicFolder>` after any change to jump finding.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from saics.schema import TrackBundle

LIB = Path(r"C:\Users\ASUS\Music\songs")
CASES = json.loads(
    (Path(__file__).parent / "data" / "jump_regressions_rated5.json").read_text("utf-8")
)
pytestmark = pytest.mark.skipif(not (LIB / ".saics" / "library.json").exists(),
                                reason="owner's library not available")  # fmt: skip


def _bundle(song):
    lib = json.loads((LIB / ".saics" / "library.json").read_text("utf-8"))
    tid = next(t["id"] for t in lib["tracks"] if t["file"] == song)
    return TrackBundle.model_validate_json(
        (LIB / ".saics" / "tracks" / f"{tid}.json").read_text("utf-8")
    )


@pytest.mark.parametrize("case", CASES, ids=[f"{c['song'][:24]}|{c['label']}" for c in CASES])
def test_rated_5_jump_is_still_selected(case):
    b = _bundle(case["song"])
    bar_t = np.asarray(b.beats)[b.downbeats]
    a = int(np.argmin(np.abs(bar_t - case["from_s"])))
    t = int(np.argmin(np.abs(bar_t - case["to_s"])))
    assert any(j.from_bar == a and j.to_bar == t for j in b.jumps), [j.label for j in b.jumps]
