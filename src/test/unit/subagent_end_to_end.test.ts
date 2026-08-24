import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ConductorSession,
  createOrchestrator,
  nodeProcessPort,
  ORCHESTRATION_METHODS,
  type ChildSession,
  type OrchestrationLimits,
  type SubagentResult,
} from "../../core/index.js";
import { launchMockAgent } from "../acp-harness.js";
import { ipcServer } from "../ipc-fixtures.js";

/**
 * The whole chain, once: an Agent's harness starts the Shim, the Shim calls back
 * over the socket under its Session Capability, the Orchestrator opens a child
 * Session on a real Agent process, and the child's answer comes back as the
 * tool's result (ARCHITECTURE.md §Data flows).
 *
 * Every part of this has its own test with everything else faked. What only this
 * can show is that the parts agree: the Shim's tool arguments really are the
 * schema the socket validates, the socket's answer really is what the Shim can
 * read, and the result really does carry what the child Agent said.
 */

const shim = fileURLToPath(new URL("../../shim/mcp-shim.ts", import.meta.url));
const typescriptLoader = import.meta.resolve("tsx");

/** The Smoke Test prompt: the mock Agent answers it and nothing else. */
const BRIEF = "Reply with exactly: OK";

function limits(): OrchestrationLimits {
  return {
    maxSpawnDepth: 1,
    maxConcurrentSubagents: 2,
    maxSubagentsPerSession: 4,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 30_000,
    budgetUsdPerSubagent: 1,
    isolation: "shared",
  };
}

async function chain(t: TestContext): Promise<{ client: Client; children: ChildSession[] }> {
  const children: ChildSession[] = [];
  const orchestrator = createOrchestrator({
    limits,
    runtimes: async () => [
      { id: "mock", displayName: "Mock Agent", available: true, budget: false, fanOut: false },
    ],
    async openChild(launch) {
      const session = await ConductorSession.open(
        {
          runtimeId: launch.runtimeId,
          launch: launchMockAgent(),
          cwd: launch.cwd,
          onUpdate: launch.observe,
        },
        { process: nodeProcessPort },
      );
      children.push(session);
      return session;
    },
  });
  orchestrator.attach("parent-key", {
    sessionId: "parent-acp",
    runtimeId: "mock",
    cwd: process.cwd(),
  });
  t.after(() => orchestrator.dispose());

  const server = await ipcServer(t, { handler: orchestrator.handle });
  const capability = server.issue({
    sessionId: "parent-key",
    depth: 0,
    roots: [process.cwd()],
    expiresAtMs: Date.now() + 60_000,
    methods: [...ORCHESTRATION_METHODS],
  });
  t.after(() => capability.revoke());

  // The Shim exactly as a harness gets it: another process, over stdio, with the
  // socket in its arguments and the capability in its environment.
  const client = new Client({ name: "harness", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", typescriptLoader, shim, "--socket", server.address],
      env: { AGENT_CONDUCTOR_SESSION_SECRET: capability.secret },
    }),
  );
  t.after(() => client.close());
  return { client, children };
}

/** What a tool call came back with, parsed the way an Agent would read it. */
function answer(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
  return JSON.parse(text) as Record<string, unknown>;
}

test("an agent's shim spawns a real child agent and gets its answer back", { timeout: 60_000 }, async (t) => {
  const { client, children } = await chain(t);

  const result = answer(
    await client.callTool({ name: "spawn_subagent", arguments: { brief: BRIEF } }),
  ) as unknown as SubagentResult;

  assert.equal(result.state, "done");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.text, "OK", "the child's own words are what the parent is handed");
  assert.equal(result.runtime, "mock");
  assert.notEqual(result.sessionId, "", "the child Agent chose a session id of its own");
  assert.equal(result.cost, "unknown", "the mock Agent reports no cost, and none is invented");
  assert.equal(result.budget, "unenforced");

  assert.equal(children.length, 1);
  // One process per Session: the child's ended with its Turn (ADR-0008).
  const child = children[0];
  assert.ok(child);
  assert.equal(
    await Promise.race([
      (child as ConductorSession).exited.then(() => "gone"),
      new Promise((resolve) => setTimeout(() => resolve("alive"), 2_000).unref()),
    ]),
    "gone",
  );
});

test("the shim's runtime list is the one the orchestrator decided, not one it holds", async (t) => {
  const { client } = await chain(t);

  const listed = answer(await client.callTool({ name: "list_runtimes", arguments: {} }));

  assert.deepEqual(listed, {
    runtimes: [{ id: "mock", name: "Mock Agent", spawnable: true, budget: false }],
  });
});

test("a brief naming a file outside the granted roots is refused before any agent starts", async (t) => {
  const { client, children } = await chain(t);

  const refused = await client.callTool({
    name: "spawn_subagent",
    arguments: { brief: BRIEF, files: ["/etc/shadow"] },
  });

  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /outside this session's roots/);
  assert.deepEqual(children, [], "nothing is spawned for a brief that was refused");
});
