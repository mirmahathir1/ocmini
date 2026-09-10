"""Core data types for taskbook.

Tasks are plain dataclasses that round-trip through dicts so the storage layer
can stay ignorant of the field list.
"""

from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from typing import Any, Optional

# Valid states a task can occupy. Order matters: `sort_key` uses the index to
# group open work above finished work.
STATES = ("todo", "doing", "done")

PRIORITIES = ("low", "normal", "high")


class TaskError(Exception):
    """Raised when a task cannot be built or mutated as requested.

    The CLI turns this into a message on stderr and a non-zero exit, so the
    text of the message is user-facing. Keep it specific.
    """


@dataclass
class Task:
    id: int
    title: str
    state: str = "todo"
    priority: str = "normal"
    tags: list[str] = field(default_factory=list)
    created: str = ""
    done_on: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.title.strip():
            raise TaskError("task title must not be empty")
        if self.state not in STATES:
            raise TaskError(
                f"unknown state {self.state!r}; expected one of {', '.join(STATES)}"
            )
        if self.priority not in PRIORITIES:
            raise TaskError(
                f"unknown priority {self.priority!r}; "
                f"expected one of {', '.join(PRIORITIES)}"
            )
        if not self.created:
            self.created = today_iso()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Task":
        """Build a Task from stored JSON.

        Unknown keys are dropped rather than raising, so a store written by a
        newer version still loads here.
        """
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known})

    def sort_key(self) -> tuple[int, int, int]:
        """Open work first, then higher priority, then lower id."""
        return (
            STATES.index(self.state),
            -PRIORITIES.index(self.priority),
            self.id,
        )

    def matches(self, needle: str) -> bool:
        """Case-insensitive substring match over the title and tags."""
        needle = needle.lower()
        if needle in self.title.lower():
            return True
        return any(needle in tag.lower() for tag in self.tags)


def today_iso() -> str:
    return date.today().isoformat()


def parse_iso(value: str) -> date:
    """Parse an ISO date, raising TaskError with a readable message."""
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise TaskError(f"expected a date as YYYY-MM-DD, got {value!r}") from None


def normalise_tags(raw: Optional[str]) -> list[str]:
    """Split a comma-separated tag string into a clean, de-duplicated list."""
    if not raw:
        return []
    seen: list[str] = []
    for part in raw.split(","):
        tag = part.strip().lower()
        if tag and tag not in seen:
            seen.append(tag)
    return seen
