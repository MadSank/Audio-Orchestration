"""Regenerate tests/golden/versions.json. Only run this when a sound change is intended
and the owner has approved it (CLAUDE.md hard rule 5).

    python tests/make_versions_golden.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import golden_util as g  # noqa: E402

out = {}
for sr in g.RATES:
    for mode in g.CHAINS:
        y = g.render(mode, sr)
        out[f"{mode}@{sr}"] = {
            "shape": list(y.shape),
            "sha256": g.exact_hash(y),
            "bands_db": g.band_fingerprint(y, sr),
        }
        print(mode, sr, y.shape)

path = Path(__file__).parent / "golden" / "versions.json"
path.parent.mkdir(exist_ok=True)
path.write_text(json.dumps(out, separators=(",", ":")))
print("wrote", path)
