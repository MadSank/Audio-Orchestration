"""Re-analyse chosen songs into a separate folder, to compare an analysis change before it reaches
the library (hard rule 6). Reads the audio and the library's own bundles; never writes inside the
music folder."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from saics import analysis as A
from saics.schema import TrackBundle


def reanalyse(folder: Path, ids: list, out: Path, clean_beats: bool = True, log=print) -> list:
    """Bundles and features for `ids`, as `saics analyze` would make them with `clean_beats`,
    written to `out/tracks` and `out/features`. Returns the ids done."""
    folder, out = Path(folder).resolve(), Path(out).resolve()
    if out == folder or folder in out.parents:
        raise ValueError("the comparison folder must be outside the music folder")
    saics = folder / ".saics"
    (out / "tracks").mkdir(parents=True, exist_ok=True)
    (out / "features").mkdir(parents=True, exist_ok=True)
    feedback = A.read_jump_feedback(saics)
    not_loopable = A.read_forever_overrides(saics)
    A.CLEAN_SPLIT_BEATS = clean_beats
    done = []
    try:
        for i, tid in enumerate(ids):
            if (out / "tracks" / f"{tid}.json").exists():
                done.append(tid)
                continue
            old = json.loads((saics / "tracks" / f"{tid}.json").read_text("utf-8"))
            rel = old["track"]["file"]
            meta = {
                "class": old["triage"]["class"], "reasons": old["triage"].get("reasons", []),
                "group": old["group"]["id"], "version": old["group"]["version"],
                "evidence": old["group"].get("evidence", ""),
                "loopable": rel not in not_loopable, "feedback": feedback.get(rel),
            }  # fmt: skip
            try:
                bundle, feats = A.analyse_track(folder / rel, rel, meta)
            except Exception as e:  # noqa: BLE001 - one bad file must not stop the rest
                log(f"  {rel}: failed: {e}")
                continue
            if bundle.track.id != tid:
                log(f"  {rel}: the audio changed since it was analysed; skipped")
                continue
            (out / "tracks" / f"{tid}.json").write_text(bundle.dump(), encoding="utf-8")
            np.savez_compressed(out / "features" / f"{tid}.npz", **feats)
            done.append(tid)
            was = len(old.get("jumps", []))
            log(f"  [{i + 1}/{len(ids)}] {rel}: {len(bundle.jumps)} jumps (was {was})")
    finally:
        A.CLEAN_SPLIT_BEATS = False
    return done


def load(out: Path, tid: str) -> TrackBundle:
    return TrackBundle.model_validate_json(
        (Path(out) / "tracks" / f"{tid}.json").read_text("utf-8")
    )
