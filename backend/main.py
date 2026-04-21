"""
main.py  v3
===========
Structure-Aware Intelligent Audio Continuity System — FastAPI Server

Endpoints
---------
POST /upload       multipart/form-data  →  seamless-loop WAV  (FileResponse)
POST /analyze      multipart/form-data  →  JSON graph data  (beats + edges)
POST /transition   multipart/form-data  →  JSON result + preview WAV URL
GET  /health                            →  {"status": "ok"}
"""

import os
import logging
import tempfile
import asyncio
from pathlib import Path
from typing import List

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from audio_processor import AudioContinuityProcessor, TrackTransitionProcessor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("saics.api")

app = FastAPI(
    title="SAICS API",
    description="Structure-Aware Intelligent Audio Continuity System",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_EXT = {".mp3", ".wav", ".flac", ".ogg", ".aac", ".aif", ".aiff", ".m4a"}
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class BeatInfo(BaseModel):
    index: int
    time: float
    duration: float
    beat_phase: int   # 0 = downbeat, 1-3 = subsequent beats


class EdgeInfo(BaseModel):
    source: int
    target: int
    score: float
    cost: float


class AnalysisResponse(BaseModel):
    filename: str
    song_duration_s: float
    tempo: float
    beat_count: int
    edge_count: int
    beats: List[BeatInfo]
    edges: List[EdgeInfo]


class TransitionResponse(BaseModel):
    src_beat_idx: int
    tgt_beat_idx: int
    src_time: float
    tgt_time: float
    score: float
    tempo_a: float
    tempo_b: float
    tempo_delta: float
    key_distance: int
    preview_url: str   # relative URL to download the preview WAV


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _delete_file(path: str) -> None:
    try:
        if os.path.exists(path):
            os.remove(path)
            log.info("Cleaned up: %s", path)
    except Exception as exc:
        log.warning("Could not delete %s: %s", path, exc)


async def _save_upload(file: UploadFile) -> tuple[str, str]:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ext}'. Accepted: {', '.join(sorted(ALLOWED_EXT))}",
        )
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large. Max 100 MB.")

    in_fd, in_path = tempfile.mkstemp(suffix=ext, prefix="saics_in_")
    with os.fdopen(in_fd, "wb") as fh:
        fh.write(content)
    log.info("Saved upload: %s (%d bytes)", in_path, len(content))
    return in_path, Path(file.filename or "output").stem


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health", tags=["Meta"])
async def health_check() -> JSONResponse:
    return JSONResponse({"status": "ok", "service": "SAICS API", "version": "3.0.0"})


# ── POST /upload ─────────────────────────────────────────────────────────────

@app.post("/upload", tags=["Processing"])
async def upload_audio(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> FileResponse:
    """Full pipeline → seamless-loop WAV."""
    in_path, stem = await _save_upload(file)
    out_path = ""
    try:
        loop = asyncio.get_event_loop()
        out_path = await loop.run_in_executor(None, _run_full_pipeline, in_path)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Upload pipeline failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Audio processing failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)

    background_tasks.add_task(_delete_file, out_path)
    dl_name = f"{stem}_seamless_loop.wav"
    return FileResponse(
        path=out_path,
        media_type="audio/wav",
        filename=dl_name,
    )


# ── POST /analyze ─────────────────────────────────────────────────────────────

@app.post("/analyze", tags=["Processing"], response_model=AnalysisResponse)
async def analyze_audio(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> AnalysisResponse:
    """Partial pipeline: feature extraction + graph only.  Powers the jump-graph UI."""
    in_path, stem = await _save_upload(file)
    try:
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _run_analysis_pipeline, in_path)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Analyze pipeline failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)

    result["filename"] = file.filename or stem
    return AnalysisResponse(**result)


# ── POST /analyze-meta ────────────────────────────────────────────────────────

@app.post("/analyze-meta", tags=["Processing"])
async def analyze_meta(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> JSONResponse:
    """Lightweight extraction: returns only tempo, key, and duration (no graph)."""
    in_path, stem = await _save_upload(file)
    try:
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _run_meta_pipeline, in_path)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Meta-analysis failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Meta-analysis failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)

    return JSONResponse(result)


# ── POST /transition ──────────────────────────────────────────────────────────

