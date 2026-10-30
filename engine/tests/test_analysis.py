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
    assert json.loads(b.dump())["schema"] == "saics.analysis/9"

    again = an.analyze(lib, None, workers=1, log=lambda *_: None)  # cached: nothing re-analysed
    assert again["bundles"] == 1

    # A run stopped before library.json was written: bundles on disk are still reused,
    # and bundles of files that left the library are pruned.
    (lib / ".saics" / "library.json").unlink()
    (lib / ".saics" / "tracks" / "deadbeef.json").write_text("{}", encoding="utf-8")
    logs = []
    third = an.analyze(lib, None, workers=1, log=logs.append)
    assert third["bundles"] == 1 and "0 to analyse" in logs[0]
    assert not (lib / ".saics" / "tracks" / "deadbeef.json").exists()


def _song_with_gaps(sr=22050):
    t = np.arange(40 * sr) / sr
    y = 0.3 * np.sin(2 * np.pi * 220 * t) * (1 + 0.5 * np.sin(2 * np.pi * 2 * t))
    y[int(20.0 * sr) : int(21.0 * sr)] = 0.0  # 1 s silent gap, then full level again
    y[int(30.0 * sr) : int(31.5 * sr)] *= 10 ** (-20 / 20)  # near-silent breakdown, -20 dB
    y[int(31.5 * sr) :] *= 10 ** (-12 / 20)  # ... that does not come back up
    return y.astype(np.float32)


def test_detect_breaks_silence_and_breakdown():
    sr = 22050
    breaks = an.detect_breaks(_song_with_gaps(sr), sr, np.arange(0, 40, 0.5))
    assert len(breaks) == 2
    gap, dip = breaks
    assert abs(gap.start_s - 20.0) < 0.3 and abs(gap.end_s - 21.0) < 0.3
    assert gap.kind == "silence" and gap.depth_db < -30 and gap.ramp_up
    assert (gap.start_beat, gap.end_beat) == (40, 42)
    assert dip.kind == "breakdown" and -30 < dip.depth_db <= -15 and not dip.ramp_up


def test_no_breaks_in_steady_music_or_at_the_edges():
    sr = 22050
    y = _song_with_gaps(sr)[: 19 * sr].copy()
    y[: sr // 2] = 0  # leading silence is an intro, not a break
    assert an.detect_breaks(y, sr, np.arange(0, 19, 0.5)) == []


RACING_ORIGINAL = (
    "*Racing Into the Night*Split Audio*"  # full original; the loop file is a 190 s edit
)


@pytest.mark.slow
def test_racing_into_the_night_gap_before_final_section():
    from pathlib import Path

    from saics.io import decode

    lib = Path(r"C:\Users\ASUS\Music\songs")
    files = list(lib.glob(RACING_ORIGINAL)) if lib.exists() else []
    if not files:
        pytest.skip("owner's library not available")
    y = decode(files[0], sr=an.SR, mono=False)[0]  # left channel: the Japanese original
    breaks = an.detect_breaks(y, an.SR, np.arange(0, len(y) / an.SR, 0.5))
    gap = [b for b in breaks if 185 < b.start_s < 195]
    assert gap, [(b.start_s, b.end_s, b.depth_db) for b in breaks]
    assert gap[0].kind == "silence" and gap[0].ramp_up and gap[0].end_s - gap[0].start_s > 0.5


def test_regularize_follows_a_phase_shift_and_ignores_half_bars():
    from saics.structure import regularize_downbeats

    raw = list(range(0, 64, 4)) + list(range(64, 100, 2)) + [101] + list(range(105, 180, 4))
    grid, m, conf = regularize_downbeats(raw, 180)
    assert m == 4
    assert all(d in grid for d in range(0, 64, 4))  # first part on phase 0
    assert all(d in grid for d in range(105, 176, 4))  # follows the shifted phase later
    assert all(b - a in (3, 4, 5) for a, b in zip(grid[:-1], grid[1:], strict=True))


def test_regularize_rejects_one_beat_bars():
    from saics.structure import regularize_downbeats

    grid, m, _ = regularize_downbeats(list(range(0, 100)), 100)
    assert m in (3, 4) and all(b - a >= 2 for a, b in zip(grid[:-1], grid[1:], strict=True))


def test_key_tolerates_a_mask_one_longer_than_the_chroma():
    from saics.structure import key_from_chroma

    prof = np.roll(an.MAJOR, 7)[:, None] * np.ones((1, 10))
    mask = np.zeros(11, bool)
    mask[::4] = True
    assert key_from_chroma(prof, prof, mask)[:2] == ("G", "major")
