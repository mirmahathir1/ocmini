"""Text rendering for taskbook.

Every command that prints a task list goes through here, so column widths and
the empty-list message stay consistent. Rendering never touches the store and
never prints — it returns strings, which is what makes it testable.
"""

from .models import Task

STATE_MARKS = {"todo": "[ ]", "doing": "[~]", "done": "[x]"}

PRIORITY_MARKS = {"low": " ", "normal": " ", "high": "!"}

EMPTY_MESSAGE = "no tasks yet — add one with: taskbook add \"my first task\""


def render_task(task: Task) -> str:
    """One task as a single line: mark, id, title, then tags."""
    mark = STATE_MARKS[task.state]
    flag = PRIORITY_MARKS[task.priority]
    line = f"{mark}{flag} {task.id:>3}  {task.title}"
    if task.tags:
        line += f"  ({', '.join(task.tags)})"
    return line


def render_list(tasks: list[Task]) -> str:
    """A full listing, or the empty-state hint when there is nothing to show."""
    if not tasks:
        return EMPTY_MESSAGE
    return "\n".join(render_task(t) for t in tasks)


def render_summary(tasks: list[Task]) -> str:
    """A one-line count by state, always in STATES order."""
    counts = {"todo": 0, "doing": 0, "done": 0}
    for task in tasks:
        counts[task.state] += 1
    parts = [f"{counts[state]} {state}" for state in ("todo", "doing", "done")]
    return " · ".join(parts)
