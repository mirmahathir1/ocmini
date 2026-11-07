// Marks what in each logged prompt is not hardcoded in ocmini's source.
//
// Loaded after the viewer script on every turn page. It decorates the tree that
// script built and changes no log text. Red means the text was filled in at
// runtime: your prompt, model output, tool results, and environment values.
// Plain means the text is a literal in ocmini's source. Anything these rules
// don't recognise in a tool result stays red rather than passing as hardcoded.
(() => {
  "use strict";

  // How many leading input items each request repeats from the request before it.
  // A page can't read the previous page, so this comes from the log.
  const REPEATED_ITEMS = {
    3: 2, 4: 6, 5: 9, 6: 12, 7: 15, 8: 19, 9: 22, 10: 25, 11: 28, 12: 30, 13: 33, 14: 37,
    15: 40, 16: 42, 17: 44, 18: 46, 19: 49, 20: 53, 21: 56, 22: 59, 23: 62, 24: 65, 25: 69, 26: 74,
  };

  // Hardcoded strings that fill a whole prompt item.
  const TITLE_PROMPT_START = "You are a title generator."; // agent/prompt/title.txt
  const TITLE_INSTRUCTION = "Generate a title for this conversation:\n"; // session/prompt.ts
  const WRITE_RESULT = "Wrote file successfully."; // tool/write.ts

  // Each pattern matches a hardcoded template; its capture groups are the parts
  // filled in at runtime. Everything outside a group stays plain.
  const SYSTEM_HOLES = [
    /^You are powered by the model named (.+)\. The exact model ID is (.+)$/dgm, // session/system.ts
    /^  Working directory: (.+)$/dgm,
    /^  Workspace root folder: (.+)$/dgm,
    /^  Is directory a git repo: (.+)$/dgm,
    /^  Platform: (.+)$/dgm,
    /^  Today's date: (.+)$/dgm,
    /^Instructions from: ([\s\S]+?)\n(?=Instructions from: |Skills provide specialized)/dgm, // session/instruction.ts
    // skill/index.ts. Skills found on disk only: the built-in one is a literal in that file.
    /^    <name>(.+)<\/name>\n    <description>((?:(?!<\/description>)[\s\S])+)<\/description>\n    <location>(?!&lt;built-in&gt;)(.+)<\/location>$/dgm,
  ];
  const BASH_SCHEMA_HOLES = [/OS: (\w+), Shell: (\w+)/dg, /^Use `(.+)` for temporary work/dgm]; // tool/shell/shell.txt
  const WEBSEARCH_SCHEMA_HOLES = [/^The current year is (\d+)\. You MUST/dgm]; // tool/websearch.txt
  const READ_RESULT_HOLES = [
    /^<path>(.+)<\/path>$/dgm, // tool/read.ts
    /^<entries>\n([\s\S]+?)\n\n\((\d+) entries\)\n<\/entries>$/dgm,
    /^<content>\n([\s\S]+?)\n\n\(End of file - total (\d+) lines\)\n<\/content>$/dgm,
  ];

  function holes(text, patterns) {
    const ranges = [];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) ranges.push(...match.indices.slice(1));
    }
    return ranges;
  }

  // Red ranges for one string inside an `input` item.
  function inputRanges(item, key, text, toolNames) {
    const whole = [[0, text.length]];
    if (key === "type" || key === "role") return [];
    if (item.role === "developer") return text.startsWith(TITLE_PROMPT_START) ? [] : holes(text, SYSTEM_HOLES);
    if (item.role === "user") return text === TITLE_INSTRUCTION ? [] : whole;
    if (item.type === "function_call_output" && key === "output") {
      if (text === WRITE_RESULT) return [];
      if (toolNames[item.call_id] === "read") {
        const found = holes(text, READ_RESULT_HOLES);
        return found.length ? found : whole;
      }
    }
    return whole;
  }

  // Red ranges for one string inside a `tools` schema. Only these two tools
  // carry runtime values; the rest match their source files byte for byte.
  function toolRanges(tool, path, text) {
    if (path.length !== 1 || path[0] !== "description") return [];
    if (tool.name === "bash") return holes(text, BASH_SCHEMA_HOLES);
    if (tool.name === "websearch") return holes(text, WEBSEARCH_SCHEMA_HOLES);
    return [];
  }

  function describeInput(item, toolNames) {
    if (item.role === "developer") {
      return ["ocmini", item.content.startsWith(TITLE_PROMPT_START) ? "title prompt" : "system prompt"];
    }
    if (item.role === "user") {
      return item.content[0]?.text === TITLE_INSTRUCTION ? ["ocmini", "title instruction"] : ["you", "task prompt"];
    }
    if (item.type === "reasoning") return ["model", "reasoning (encrypted)"];
    if (item.type === "function_call") return ["model", item.name + " call"];
    if (item.type === "function_call_output") return ["tool", toolNames[item.call_id] + " result"];
    return ["other", item.type ?? item.role ?? "item"];
  }

  // Cuts text into [start, end, classes] pieces.
  function pieces(text, ranges) {
    const sorted = ranges.filter(Boolean).toSorted((a, b) => a[0] - b[0]);
    const out = [];
    let cursor = 0;
    for (const [rangeStart, rangeEnd] of sorted) {
      const start = Math.max(rangeStart, cursor);
      if (rangeEnd <= start) continue;
      if (start > cursor) out.push([cursor, start, ""]);
      out.push([start, rangeEnd, "ph-red"]);
      cursor = rangeEnd;
    }
    if (cursor < text.length) out.push([cursor, text.length, ""]);
    return out;
  }

  // Maps each decoded character to its position in the raw JSON token, quotes included.
  function rawOffsets(raw) {
    const offsets = [];
    for (let i = 1; i < raw.length - 1; ) {
      offsets.push(i);
      i += raw[i] !== "\\" ? 1 : raw[i + 1] === "u" ? 6 : 2;
    }
    offsets.push(raw.length - 1);
    return offsets;
  }

  function fill(element, text, parts, toTextIndex, before = "", after = "") {
    const nodes = parts.map(([start, end, classes]) => {
      const value = text.slice(toTextIndex(start), toTextIndex(end));
      if (!classes) return value;
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = value;
      return span;
    });
    element.replaceChildren(before, ...nodes, after);
  }

  // Walks a parsed JSON value and the viewer's tree for it side by side.
  function visit(element, value, onString, path = []) {
    if (typeof value === "string") return onString(element, value, path);
    if (value === null || typeof value !== "object") return;
    const box = element.querySelector(":scope > .json-tree-children");
    if (!box) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(box.children[index].children[0], child, onString, [...path, index]));
    } else {
      Object.entries(value).forEach(([key, child], index) => {
        visit(box.children[index].children[2], child, onString, [...path, key]);
      });
    }
  }

  const previews = new WeakMap();

  function paintItem(element, value, rangesFor) {
    visit(element, value, (button, text, path) => {
      const ranges = rangesFor(path, text);
      if (!ranges.length) return;
      const parts = pieces(text, ranges);
      const raw = button.textContent;
      const offsets = rawOffsets(raw);
      fill(button, raw, parts, (index) => offsets[index], '"', '"');
      previews.set(button, { text, parts });
    });
  }

  function addChip(element, who, what) {
    const chip = document.createElement("span");
    chip.className = "ph-chip";
    chip.dataset.who = who;
    chip.textContent = `${who} · ${what}`;
    element.querySelector(":scope > summary").append(chip);
  }

  function childNode(root, key, body) {
    const index = Object.keys(body).indexOf(key);
    return index < 0 ? null : root.querySelector(":scope > .json-tree-children").children[index].children[2];
  }

  function annotateRequest(entry, requestNumber) {
    const tree = entry.querySelector(".json-tree");
    if (!tree) return null;
    const body = JSON.parse(tree.dataset.jsonSource);
    const root = tree.firstElementChild;
    const inputNode = childNode(root, "input", body);
    if (!inputNode) return null;

    const toolNames = {};
    for (const item of body.input) if (item.type === "function_call") toolNames[item.call_id] = item.name;

    const rows = inputNode.querySelector(":scope > .json-tree-children");
    const repeated = REPEATED_ITEMS[requestNumber] ?? 0;
    body.input.forEach((item, index) => {
      const element = rows.children[index].children[0];
      paintItem(element, item, (path, text) => inputRanges(item, path.at(-1), text, toolNames));
      addChip(element, ...describeInput(item, toolNames));
      if (index < repeated) rows.children[index].classList.add("ph-repeat");
    });

    if (repeated) {
      const note = document.createElement("div");
      note.className = "ph-repeat-note";
      note.textContent = `${repeated} items repeated from the previous turn are hidden`;
      rows.prepend(note);
    }

    const toolsNode = childNode(root, "tools", body);
    (body.tools ?? []).forEach((tool, index) => {
      const element = toolsNode.querySelector(":scope > .json-tree-children").children[index].children[0];
      paintItem(element, tool, (path, text) => toolRanges(tool, path, text));
      addChip(element, "ocmini", tool.name + " schema");
    });

    return [entry, root, inputNode];
  }

  function addStyles() {
    const style = document.createElement("style");
    style.id = "prompt-highlight-style";
    style.textContent = `
      .ph-red { color: #c1121f; }
      .ph-chip {
        display: inline-block;
        margin-left: .6em;
        padding: 0 .5em;
        border-radius: 999px;
        font: 600 11px/1.7 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap;
      }
      .ph-chip[data-who="you"] { background: #fde2e4; color: #8a1020; }
      .ph-chip[data-who="model"] { background: #e7e0ff; color: #45308f; }
      .ph-chip[data-who="tool"] { background: #d9f0e3; color: #0f5a36; }
      .ph-chip[data-who="ocmini"], .ph-chip[data-who="other"] { background: #e9ecef; color: #3f474e; }
      .ph-repeat-note { display: none; color: #6c757d; font-style: italic; }
      .ph-new-only .ph-repeat { display: none; }
      .ph-new-only .ph-repeat-note { display: block; }
      .ph-legend {
        margin-right: auto;
        border-radius: .35rem;
        padding: .2rem .55rem;
        background: #fff;
        color: #212529;
        font: 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
    `;
    document.head.append(style);
  }

  function addControls(requests) {
    const toolbar = document.querySelector(".json-fold-toolbar");
    if (!toolbar) return;

    const legend = document.createElement("span");
    legend.className = "ph-legend";
    legend.innerHTML = '<span class="ph-red">Red</span>: not hardcoded';
    toolbar.prepend(legend);

    const showPrompts = () => {
      for (const nodes of requests) for (const node of nodes) node.open = true;
    };
    const prompts = document.createElement("button");
    prompts.type = "button";
    prompts.textContent = "Show prompts";
    prompts.addEventListener("click", showPrompts);

    const newOnly = document.createElement("button");
    newOnly.type = "button";
    newOnly.textContent = "New this turn only";
    newOnly.setAttribute("aria-pressed", "false");
    newOnly.addEventListener("click", () => {
      const on = document.body.classList.toggle("ph-new-only");
      newOnly.setAttribute("aria-pressed", String(on));
      newOnly.textContent = on ? "Show full prompts" : "New this turn only";
      if (on) showPrompts();
    });

    toolbar.append(prompts, newOnly);
  }

  function init() {
    const requests = [];
    for (const entry of document.querySelectorAll(".log-entry")) {
      const number = entry.querySelector(":scope > summary").textContent.match(/── REQUEST #(\d+) ──/)?.[1];
      const nodes = number && annotateRequest(entry, Number(number));
      if (nodes) requests.push(nodes);
    }
    if (!requests.length) return;

    addStyles();
    addControls(requests);

    // The viewer fills the preview in the button's own click handler, which has
    // already run by the time the click bubbles up to here.
    document.addEventListener("click", (event) => {
      const button = event.target.closest(".json-string-link");
      const preview = button && previews.get(button);
      if (!preview) return;
      const content = document.querySelector("#json-string-preview .json-string-content");
      fill(content, preview.text, preview.parts, (index) => index);
    });
  }

  if (typeof document !== "undefined") init();
  if (typeof module !== "undefined") module.exports = { inputRanges, toolRanges, pieces, rawOffsets };
})();
