import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EFFORT_LEVELS, type SessionCapability, type OrchestrationCall } from "../../core/index.js";
import { ipcServer } from "../ipc-fixtures.js";

const shim = fileURLToPath(new URL("../../shim/mcp-shim.ts", import.meta.url));
const typescriptLoader = import.meta.resolve("tsx");

const GRANT: SessionCapability = {
  sessionId: "parent-session",
  depth: 0,
  roots: ["/workspace"],
  expiresAtMs: 2 ** 42,
  methods: ["list_runtimes", "spawn_subagent", "check_subagent", "subagent_result", "cancel_subagent"],
};

/** Text a tool call came back with, however many parts it arrived in. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/**
 * The Shim as an Agent's harness actually gets it: a separate process, driven
 * over stdio by a real MCP client, with the socket and the capability arriving
 * the way a Session hands them over.
 */
async function shimUnderTest(
  t: TestContext,
  handler: (call: OrchestrationCall) => Promise<unknown>,
  grant: SessionCapability = GRANT,
): Promise<{ client: Client; calls: OrchestrationCall[] }> {
  const calls: OrchestrationCall[] = [];
  const server = await ipcServer(t, {
    handler: async (call) => {
      calls.push(call);
      return handler(call);
    },
    now: () => 0,
  });
  const capability = server.issue(grant);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", typescriptLoader, shim, "--socket", server.address],
      env: { AGENT_CONDUCTOR_SESSION_SECRET: capability.secret },
    }),
  );
  t.after(() => client.close());
  return { client, calls };
}

test("the Shim offers the orchestration tools and nothing that merely reports on itself", async (t) => {
  const { client } = await shimUnderTest(t, async () => ({}));

  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["cancel_subagent", "check_subagent", "list_runtimes", "spawn_subagent", "subagent_result"],
    "a tool that only says the Shim is alive is authority spent on nothing",
  );
  const spawn = tools.find((tool) => tool.name === "spawn_subagent");
  assert.match(
    spawn?.description ?? "",
    /no access to this conversation/i,
    "the model has to be told the child shares nothing, or it will write half a brief",
  );
  assert.deepEqual(spawn?.inputSchema.required, ["brief"]);
  // The Shim is bundled apart from the core and imports nothing from it, so the
  // two copies of this vocabulary agree only as far as something checks. A level
  // added to the core and not here is refused at the wire with no other sign.
  const properties = spawn?.inputSchema.properties as { effort?: { enum?: string[] } } | undefined;
  assert.deepEqual(properties?.effort?.enum, [...EFFORT_LEVELS]);
});

test("a tool call arrives at the Orchestrator with the Session it was made under", async (t) => {
  const { client, calls } = await shimUnderTest(t, async () => ({ handle: "child-1", state: "running" }));

  const result = await client.callTool({
    name: "spawn_subagent",
    arguments: { brief: "write the release notes", runtime: "codex", effort: "high" },
  });

  assert.deepEqual(calls[0]?.params, {
    brief: "write the release notes",
    runtime: "codex",
    effort: "high",
  });
  assert.equal(calls[0]?.grant.sessionId, "parent-session");
  assert.deepEqual(JSON.parse(textOf(result)), { handle: "child-1", state: "running" });
});

test("a call the capability does not allow comes back as a tool error, not as silence", async (t) => {
  const { client, calls } = await shimUnderTest(t, async () => ({}), {
    ...GRANT,
    methods: ["list_runtimes"],
  });

  const result = await client.callTool({ name: "cancel_subagent", arguments: { handle: "child-1" } });

  assert.equal(result.isError, true, "the model must be able to read what went wrong");
  assert.match(textOf(result), /unauthorized/);
  assert.deepEqual(calls, []);
});

test("the Shim refuses to work at all without a capability", async (t) => {
  const server = await ipcServer(t, { handler: async () => ({}), now: () => 0 });
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", typescriptLoader, shim, "--socket", server.address],
      env: {},
    }),
  );
  t.after(() => client.close());

  const result = await client.callTool({ name: "list_runtimes", arguments: {} });

  assert.equal(result.isError, true);
  assert.match(
    textOf(result),
    /orchestration is unavailable/,
    "the Shim's own refusal, not one it relayed from a server it should never have reached",
  );
});

test("every tool reaches its own method", async (t) => {
  const { client, calls } = await shimUnderTest(t, async (call) => ({ method: call.method }));

  for (const [name, args] of [
    ["list_runtimes", {}],
    ["spawn_subagent", { brief: "x" }],
    ["check_subagent", { handle: "h" }],
    ["subagent_result", { handle: "h" }],
    ["cancel_subagent", { handle: "h" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.deepEqual(JSON.parse(textOf(result)), { method: name }, name);
  }
  assert.deepEqual(
    calls.map((call) => call.method),
    ["list_runtimes", "spawn_subagent", "check_subagent", "subagent_result", "cancel_subagent"],
  );
});
