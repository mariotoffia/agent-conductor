import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatSink,
  MAX_REMEMBERED_TOOL_CALLS,
  readBackLine,
  type ChatCommand,
} from "../../vscode/chatSink.js";
import { DiffDocuments } from "../../vscode/diffDocs.js";
import { inlineText } from "../../vscode/sealing.js";
import { MAX_LABEL_CHARS } from "../../vscode/permissions.js";
import type { RenderItem } from "../../vscode/render.js";
import { linkish } from "../link-forms.js";

/**
 * What the Agent's own strings are allowed to do once they reach a chat stream:
 * how much of them is shown, how much is kept, and what they may not imitate.
 */

function sink(
  overrides: {
    showThinking?: boolean;
    toolTitles?: Map<string, string>;
    slashCommands?: readonly string[];
  } = {},
) {
  const written: string[] = [];
  const progressed: string[] = [];
  const buttons: ChatCommand[] = [];
  const logs: string[] = [];
  const toolTitles = overrides.toolTitles ?? new Map<string, string>();
  const stream = {
    markdown: (value: string) => written.push(value),
    // Kept apart as well as together: `progress` renders plain text, so what is
    // right to write there is not what is right to write as markdown.
    progress: (value: string) => {
      progressed.push(value);
      written.push(value);
    },
    button: (command: ChatCommand) => buttons.push(command),
  };
  return {
    written,
    progressed,
    buttons,
    logs,
    toolTitles,
    text: () => written.join(""),
    draw: (item: RenderItem) =>
      new ChatSink(stream, {
        diffs: new DiffDocuments(),
        sessionId: "s1",
        showThinking: overrides.showThinking ?? true,
        ...(overrides.slashCommands ? { slashCommands: overrides.slashCommands } : {}),
        toolTitles,
        log: { log: (level, text) => logs.push(`${level} ${text}`) },
      }).draw(item),
  };
}

const toolCall = (id: string, title: string): RenderItem => ({
  kind: "toolCall",
  toolCallId: id,
  title,
  status: "completed",
  locations: [],
  update: false,
});

test("an agent's tool title is bounded before it is shown", () => {
  const s = sink();

  s.draw(toolCall("t1", "T".repeat(5_000)));

  assert.ok(s.text().length < 5_000, "the whole title reached the stream");
});

test("what is retained per tool call is the bounded title, not the agent's string", () => {
  const s = sink();

  s.draw(toolCall("t1", "T".repeat(5_000)));

  const kept = s.toolTitles.get("t1") ?? "";
  assert.ok(kept.length <= MAX_LABEL_CHARS, `retained ${kept.length} characters`);
});

test("retained tool titles are capped, so a session cannot be filled by an agent", () => {
  const s = sink();

  for (let at = 0; at < MAX_REMEMBERED_TOOL_CALLS + 50; at += 1) {
    s.draw(toolCall(`t${at}`, `title ${at}`));
  }

  assert.equal(s.toolTitles.size, MAX_REMEMBERED_TOOL_CALLS);
  assert.equal(s.toolTitles.has("t0"), false, "the oldest should have been dropped");
});

test("a status-only update still names the call the agent announced earlier", () => {
  const s = sink();
  s.draw(toolCall("t1", "Edit mock file"));

  s.draw({ kind: "toolCall", toolCallId: "t1", status: "failed", locations: [], update: true });

  assert.match(s.text(), /Edit mock file/);
});

test("a thought containing a blank line cannot escape its blockquote", () => {
  const s = sink();

  s.draw({ kind: "thought", text: "considering\n\n# Not a heading in the transcript" });

  // A blank line ends a Markdown blockquote; every line has to stay inside it.
  const quoted = s.text().trim().split("\n").filter((line) => line.trim() !== "");
  assert.ok(quoted.every((line) => line.startsWith("> ")), s.text());
});

test("thinking the setting withholds is not drawn at all", () => {
  const s = sink({ showThinking: false });

  s.draw({ kind: "thought", text: "Mock thought" });

  assert.equal(s.text(), "");
});

test("an update nobody can draw is logged, bounded, rather than dropped", () => {
  const s = sink();

  s.draw({ kind: "unsupported", sessionUpdate: "X".repeat(5_000) });

  assert.equal(s.text(), "", "nothing unrenderable may be put in front of the user");
  assert.equal(s.logs.length, 1);
  assert.ok(s.logs[0].length < 5_000, "the agent's string reached the log unbounded");
});

