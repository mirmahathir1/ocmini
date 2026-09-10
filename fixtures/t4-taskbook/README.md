# taskbook

A small task tracker that keeps its tasks in a JSON file. Standard library only.

## Usage

    python -m taskbook add "write the report" --priority high --tags work,q3
    python -m taskbook list
    python -m taskbook list --state todo
    python -m taskbook list --tag work
    python -m taskbook find report
    python -m taskbook start 1
    python -m taskbook done 1
    python -m taskbook reopen 1
    python -m taskbook remove 1
    python -m taskbook summary

The store lives at `./.taskbook.json`. Override it with `--file PATH` or by
setting `TASKBOOK_FILE`.

## Commands

| Command | What it does |
|---|---|
| `add TITLE` | Add a task. `--priority low\|normal\|high`, `--tags a,b` |
| `list` | List tasks, open work first. `--state`, `--tag` filter |
| `find NEEDLE` | Search titles and tags; exit 1 if nothing matches |
| `start ID` | Mark a task in progress |
| `done ID` | Mark a task complete |
| `reopen ID` | Move a done task back to todo |
| `remove ID` | Delete a task |
| `summary` | Counts by state |

## Layout

| Module | Responsibility |
|---|---|
| `taskbook/models.py` | `Task`, validation, sorting, tag helpers |
| `taskbook/storage.py` | Atomic JSON load and save |
| `taskbook/render.py` | Text output; returns strings, never prints |
| `taskbook/commands.py` | One function per subcommand |
| `taskbook/cli.py` | Argument parsing and dispatch |

## Tests

    python -m unittest discover -s tests -t .

## Conventions

- Errors that the user should see are raised as `TaskError`; `cli.main` turns
  them into a message on stderr and exit code 1.
- Rendering returns strings so it can be tested without capturing stdout.
- Commands take `(args, store, out)` and return an exit code.
