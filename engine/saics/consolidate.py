"""Reversible file moves into the library (e.g. approved songs from Downloads).

Every move is recorded in a JSON manifest (source, destination, size, SHA-256) so
`undo` puts each file back exactly where it was. Nothing is ever deleted or overwritten:
a move whose destination exists, or an undo whose original location is taken, is refused.
"""

import hashlib
import json
import shutil
import time
from pathlib import Path


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def move_files(sources: list, dest_dir: Path, manifest: Path, note: str = "") -> list:
    """Move `sources` into `dest_dir`; append each move to `manifest`. Returns the records."""
    dest_dir = Path(dest_dir)
    sources = [Path(s) for s in sources]
    missing = [str(s) for s in sources if not s.is_file()]
    clashes = [str(dest_dir / s.name) for s in sources if (dest_dir / s.name).exists()]
    names = [s.name for s in sources]
    dupes = {n for n in names if names.count(n) > 1}
    if missing or clashes or dupes:
        raise ValueError(f"refusing to move: missing={missing} exists={clashes} same name={dupes}")
    dest_dir.mkdir(parents=True, exist_ok=True)
    log = _load(manifest)
    records = []
    for src in sources:
        rec = {"source": str(src.resolve()), "dest": str((dest_dir / src.name).resolve()),
               "size": src.stat().st_size, "sha256": _sha256(src),
               "moved_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "note": note}  # fmt: skip
        shutil.move(str(src), rec["dest"])
        dest = Path(rec["dest"])
        if dest.stat().st_size != rec["size"] or _sha256(dest) != rec["sha256"]:
            raise RuntimeError(f"verification failed after moving {src}")
        log["moves"].append(rec)
        records.append(rec)
        _save(manifest, log)  # after every file, so a crash never loses the record
    return records


def undo(manifest: Path) -> list:
    """Move every recorded file back to its source (newest first). Returns undone records."""
    log = _load(manifest)
    done = []
    for rec in reversed([r for r in log["moves"] if not r.get("undone")]):
        src, dest = Path(rec["source"]), Path(rec["dest"])
        if src.exists():
            raise ValueError(f"refusing to undo: {src} exists again")
        if not dest.is_file() or _sha256(dest) != rec["sha256"]:
            raise ValueError(f"refusing to undo: {dest} is missing or changed")
        src.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dest), str(src))
        rec["undone"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        _save(manifest, log)
        done.append(rec)
    return done


def _load(manifest: Path) -> dict:
    manifest = Path(manifest)
    if manifest.exists():
        return json.loads(manifest.read_text(encoding="utf-8"))
    return {"schema": "saics.moves/1", "moves": []}


def _save(manifest: Path, log: dict) -> None:
    manifest = Path(manifest)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    tmp = manifest.with_suffix(".tmp")
    tmp.write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(manifest)
