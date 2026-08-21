import assert from "node:assert/strict";
import { test } from "node:test";
import { contentText, renderUpdate, type RenderItem } from "../../vscode/render.js";

/**
 * Every documented Update reaches the render model, and nothing an Agent can put
 * on the wire silently disappears on the way (ARCHITECTURE.md §Data flows).
 *
 * The mapping takes `unknown`, so these fixtures are written as an Agent would
 * send them rather than as the SDK's types describe them.
 */

const kinds = (items: RenderItem[]): string[] => items.map((item) => item.kind);
const only = (items: RenderItem[], kind: RenderItem["kind"]): RenderItem[] =>
  items.filter((item) => item.kind === kind);

test("a message chunk renders its text", () => {
  const items = renderUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Mock response" },
  });

  assert.deepEqual(items, [{ kind: "message", text: "Mock response" }]);
});

test("a thought chunk is kept apart from a message", () => {
  const items = renderUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Mock thought" },
  });

  assert.deepEqual(items, [{ kind: "thought", text: "Mock thought" }]);
});

test("a replayed user turn is not rendered as the agent speaking", () => {
  const items = renderUpdate({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "replayed user turn" },
  });

  assert.deepEqual(items, [{ kind: "userMessage", text: "replayed user turn" }]);
});

test("a tool call renders its title, the agent's own kind, and its locations", () => {
  const items = renderUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "mock-tool",
    title: "Edit mock file",
    kind: "edit",
    status: "pending",
    locations: [{ path: "/w/mock.txt" }, { line: 3 }],
  });

  assert.deepEqual(items, [{
    kind: "toolCall",
    toolCallId: "mock-tool",
    title: "Edit mock file",
    // Shown, never decided on: the agent chose this word (ADR-0007).
    toolKind: "edit",
    status: "pending",
    locations: ["/w/mock.txt"],
    update: false,
  }]);
});

test("a status-only update is still drawn, and says it follows an announced call", () => {
  const items = renderUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "mock-tool",
    status: "completed",
  });

  assert.deepEqual(items, [{
    kind: "toolCall",
    toolCallId: "mock-tool",
    status: "completed",
    locations: [],
    update: true,
  }]);
});

test("a diff carried by a tool call update renders as a diff item", () => {
  const items = renderUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "mock-tool",
    status: "completed",
    content: [{ type: "diff", path: "/w/mock.txt", oldText: "before\n", newText: "after\n" }],
  });

  assert.deepEqual(only(items, "diff"), [{
    kind: "diff",
    toolCallId: "mock-tool",
    path: "/w/mock.txt",
    oldText: "before\n",
    newText: "after\n",
  }]);
});

test("a diff with no previous text is a file being created, not a dropped update", () => {
  const items = renderUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "new-file",
    title: "Create",
    content: [{ type: "diff", path: "/w/new.txt", newText: "hello\n" }],
  });

  assert.deepEqual(only(items, "diff"), [{
    kind: "diff",
    toolCallId: "new-file",
    path: "/w/new.txt",
    oldText: "",
    newText: "hello\n",
  }]);
});

test("terminal and plain content carried by one tool call each get an item", () => {
  const items = renderUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "mock-tool",
    content: [
      { type: "terminal", terminalId: "term-1" },
      { type: "content", content: { type: "text", text: "tool said this" } },
    ],
  });

  assert.deepEqual(kinds(items), ["toolCall", "terminal", "message"]);
  assert.deepEqual(only(items, "terminal"), [
    { kind: "terminal", toolCallId: "mock-tool", terminalId: "term-1" },
  ]);
});

test("a plan renders its entries", () => {
  const items = renderUpdate({
    sessionUpdate: "plan",
    entries: [{ content: "Exercise ACP client", priority: "high", status: "completed" }],
  });

  assert.deepEqual(items, [{
    kind: "plan",
    entries: [{ content: "Exercise ACP client", priority: "high", status: "completed" }],
  }]);
});

test("the itemised, prose and file plan shapes all reach the model", () => {
  const itemised = renderUpdate({
    sessionUpdate: "plan_update",
    plan: { type: "items", planId: "p1", entries: [{ content: "step", priority: "low", status: "pending" }] },
  });
  const prose = renderUpdate({
    sessionUpdate: "plan_update",
    plan: { type: "markdown", planId: "p1", content: "# plan" },
  });
  const file = renderUpdate({
    sessionUpdate: "plan_update",
    plan: { type: "file", planId: "p1", uri: "file:///w/plan.md" },
  });

  assert.deepEqual(itemised, [{
    kind: "plan",
    planId: "p1",
    entries: [{ content: "step", priority: "low", status: "pending" }],
  }]);
  assert.deepEqual(prose, [{ kind: "planText", planId: "p1", text: "# plan" }]);
  assert.deepEqual(file, [{ kind: "planText", planId: "p1", text: "file:///w/plan.md" }]);
});

