"""saics analyze: helpers on known answers + one end-to-end run on a synthetic song."""

import hashlib
import json
import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

from saics import analysis as an
from saics.schema import Library, TrackBundle


def test_meter_from_downbeats_is_not_assumed_4_4():
    assert an.meter_from_downbeats(list(range(0, 60, 3))) == (3, 1.0)
    assert an.meter_from_downbeats(list(range(0, 80, 4)))[0] == 4
    db = [0, 4, 8, 12, 16, 19, 23, 27, 31]  # one 3-beat bar among 4/4
    assert an.meter_from_downbeats(db)[0] == 4 and an.meter_from_downbeats(db)[1] < 1


def test_downbeat_indices_map_to_beats():
    beats = np.arange(0, 20, 0.5)
    assert an.downbeat_indices(beats, np.array([0.01, 1.52, 3.0, 9.99])) == [0, 3, 6, 20]
    assert an.downbeat_indices(beats, np.array([0.25])) == []  # between beats: dropped


def test_tempo_from_beats():
    bpm, stable, conf = an.tempo_from_beats(np.arange(0, 60, 0.5))
    assert bpm == 120.0 and stable and conf == 1.0


@pytest.mark.parametrize(
    "tonic,mode,camelot",
    [(0, "major", "8B"), (9, "minor", "8A"), (7, "major", "9B"), (2, "minor", "7A")],
)
def test_key_from_chroma_profiles(tonic, mode, camelot):
    prof = np.roll(an.MAJOR if mode == "major" else an.MINOR, tonic)
    t, m, c, conf = an.key_from_chroma(prof)
    assert (t, m, c) == (an.PITCHES[tonic], mode, camelot) and conf > 0


def test_sections_find_repeats():
    rng = np.random.default_rng(0)
    a, b = rng.normal(size=8), rng.normal(size=8)
    bars = np.array([a] * 8 + [b] * 8 + [a] * 8) + 0.05 * rng.normal(size=(24, 8))
    secs = an.sections_from_bars(bars)
    starts = [s.start_bar for s in secs]
    assert 8 in starts and 16 in starts
    first, last = secs[0], secs[-1]
    assert first.group == last.group != [s for s in secs if s.start_bar == 8][0].group


def test_vocal_hysteresis():
    r = np.array([0, 0, 0.5, 0.5, 0.3, 0.3, 0.1, 0, 0.3, 0])
    act = an.smooth_activity(r)
    assert act[2] > 0 and act[4] > 0  # stays on above the off-threshold
    assert act[8] == 0  # 0.3 alone never switches it on


def test_track_id_ignores_name_but_not_audio():
    y = np.sin(np.arange(44100 * 31) / 10).astype(np.float32)
    assert an.track_id(y, 31.0) == an.track_id(y.copy(), 31.0)
    assert an.track_id(y, 31.0) != an.track_id(y * 0.5, 31.0)


@pytest.mark.slow
@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_analyze_end_to_end(tmp_path):
    from test_triage import _song

    lib = tmp_path / "songs"
    lib.mkdir()
    y = _song(40, 44100, seed=2, bpm=120)
    wav = tmp_path / "x.wav"
    sf.write(wav, np.stack([y, y]).T, 44100)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(wav), "-b:a", "192k",
                    str(lib / "Test Song.mp3")], check=True)  # fmt: skip
    before = hashlib.sha256((lib / "Test Song.mp3").read_bytes()).hexdigest()

    res = an.analyze(lib, None, workers=1, log=lambda *_: None)
    assert res["bundles"] == 1 and not res["errors"]
    assert hashlib.sha256((lib / "Test Song.mp3").read_bytes()).hexdigest() == before
    written = {p.relative_to(lib).as_posix() for p in lib.rglob("*") if p.is_file()}
    assert all(w == "Test Song.mp3" or w.startswith(".saics/") for w in written)

    library = Library.model_validate_json((lib / ".saics" / "library.json").read_text("utf-8"))
    tid = library.tracks[0].id
    b = TrackBundle.model_validate_json(
        (lib / ".saics" / "tracks" / f"{tid}.json").read_text("utf-8")
    )
    assert b.tempo.bpm > 0 and len(b.beats) > 20  # tempo accuracy is checked on real songs
    assert b.track.codec == "mp3" and b.track.native_sample_rate == 44100
    assert (
        -20 < b.loudness.integrated_lufs < 0
        and abs(b.loudness.gain_db + b.loudness.integrated_lufs + 14) < 0.01
    )
    assert len(b.vocal_activity) == len(b.beats) and max(b.vocal_activity) < 0.5  # no vocals
    assert json.loads(b.dump())["schema"] == "saics.analysis/6"

    again = an.analyze(lib, None, workers=1, log=lambda *_: None)  # cached: nothing re-analysed
    assert again["bundles"] == 1
