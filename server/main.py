"""
main.py v5 — SAICS FastAPI Server
==================================
Endpoints: /upload, /analyze, /analyze-full, /analyze-meta,
           /transition, /library-scores, /render-version,
           /health, /preview/{filename}
"""

import os, logging, tempfile, asyncio
from pathlib import Path
from typing import List, Dict

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from saics.legacy.audio_processor import AudioContinuityProcessor, TrackTransitionProcessor
from saics.legacy.library_analyzer import score_pair, score_all_pairs
from saics.legacy.models import TrackFingerprint
from saics.versions import render_audio_version, VALID_MODES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("saics.api")

app = FastAPI(title="SAICS API", description="Structure-Aware Intelligent Audio Continuity System", version="5.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

ALLOWED_EXT = {".mp3", ".wav", ".flac", ".ogg", ".aac", ".aif", ".aiff", ".m4a"}
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# Persistent fingerprint store
_fingerprint_store: Dict[str, dict] = {}  # track_name -> serialized fingerprint


# ── Pydantic models ──────────────────────────────────────────────────

class BeatInfo(BaseModel):
    index: int
    time: float
    duration: float
    beat_phase: int
    is_phrase_start: bool = False

class EdgeInfo(BaseModel):
    source: int
    target: int
    score: float
    cost: float
    probability: float = 0.0
    reachability: float = 0.0

class AnalysisResponse(BaseModel):
    filename: str
    song_duration_s: float
    tempo: float
    beat_count: int
    edge_count: int
    beats: List[BeatInfo]
    edges: List[EdgeInfo]

class FullAnalysisResponse(BaseModel):
    filename: str
    song_duration_s: float
    tempo: float
    beat_count: int
    edge_count: int
    min_beats_between_jumps: int
    beats: List[BeatInfo]
    edges: List[EdgeInfo]
    jump_schedule: list


# ── Helpers ───────────────────────────────────────────────────────────

def _delete_file(path: str):
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception as exc:
        log.warning("Cleanup failed %s: %s", path, exc)

async def _save_upload(file: UploadFile) -> tuple:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(415, f"Unsupported: {ext}")
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 100MB)")
    fd, path = tempfile.mkstemp(suffix=ext, prefix="saics_in_")
    with os.fdopen(fd, "wb") as f:
        f.write(content)
    return path, Path(file.filename or "output").stem


# ── Routes ────────────────────────────────────────────────────────────

@app.get("/health", tags=["Meta"])
async def health():
    return JSONResponse({"status": "ok", "service": "SAICS API", "version": "5.0.0"})


