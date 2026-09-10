"""Command implementations.

Each command takes parsed args plus a loaded Store and returns an exit code,
writing user-facing output through the injected `out` stream. Keeping the
stream injectable is what lets the tests assert on output without capturing
process stdout.
"""

from typing import Any, TextIO

from .models import Task, TaskError, normalise_tags, today_iso
from .render import render_list, render_summary, render_task
from .storage import Store


def cmd_add(args: Any, store: Store, out: TextIO) -> int:
    task = Task(
        id=0,  # replaced by Store.add
        title=args.title,
        priority=args.priority,
        tags=normalise_tags(args.tags),
    )
    store.add(task)
    store.save()
    print(f"added {render_task(task)}", file=out)
    return 0


def cmd_list(args: Any, store: Store, out: TextIO) -> int:
    tasks = store.sorted_tasks()

    if args.state:
        tasks = [t for t in tasks if t.state == args.state]
    if args.tag:
        wanted = args.tag.strip().lower()
        tasks = [t for t in tasks if wanted in t.tags]

    print(render_list(tasks), file=out)
    return 0


def cmd_find(args: Any, store: Store, out: TextIO) -> int:
    tasks = [t for t in store.sorted_tasks() if t.matches(args.needle)]
    if not tasks:
        print(f"nothing matches {args.needle!r}", file=out)
        return 1
    print(render_list(tasks), file=out)
    return 0


def cmd_start(args: Any, store: Store, out: TextIO) -> int:
    task = store.get(args.id)
    if task.state == "done":
        raise TaskError(f"task {task.id} is already done; reopen it first")
    task.state = "doing"
    store.save()
    print(f"started {render_task(task)}", file=out)
    return 0


def cmd_done(args: Any, store: Store, out: TextIO) -> int:
    task = store.get(args.id)
    if task.state == "done":
        raise TaskError(f"task {task.id} is already done")
    task.state = "done"
    task.done_on = today_iso()
    store.save()
    print(f"completed {render_task(task)}", file=out)
    return 0


def cmd_reopen(args: Any, store: Store, out: TextIO) -> int:
    task = store.get(args.id)
    if task.state != "done":
        raise TaskError(f"task {task.id} is not done")
    task.state = "todo"
    task.done_on = None
    store.save()
    print(f"reopened {render_task(task)}", file=out)
    return 0


def cmd_remove(args: Any, store: Store, out: TextIO) -> int:
    task = store.remove(args.id)
    store.save()
    print(f"removed {render_task(task)}", file=out)
    return 0


def cmd_summary(args: Any, store: Store, out: TextIO) -> int:
    print(render_summary(store.tasks), file=out)
    return 0
