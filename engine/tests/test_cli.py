from saics.cli import main


def test_unimplemented_commands_exit_2(capsys):
    assert main(["eval", "build"]) == 2
    assert "P2" in capsys.readouterr().err
