from saics.cli import main


def test_render_without_bundle_fails_cleanly(tmp_path, capsys):
    (tmp_path / ".saics").mkdir()
    (tmp_path / ".saics" / "library.json").write_text('{"tracks": []}')
    assert main(["render", str(tmp_path), "nope.mp3"]) == 2
    assert "no analysis bundle" in capsys.readouterr().err
