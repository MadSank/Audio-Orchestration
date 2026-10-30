import pytest

from saics.consolidate import move_files, undo


def test_move_and_undo_round_trip(tmp_path):
    src_dir, lib = tmp_path / "Downloads", tmp_path / "songs" / "from-downloads"
    (src_dir / "sub").mkdir(parents=True)
    a, b = src_dir / "a song.mp3", src_dir / "sub" / "b 夜に駆ける.mp3"
    a.write_bytes(b"aaa")
    b.write_bytes(b"bbbb")
    manifest = tmp_path / "songs" / ".saics" / "moves.json"

    recs = move_files([a, b], lib, manifest)
    assert len(recs) == 2 and not a.exists() and not b.exists()
    assert (lib / "a song.mp3").read_bytes() == b"aaa"

    undo(manifest)
    assert a.read_bytes() == b"aaa" and b.read_bytes() == b"bbbb"
    assert not (lib / "a song.mp3").exists()
    assert undo(manifest) == []  # already undone


def test_refuses_to_overwrite(tmp_path):
    lib = tmp_path / "lib"
    lib.mkdir()
    (lib / "x.mp3").write_bytes(b"keep me")
    src = tmp_path / "x.mp3"
    src.write_bytes(b"new")
    with pytest.raises(ValueError):
        move_files([src], lib, tmp_path / "m.json")
    assert (lib / "x.mp3").read_bytes() == b"keep me" and src.exists()


def test_undo_refuses_changed_file(tmp_path):
    src = tmp_path / "d" / "x.mp3"
    src.parent.mkdir()
    src.write_bytes(b"one")
    m = tmp_path / "m.json"
    move_files([src], tmp_path / "lib", m)
    (tmp_path / "lib" / "x.mp3").write_bytes(b"edited")
    with pytest.raises(ValueError):
        undo(m)