@app.post("/upload", tags=["Processing"])
async def upload_audio(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    in_path, stem = await _save_upload(file)
    try:
        loop = asyncio.get_running_loop()
        out_path = await loop.run_in_executor(None, lambda: AudioContinuityProcessor(in_path).process())
    except Exception as exc:
        log.exception("Upload failed: %s", exc)
        raise HTTPException(500, f"Processing failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)
    background_tasks.add_task(_delete_file, out_path)
    return FileResponse(path=out_path, media_type="audio/wav", filename=f"{stem}_seamless_loop.wav")


@app.post("/analyze", tags=["Processing"], response_model=AnalysisResponse)
async def analyze_audio(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    in_path, stem = await _save_upload(file)
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run_analysis, in_path)
    except Exception as exc:
        log.exception("Analyze failed: %s", exc)
        raise HTTPException(500, f"Analysis failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)
    result["filename"] = file.filename or stem
    return AnalysisResponse(**result)


@app.post("/analyze-full", tags=["Processing"])
async def analyze_full(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    """Full analysis with pre-computed jump schedule for real-time frontend playback."""
    in_path, stem = await _save_upload(file)
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run_full_analysis, in_path)
    except Exception as exc:
        log.exception("Full analysis failed: %s", exc)
        raise HTTPException(500, f"Analysis failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)
    result["filename"] = file.filename or stem
    return JSONResponse(result)


@app.post("/analyze-meta", tags=["Processing"])
async def analyze_meta(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    in_path, stem = await _save_upload(file)
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run_meta, in_path, file.filename or stem)
    except Exception as exc:
        log.exception("Meta failed: %s", exc)
        raise HTTPException(500, f"Meta-analysis failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)
    return JSONResponse(result)


@app.post("/transition", tags=["Processing"])
async def find_transition(background_tasks: BackgroundTasks,
                          mode: str = Form("auto"),
                          track_a: UploadFile = File(...), track_b: UploadFile = File(...)):
    in_a, sa = await _save_upload(track_a)
    in_b, sb = await _save_upload(track_b)
    try:
        loop = asyncio.get_running_loop()
        result, preview_path, applied_mode = await loop.run_in_executor(None, _run_transition, in_a, in_b, mode)
    except Exception as exc:
        log.exception("Transition failed: %s", exc)
        raise HTTPException(500, f"Transition failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_a)
        background_tasks.add_task(_delete_file, in_b)

    pfn = Path(preview_path).name
    _preview_registry[pfn] = preview_path

    payload = {
        "src_beat_idx": result.src_beat_idx, "tgt_beat_idx": result.tgt_beat_idx,
        "src_time": round(result.src_time, 4), "tgt_time": round(result.tgt_time, 4),
        "score": round(result.score, 4),
        "tempo_a": round(result.tempo_a, 2), "tempo_b": round(result.tempo_b, 2),
        "tempo_delta": round(result.tempo_delta, 2), "key_distance": result.key_distance,
        "duration_a": round(result.duration_a, 3), "duration_b": round(result.duration_b, 3),
        "preview_url": f"/preview/{pfn}",
        "applied_mode": applied_mode,
        "candidates": [
            {"src_beat_idx": c.src_beat_idx, "tgt_beat_idx": c.tgt_beat_idx,
             "src_time": round(c.src_time, 4), "tgt_time": round(c.tgt_time, 4),
             "score": round(c.score, 4)}
            for c in result.candidates
        ],
    }
    return JSONResponse(payload)


@app.post("/library-scores", tags=["Processing"])
async def library_scores(background_tasks: BackgroundTasks, files: List[UploadFile] = File(...)):
    """Score all pairs in a batch of tracks. Returns pairwise compatibility matrix."""
    if len(files) < 2:
        raise HTTPException(400, "Need at least 2 tracks")

    paths = []
    names = []
    for f in files:
        p, s = await _save_upload(f)
        paths.append(p)
        names.append(f.filename or s)

    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run_library_scores, paths, names)
    except Exception as exc:
        log.exception("Library scoring failed: %s", exc)
        raise HTTPException(500, f"Library scoring failed: {exc}")
    finally:
        for p in paths:
            background_tasks.add_task(_delete_file, p)

    return JSONResponse(result)


_preview_registry: dict = {}

@app.get("/preview/{filename}", tags=["Processing"])
async def download_preview(filename: str, background_tasks: BackgroundTasks):
    path = _preview_registry.pop(filename, None)
    if not path or not os.path.exists(path):
        raise HTTPException(404, "Preview not found")
    background_tasks.add_task(_delete_file, path)
    return FileResponse(path=path, media_type="audio/wav", filename=filename)


@app.post("/render-version", tags=["Processing"])
async def render_version(background_tasks: BackgroundTasks,
                         mode: str = Form("normal"),
                         file: UploadFile = File(...)):
    """
    Render a full-quality version of the uploaded track with the given
    DSP mode applied. Returns a 320 kbps MP3 file.

    Supported modes: normal, sped_up, 8d_audio, lofi_vhs, slowed_reverb,
                     nightcore, bass_boost, vinyl_crackle, underwater
    """
    if mode not in VALID_MODES:
        raise HTTPException(400, f"Invalid mode: {mode!r}. Valid: {VALID_MODES}")

    in_path, stem = await _save_upload(file)
    try:
        loop = asyncio.get_running_loop()
        mp3_path = await loop.run_in_executor(
            None, render_audio_version, in_path, mode
        )
    except Exception as exc:
        log.exception("Render-version failed: %s", exc)
        raise HTTPException(500, f"Rendering failed: {exc}")
    finally:
        background_tasks.add_task(_delete_file, in_path)

    # Schedule MP3 cleanup after response is sent
    background_tasks.add_task(_delete_file, mp3_path)

    safe_name = f"{stem} ({mode.replace('_', ' ').title()}).mp3"
    return FileResponse(
        path=mp3_path,
        media_type="audio/mpeg",
        filename=safe_name,
    )


# ── Worker functions ──────────────────────────────────────────────────

def _run_analysis(input_path: str) -> dict:
    proc = AudioContinuityProcessor(input_path)
    proc.load_and_extract()
    proc.build_similarity_graph()
    n = len(proc.beats)
    return {
        "filename": "", "song_duration_s": round(proc.beats[-1].time if proc.beats else 0, 3),
        "tempo": round(float(proc.tempo), 2), "beat_count": n, "edge_count": len(proc.edges),
        "beats": [
            {"index": b.index, "time": round(b.time, 4),
             "duration": round(max(0, (proc.beats[i+1].time - b.time) if i+1 < n else 60/proc.tempo), 4),
             "beat_phase": b.beat_phase, "is_phrase_start": b.is_phrase_start}
            for i, b in enumerate(proc.beats)
        ],
        "edges": [
            {"source": e.source, "target": e.target, "cost": round(e.cost, 4),
             "score": round(e.score, 4), "probability": round(e.probability, 4),
             "reachability": round(e.reachability, 4)}
            for e in proc.edges
        ],
    }


def _run_full_analysis(input_path: str) -> dict:
    proc = AudioContinuityProcessor(input_path)
    proc.load_and_extract()
    proc.build_similarity_graph()
    n = len(proc.beats)
    return {
        "filename": "", "song_duration_s": round(proc.beats[-1].time if proc.beats else 0, 3),
        "tempo": round(float(proc.tempo), 2), "beat_count": n, "edge_count": len(proc.edges),
        "min_beats_between_jumps": proc.MIN_BEATS_BETWEEN_JUMPS,
        "beats": [
            {"index": b.index, "time": round(b.time, 4),
             "duration": round(max(0, (proc.beats[i+1].time - b.time) if i+1 < n else 60/proc.tempo), 4),
             "beat_phase": b.beat_phase, "is_phrase_start": b.is_phrase_start}
            for i, b in enumerate(proc.beats)
        ],
        "edges": [
            {"source": e.source, "target": e.target, "cost": round(e.cost, 4),
             "score": round(e.score, 4), "probability": round(e.probability, 4),
             "reachability": round(e.reachability, 4)}
            for e in proc.edges
        ],
        "jump_schedule": proc.build_jump_schedule(),
    }


def _run_meta(input_path: str, name: str) -> dict:
    import numpy as np
    proc = AudioContinuityProcessor(input_path)
    proc.load_and_extract()
    fp = proc.extract_fingerprint(track_id=name)

    # Store for later scoring
    _fingerprint_store[name] = {
        "tempo": fp.tempo, "key_idx": fp.key_idx,
        "mean_chroma": fp.mean_chroma.tolist(),
        "mean_mfcc": fp.mean_mfcc.tolist(),
        "energy_profile": fp.energy_profile.tolist(),
        "duration": fp.duration, "camelot_key": fp.camelot_key,
    }

    return {
        "tempo": round(fp.tempo, 2), "key": fp.key_idx,
        "camelot_key": fp.camelot_key,
        "duration": round(fp.duration, 3), "beat_count": len(proc.beats),
    }


def _run_transition(path_a, path_b, mode):
    return TrackTransitionProcessor(path_a, path_b).process(mode=mode)


def _run_library_scores(paths: list, names: list) -> dict:
    import numpy as np
    fingerprints = {}
    track_info = {}

    for path, name in zip(paths, names):
        proc = AudioContinuityProcessor(path)
        proc.load_and_extract()
        fp = proc.extract_fingerprint(track_id=name)
        fingerprints[name] = fp
        track_info[name] = {
            "tempo": round(fp.tempo, 2), "key": fp.key_idx,
            "camelot_key": fp.camelot_key, "duration": round(fp.duration, 3),
        }
        # Cache
        _fingerprint_store[name] = {
            "tempo": fp.tempo, "key_idx": fp.key_idx,
            "mean_chroma": fp.mean_chroma.tolist(),
            "mean_mfcc": fp.mean_mfcc.tolist(),
            "energy_profile": fp.energy_profile.tolist(),
            "duration": fp.duration, "camelot_key": fp.camelot_key,
        }

    pairs = score_all_pairs(fingerprints)
    return {"tracks": track_info, "pairs": pairs}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="0.0.0.0", port=8000, reload=True)