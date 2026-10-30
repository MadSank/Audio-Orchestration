from saics.cli import main


def test_unimplemented_commands_exit_2(capsys):
    assert main(["render"]) == 2
    assert "P3" in capsys.readouterr().err