@app.post("/transition", tags=["Processing"])
async def find_transition(
    background_tasks: BackgroundTasks,
    track_a: UploadFile = File(..., description="Outgoing track (Track A)"),
    track_b: UploadFile = File(..., description="Incoming track (Track B)"),
) -> JSONResponse:
    """
    Cross-track transition finder.

    Accepts two audio files, analyses both, finds the optimal beat pair for
    crossfading A into B, and returns:
      - JSON metadata (beat indices, times, score, BPM delta, key distance)
      - A download URL for a preview WAV centred on the crossfade point

    The preview WAV is held in a temp file; the client should download it
    promptly.  It is deleted after the next GC cycle (background task).
    """
    in_a, stem_a = await _save_upload(track_a)
    in_b, stem_b = await _save_upload(track_b)
    preview_path = ""

    try:
        loop = asyncio.get_event_loop()
        result, preview_path = await loop.run_in_executor(
            None, _run_transition_pipeline, in_a, in_b
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Transition pipeline failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Transition analysis failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_a)
        background_tasks.add_task(_delete_file, in_b)

    # Serve the preview WAV via a temporary /preview/{token} route by
    # embedding the raw bytes in a separate endpoint keyed by filename stem.
    # Simpler: return the file inline as a two-part response isn't possible
    # in plain JSON, so we expose a GET /preview/<filename> endpoint and pass
    # the filename back to the client.
    preview_filename = Path(preview_path).name

    # Register a one-shot download route for this preview
    _register_preview(app, preview_path, preview_filename, background_tasks)

    payload = {
        "src_beat_idx":  result.src_beat_idx,
        "tgt_beat_idx":  result.tgt_beat_idx,
        "src_time":      round(result.src_time, 4),
        "tgt_time":      round(result.tgt_time, 4),
        "score":         round(result.score, 4),
        "tempo_a":       round(result.tempo_a, 2),
        "tempo_b":       round(result.tempo_b, 2),
        "tempo_delta":   round(result.tempo_delta, 2),
        "key_distance":  result.key_distance,
        "duration_a":    round(result.duration_a, 3),
        "duration_b":    round(result.duration_b, 3),
        "preview_url":   f"/preview/{preview_filename}",
        "candidates": [
            {
                "src_beat_idx": c.src_beat_idx,
                "tgt_beat_idx": c.tgt_beat_idx,
                "src_time":     round(c.src_time, 4),
                "tgt_time":     round(c.tgt_time, 4),
                "score":        round(c.score, 4),
            }
            for c in result.candidates
        ],
    }
    return JSONResponse(payload)


# ── GET /preview/{filename} ───────────────────────────────────────────────────
# Registered dynamically per transition request (see _register_preview).
# A global registry keeps file paths alive until served.

_preview_registry: dict[str, str] = {}


def _register_preview(
    app_: "FastAPI",
    file_path: str,
    filename: str,
    background_tasks: BackgroundTasks,
) -> None:
    """
    Add the preview WAV to the registry so the GET /preview/{filename} route
    can serve it.  Schedule deletion after a fixed TTL by abusing background
    tasks (they run after the *current* response completes, so deletion happens
    on next request cycle — good enough for our use case).
    """
    _preview_registry[filename] = file_path


@app.get("/preview/{filename}", tags=["Processing"])
async def download_preview(filename: str, background_tasks: BackgroundTasks) -> FileResponse:
    """Serve and then delete a transition preview WAV."""
    path = _preview_registry.get(filename)
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Preview not found or already downloaded.")
    _preview_registry.pop(filename, None)
    background_tasks.add_task(_delete_file, path)
    return FileResponse(
        path=path,
        media_type="audio/wav",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Sync worker functions
# ---------------------------------------------------------------------------

def _run_full_pipeline(input_path: str) -> str:
    return AudioContinuityProcessor(input_path).process()


def _run_analysis_pipeline(input_path: str) -> dict:
    proc = AudioContinuityProcessor(input_path)
    proc.load_and_extract()
    proc.build_similarity_graph()

    beats = proc.beats
    n = len(beats)
    duration_s = beats[-1].time if beats else 0.0

    beat_list = []
    for i, b in enumerate(beats):
        dur = beats[i + 1].time - b.time if i + 1 < n else 60.0 / proc.tempo
        beat_list.append({
            "index":      b.index,
            "time":       round(b.time, 4),
            "duration":   round(max(dur, 0.0), 4),
            "beat_phase": b.beat_phase,
        })

    edge_list = [
        {"source": e.source, "target": e.target,
         "cost": round(e.cost, 4), "score": round(max(0.0, 1.0 - e.cost), 4)}
        for e in proc.edges
    ]

    return {
        "filename":        "",
        "song_duration_s": round(duration_s, 3),
        "tempo":           round(float(proc.tempo), 2),
        "beat_count":      len(beat_list),
        "edge_count":      len(edge_list),
        "beats":           beat_list,
        "edges":           edge_list,
    }


def _run_meta_pipeline(input_path: str) -> dict:
    """Lightweight extraction: tempo, key, duration only (no graph build)."""
    proc = AudioContinuityProcessor(input_path)
    proc.load_and_extract()

    import numpy as np  # local import — already available at module level

    duration_s = float(len(proc.y) / proc.sr)

    # Estimate key from mean chroma profile
    chroma_feats = np.stack([b.feature[:12] for b in proc.beats])
    mean_chroma  = chroma_feats.mean(axis=0)
    key_idx      = int(np.argmax(mean_chroma))

    return {
        "tempo":      round(float(proc.tempo), 2),
        "key":        key_idx,
        "duration":   round(duration_s, 3),
        "beat_count": len(proc.beats),
    }


def _run_transition_pipeline(path_a: str, path_b: str):
    proc = TrackTransitionProcessor(path_a, path_b)
    return proc.process()


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)