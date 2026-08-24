import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ResolvedRuntime, RuntimeSpec } from "../../core/index.js";
import { readSettings } from "../../vscode/config.js";
import { limitsFrom, orchestration, type Orchestration } from "../../vscode/orchestration.js";

/** Settings as VS Code hands them over: unset keys fall back to the manifest. */
function settingsWith(values: Record<string, unknown>) {
  const { settings } = readSettings({ get: (key) => values[key] });
  return settings;
}

/** A Runtime that has cleared everything a Shim injection asks of it. */
const ELIGIBLE = {
  trusted: true,
  capabilities: { readback: true, suppression: false, budget: false },
  quirks: { processScopedConfig: false, effortReadback: true, slashCommandAllowlist: [] },
} satisfies Pick<ResolvedRuntime, "trusted" | "capabilities" | "quirks">;

function wiring(
  t: TestContext,
  values: Record<string, unknown>,
  over: Partial<Parameters<typeof orchestration>[0]> = {},
): Orchestration {
  const conductor = orchestration({
    settings: () => settingsWith(values),
    runtimes: () => [],
    trustFor: () => undefined,
    executable: { resolve: async () => undefined },
    workspace: () => "/workspace",
    openChild: () => Promise.reject(new Error("no child is expected in this test")),
    storage: { read: async () => undefined, writeAtomic: async () => undefined },
    log: { log: () => undefined },
    command: process.execPath,
    shim: { args: ["/ext/dist/mcp-shim.cjs"] },
    worktreeRoot: "/tmp/agent-conductor-worktrees",
    git: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    ...over,
  });
  t.after(() => conductor.dispose());
  return conductor;
}

test("a window with orchestration switched off opens no socket at all", async (t) => {
  const conductor = wiring(t, {});

  const injection = await conductor.inject({
    runtime: ELIGIBLE,
    sessionKey: "session-key",
    depth: 0,
    roots: ["/workspace"],
  });

  assert.deepEqual(injection.servers, []);
  assert.match(injection.refused ?? "", /switched off/);
  // Asked of this Orchestration rather than of the machine's temporary
  // directory, which every other socket in the suite shares.
  assert.equal(
    conductor.address(),
    undefined,
    "while orchestration is off there is to be no socket, not an empty one (ADR-0008)",
  );
});

test("a Runtime whose agent accepts no MCP servers opens no socket either", async (t) => {
  const conductor = wiring(t, { "orchestration.enabled": true });

  const injection = await conductor.inject({
    runtime: { ...ELIGIBLE, quirks: { ...ELIGIBLE.quirks, refusesMcpServers: true } },
    sessionKey: "session-key",
    depth: 0,
    roots: ["/workspace"],
  });

  assert.deepEqual(injection.servers, []);
  assert.equal(conductor.address(), undefined);
});

test("a Session at the spawn depth cap opens no socket either", async (t) => {
  const conductor = wiring(t, { "orchestration.enabled": true });

  const injection = await conductor.inject({
    runtime: ELIGIBLE,
    sessionKey: "session-key",
    depth: 1,
    roots: ["/workspace"],
  });

  assert.deepEqual(injection.servers, []);
  assert.equal(conductor.address(), undefined);
});

test("no Runtime is offered as one that holds a money limit, whatever its trust says", async (t) => {
  const spec: RuntimeSpec = {
    id: "claude",
    displayName: "Claude Code",
    launch: { command: process.execPath, args: [], env: {} },
    policy: { suppressBuiltInSubagents: false },
    quirks: { processScopedConfig: false, effortReadback: true, slashCommandAllowlist: [] },
  };
  const conductor = wiring(
    t,
    { "orchestration.enabled": true },
    {
      runtimes: () => [spec],
      // A trust record saying this Runtime can enforce a money limit on a child.
      // Nothing writes one today; this is what happens the day something does.
      trustFor: () => ({ fingerprint: "fp", budget: true }),
      executable: { resolve: async (command) => ({ path: command }) },
    },
  );

  const [target] = await conductor.targets();

  assert.equal(
    target?.budget,
    false,
    "a limit this client has no way to send is not one a parent may be told is being held",
  );
});

test("an eligible Session gets the bundled Shim, run by an absolute interpreter", async (t) => {
  const conductor = wiring(t, { "orchestration.enabled": true });

  const injection = await conductor.inject({
    runtime: ELIGIBLE,
    sessionKey: "session-key",
    depth: 0,
    roots: ["/workspace"],
  });
  t.after(() => injection.revoke());

  assert.equal(injection.servers.length, 1);
  const server = injection.servers[0] as unknown as Record<string, unknown>;
  assert.equal(server.command, process.execPath);
  assert.deepEqual((server.args as string[]).slice(0, 2), ["/ext/dist/mcp-shim.cjs", "--socket"]);
  // Without this the three assertions that a socket was *not* made would pass
  // against an `address()` that is broken outright and answers nothing, ever.
  assert.equal(typeof conductor.address(), "string");
  assert.equal((server.args as string[])[2], conductor.address());
});

test("the limits a spawn is measured against are the user's settings, preset and all", () => {
  const limits = limitsFrom(
    settingsWith({
      "orchestration.maxSpawnDepth": 2,
      "orchestration.maxConcurrentSubagents": 5,
      "orchestration.maxSubagentsPerSession": 7,
      "orchestration.subagentTimeoutMs": 120_000,
      "orchestration.budgetUsdPerSubagent": 4,
      "orchestration.subagentIsolation": "shared",
      "orchestration.defaultSubagentPreset": "reviewer",
      presets: { reviewer: { runtime: "codex", model: "gpt-5", effort: "high" } },
    }),
  );

  assert.deepEqual(limits, {
    maxSpawnDepth: 2,
    maxConcurrentSubagents: 5,
    maxSubagentsPerSession: 7,
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 120_000,
    budgetUsdPerSubagent: 4,
    isolation: "shared",
    defaultRuntimeId: "codex",
    defaultModel: "gpt-5",
    defaultEffort: "high",
  });
});

test("a preset the settings do not have leaves the defaults to the parent's own Runtime", () => {
  const limits = limitsFrom(settingsWith({ "orchestration.defaultSubagentPreset": "missing" }));

  assert.equal(limits.defaultRuntimeId, undefined);
  assert.equal(limits.defaultModel, undefined);
  assert.equal(limits.defaultEffort, undefined);
});
