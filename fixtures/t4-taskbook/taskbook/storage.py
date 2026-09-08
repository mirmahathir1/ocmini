"""JSON-file persistence for taskbook.

The store is a single JSON document: a version marker, the next id to hand out,
and a list of tasks. Writes are atomic — we write a sibling temp file and
replace, so an interrupted run cannot truncate an existing store.
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .models import Task, TaskError

SCHEMA_VERSION = 1

DEFAULT_STORE_NAME = ".taskbook.json"


def default_store_path() -> Path:
    """Where the store lives when --file is not given.

    Honours TASKBOOK_FILE so tests and scripts can redirect it.
    """
    override = os.environ.get("TASKBOOK_FILE")
    if override:
        return Path(override)
    return Path.cwd() / DEFAULT_STORE_NAME


class Store:
    """A loaded task store. Call `save` to persist changes."""

    def __init__(self, path: Path, next_id: int = 1, tasks: list[Task] | None = None):
        self.path = path
        self.next_id = next_id
        self.tasks: list[Task] = tasks or []

    @classmethod
    def load(cls, path: Path) -> "Store":
        """Read a store from disk, returning an empty one if absent.

        A corrupt or unreadable store is an error rather than a silent reset —
        clobbering someone's tasks because a byte flipped is worse than failing.
        """
        if not path.exists():
            return cls(path)
        try:
            raw: Any = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise TaskError(f"{path} is not valid JSON: {exc.msg}") from None
        except OSError as exc:
            raise TaskError(f"cannot read {path}: {exc.strerror}") from None

        if not isinstance(raw, dict):
            raise TaskError(f"{path} does not contain a task store")

        version = raw.get("version", SCHEMA_VERSION)
        if version > SCHEMA_VERSION:
            raise TaskError(
                f"{path} was written by a newer taskbook (schema {version}); "
                f"this build understands schema {SCHEMA_VERSION}"
            )

        tasks = [Task.from_dict(item) for item in raw.get("tasks", [])]
        next_id = raw.get("next_id") or (max((t.id for t in tasks), default=0) + 1)
        return cls(path, next_id=next_id, tasks=tasks)

    def save(self) -> None:
        payload = {
            "version": SCHEMA_VERSION,
            "next_id": self.next_id,
            "tasks": [t.to_dict() for t in self.tasks],
        }
        body = json.dumps(payload, indent=2, sort_keys=True) + "\n"

        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(body)
            os.replace(tmp, self.path)
        except OSError as exc:
            # Do not leave the temp file behind on a failed write.
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise TaskError(f"cannot write {self.path}: {exc.strerror}") from None

    def add(self, task: Task) -> Task:
        task.id = self.next_id
        self.next_id += 1
        self.tasks.append(task)
        return task

    def get(self, task_id: int) -> Task:
        for task in self.tasks:
            if task.id == task_id:
                return task
        raise TaskError(f"no task with id {task_id}")

    def remove(self, task_id: int) -> Task:
        task = self.get(task_id)
        self.tasks.remove(task)
        return task

    def sorted_tasks(self) -> list[Task]:
        return sorted(self.tasks, key=lambda t: t.sort_key())
