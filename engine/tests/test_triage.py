"""saics triage on a synthetic library: real codecs, mixed rates, junk, duplicates."""

import csv
import hashlib
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from saics import triage as tr

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
SR = 44100


def _song(seconds: float, sr: int, seed: int = 0, bpm: float = 120.0) -> np.ndarray:
    """Drums + changing chords + a melody line: something with a clear beat and key."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    t = np.arange(n) / sr
    beat = int(60 / bpm * sr)
    y = np.zeros(n)
    kt = np.arange(int(0.15 * sr)) / sr
    kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-kt * 30)) * kt) * np.exp(-kt * 20)
    hat = rng.standard_normal(int(0.03 * sr)) * np.exp(-np.arange(int(0.03 * sr)) / (0.005 * sr))
    for s in range(0, n - len(kick), beat):
        y[s : s + len(kick)] += 0.7 * kick
        y[s + beat // 2 : s + beat // 2 + len(hat)] += 0.1 * hat[: max(0, n - s - beat // 2)]
    roots = rng.choice([196.0, 220.0, 261.6, 293.7, 174.6], size=n // (4 * beat) + 1)
    for bar, s in enumerate(range(0, n, 4 * beat)):
        seg = slice(s, min(n, s + 4 * beat))
        y[seg] += sum(0.06 * np.sin(2 * np.pi * roots[bar] * r * t[seg]) for r in (1, 1.25, 1.5))
        y[seg] += 0.05 * np.sin(2 * np.pi * roots[bar] * 2 * t[seg])
    return (0.8 * y / np.abs(y).max()).astype(np.float32)


def _encode(y: np.ndarray, sr: int, dest: Path, args: list) -> None:
    wav = dest.with_suffix(".tmp.wav")
    sf.write(wav, y, sr)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), *args, str(dest)], check=True)
    wav.unlink()


@pytest.fixture(scope="module")
def library(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("music")
    song = _song(70, SR, seed=1)
    _encode(song, SR, d / "Song A.mp3", ["-b:a", "320k"])
    _encode(song, SR, d / "Song A (Lyrics) low.mp3", ["-b:a", "96k"])  # duplicate, worse copy
    other = _song(65, 48000, seed=7, bpm=97)
    _encode(other, 48000, d / "Song B 48k.mp3", ["-b:a", "192k"])  # different song, 48 kHz
    _encode(other, 48000, d / "Song B (8D Audio).mp3", ["-b:a", "192k"])  # variant hint name
    _encode(_song(60, SR, seed=3, bpm=140), SR, d / "Mislabelled.mp3", ["-c:a", "aac", "-f", "mp4"])
    _encode(_song(12, SR, seed=4), SR, d / "Ringtone.mp3", ["-b:a", "128k"])
    noise = np.random.default_rng(5).standard_normal(60 * SR).astype(np.float32)
    noise *= np.linspace(0.1, 0.4, len(noise), dtype=np.float32)  # wind/whoosh-like sfx
    _encode(noise, SR, d / "Wind sfx.mp3", ["-b:a", "128k"])
    (d / "Broken download.mp3").write_bytes(b"{}")
    (d / "notes.txt").write_text("hi")
    return d


@pytest.fixture(scope="module")
def report(library, tmp_path_factory):
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in library.iterdir()}
    out = tmp_path_factory.mktemp("out") / "triage_report.csv"
    tr.triage(library, out, workers=2, log=lambda *_: None)
    after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in library.iterdir()}
    with out.open(encoding="utf-8-sig") as f:
        rows = {r["file"]: r for r in csv.DictReader(f)}
    return rows, before, after


def test_music_folder_untouched(report):
    _, before, after = report
    assert before == after  # nothing moved, renamed, added, deleted or modified


def test_refuses_report_inside_music_folder(library):
    with pytest.raises(ValueError):
        tr.triage(library, library / "triage_report.csv", workers=1, log=lambda *_: None)


def test_real_codec_not_extension(report):
    rows, *_ = report
    r = rows["Mislabelled.mp3"]
    assert r["codec"] == "aac" and r["ext_mismatch"] == "True"
    assert r["class"] == "music"
    assert rows["Song B 48k.mp3"]["sample_rate"] == "48000"
    assert rows["Song A.mp3"]["ext_mismatch"] == "False"


def test_junk_classes(report):
    rows, *_ = report
    assert rows["Broken download.mp3"]["class"] == "unreadable"
    assert rows["Ringtone.mp3"]["class"] == "short"
    assert rows["Wind sfx.mp3"]["class"] == "sfx"
    assert rows["notes.txt"]["class"] == "not_audio"


def test_duplicates_keep_better_copy(report):
    rows, *_ = report
    dup = rows["Song A (Lyrics) low.mp3"]
    assert dup["class"] == "duplicate" and dup["keep"] == "no"
    assert dup["duplicate_of"] == "Song A.mp3"
    assert rows["Song A.mp3"]["keep"] == "yes" and rows["Song A.mp3"]["class"] == "music"
    assert rows["Song B 48k.mp3"]["class"] == "music"  # a different song is not a duplicate


def test_variant_hint(report):
    rows, *_ = report
    assert rows["Song B (8D Audio).mp3"]["variant_hint"] == "8d"


def test_songs_not_flagged(report):
    rows, *_ = report
    for name in ("Song A.mp3", "Song B 48k.mp3", "Mislabelled.mp3"):
        assert rows[name]["class"] == "music", (name, rows[name]["reasons"])


def test_min_ber_identical_vs_random():
    rng = np.random.default_rng(0)
    a = rng.integers(0, 2**32, 300, dtype=np.uint64).astype(np.uint32)
    b = rng.integers(0, 2**32, 300, dtype=np.uint64).astype(np.uint32)
    assert tr.min_ber(a, a) == 0.0
    assert tr.min_ber(a[20:], a) == 0.0  # found at an offset
    assert tr.min_ber(a, b) > 0.4


def test_apply_is_refused(library, tmp_path):
    from saics.cli import main

    assert main(["triage", str(library), "--apply", "--out", str(tmp_path / "r.csv")]) == 2
