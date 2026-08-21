import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatSink, MAX_REMEMBERED_TOOL_CALLS, type ChatCommand } from "../../vscode/chatSink.js";
import { DiffDocuments } from "../../vscode/diffDocs.js";
import { MAX_LABEL_CHARS } from "../../vscode/permissions.js";
import type { RenderItem } from "../../vscode/render.js";

/**
 * What the Agent's own strings are allowed to do once they reach a chat stream:
 * how much of them is shown, how much is kept, and what they may not imitate.
 */

function sink(overrides: { showThinking?: boolean; toolTitles?: Map<string, string> } = {}) {
  const written: string[] = [];
  const buttons: ChatCommand[] = [];
  const logs: string[] = [];
  const toolTitles = overrides.toolTitles ?? new Map<string, string>();
  const stream = {
    markdown: (value: string) => written.push(value),
    progress: (value: string) => written.push(value),
    button: (command: ChatCommand) => buttons.push(command),
  };
  return {
    written,
    buttons,
    logs,
    toolTitles,
    text: () => written.join(""),
    draw: (item: RenderItem) =>
      new ChatSink(stream, {
        diffs: new DiffDocuments(),
        sessionId: "s1",
        showThinking: overrides.showThinking ?? true,
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
