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


def _jumps(args) -> int:
    from pathlib import Path

    from saics.analysis import recompute_jumps

    only = None
    if args.only:
        lines = Path(args.only).read_text(encoding="utf-8").splitlines()
        only = {
            ln.strip().replace("\\", "/") for ln in lines if ln.strip() and not ln.startswith("#")
        }
    recompute_jumps(Path(args.folder), only)
    return 0


def _portals(args) -> int:
    from pathlib import Path

    from saics.portals import write_graph

    write_graph(Path(args.folder))
    return 0


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
    t.add_argument(
        "--apply",
        action="store_true",
        help="move files of --classes (read from --out report) into _set_aside/",
    )
    t.add_argument("--classes", default="", help="comma list for --apply, e.g. long,duplicate")
    t.add_argument("--undo", action="store_true", help="restore everything --apply moved")
    t.set_defaults(func=_triage)

    u = sub.add_parser("undo-moves", help="put files recorded in a move manifest back")
    u.add_argument("manifest")
    u.set_defaults(func=_undo_moves)

    jp = sub.add_parser("jumps", help="re-run jump finding from cached features (fast)")
    jp.add_argument("folder")
    jp.add_argument("--only", default="", help="file listing songs to update")
    jp.set_defaults(func=_jumps)

    pg = sub.add_parser("portals", help="find cross-song portals: writes .saics/portals.json")
    pg.add_argument("folder")
    pg.set_defaults(func=_portals)

    a = sub.add_parser("analyze", help="write <folder>/.saics/ analysis bundles")
    a.add_argument("folder")
    a.add_argument(
        "--triage",
        default="triage_report.csv",
        help="triage report: classes + song groups (default: ./triage_report.csv)",
    )
    a.add_argument("--workers", type=int, default=3, help="processes (each loads the models)")
    a.add_argument("--limit", type=int, default=0)
    a.add_argument("--only", default="", help="file listing songs to (re)analyse first")
    a.set_defaults(func=_analyze)

    r = sub.add_parser("render", help="offline Forever render of one song (+ jump log)")
    r.add_argument("folder", help="music folder (with .saics/)")
    r.add_argument("file", help="song, relative to the music folder")
    r.add_argument("--minutes", type=float, default=7.0)
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--out", default="forever.mp3")
    r.set_defaults(func=_render)

    e = sub.add_parser("eval", help="listening-test harness")
    e.add_argument("action", choices=["build", "build2", "build2b", "build3", "report", "feedback"])
    e.add_argument("folder", nargs="?", default="", help="music folder (build)")
    e.add_argument("--set", default="eval/set.txt", help="songs to evaluate, one per line")
    e.add_argument("--eval-dir", default="eval", help="clips/, results/, report.md live here")
    e.add_argument("--per-song", type=int, default=10)
    e.set_defaults(func=_eval)
    return p


def _render(args) -> int:
    import json
    from pathlib import Path

    from saics.render import render_forever, write_audio
    from saics.schema import TrackBundle

    folder = Path(args.folder)
    lib = json.loads((folder / ".saics" / "library.json").read_text("utf-8"))
    rel = args.file.replace("\\", "/")
    tid = next((t["id"] for t in lib["tracks"] if t["file"] == rel), None)
    if tid is None:
        print(f"no analysis bundle for {rel}", file=sys.stderr)
        return 2
    b = TrackBundle.model_validate_json(
        (folder / ".saics" / "tracks" / f"{tid}.json").read_text("utf-8")
    )
    y, sr, log = render_forever(folder / rel, b, args.minutes, args.seed)
    write_audio(args.out, y, sr)
    for e in log:
        print(f"{e['at_s']:7.1f}s  {e['from']} -> {e['to']}  ({e['kind']})")
    return 0


def _eval(args) -> int:
    from saics.evaluation import run_eval

    return run_eval(args)


def main(argv=None) -> int:
    # Windows consoles default to a legacy code page; song titles (Japanese, emoji, ...) must
    # never crash a long batch just by being logged.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
