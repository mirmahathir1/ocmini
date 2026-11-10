"""The conversation sent to the model on every request.

With store: false the server keeps nothing between requests, so this array is the
whole conversation: the developer prompt, each user prompt, everything the model
returned, and every tool output.
"""


class History:
    def __init__(self):
        self.items = []

    def initialize_history(self, system, environment):
        """Start over with just the developer prompt: the system prompt plus environment details."""
        self.items = [{"role": "developer", "content": system + "\n" + environment}]

    def add_user_prompt(self, prompt):
        self.items.append({"role": "user", "content": [{"type": "input_text", "text": prompt}]})

    def add_model_output(self, items):
        """Add the model's output items, in the shape they are sent back in."""
        self.items.extend(filter(None, map(_replay, items)))

    def add_from_outputs(self, calls, outputs):
        """Add each tool call's output, paired with the call it answers."""
        self.items.extend(
            {"type": "function_call_output", "call_id": call["call_id"], "output": output}
            for call, output in zip(calls, outputs)
        )


def _replay(item):
    # store: false means the server keeps nothing, so each output item is sent back
    # in the shape opencode's AI SDK uses, without server-side ids.
    if item["type"] == "reasoning" and item.get("content"):
        # Groq returns reasoning in the clear, so it is replayed as plain reasoning_text.
        return {"type": "reasoning", "content": item["content"], "summary": item.get("summary", [])}
    if item["type"] == "function_call":
        return {"type": "function_call", "call_id": item["call_id"], "name": item["name"], "arguments": item["arguments"]}
    if item["type"] == "message":
        text = "".join(part.get("text", "") for part in item.get("content", []) if part.get("type") == "output_text")
        return {"role": "assistant", "content": [{"type": "output_text", "text": text}]} if text else None
    return None
