# Encrypted reasoning in the logs

Every request and response in the session log contains long unreadable strings
under `encrypted_content`, such as `"Q-PaDgFaXmADfsoD-PPdYjlr..."`. Each one is the
model's hidden reasoning (its chain of thought) for one step. The provider encrypts
it, so neither ocmini nor anyone reading the log can see what the model was
thinking. Only the provider can decrypt it.

## Where it appears

Each blob sits in a `"type": "reasoning"` item next to a `summary` field.
[turn_11.log:31-34](../session/turns/turn_11.log#L31-L34) shows one:

```json
{
  "type": "reasoning",
  "encrypted_content": "Q-PaDgFaXmADfsoD-PPdYjlrGQ0zhFKbWHoRXAmn...",
  "summary": []
}
```

The `summary` is the only readable part. It is usually empty. Sometimes it holds
one short line, for example "Refining the CLI layout and numeric parsing rules with
error handling and output formats." at
[turn_11.log:73](../session/turns/turn_11.log#L73).

## What causes it

OpenCode sends these settings with every request
([turn_11.log:207-215](../session/turns/turn_11.log#L207-L215)):

```json
"store": false,
"include": ["reasoning.encrypted_content"],
"reasoning": { "effort": "xhigh", "summary": "auto" }
```

- `"store": false` tells the provider to keep nothing between calls. The server
  has no memory of the conversation, so the client has to send the full history
  every time.
- `"include": ["reasoning.encrypted_content"]` asks the provider to return each
  reasoning step as an encrypted blob instead of dropping it.
- `"summary": "auto"` asks for the short readable summaries, which the provider
  mostly leaves empty.

OpenCode then puts every blob back into the `input` of the next request. That lets
the model pick up its own earlier reasoning across tool calls, even though the
server stored nothing.

## Why the provider encrypts it

The provider wants two things at once: the model should be able to reuse its
reasoning, and nobody outside the provider should be able to read it.

- **Why hide it:** Providers don't expose raw chain of thought. Partly that's
  competition, since other labs could train their models on it. Partly it's safety:
  raw reasoning isn't filtered for policy, and providers want to monitor it without
  training the model to make it look tidy.
- **Why encrypt it instead of dropping it:** Dropping it would make the model lose
  its train of thought between tool calls. Storing it on the provider's servers
  would break `"store": false` and zero-data-retention setups. Encrypting it and
  handing it to the client solves both: the client can carry it but can't read it.

## Observations from this session

- **Every blob is resent every time.** The number of blobs in a request grows as
  the session goes on, from 4 in turn 1 to 26 in turn 25. Turn 25's request
  alone carries about 104 KB of them.
- **They make up about 31% of the log.** Of the 6.5 MB in [session/](../session/),
  about 2.0 MB is `encrypted_content`.
- **Sizes vary.** Most blobs are 1,426 characters long, which is likely a
  short or empty reasoning step. A few are much larger, such as 21,906 and 43,751
  characters in turn 11's request. A large blob points to a step where the model
  reasoned at length, even though you can't read it.
- **The format looks like base64url.** Every blob starts with `Q-PaDg`, which
  decodes to the same leading bytes each time. That is probably a version or key
  header.
- **The same reasoning item comes back with two different ciphertexts.** In turn
  10's response, item `rs_6ab888aeda549884b1fe4ddf:rs_01a0e0d5e88f7783ae71c446580ae11d` has one blob in
  the `response.output_item.done` event and a different blob in the final
  `response.completed` event. OpenCode sends back the first one. The encryption is
  probably randomized, so comparing blobs byte-for-byte won't tell you whether two
  reasoning steps are the same.

## What this means for reading logs

You can't reconstruct why the model made a decision from the log. You only have
its visible text, its tool calls and the occasional one-line summary. When a run
goes wrong, look at the tool calls and outputs around the decision. The reasoning
blobs can tell you where the model thought hard, from their size, but not what it
thought.