test("a removed plan is an item, so a stale plan is not left on screen unexplained", () => {
  assert.deepEqual(renderUpdate({ sessionUpdate: "plan_removed", planId: "p1" }), [
    { kind: "planRemoved", planId: "p1" },
  ]);
});

test("available commands render with their descriptions", () => {
  const items = renderUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "compact", description: "Compact the conversation" }],
  });

  assert.deepEqual(items, [{
    kind: "commands",
    commands: [{ name: "compact", description: "Compact the conversation" }],
  }]);
});

test("a mode change renders", () => {
  assert.deepEqual(renderUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" }), [
    { kind: "mode", modeId: "plan" },
  ]);
});

test("a config option update renders what the agent reports it is running", () => {
  const items = renderUpdate({
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "mock-model-fast",
        options: [{ value: "mock-model-fast", name: "Fast" }],
      },
      {
        type: "select",
        id: "effort",
        name: "Effort",
        category: "thought_level",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      },
    ],
  });

  assert.deepEqual(items, [{ kind: "config", model: "mock-model-fast", effort: "low" }]);
});

test("an agent that reports no selector renders no effective value at all", () => {
  const items = renderUpdate({ sessionUpdate: "config_option_update", configOptions: [] });

  // Nothing is invented for a picker the agent never exposed (ADR-0005).
  assert.deepEqual(items, [{ kind: "config" }]);
});

test("usage renders its window and its cost", () => {
  const items = renderUpdate({
    sessionUpdate: "usage_update",
    used: 100,
    size: 1_000,
    cost: { amount: 0.01, currency: "USD" },
  });

  assert.deepEqual(items, [
    { kind: "usage", used: 100, size: 1_000, cost: { amount: 0.01, currency: "USD" } },
  ]);
});

test("usage without a cost renders without inventing one", () => {
  assert.deepEqual(renderUpdate({ sessionUpdate: "usage_update", used: 5, size: 10 }), [
    { kind: "usage", used: 5, size: 10 },
  ]);
});

test("session info renders the title the agent gave the session", () => {
  const items = renderUpdate({
    sessionUpdate: "session_info_update",
    title: "Fix the parser",
    updatedAt: "2026-08-21T10:00:00Z",
  });

  assert.deepEqual(items, [
    { kind: "info", title: "Fix the parser", updatedAt: "2026-08-21T10:00:00Z" },
  ]);
});

test("an update this client does not document is reported, never silently dropped", () => {
  assert.deepEqual(renderUpdate({ sessionUpdate: "invented_by_a_later_sdk" }), [
    { kind: "unsupported", sessionUpdate: "invented_by_a_later_sdk" },
  ]);
  assert.deepEqual(renderUpdate(null), [{ kind: "unsupported", sessionUpdate: "" }]);
});

test("a tool call content variant this client does not document is reported", () => {
  const items = renderUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "mock-tool",
    content: [{ type: "video", uri: "file:///w/clip.mp4" }],
  });

  assert.deepEqual(only(items, "unsupported"), [
    { kind: "unsupported", sessionUpdate: "tool_call content video" },
  ]);
});

test("a documented content block that is simply empty is not called undocumented", () => {
  const items = renderUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "mock-tool",
    content: [{ type: "content", content: { type: "text", text: "" } }],
  });

  // It says nothing about the protocol, so it must not be reported as though
  // this client had failed to understand it.
  assert.deepEqual(kinds(items), ["toolCall"]);
});

test("a plan update whose shape is unknown is reported rather than drawn as empty", () => {
  assert.deepEqual(renderUpdate({ sessionUpdate: "plan_update", plan: { type: "hologram" } }), [
    { kind: "unsupported", sessionUpdate: "plan_update" },
  ]);
});

test("binary content is named rather than drawn into the render model", () => {
  const image = "data:image/png;base64," + "A".repeat(4_000);

  assert.equal(contentText({ type: "image", mimeType: "image/png", data: image }), "_(image image/png)_");
  assert.equal(contentText({ type: "audio", data: image }), "_(audio)_");
  assert.equal(
    contentText({ type: "resource_link", name: "spec", uri: "file:///w/spec.md" }),
    "[spec](file:///w/spec.md)",
  );
  assert.equal(
    contentText({ type: "resource", resource: { uri: "file:///w/a.txt", text: "inline" } }),
    "inline",
  );
  assert.equal(
    contentText({ type: "resource", resource: { uri: "file:///w/a.bin", blob: image } }),
    "_(resource file:///w/a.bin)_",
  );
});
