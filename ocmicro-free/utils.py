import datetime
import os
import sys


def api_key():
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".groq_key")) as f:
        return f.read().strip()


def environment(model):
    # SystemPrompt.environment in src/session/system.ts, without the git lines.
    return "\n".join(
        [
            f"You are powered by the model named {model}. The exact model ID is groq/{model}",
            "Here is some useful information about the environment you are running in:",
            "<env>",
            f"  Working directory: {os.getcwd()}",
            f"  Platform: {sys.platform}",
            f"  Today's date: {datetime.date.today().strftime('%a %b %d %Y')}",
            "</env>",
        ]
    )
