"""`saics` command line: triage | analyze | render | eval."""

import argparse
import sys


def _not_yet(phase: str):
    def run(_args) -> int:
        print(f"not implemented yet (planned in {phase}; see PLAN.md)", file=sys.stderr)
        return 2

    return run


def _triage(args) -> int:
    from saics.triage import run_triage

    return run_triage(args)


def _analyze(args) -> int:
    from saics.analysis import run_analyze

    return run_analyze(args)


def _undo_moves(args) -> int:
    from saics.consolidate import undo

    for rec in undo(args.manifest):
        print(f"restored {rec['source']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="saics", description="SAICS v6 analysis engine")
    sub = p.add_subparsers(dest="command", required=True)

    t = sub.add_parser("triage", help="classify files (report-only unless --apply)")
    t.add_argument("folder")
    t.add_argument("--out", default="triage_report.csv", help="CSV path (default: ./)")
    t.add_argument("--workers", type=int, default=4)
    t.add_argument("--limit", type=int, default=0, help="only the first N files (debugging)")
    t.add_argument(
        "--groups-file",
        default=None,
        help="group overrides CSV (default: <folder>/.saics/groups_overrides.csv)",
    )
    t.add_argument("--apply", action="store_true", help="move flagged files (not implemented)")
    t.add_argument("--undo", action="store_true", help="restore moved files (not implemented)")
    t.set_defaults(func=_triage)

    u = sub.add_parser("undo-moves", help="put files recorded in a move manifest back")
    u.add_argument("manifest")
    u.set_defaults(func=_undo_moves)

    a = sub.add_parser("analyze", help="write <folder>/.saics/ analysis bundles")
    a.add_argument("folder")
    a.add_argument(
        "--triage",
        default="triage_report.csv",
        help="triage report: classes + song groups (default: ./triage_report.csv)",
    )
    a.add_argument("--workers", type=int, default=3, help="processes (each loads the models)")
    a.add_argument("--limit", type=int, default=0)
    a.set_defaults(func=_analyze)

    r = sub.add_parser("render", help="offline render (eval clips, exports)")
    r.set_defaults(func=_not_yet("P3"))

    e = sub.add_parser("eval", help="listening-test harness")
    e.add_argument("action", choices=["build", "report"])
    e.add_argument("folder", nargs="?", default="", help="music folder (build)")
    e.add_argument("--set", default="eval/set.txt", help="songs to evaluate, one per line")
    e.add_argument("--eval-dir", default="eval", help="clips/, results/, report.md live here")
    e.add_argument("--per-song", type=int, default=10)
    e.set_defaults(func=_eval)
    return p


def _eval(args) -> int:
    from saics.evaluation import run_eval

    return run_eval(args)


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
