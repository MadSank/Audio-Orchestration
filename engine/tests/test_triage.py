"""saics triage on a synthetic library: real codecs, mixed rates, junk, duplicates, groups."""

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
    """Drums + a random major/minor chord per bar + melody: clear beat, distinct harmony."""
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
    bars = n // (4 * beat) + 1
    roots = 196.0 * 2 ** (rng.integers(0, 12, bars) / 12)
    thirds = np.where(rng.random(bars) < 0.5, 2 ** (4 / 12), 2 ** (3 / 12))
    for bar, s in enumerate(range(0, n, 4 * beat)):
        seg = slice(s, min(n, s + 4 * beat))
        for r in (1, thirds[bar], 1.5):
            y[seg] += 0.06 * np.sin(2 * np.pi * roots[bar] * r * t[seg])
        for k in range(4):  # one melody note per beat
            sub = slice(s + k * beat, min(n, s + (k + 1) * beat))
            y[sub] += 0.04 * np.sin(
                2 * np.pi * roots[bar] * 2 * [1, 1.5, thirds[bar], 2][k] * t[sub]
            )
    return (0.8 * y / np.abs(y).max()).astype(np.float32)


def _varispeed(y: np.ndarray, factor: float) -> np.ndarray:
    idx = np.arange(0, len(y) - 1, factor)
    return np.interp(idx, np.arange(len(y)), y).astype(np.float32)


def _encode(y: np.ndarray, sr: int, dest: Path, args: list) -> None:
    wav = dest.with_suffix(".tmp.wav")
    sf.write(wav, y, sr)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), *args, str(dest)], check=True)
    wav.unlink()


@pytest.fixture(scope="module")
def library(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("music")
    neon = _song(80, SR, seed=1)
    _encode(neon, SR, d / "Neon Highway.mp3", ["-b:a", "320k"])
    _encode(neon, SR, d / "AUDIOALTER_Neon Highway.mp3", ["-b:a", "128k"])  # same version, worse
    _encode(neon, SR, d / "Neon Highway (Lyrics).mp3", ["-b:a", "256k"])  # lyric video: a version
    shutil.copyfile(d / "Neon Highway (Lyrics).mp3", d / "Neon Highway (Lyrics) (1).mp3")
    _encode(neon, SR, d / "Neon Highway (English Ver.).mp3", ["-b:a", "224k"])  # language version
    _encode(neon[: 50 * SR], SR, d / "Neon Highway but only the good part.mp3", ["-b:a", "320k"])
    _encode(
        _varispeed(neon, 1.3), SR, d / "Starfall (Nightcore).mp3", ["-b:a", "192k"]
    )  # audio only
    copper = _song(70, 48000, seed=7, bpm=97)
    _encode(copper, 48000, d / "Copper Sky.mp3", ["-b:a", "192k"])  # different song, 48 kHz
    _encode(copper, 48000, d / "Copper Sky (8D Audio).mp3", ["-b:a", "160k"])
    _encode(_song(60, SR, seed=3, bpm=140), SR, d / "Mislabelled.mp3", ["-c:a", "aac", "-f", "mp4"])
    _encode(_song(12, SR, seed=4), SR, d / "Ringtone.mp3", ["-b:a", "128k"])
    noise = np.random.default_rng(5).standard_normal(60 * SR).astype(np.float32)
    noise *= np.linspace(0.1, 0.4, len(noise), dtype=np.float32)  # wind/whoosh-like sfx
    _encode(noise, SR, d / "Wind sfx.mp3", ["-b:a", "128k"])
    brown = np.cumsum(np.random.default_rng(6).standard_normal(60 * SR)).astype(np.float32)
    brown -= np.convolve(brown, np.ones(4410) / 4410, mode="same")  # drift removal
    _encode(brown / np.abs(brown).max() * 0.5, SR, d / "Brown noise sleep.mp3", ["-b:a", "128k"])
    (d / "Broken download.mp3").write_bytes(b"{}")
    (d / "notes.txt").write_text("hi")
    return d


def _run(library, out_dir, groups_file=None):
    out = out_dir / "triage_report.csv"
    tr.triage(library, out, workers=2, log=lambda *_: None, groups_file=groups_file)
    with out.open(encoding="utf-8-sig") as f:
        return {r["file"]: r for r in csv.DictReader(f)}


@pytest.fixture(scope="module")
def report(library, tmp_path_factory):
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in library.iterdir()}
    out_dir = tmp_path_factory.mktemp("out")
    rows = _run(library, out_dir)
    after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in library.iterdir()}
    return rows, before, after, out_dir


def test_music_folder_untouched(report):
    _, before, after, _ = report
    assert before == after  # nothing moved, renamed, added, deleted or modified


def test_refuses_report_inside_music_folder(library):
    with pytest.raises(ValueError):
        tr.triage(library, library / "triage_report.csv", workers=1, log=lambda *_: None)


def test_real_codec_not_extension(report):
    rows, *_ = report
    r = rows["Mislabelled.mp3"]
    assert r["codec"] == "aac" and r["ext_mismatch"] == "True"
    assert r["class"] == "music"
    assert rows["Copper Sky.mp3"]["sample_rate"] == "48000"
    assert rows["Neon Highway.mp3"]["ext_mismatch"] == "False"


def test_junk_classes(report):
    rows, *_ = report
    assert rows["Broken download.mp3"]["class"] == "unreadable"
    assert rows["Ringtone.mp3"]["class"] == "short"
    assert rows["Wind sfx.mp3"]["class"] == "sfx"
    assert rows["Brown noise sleep.mp3"]["class"] == "sfx"
    assert rows["notes.txt"]["class"] == "not_audio"


