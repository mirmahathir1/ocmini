"""Argument parsing and entry point.

Every subcommand is registered the same way: a parser, its arguments, then a
`func` default pointing at the implementation in commands.py. `main` stays
thin — parse, load, dispatch, turn TaskError into a clean failure.
"""

import argparse
import sys
from pathlib import Path
from typing import Optional, Sequence, TextIO

from . import commands
from .models import PRIORITIES, STATES, TaskError
from .storage import Store, default_store_path

PROG = "taskbook"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description="A small task tracker that stores tasks in a JSON file.",
    )
    parser.add_argument(
        "--file",
        type=Path,
        default=None,
        help="path to the task store (default: ./.taskbook.json or $TASKBOOK_FILE)",
    )
    subs = parser.add_subparsers(dest="command", metavar="COMMAND")

    p_add = subs.add_parser("add", help="add a new task")
    p_add.add_argument("title", help="what needs doing")
    p_add.add_argument(
        "--priority",
        choices=PRIORITIES,
        default="normal",
        help="task priority (default: normal)",
    )
    p_add.add_argument("--tags", help="comma-separated tags")
    p_add.set_defaults(func=commands.cmd_add)

    p_list = subs.add_parser("list", help="list tasks")
    p_list.add_argument("--state", choices=STATES, help="only show this state")
    p_list.add_argument("--tag", help="only show tasks carrying this tag")
    p_list.set_defaults(func=commands.cmd_list)

    p_find = subs.add_parser("find", help="search titles and tags")
    p_find.add_argument("needle", help="text to search for")
    p_find.set_defaults(func=commands.cmd_find)

    p_start = subs.add_parser("start", help="mark a task in progress")
    p_start.add_argument("id", type=int, help="task id")
    p_start.set_defaults(func=commands.cmd_start)

    p_done = subs.add_parser("done", help="mark a task complete")
    p_done.add_argument("id", type=int, help="task id")
    p_done.set_defaults(func=commands.cmd_done)

    p_reopen = subs.add_parser("reopen", help="move a done task back to todo")
    p_reopen.add_argument("id", type=int, help="task id")
    p_reopen.set_defaults(func=commands.cmd_reopen)

    p_remove = subs.add_parser("remove", help="delete a task")
    p_remove.add_argument("id", type=int, help="task id")
    p_remove.set_defaults(func=commands.cmd_remove)

    p_summary = subs.add_parser("summary", help="counts by state")
    p_summary.set_defaults(func=commands.cmd_summary)

    return parser


def main(
    argv: Optional[Sequence[str]] = None,
    out: Optional[TextIO] = None,
    err: Optional[TextIO] = None,
) -> int:
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr

    parser = build_parser()
    args = parser.parse_args(argv)

    if not getattr(args, "command", None):
        parser.print_help(out)
        return 0

    path = args.file if args.file is not None else default_store_path()

    try:
        store = Store.load(path)
        return args.func(args, store, out)
    except TaskError as exc:
        print(f"{PROG}: {exc}", file=err)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
