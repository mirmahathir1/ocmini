// Draws a sequence diagram at the top of each turn page: who acted on whom, in time order.
//
// A RESPONSE entry is written when its stream ends, so in the log a tool can sit
// above the reply that asked for it. The diagram splits each reply into the moments
// inside its stream, which puts every step in the order it happened. The log entries
// below stay as they are, and each row opens the entry it came from.
(() => {
  "use strict";

  function readEntries() {
    return [...document.querySelectorAll(".log-entry")].flatMap((element) => {
      const header = element.querySelector(":scope > summary").textContent;
      const match = header.match(/^\[\S+ \+([\d.]+)s\] ── (.+?) ── (.*)$/);
      if (!match) return [];
      const body = element.querySelector(":scope > .log-entry-body");
      return [{
        element,
        time: Number(match[1]),
        kind: match[2],
        meta: match[3].split(" · "),
        text: body.dataset.originalText ?? body.textContent,
      }];
    });
  }

  // The moments inside a reply, with offsets counted from its request.
  function replyMoments(text) {
    const moments = [];
    for (const line of text.split("\n")) {
      if (!line.includes('"response.output_item.added"')) continue;
      const [, offset, json] = line.match(/^\s*\+([\d.]+) data: (\{.*\})\s*$/);
      const { item } = JSON.parse(json);
      if (item.type === "function_call") moments.push({ offset: Number(offset), label: `asks for ${item.name}` });
      if (item.type === "message") moments.push({ offset: Number(offset), label: "writes text" });
    }
    return moments;
  }

  function buildSteps(entries) {
    const requestTimes = new Map();
    for (const { kind, time } of entries) {
      if (kind.startsWith("REQUEST")) requestTimes.set(kind.match(/\d+/)[0], time);
    }

    const steps = [];
    for (const entry of entries) {
      const { kind, time, meta, text } = entry;
      const name = kind.replace(/ ?#?\d+/, "");
      const number = kind.match(/\d+/)?.[0];
      const add = (at, from, to, label) => steps.push({ at, from, to, label, entry });

      switch (name) {
        case "REQUEST":
          add(time, "ocmini", "model", "prompt");
          break;
        case "RESPONSE":
          for (const { offset, label } of replyMoments(text)) {
            add(requestTimes.get(number) + offset, "model", "ocmini", label);
          }
          add(time, "model", "ocmini", "reply ends");
          break;
        case "TOOL":
          add(time, "ocmini", "tool", `starts ${meta[2].split(" ")[0]}`);
          break;
        case "TOOL END": {
          const [status, took] = meta.slice(-2);
          add(time, "tool", "ocmini", `${status === "ok" ? "output" : status}, ${took}`);
          break;
        }
        case "PERMISSION": {
          const [permission, , outcome] = meta.slice(2);
          if (outcome === "ask") add(time, "ocmini", "you", `asks about ${permission}`);
          else add(time, "ocmini", "ocmini", `${permission} permission: ${outcome}`);
          break;
        }
        case "PERMISSION REPLY":
          add(time, "you", "ocmini", `replies: ${meta.at(-1)}`);
          break;
        case "TURN END":
          add(time, "ocmini", "ocmini", `turn ends: ${meta.at(-1)}`);
          break;
      }
    }
    return steps.sort((a, b) => a.at - b.at);
  }

  function span(className, text) {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    return element;
  }

  function openEntry(element) {
    const header = document.querySelector(".turn-header");
    element.open = true;
    element.style.scrollMarginTop = `${header.offsetHeight + 8}px`;
    element.scrollIntoView({ block: "start" });
    element.querySelector(":scope > summary").focus({ preventScroll: true });
  }

  function drawMark(step, laneX) {
    const fromX = laneX(step.from);
    const toX = laneX(step.to);
    if (step.from === step.to) {
      const note = span("seq-note", step.label);
      note.style.left = `${fromX}%`;
      return note;
    }
    const arrow = document.createElement("span");
    arrow.className = `seq-arrow ${toX > fromX ? "seq-to-right" : "seq-to-left"}`;
    arrow.style.left = `${Math.min(fromX, toX)}%`;
    arrow.style.width = `${Math.abs(toX - fromX)}%`;
    arrow.append(span("seq-label", step.label));
    return arrow;
  }

  function drawRow(step, laneX) {
    const time = `+${step.at.toFixed(3)}s`;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "seq-row";
    row.dataset.actor = step.from;
    row.setAttribute("aria-label", `${time}, ${step.from}: ${step.label}. Opens ${step.entry.kind}.`);
    row.addEventListener("click", () => openEntry(step.entry.element));

    const track = document.createElement("span");
    track.className = "seq-track";
    track.append(drawMark(step, laneX));
    row.append(span("seq-time", time), track, span("seq-entry", step.entry.kind));
    return row;
  }

  function drawDiagram(steps) {
    const usesYou = steps.some((step) => step.from === "you" || step.to === "you");
    const lanes = usesYou ? ["you", "ocmini", "model", "tool"] : ["ocmini", "model", "tool"];
    const laneX = (lane) => 8 + (lanes.indexOf(lane) * 84) / (lanes.length - 1);

    const section = document.createElement("section");
    section.className = "seq";
    section.setAttribute("aria-labelledby", "seq-title");
    section.style.setProperty(
      "--seq-lifelines",
      lanes.map((lane) => `linear-gradient(#ced4da, #ced4da) ${laneX(lane)}% 0 / 1px 100% no-repeat`).join(", "),
    );

    const title = span("seq-title", "What happened, in time order");
    title.id = "seq-title";
    section.append(title, span("seq-hint", "Click a row to open its log entry."));

    const header = document.createElement("div");
    header.className = "seq-header";
    const names = document.createElement("span");
    names.className = "seq-lanes";
    for (const lane of lanes) {
      const name = span("seq-lane", lane);
      name.dataset.actor = lane;
      name.style.left = `${laneX(lane)}%`;
      names.append(name);
    }
    header.append(span("seq-time", "Time"), names, span("seq-entry", "Log entry"));

    const rows = document.createElement("div");
    rows.className = "seq-rows";
    rows.append(header, ...steps.map((step) => drawRow(step, laneX)));

    const scroller = document.createElement("div");
    scroller.className = "seq-scroll";
    scroller.append(rows);
    section.append(scroller);
    return section;
  }

  function addStyles() {
    const style = document.createElement("style");
    style.id = "turn-diagram-style";
    style.textContent = `
      .seq {
        --seq-bg: #fff;
        margin-bottom: 1rem;
        border: 1px solid #dee2e6;
        border-radius: .5rem;
        padding: .75rem 1rem;
        background: var(--seq-bg);
        color: #212529;
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .seq-title { font-size: 15px; font-weight: 600; }
      .seq-hint { margin-left: .75em; color: #626b73; }
      .seq-scroll { margin-top: .5rem; overflow-x: auto; }
      .seq-rows { min-width: 760px; }
      .seq-header, .seq-row {
        display: grid;
        grid-template-columns: 6.5rem 1fr 11rem;
        align-items: stretch;
        width: 100%;
      }
      .seq-header { color: #626b73; font-weight: 600; }
      .seq-lanes { position: relative; min-height: 1.75rem; }
      .seq-lane {
        position: absolute;
        top: 0;
        transform: translateX(-50%);
        border-radius: 999px;
        padding: 0 .6em;
        font: 600 12px/1.8 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .seq-lane[data-actor="you"] { background: #fde2e4; color: #8a1020; }
      .seq-lane[data-actor="ocmini"] { background: #e9ecef; color: #3f474e; }
      .seq-lane[data-actor="model"] { background: #e7e0ff; color: #45308f; }
      .seq-lane[data-actor="tool"] { background: #d9f0e3; color: #0f5a36; }
      .seq-row {
        appearance: none;
        border: 0;
        padding: 0;
        background: var(--seq-bg);
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .seq-row:hover { --seq-bg: #f1f3f5; }
      .seq-row:focus-visible { outline: 2px solid #0b5ed7; outline-offset: -2px; }
      .seq-time, .seq-entry {
        align-self: center;
        color: #626b73;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .seq-header .seq-entry { padding-left: 1rem; }
      .seq-row .seq-entry { padding-left: 1rem; }
      .seq-track {
        position: relative;
        display: block;
        height: 1.9rem;
        background: var(--seq-lifelines);
      }
      .seq-row[data-actor="you"] .seq-track { color: #8a1020; }
      .seq-row[data-actor="ocmini"] .seq-track { color: #3f474e; }
      .seq-row[data-actor="model"] .seq-track { color: #45308f; }
      .seq-row[data-actor="tool"] .seq-track { color: #0f5a36; }
      .seq-arrow {
        position: absolute;
        top: 50%;
        border-top: 1.5px solid currentColor;
      }
      .seq-arrow::after {
        content: "";
        position: absolute;
        top: -5px;
        border-block: 4px solid transparent;
      }
      .seq-to-right::after { right: 0; border-left: 8px solid currentColor; }
      .seq-to-left::after { left: 0; border-right: 8px solid currentColor; }
      .seq-label, .seq-note {
        position: absolute;
        padding: 0 .4em;
        background: var(--seq-bg);
        white-space: nowrap;
      }
      .seq-label { top: 0; left: 50%; transform: translate(-50%, -50%); }
      .seq-note { top: 50%; margin-left: .5em; transform: translateY(-50%); }
    `;
    document.head.append(style);
  }

  const steps = buildSteps(readEntries());
  if (!steps.length) return;
  addStyles();
  document.querySelector("main .card").before(drawDiagram(steps));
})();