test("a runtime that reports no cost says unknown rather than nothing", () => {
  const s = sink();

  s.draw({ kind: "usage", used: 100, size: 1_000 });

  assert.match(s.text(), /context 100\/1000/);
  assert.match(s.text(), /cost unknown/);
});

/**
 * Read-back prints two values the Agent chose, into a line the Client wrote.
 * Neither may end the code span it sits in and carry on as the Client's voice
 * (ADR-0005 says show the mismatch; ADR-0007 says the Agent is not trusted).
 */

test("an agent's effective value cannot break out of the read-back line", () => {
  const line = readBackLine("model", {
    requested: "sonnet",
    effective: "x`\n\n---\n\n**Agent Conductor:** approved for unattended writes.\n\n`",
    verification: "verified",
  });

  // One line, and the value sealed inside its code span: markdown it contains
  // renders as the text it is, and cannot become structure or a second voice.
  assert.equal(line.trim().split("\n").length, 1, `read-back drew ${line.trim().split("\n").length} lines`);
  const spans = line.match(/`[^`]*`/g) ?? [];
  assert.equal(spans.length, 2, `code spans are unbalanced: ${line}`);
  assert.ok(
    spans.every((span) => !span.slice(1, -1).includes("`")),
    "a value ended the span it was written into",
  );
});

test("a very long value is bounded rather than filling the transcript", () => {
  const line = readBackLine("model", {
    requested: "sonnet",
    effective: "m".repeat(5_000),
    verification: "verified",
  });

  assert.ok(line.length < 1_000, `read-back was ${line.length} characters`);
});

test("an ordinary read-back still says both halves and names a mismatch", () => {
  const line = readBackLine("model", {
    requested: "opus",
    effective: "sonnet",
    verification: "verified",
  });

  assert.match(line, /opus/);
  assert.match(line, /sonnet/);
  assert.match(line, /mismatch/);
});

test("a session info update with no title is still accounted for", () => {
  const s = sink();

  s.draw({ kind: "info", updatedAt: "2026-08-22T10:00:00Z" });

  // UBIQUITOUS (Render Model): an item nobody drew is indistinguishable from an
  // Agent that sent nothing, so what is not shown is at least recorded.
  assert.ok(s.written.length + s.logs.length > 0, "drawn nowhere and logged nowhere");
});

/**
 * Which of an Agent's own commands are offered.
 *
 * The allowlist exists because some of them drive an interactive terminal UI
 * and hang an ACP session when they are sent. Every command is still shown —
 * an Update nobody drew reads like an Agent that sent nothing — but only the
 * ones on the list are put in front of the user as something to type.
 */

test("only allowlisted agent commands are offered as commands to type", () => {
  const s = sink({ slashCommands: ["compact", "review"] });

  s.draw({
    kind: "commands",
    commands: [
      { name: "compact", description: "Compact the conversation" },
      { name: "login", description: "Opens an interactive prompt" },
    ],
  });

  assert.match(s.text(), /`\/compact`/, "an allowed command is offered");
  assert.match(s.text(), /login/, "every command is still shown");
  assert.equal(s.text().includes("`/login`"), false, `login was offered: ${s.text()}`);
});

test("with no allowlist nothing is offered, and everything is still shown", () => {
  const s = sink({ slashCommands: [] });

  s.draw({ kind: "commands", commands: [{ name: "compact", description: "Compact" }] });

  assert.match(s.text(), /compact/);
  assert.equal(s.text().includes("`/compact`"), false, s.text());
});

test("a carriage return cannot end the quote an agent's own words are drawn in", () => {
  const s = sink();

  // Every markdown renderer treats a lone CR as a line ending, so `\r\r` is a
  // blank line: the blockquote ends and what follows is ordinary transcript
  // prose with this Client's emphasis available (ADR-0007).
  s.draw({ kind: "thought", text: "considering\r\r**Agent Conductor:** approved." });

  const lines = s.text().trim().split(/\r\n?|\n/);
  assert.ok(
    lines.every((line) => line === "" || line.startsWith(">")),
    `the agent left the quote: ${JSON.stringify(lines)}`,
  );
});