def test_same_version_other_encoding_is_duplicate(report):
    rows, *_ = report
    dup = rows["AUDIOALTER_Neon Highway.mp3"]
    assert dup["class"] == "duplicate" and dup["keep"] == "no"
    assert dup["duplicate_of"] == "Neon Highway.mp3"
    assert (
        rows["Neon Highway.mp3"]["keep"] == "yes" and rows["Neon Highway.mp3"]["class"] == "music"
    )


def test_byte_identical_is_duplicate(report):
    rows, *_ = report
    r = rows["Neon Highway (Lyrics) (1).mp3"]
    assert r["class"] == "duplicate" and "byte-identical" in r["reasons"]
    assert r["duplicate_of"] == "Neon Highway (Lyrics).mp3"


def test_versions_are_never_duplicates(report):
    rows, *_ = report
    for name in ("Neon Highway (Lyrics).mp3", "Neon Highway (English Ver.).mp3",
                 "Neon Highway but only the good part.mp3", "Starfall (Nightcore).mp3",
                 "Copper Sky (8D Audio).mp3"):  # fmt: skip
        assert rows[name]["class"] == "music" and rows[name]["keep"] == "yes", name


def test_version_labels(report):
    rows, *_ = report
    assert rows["Neon Highway.mp3"]["version"] == "original"
    assert rows["Neon Highway (Lyrics).mp3"]["version"] == "lyrics"
    assert rows["Neon Highway (English Ver.).mp3"]["version"] == "english"
    assert rows["Starfall (Nightcore).mp3"]["version"] == "nightcore"
    assert rows["Copper Sky (8D Audio).mp3"]["version"] == "8d"


def test_groups(report):
    rows, *_ = report
    neon = {rows[f]["group"] for f in rows if "Neon Highway" in f or f.startswith("Starfall")}
    assert len(neon) == 1 and "" not in neon  # nightcore joins by audio alone
    copper = {rows["Copper Sky.mp3"]["group"], rows["Copper Sky (8D Audio).mp3"]["group"]}
    assert len(copper) == 1
    assert copper.isdisjoint(neon)
    assert rows["Mislabelled.mp3"]["group"] not in neon | copper
    assert "audio" in rows["Starfall (Nightcore).mp3"]["group_evidence"]


def test_group_review_csv(report):
    *_, out_dir = report
    with (out_dir / "song_groups_review.csv").open(encoding="utf-8-sig") as f:
        review = list(csv.DictReader(f))
    first = review[0]  # largest group first
    assert first["group_name"].lower().startswith("neon highway")
    assert int(first["group_size"]) == 7
    assert (out_dir / "groups_overrides.example.csv").exists()


def test_group_overrides(library, tmp_path):
    ov = tmp_path / "overrides.csv"
    ov.write_text(
        "# test\n"
        "split,Starfall (Nightcore).mp3,\n"
        "merge,Mislabelled.mp3,Copper Sky.mp3\n"
        "version,Copper Sky (8D Audio).mp3,8d+bass boosted\n",
        encoding="utf-8",
    )
    rows = _run(library, tmp_path, groups_file=ov)
    assert rows["Starfall (Nightcore).mp3"]["group"] != rows["Neon Highway.mp3"]["group"]
    assert rows["Neon Highway (Lyrics).mp3"]["group"] == rows["Neon Highway.mp3"]["group"]
    assert rows["Mislabelled.mp3"]["group"] == rows["Copper Sky.mp3"]["group"]
    assert rows["Copper Sky (8D Audio).mp3"]["version"] == "8d+bass boosted"


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


def test_long_class_apply_and_undo(tmp_path, monkeypatch):
    lib = tmp_path / "songs"
    (lib / "sub").mkdir(parents=True)
    _encode(_song(70, SR, seed=8), SR, lib / "sub" / "Hour Loop.mp3", ["-b:a", "64k"])
    _encode(_song(50, SR, seed=9), SR, lib / "Real Song.mp3", ["-b:a", "64k"])
    monkeypatch.setattr(tr, "LONG_CLASS_S", 60.0)  # stand-in for the 15-minute threshold
    out = tmp_path / "triage_report.csv"
    tr.triage(lib, out, workers=1, log=lambda *_: None)
    with out.open(encoding="utf-8-sig") as f:
        rows = {r["file"]: r for r in csv.DictReader(f)}
    long_row = rows["sub/Hour Loop.mp3"]
    assert long_row["class"] == "long" and long_row["group"] == ""  # no group, no analysis
    assert rows["Real Song.mp3"]["class"] == "music"

    from saics.cli import main

    with pytest.raises(ValueError):
        tr.set_aside(lib, out, {"music"}, log=lambda *_: None)  # songs are never moved
    assert main(["triage", str(lib), "--apply", "--out", str(out)]) == 2  # needs --classes
    assert main(["triage", str(lib), "--apply", "--classes", "long", "--out", str(out)]) == 0
    assert not (lib / "sub" / "Hour Loop.mp3").exists()
    assert (lib / "_set_aside" / "long" / "sub" / "Hour Loop.mp3").exists()
    assert (lib / "Real Song.mp3").exists()
    assert (lib / ".saics" / "set_aside_manifest.json").exists()
    assert main(["triage", str(lib), "--undo"]) == 0
    assert (lib / "sub" / "Hour Loop.mp3").exists()
    assert not (lib / "_set_aside" / "long" / "sub" / "Hour Loop.mp3").exists()
