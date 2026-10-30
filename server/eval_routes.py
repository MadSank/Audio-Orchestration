"""Blind listening-test endpoints for the eval pages.

/eval/        seam clips (round 1: 5 s context; round 2: 15 s + section reveal after rating)
/eval/full/   full-song Forever renders: "felt wrong" marks + overall rating (P3 acceptance)
"""

import json
import random
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
ROUNDS = {"1": EVAL_DIR / "clips", "2": EVAL_DIR / "round2", "2b": EVAL_DIR / "round2b"}
LATEST_ROUND = "2b"
FULL_DIR = EVAL_DIR / "full"
router = APIRouter(prefix="/eval", tags=["Eval"])


class Rating(BaseModel):
    clip_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    rating: int = Field(ge=1, le=5)
    rater: str = Field("owner", max_length=40)
    jittery: bool = False  # stutter/flutter anywhere in the clip, independent of the seam


class FullRating(BaseModel):
    render_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    overall: int = Field(ge=1, le=5)
    marks: list[float] = Field(default_factory=list, max_length=200)  # seconds into the render
    notes: str = Field("", max_length=2000)
    rater: str = Field("owner", max_length=40)


def _manifest(rnd: str) -> dict:
    d = ROUNDS.get(rnd)
    p = d / "manifest.json" if d else None
    if not p or not p.exists():
        raise HTTPException(404, f"no clips for round {rnd}: run `saics eval build`/`build2`")
    return json.loads(p.read_text("utf-8"))


def _all_clips() -> dict:
    out = {}
    for rnd, d in ROUNDS.items():
        if (d / "manifest.json").exists():
            for c in json.loads((d / "manifest.json").read_text("utf-8"))["clips"]:
                out[c["id"]] = (rnd, c)
    return out


def _append(name: str, rec: dict) -> None:
    out = EVAL_DIR / "results" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(out.read_text("utf-8")) if out.exists() else {"ratings": []}
    data["ratings"].append({**rec, "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    out.write_text(json.dumps(data, indent=1), "utf-8")


def _rated(prefix: str, key: str, rater: str) -> set:
    done = set()
    for p in (EVAL_DIR / "results").glob(f"{prefix}*.json"):
        for r in json.loads(p.read_text("utf-8")).get("ratings", []):
            if r.get("rater") == rater and key in r:
                done.add(r[key])
    return done


# ── seam clips ────────────────────────────────────────────────────────────────


@router.get("/")
def page():
    return FileResponse(EVAL_DIR / "index.html", media_type="text/html")


@router.get("/clips")
def clips(rater: str = "owner", round: str = LATEST_ROUND):  # noqa: A002
    """Unrated clips of a round for this rater, shuffled. Never exposes the variant."""
    m = _manifest(round)
    rated = _rated("20", "clip_id", rater)
    ids = [c["id"] for c in m["clips"]]
    todo = [i for i in ids if i not in rated]
    random.shuffle(todo)
    return {"round": round, "context_s": m.get("context_s", 5), "total": len(ids),
            "rated": len(ids) - len(todo), "todo": todo}  # fmt: skip


@router.get("/clip/{clip_id}.wav")
def clip(clip_id: str):
    if not clip_id.isalnum() or len(clip_id) != 12:
        raise HTTPException(400, "bad id")
    found = _all_clips().get(clip_id)
    if not found:
        raise HTTPException(404, "no such clip")
    return FileResponse(ROUNDS[found[0]] / f"{clip_id}.wav", media_type="audio/wav")


@router.post("/rate")
def rate(r: Rating):
    found = _all_clips().get(r.clip_id)
    if not found:
        raise HTTPException(404, "no such clip")
    rnd, c = found
    rec = r.model_dump()
    rec["jittery"] = rec["jittery"] or r.rating == 1  # 1 means jittery by definition
    rec["scale"] = "v2"  # owner's 1-5 scale with the jittery flag (eval/README.md)
    rec["round"] = rnd
    _append(f"{time.strftime('%Y-%m-%d')}.json", rec)
    # Reveal where the jump went (section labels) only after the rating is stored.
    return {"ok": True, "reveal": c.get("reveal")}


# ── full-song test ────────────────────────────────────────────────────────────


def _full_manifest() -> dict:
    p = FULL_DIR / "manifest.json"
    if not p.exists():
        raise HTTPException(404, "no full-song renders: run `saics eval build2`")
    return json.loads(p.read_text("utf-8"))


@router.get("/full/")
def full_page():
    return FileResponse(EVAL_DIR / "full.html", media_type="text/html")


@router.get("/full/list")
def full_list(rater: str = "owner"):
    """Renders to listen to (titles only; the jump log stays hidden until rated)."""
    done = _rated("full-", "render_id", rater)
    return {"renders": [{"id": r["id"], "title": r["title"], "duration_s": r["duration_s"],
                         "rated": r["id"] in done} for r in _full_manifest()["renders"]]}  # fmt: skip


@router.get("/full/audio/{render_id}.mp3")
def full_audio(render_id: str):
    if not render_id.isalnum() or len(render_id) != 12:
        raise HTTPException(400, "bad id")
    p = FULL_DIR / f"{render_id}.mp3"
    if not p.exists():
        raise HTTPException(404, "no such render")
    return FileResponse(p, media_type="audio/mpeg")


@router.post("/full/rate")
def full_rate(r: FullRating):
    render = next((x for x in _full_manifest()["renders"] if x["id"] == r.render_id), None)
    if not render:
        raise HTTPException(404, "no such render")
    _append(f"full-{time.strftime('%Y-%m-%d')}.json", r.model_dump())
    return {"ok": True, "song": render["song"], "jumps": render["jumps"]}
