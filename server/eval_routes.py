"""Blind listening-test endpoints for the P2 eval page (served at /eval/)."""

import json
import random
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
router = APIRouter(prefix="/eval", tags=["Eval"])


class Rating(BaseModel):
    clip_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    rating: int = Field(ge=1, le=5)
    rater: str = Field("owner", max_length=40)
    jittery: bool = False  # stutter/flutter anywhere in the clip, independent of the seam


def _manifest() -> dict:
    p = EVAL_DIR / "clips" / "manifest.json"
    if not p.exists():
        raise HTTPException(404, "no clips yet: run `saics eval build`")
    return json.loads(p.read_text("utf-8"))


@router.get("/")
def page():
    return FileResponse(EVAL_DIR / "index.html", media_type="text/html")


@router.get("/clips")
def clips(rater: str = "owner"):
    """Unrated clips for this rater, shuffled. Never exposes the variant (blind test)."""
    rated = set()
    for p in (EVAL_DIR / "results").glob("*.json"):
        for r in json.loads(p.read_text("utf-8")).get("ratings", []):
            if r.get("rater") == rater:
                rated.add(r["clip_id"])
    ids = [c["id"] for c in _manifest()["clips"]]
    todo = [i for i in ids if i not in rated]
    random.shuffle(todo)
    return {"total": len(ids), "rated": len(ids) - len(todo), "todo": todo}


@router.get("/clip/{clip_id}.wav")
def clip(clip_id: str):
    if not clip_id.isalnum() or len(clip_id) != 12:
        raise HTTPException(400, "bad id")
    p = EVAL_DIR / "clips" / f"{clip_id}.wav"
    if not p.exists():
        raise HTTPException(404, "no such clip")
    return FileResponse(p, media_type="audio/wav")


@router.post("/rate")
def rate(r: Rating):
    if r.clip_id not in {c["id"] for c in _manifest()["clips"]}:
        raise HTTPException(404, "no such clip")
    out = EVAL_DIR / "results" / f"{time.strftime('%Y-%m-%d')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(out.read_text("utf-8")) if out.exists() else {"ratings": []}
    rec = r.model_dump()
    rec["jittery"] = rec["jittery"] or r.rating == 1  # 1 means jittery by definition
    rec["scale"] = "v2"  # owner's 1-5 scale with the jittery flag (eval/README.md); v1 had no tag
    data["ratings"].append({**rec, "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    out.write_text(json.dumps(data, indent=1), "utf-8")
    return {"ok": True}