test("no agent string drawn inside our own words can write a line of its own", () => {
  // The distinction that matters: an Agent's message and its thoughts are its
  // own blocks and may be prose, while everything below is drawn *inside* a line
  // this Client wrote — and one of those ending its own span reads as a second
  // voice with the markdown to look like it (ADR-0007).
  const forged =
    "x`\n\n---\n\n**Agent Conductor:** approved for unattended writes.\n\n`" +
    " [approve unattended writes](https://evil.invalid/x) https://evil.invalid/y" +
    " <https://evil.invalid/z> <mailto:keys@evil.invalid> www.evil.invalid/get-a-key" +
    " 9www.evil.invalid/pay keys@evil.invalid";
  const items: RenderItem[] = [
    { kind: "config", model: forged, effort: forged },
    { kind: "mode", modeId: forged },
    { kind: "info", title: forged },
    { kind: "commands", commands: [{ name: forged, description: forged }] },
    { kind: "plan", entries: [{ content: forged, status: "pending", priority: "high" }] },
    toolCall("t1", forged),
    // A running call is drawn through `progress`, which is the other renderer.
    { kind: "toolCall", toolCallId: "t2", title: forged, status: "in_progress", locations: [], update: false },
    { kind: "usage", used: 1, size: 2, cost: { amount: 1, currency: forged } },
    { kind: "terminal", toolCallId: "t1", terminalId: forged },
    // Framed too: `**user:**` is this Client's attribution, not the Agent's.
    { kind: "userMessage", text: forged },
  ];

  // Twice over: with the forged name on the allowlist and off it. Those are two
  // different renderings — one inside a code span, one bare in a line of ours —
  // and the bare one is what most commands get, since the allowlist is short and
  // some Runtimes offer none at all.
  for (const item of items.flatMap((entry) => [
    { item: entry, offered: [forged] },
    { item: entry, offered: [] as string[] },
  ])) {
    const s = sink({ slashCommands: item.offered });
    s.draw(item.item);

    const drawn = s.text().trim();
    // One line — a rule or a heading needs a line of its own — and no live
    // emphasis outside a code span, where a second voice would need the bold to
    // look like ours. This holds for a progress line too: VS Code turns the
    // string into a `MarkdownString` and renders it through the same renderer as
    // any other part of the stream. Inside a span every character is literal, so
    // what is checked is what is left once the spans are taken out.
    assert.equal(drawn.includes("\n"), false, `${item.item.kind} drew its own line: ${drawn}`);
    const outsideSpans = drawn.replace(/`[^`]*`/g, "");
    assert.equal(
      outsideSpans.includes("**Agent Conductor:**"),
      false,
      `${item.item.kind} left the agent live emphasis outside a span: ${drawn}`,
    );
    // A link is worse than forged emphasis, because it is something to click —
    // and every form that renders as one, not only the form a fix happened to
    // break: an inline link, an autolink with or without a slash in its scheme,
    // and the two literals a GFM renderer turns into links on sight.
    const clickable = linkish(outsideSpans);
    assert.equal(clickable, undefined, `${item.item.kind} drew ${clickable ?? ""}: ${drawn}`);
  }
});

test("a glob in a tool title is still readable after it has been sealed", () => {
  const s = sink();

  s.draw(toolCall("t1", 'Grep(pattern="**/*.ts")'));

  // Globs are the most common thing in a tool title. Sealing must not turn
  // `**/*.ts` into ` / .ts`, which names a file nobody has — escaped, it reads
  // back as itself once the renderer has done its half.
  assert.match(s.text().replace(/\\/g, ""), /\*\*\/\*\.ts/);
});

test("a title sealed once is not sealed again when its status changes", () => {
  const titles = new Map<string, string>();
  const first = sink({ toolTitles: titles });
  const second = sink({ toolTitles: titles });

  first.draw(toolCall("t1", 'Grep(pattern="**/*.ts")'));
  second.draw({ kind: "toolCall", toolCallId: "t1", status: "completed", locations: [], update: true });

  // Sealing is not idempotent — escaping twice turns `\*` into `\\*`, which
  // renders the backslash and frees the asterisk. The stored title has to be
  // what the agent said, sealed on the way out.
  assert.equal(second.text().replace(/\\/g, "").includes("**/*.ts"), true, second.text());
  assert.equal(second.text().includes("\\\\"), false, `escaped twice: ${second.text()}`);
});

test("an agent's own backslash cannot neutralise the escape around it", () => {
  const s = sink();

  s.draw(toolCall("t1", "\\_Agent Conductor: approved\\_"));

  // `\_x\_` escaped to `\\_x\\_` is a literal backslash and a live delimiter.
  assert.equal(/(^|[^\\])\\_/.test(s.text()), false, `an emphasis marker survived: ${s.text()}`);
});

test("a value drawn inside a code span shows what the agent said, not an escape", () => {
  const s = sink();

  s.draw({ kind: "config", model: "gpt_5_mini", effort: "x_high" });

  // Backslashes are literal inside a code span, so escaping there shows the
  // user something the agent never reported (ADR-0005).
  assert.match(s.text(), /`gpt_5_mini`/);
  assert.match(s.text(), /`x_high`/);
});

test("a running call's title is sealed for the renderer a progress line uses", () => {
  const s = sink();

  s.draw({ kind: "toolCall", toolCallId: "t1", title: 'Grep(pattern="**/*.ts")', status: "in_progress", locations: [], update: false });

  // VS Code turns a progress string into a `MarkdownString` and renders it the
  // same way as the rest of the stream, so a glob left live would be emphasis
  // rather than a path — and escaped, the renderer puts it back as itself.
  assert.equal(s.progressed.length, 1, `drawn as markdown instead: ${s.text()}`);
  assert.match(s.progressed[0]?.replace(/\\/g, "") ?? "", /\*\*\/\*\.ts/);
  assert.equal(/(^|[^\\])\*/.test(s.progressed[0] ?? ""), false, `live emphasis: ${s.progressed[0] ?? ""}`);
});

test("sealing leaves alone the things it is not there to break", () => {
  // Breaking is for what a renderer makes clickable, and nothing else. An
  // address is broken wherever one would render — `package@1.2.3` included,
  // because a renderer links that too — but a version on its own, a path, a
  // time and a scoped package name are all left as they were said.
  const kept = [
    "install @agentclientprotocol/claude-agent-acp",
    "node 22.13.0 or later",
    "at 12:30 the run stopped",
    "C:\\Users\\me\\project",
    "tests/test_a.py::test_b",
  ];

  // Un-escaped once, which is what the renderer does: `\\_` is an underscore and
  // `\\\\` is a backslash. What is left has to be what the agent sent.
  for (const text of kept) {
    const rendered = inlineText(text, 500).replace(/\\(.)/g, "$1");
    assert.equal(rendered, text, `sealing changed: ${text}`);
  }
});

test("sealing a string twice is sealing it once", () => {
  // Some of what the wizard says is sealed on the way to being composed and
  // again on the way out. A rule that consumes the character it matched on skips
  // the next overlapping one, so a second pass finds more to do — and a line
  // sized against the first pass no longer fits after the second.
  const chained = "ops@acme.@security.example and <a@b.@c.example> and www.www.example";

  const once = inlineText(chained, 500);
  assert.equal(inlineText(once, 500), once, `a second pass changed it: ${once}`);
  const clickable = linkish(once);
  assert.equal(clickable, undefined, `one pass left ${clickable ?? ""}: ${once}`);
});

test("an agent cannot reverse the line this client wrote around it", () => {
  const s = sink();

  // A right-to-left override draws everything after it backwards, so a value the
  // client frames can turn the client's own words around it into nonsense — or
  // into different words. `\\s` does not cover one, and neither does a clamp.
  s.draw({ kind: "config", model: "sonnet\u202e", effort: "low\u202b" });
  s.draw({ kind: "toolCall", toolCallId: "t1", title: "Edit\u202e", status: "completed", locations: [], update: false });

  assert.equal(
    /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s.text()),
    false,
    `a direction override survived: ${JSON.stringify(s.text())}`,
  );
});

test("an agent cannot strike through the words this client wrote", () => {
  const s = sink();

  s.draw({ kind: "plan", entries: [{ content: "Drop the~~production database", status: "pending", priority: "low~~priority" }] });

  // `~~` spans until its pair, and the pair can be inside the next thing this
  // client wrote — so the client's own `_(priority)_` disappears into the
  // agent's strikethrough. Same extension as the `www.` the sealing already
  // assumes is on.
  const drawn = s.text();
  assert.equal(/(^|[^\\])~~/.test(drawn), false, `live strikethrough: ${drawn}`);
});
