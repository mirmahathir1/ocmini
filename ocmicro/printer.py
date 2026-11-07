import json
import sys

DIM, RESET = ("\033[2m", "\033[0m") if sys.stdout.isatty() else ("", "")


def print_call(call):
    """Show a bash call as `$ <command>`, or its raw arguments if they are not valid JSON."""
    try:
        command = json.loads(call.get("arguments") or "{}").get("command", "")
    except (ValueError, AttributeError):
        command = call.get("arguments", "")
    print(f"{DIM}$ {command}{RESET}")


def preview(output, lines=10):
    """Show the first few lines of a tool's output, with a count of the lines left out."""
    shown = output.split("\n")
    more = f"\n… {len(shown) - lines} more lines" if len(shown) > lines else ""
    text = "\n".join(shown[:lines]) + more
    print(f"{DIM}{text}{RESET}")
