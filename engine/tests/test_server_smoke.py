"""The legacy endpoints still work after the P0 restructure."""

import io
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, for `server`
fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402
from server.main import app  # noqa: E402

client = TestClient(app)


def _click_wav(seconds=20.0, sr=22050, bpm=120) -> bytes:
    # Kick on every beat, noise snare on 2 and 4, plus a chord that changes each bar:
    # sparse clicks alone make librosa find 0 beats, which crashes the legacy code (D22).
    n = int(seconds * sr)
    t = np.arange(n) / sr
    rng = np.random.default_rng(0)
    beat = int(60 / bpm * sr)
    y = np.zeros(n)
    kt = np.arange(int(0.15 * sr)) / sr
    kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-kt * 30)) * kt) * np.exp(-kt * 20)
    snare = rng.standard_normal(int(0.1 * sr)) * np.exp(-np.arange(int(0.1 * sr)) / (0.02 * sr))
    for i, s in enumerate(range(0, n - len(kick), beat)):
        y[s : s + len(kick)] += 0.8 * kick
        if i % 2 == 1:
            y[s : s + len(snare)] += 0.3 * snare
    for bar, s in enumerate(range(0, n, 4 * beat)):
        root = [220.0, 174.6, 261.6, 196.0][bar % 4]
        seg = slice(s, min(n, s + 4 * beat))
        y[seg] += sum(0.05 * np.sin(2 * np.pi * root * r * t[seg]) for r in (1, 1.26, 1.5))
    buf = io.BytesIO()
    sf.write(buf, y.astype(np.float32), sr, format="WAV")
    return buf.getvalue()


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_analyze_returns_beats():
    r = client.post("/analyze", files={"file": ("clicks.wav", _click_wav(), "audio/wav")})
    assert r.status_code == 200, r.text
    d = r.json()
    # Smoke test only: legacy librosa tracking may lock to half time (60 BPM) here.
    assert d["beat_count"] > 10 and min(abs(d["tempo"] - 120), abs(d["tempo"] - 60)) < 3
    assert {"beats", "edges", "song_duration_s"} <= d.keys()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg needed for MP3 export")
def test_render_version_returns_mp3():
    r = client.post(
        "/render-version",
        data={"mode": "vinyl_crackle"},
        files={"file": ("clicks.wav", _click_wav(5.0), "audio/wav")},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "audio/mpeg" and len(r.content) > 10_000


def test_eval_page_and_validation():
    r = client.get("/eval/")
    assert r.status_code == 200 and "Seam test" in r.text
    assert client.post("/eval/rate", json={"clip_id": "../etc", "rating": 3}).status_code == 422
    assert client.post("/eval/rate", json={"clip_id": "a" * 12, "rating": 9}).status_code == 422


def test_round2_reveal_and_full_song_rating(tmp_path, monkeypatch):
    import json

    import server.eval_routes as er

    (tmp_path / "round2").mkdir()
    (tmp_path / "full").mkdir()
    reveal = {"label": "B2:5 → B1:5", "text": "B2:5 → B1:5 (1:23 → 0:41)"}
    (tmp_path / "round2" / "manifest.json").write_text(
        json.dumps(
            {"context_s": 15, "clips": [{"id": "ab" * 6, "variant": "current", "reveal": reveal}]}
        )
    )
    (tmp_path / "full" / "manifest.json").write_text(
        json.dumps(
            {
                "renders": [
                    {
                        "id": "cd" * 6,
                        "song": "x.mp3",
                        "title": "x",
                        "duration_s": 420.0,
                        "jumps": [{"at_s": 121.3, "from": "D2:2", "to": "D1:2", "kind": "repeat"}],
                    }
                ]
            }
        )
    )
    monkeypatch.setattr(er, "EVAL_DIR", tmp_path)
    monkeypatch.setattr(er, "ROUNDS", {"1": tmp_path / "clips", "2": tmp_path / "round2"})
    monkeypatch.setattr(er, "FULL_DIR", tmp_path / "full")

    d = client.get("/eval/clips?round=2").json()
    assert d["todo"] == ["ab" * 6] and d["context_s"] == 15
    r = client.post("/eval/rate", json={"clip_id": "ab" * 6, "rating": 4}).json()
    assert r["reveal"]["label"] == "B2:5 → B1:5"  # revealed only after rating
    assert client.get("/eval/clips?round=2").json()["todo"] == []

    assert client.get("/eval/full/list").json()["renders"][0]["rated"] is False
    assert "jumps" not in client.get("/eval/full/list").json()["renders"][0]  # hidden
    out = client.post(
        "/eval/full/rate", json={"render_id": "cd" * 6, "overall": 4, "marks": [120.0, 300.5]}
    ).json()
    assert out["jumps"][0]["from"] == "D2:2"
    saved = json.loads(next((tmp_path / "results").glob("full-*.json")).read_text())
    assert saved["ratings"][0]["marks"] == [120.0, 300.5]
    assert client.get("/eval/full/list").json()["renders"][0]["rated"] is True
