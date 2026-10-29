from saics.cli import main


def test_unimplemented_commands_exit_2(capsys):
    assert main(["analyze", "x"]) == 2
    assert "P1" in capsys.readouterr().err
