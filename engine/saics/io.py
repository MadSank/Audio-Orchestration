"""Audio I/O via ffmpeg/ffprobe: real-codec probing, fixed-rate decoding, Chromaprint.

Files are only ever read. Every decode resamples to a caller-chosen rate, so mixed
44.1/48 kHz libraries come out on one grid (cf. defect D15).
"""

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

AUDIO_EXTS = {".mp3", ".mpeg", ".m4a", ".aac", ".mp4", ".ogg", ".oga", ".opus", ".flac", ".wav",
              ".aif", ".aiff", ".wma", ".webm"}  # fmt: skip

# Which codecs we expect for an extension; anything else is reported as a mismatch.
EXPECTED_CODECS = {
    ".mp3": {"mp3"},
    ".mpeg": {"mp3", "mp2"},
    ".m4a": {"aac", "alac"},
    ".aac": {"aac"},
    ".ogg": {"vorbis", "opus", "flac"},
    ".oga": {"vorbis", "opus", "flac"},
    ".opus": {"opus"},
    ".flac": {"flac"},
}

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


@dataclass
class Probe:
    ok: bool
    error: str = ""
    container: str = ""
    codec: str = ""
    sample_rate: int = 0
    channels: int = 0
    bitrate_kbps: float = 0.0
    duration_s: float = 0.0
    tags: dict = field(default_factory=dict)

    def ext_mismatch(self, path: Path) -> bool:
        want = EXPECTED_CODECS.get(path.suffix.lower())
        return bool(self.ok and want and self.codec not in want)


def probe(path: Path) -> Probe:
    """Ask ffprobe what the file really is (never trust the extension)."""
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
           "-select_streams", "a", str(path)]  # fmt: skip
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return Probe(ok=False, error=f"ffprobe failed: {exc}")
    if r.returncode != 0:
        msg = r.stderr.decode("utf-8", "replace").strip().splitlines()
        return Probe(ok=False, error=(msg[-1] if msg else f"ffprobe exit {r.returncode}")[:200])
    info = json.loads(r.stdout or b"{}")
    streams = info.get("streams") or []
    if not streams:
        return Probe(ok=False, error="no audio stream")
    s, fmt = streams[0], info.get("format", {})
    br = s.get("bit_rate") or fmt.get("bit_rate") or 0
    dur = s.get("duration") or fmt.get("duration") or 0
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    return Probe(
        ok=True,
        container=fmt.get("format_name", ""),
        codec=s.get("codec_name", ""),
        sample_rate=int(s.get("sample_rate") or 0),
        channels=int(s.get("channels") or 0),
        bitrate_kbps=round(float(br) / 1000.0, 1),
        duration_s=float(dur),
        tags={k: tags[k] for k in ("title", "artist") if k in tags},
    )


def decode(path: Path, sr: int = 22050, mono: bool = True, max_seconds: float = 0) -> np.ndarray:
    """Decode to float32 at `sr` (resampled by ffmpeg). Raises RuntimeError on failure."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path)]
    if max_seconds:
        cmd += ["-t", str(max_seconds)]
    cmd += ["-vn", "-ac", "1" if mono else "2", "-ar", str(sr), "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True, timeout=600, creationflags=_NO_WINDOW)
    y = np.frombuffer(r.stdout, dtype="<f4")
    if r.returncode != 0 and y.size == 0:
        msg = r.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError((msg[-1] if msg else f"ffmpeg exit {r.returncode}")[:200])
    return y if mono else y.reshape(-1, 2).T


def chromaprint(path: Path, seconds: float = 120) -> np.ndarray:
    """Raw Chromaprint fingerprint (uint32 per ~0.124 s) via ffmpeg's chromaprint muxer."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-t", str(seconds), "-vn",
           "-ac", "1", "-f", "chromaprint", "-fp_format", "raw", "-"]  # fmt: skip
    r = subprocess.run(cmd, capture_output=True, timeout=300, creationflags=_NO_WINDOW)
    if r.returncode != 0:
        return np.zeros(0, dtype=np.uint32)
    return np.frombuffer(r.stdout[: len(r.stdout) // 4 * 4], dtype="<u4").copy()
