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


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="saics", description="SAICS v6 analysis engine")
    sub = p.add_subparsers(dest="command", required=True)

    t = sub.add_parser("triage", help="classify files (report-only unless --apply)")
    t.add_argument("folder")
    t.add_argument("--out", default="triage_report.csv", help="CSV path (default: ./)")
    t.add_argument("--workers", type=int, default=4)
    t.add_argument("--limit", type=int, default=0, help="only the first N files (debugging)")
    t.add_argument("--apply", action="store_true", help="move flagged files (not implemented)")
    t.add_argument("--undo", action="store_true", help="restore moved files (not implemented)")
    t.set_defaults(func=_triage)

    a = sub.add_parser("analyze", help="write <folder>/.saics/ analysis bundles")
    a.add_argument("folder")
    a.set_defaults(func=_not_yet("P1"))

    r = sub.add_parser("render", help="offline render (eval clips, exports)")
    r.set_defaults(func=_not_yet("P2/P3"))

    e = sub.add_parser("eval", help="listening-test harness")
    e.add_argument("action", choices=["build", "report"])
    e.set_defaults(func=_not_yet("P2"))
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
