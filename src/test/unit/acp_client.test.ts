import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import {
  ConductorSession,
  nodeProcessPort,
  type AgentProcess,
  type AgentExit,
  type ProcessPort,
  type SessionPorts,
} from "../../core/index.js";
import { harness, launchMockAgent } from "../acp-harness.js";

const testTimeoutMs = 10_000;

function acpTest(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, { timeout: testTimeoutMs }, fn);
}

/** A Runtime whose process is already gone before the handshake can start. */
function deadOnArrivalPort(): ProcessPort {
  return {
    spawn: () => ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(), // never delivers, never ends
      onStderr: () => undefined,
      exited: Promise.resolve({ code: 7, signal: null }),
      kill: () => undefined,
    }),
  };
}

/** An exit that actually happened, rather than a placeholder. */
function reaped(exit: AgentExit): boolean {
  return exit.code !== null || exit.signal !== null || exit.error !== undefined;
}

/** Ports that serve every optional ACP client surface. */
function servingPorts(): SessionPorts {
  return {
    fs: {
      readTextFile: () => Promise.resolve({ content: "" }),
      writeTextFile: () => Promise.resolve(),
    },
    terminal: {
      createTerminal: () => Promise.resolve({ terminalId: "t1" }),
      terminalOutput: () => Promise.resolve({ output: "", truncated: false }),
      waitForTerminalExit: () => Promise.resolve({ exitCode: 0 }),
      killTerminal: () => Promise.resolve(),
      releaseTerminal: () => Promise.resolve(),
    },
    elicitation: {
      createElicitation: () => Promise.reject(new Error("not used")),
      completeElicitation: () => undefined,
    },
  };
}

acpTest("session setup sends the v1 handshake, an absolute cwd, and name-sorted mcpServers", async (t) => {
  const h = harness(t);

  const session = await h.open({
    mcpServers: [
      { name: "zeta", command: process.execPath, args: [], env: [] },
      { name: "alpha", command: process.execPath, args: [], env: [] },
    ],
    sessionMeta: { claudeCode: { options: { agents: {} } } },
  });

  const initialize = h.paramsOf("initialize");
  assert.equal(initialize.protocolVersion, acp.PROTOCOL_VERSION);
  const setup = h.paramsOf("session/new");
  assert.equal(setup.cwd, process.cwd());
  assert.deepEqual((setup.mcpServers as acp.McpServer[]).map((server) => server.name), ["alpha", "zeta"]);
  assert.deepEqual(setup._meta, { claudeCode: { options: { agents: {} } } });
  assert.equal(session.sessionId, "mock-session-1");
  assert.equal(session.state, "idle");
  assert.equal(session.configOptions.length, 2);
  assert.equal(session.handshake.authMethods?.[0]?.id, "mock-auth");
});

acpTest("client capabilities advertise exactly the ports that can serve them", async (t) => {
  const bare = harness(t);
  await bare.open();
  const serving = harness(t, servingPorts());
  await serving.open();

  assert.deepEqual(bare.paramsOf("initialize").clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    _meta: { "subagent-transcript": true },
  });
  assert.deepEqual(serving.paramsOf("initialize").clientCapabilities, {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    elicitation: { form: {} },
    _meta: { "subagent-transcript": true },
  });
});

acpTest("additionalDirectories are sent only when the Agent advertises support", async (t) => {
  const extra = resolve(process.cwd(), "extra-root");
  const supported = harness(t);
  await supported.open({ additionalDirectories: [extra] });
  const unsupported = harness(t);
  await unsupported.open({
    launch: launchMockAgent("minimal-capabilities"),
    additionalDirectories: [extra],
  });

  assert.deepEqual(supported.paramsOf("session/new").additionalDirectories, [extra]);
  assert.equal("additionalDirectories" in unsupported.paramsOf("session/new"), false);
  assert.ok(
    unsupported.logs.some((line) => line.includes("does not support additionalDirectories")),
    unsupported.logs.join("\n"),
  );
});

acpTest("session/load re-sends sorted mcpServers and the session id", async (t) => {
  const h = harness(t);

  const session = await h.load("saved-session", {
    mcpServers: [
      { name: "orchestrator", command: process.execPath, args: [], env: [] },
      { name: "alpha", command: process.execPath, args: [], env: [] },
    ],
    additionalDirectories: [resolve(process.cwd(), "extra-root")],
  });

  const load = h.paramsOf("session/load");
  assert.equal(load.sessionId, "saved-session");
  assert.equal(load.cwd, process.cwd());
  assert.deepEqual((load.mcpServers as acp.McpServer[]).map((server) => server.name), [
    "alpha",
    "orchestrator",
  ]);
  assert.deepEqual(load.additionalDirectories, [resolve(process.cwd(), "extra-root")]);
  assert.equal(session.sessionId, "saved-session");
  assert.equal(session.configOptions.length, 2);
});

acpTest("session/load fails closed on an Agent without loadSession and leaves no process", async (t) => {
  const h = harness(t);

  await assert.rejects(
    h.load("saved-session", { launch: launchMockAgent("minimal-capabilities") }),
    /does not support session\/load/,
  );

  assert.equal(h.methodsSent().includes("session/load"), false);
  assert.equal(h.spawns.length, 1);
  assert.ok(reaped(await h.children[0].exited), "the probing process must be terminated");
});

acpTest("non-absolute launch commands, cwd, roots, and mcp commands are rejected before spawning", async (t) => {
  const h = harness(t);

  await assert.rejects(
    h.open({ launch: { command: "npx", args: [], env: {} } }),
    /launch command must be an absolute path/,
  );
  await assert.rejects(h.open({ cwd: "relative/workspace" }), /session cwd must be absolute/);
  await assert.rejects(
    h.open({ additionalDirectories: ["relative/root"] }),
    /additional directory must be absolute/,
  );
  await assert.rejects(
    h.open({ mcpServers: [{ name: "shim", command: "mcp-shim.cjs", args: [], env: [] }] }),
    /mcp server "shim" command must be absolute/,
  );
  assert.deepEqual(h.spawns, []);
});

acpTest("resolved secrets reach the Agent environment but only their names are logged", async (t) => {
  const h = harness(t);

  await h.open({
    launch: { ...launchMockAgent(), env: { CODEX_CONFIG: "{}" } },
    secretEnvironment: { AGENT_API_KEY: "super-secret-value" },
  });

  const [spawn] = h.spawns;
  assert.equal(spawn.env.AGENT_API_KEY, "super-secret-value");
  assert.equal(spawn.env.CODEX_CONFIG, "{}");
  assert.equal(spawn.env.PATH, process.env.PATH, "non-secret environment must be inherited");
  const log = h.logs.join("\n");
  assert.ok(log.includes("AGENT_API_KEY"), "secret names belong in the log");
  assert.equal(log.includes("super-secret-value"), false, "secret values must never be logged");
});

acpTest("the process port passes argv verbatim and never through a shell", async () => {
  const child = nodeProcessPort.spawn({
    command: process.execPath,
    args: ["-e", "process.stderr.write(process.argv[1] + '|' + process.env.CONDUCTOR_PROBE)", "$HOME;id"],
    env: { CONDUCTOR_PROBE: "probe-value" },
    cwd: process.cwd(),
  });
  let stderr = "";
  child.onStderr((chunk) => {
    stderr += chunk;
  });

  const exit = await child.exited;

  assert.equal(exit.code, 0);
  assert.equal(stderr, "$HOME;id|probe-value");
});

acpTest("an Agent that exits before the handshake reports its exit status", async (t) => {
  const h = harness(t);

  await assert.rejects(
    ConductorSession.open(h.spec({ launch: launchMockAgent("exit") }), h.ports),
    /runtime mock: .*agent process exited with code 23/,
  );
});

acpTest("an Agent that corrupts stdout and dies fails the handshake instead of hanging", async (t) => {
  const h = harness(t);
  const originalConsoleError = console.error;
  console.error = () => undefined; // the SDK reports the parse failure itself
  t.after(() => {
    console.error = originalConsoleError;
  });

  // Whether the corrupt line or the closing stream is noticed first, the
  // handshake must fail fast with a runtime-scoped reason and reap the child.
  await assert.rejects(
    ConductorSession.open(h.spec({ launch: launchMockAgent("malformed") }), h.ports),
    /runtime mock: (ACP handshake failed|agent process exited)/,
  );

  assert.ok(reaped(await h.children[0].exited), "the Agent process must not be left running");
});

acpTest("Agent stderr is captured for diagnostics without disturbing the protocol", async (t) => {
  const h = harness(t);

  const session = await h.open({ launch: launchMockAgent("stderr") });
  const response = await session.prompt("hello");

  assert.equal(response.stopReason, "end_turn");
  assert.ok(
    h.logs.some((line) => line.includes("runtime mock stderr: mock-agent stderr")),
    h.logs.join("\n"),
  );
});

acpTest("history replayed during session/load reaches the update sink", async (t) => {
  const h = harness(t);

  const session = await h.load("saved-session", { launch: launchMockAgent("load-history") });

  assert.deepEqual(
    h.updates.map((notification) =>
      notification.update.sessionUpdate === "agent_message_chunk" &&
      notification.update.content.type === "text"
        ? notification.update.content.text
        : notification.update.sessionUpdate),
    ["replayed user turn", "replayed agent turn"],
  );
  assert.equal(session.sessionId, "saved-session");
});

acpTest("an Agent answering another protocol version is refused", async (t) => {
  const h = harness(t);

  await assert.rejects(
    ConductorSession.open(h.spec({ launch: launchMockAgent("bad-protocol") }), h.ports),
    /runtime mock: ACP handshake failed: unsupported ACP protocol version 999/,
  );

  assert.ok(reaped(await h.children[0].exited), "the refused Agent must not be left running");
});

acpTest("a refused handshake keeps its reason even when the Agent must be killed", async (t) => {
  const h = harness(t);

  const refused = assert.rejects(
    ConductorSession.open(
      h.spec({ launch: launchMockAgent("bad-protocol", ["--ignore-sigterm"]) }),
      h.ports,
    ),
    /runtime mock: ACP handshake failed: unsupported ACP protocol version 999/,
  );
  // Teardown escalates because the Agent ignores SIGTERM; the diagnosis must
  // still name the protocol version, not the signal we ended it with.
  await h.clock.armed(2); // the setup deadline, then the teardown escalation
  h.clock.fire();
  await refused;

  assert.equal((await h.children[0].exited).signal, "SIGKILL");
});

acpTest("a refused handshake keeps its reason when the Agent shuts down gracefully", async (t) => {
  const h = harness(t);

  // A cooperative Runtime exits with a code, not a signal — indistinguishable
  // from one that died on its own, so the reason must not be inferred from it.
  await assert.rejects(
    ConductorSession.open(
      h.spec({ launch: launchMockAgent("bad-protocol", ["--graceful-sigterm"]) }),
      h.ports,
    ),
    /handshake failed: unsupported ACP protocol version 999 .*\(agent process exited with code 0\)/,
  );
});

acpTest("an Agent gone before the handshake starts is reported once, not wrapped", async (t) => {
  const h = harness(t, { process: deadOnArrivalPort() });

  await assert.rejects(ConductorSession.open(h.spec(), h.ports), (error: Error) => {
    assert.match(error.message, /^runtime mock: agent process exited with code 7$/);
    return true;
  });
});

acpTest("an Agent that never answers initialize is abandoned at the setup deadline", async (t) => {
  const h = harness(t);

  const refused = assert.rejects(
    ConductorSession.open(
      h.spec({ launch: launchMockAgent("silent-initialize"), setupTimeoutMs: 5_000 }),
      h.ports,
    ),
    /runtime mock: ACP handshake failed: agent did not answer initialize within 5000ms/,
  );
  await h.clock.armed(1);
  h.clock.fire();
  await refused;

  assert.ok(reaped(await h.children[0].exited), "a silent Agent must not be left running");
});

acpTest("an Agent that never answers session/new is abandoned at the setup deadline", async (t) => {
  const h = harness(t);

  const refused = assert.rejects(
    ConductorSession.open(
      h.spec({ launch: launchMockAgent("silent-session-new"), setupTimeoutMs: 5_000 }),
      h.ports,
    ),
    /runtime mock: session setup failed: agent did not answer session\/new within 5000ms/,
  );
  await h.clock.armed(2); // the handshake deadline is armed and cleared first
  h.clock.fire();
  await refused;

  assert.ok(reaped(await h.children[0].exited), "a silent Agent must not be left running");
});

acpTest("an Agent that dies during session/new reports the stage and its exit status", async (t) => {
  const h = harness(t);

  await assert.rejects(
    ConductorSession.open(h.spec({ launch: launchMockAgent("crash-on-session-new") }), h.ports),
    /runtime mock: session setup failed: .* \(agent process exited with code 42\)/,
  );

  assert.ok(reaped(await h.children[0].exited), "the crashed Agent must be reaped");
});

test("closing a session stops the helper processes the agent started", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
  const log = join(await mkdtemp(join(tmpdir(), "conductor-agent-")), "worker.log");
  const h = harness(t);
  const session = await h.open({
    launch: { ...launchMockAgent("spawns-child"), env: { MOCK_AGENT_WORKER_LOG: log } },
  });
  // Every agent CLI starts processes of its own; they are the session's to stop.
  await waitFor(async () => (await readFile(log, "utf8").catch(() => "")).length > 0);

  await session.dispose();
  await new Promise((wake) => setTimeout(wake, 250));
  const settled = (await readFile(log, "utf8")).length;
  await new Promise((wake) => setTimeout(wake, 300));

  assert.equal((await readFile(log, "utf8")).length, settled, "the agent's worker outlived its session");
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((wake) => setTimeout(wake, 50));
  }
  assert.fail("condition never held");
}

test("an agent whose process group has ended is not signalled on its old id", async (t) => {
  const h = harness(t);
  const session = await h.open();

  // Stands in for the system's answers. A process group id outlives the group,
  // and a Session whose Agent died may not be torn down for hours — long enough
  // for that id to be handed to somebody else, which is what `recycled` is.
  const signalled: number[] = [];
  let recycled = false;
  const realKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0) signalled.push(pid);
    if (recycled && pid < 0) return true; // somebody else's group answers now
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  t.after(() => {
    process.kill = realKill;
  });

  h.children[0]?.kill("SIGKILL");
  await session.exited;
  signalled.length = 0;
  recycled = true;

  await session.dispose();

  assert.deepEqual(signalled.filter((pid) => pid < 0), [], "an ended group was signalled");
});

test("a refused handshake keeps its reason even when the teardown itself fails", async (t) => {
  const started: AgentProcess[] = [];
  const h = harness(t, {
    process: {
      spawn(request) {
        const child = nodeProcessPort.spawn(request);
        started.push(child);
        return { ...child, kill: () => { throw new Error("signal refused"); } };
      },
    },
  });
  t.after(() => {
    for (const child of started) child.kill("SIGKILL");
  });

  // The handshake is what failed; a teardown that fails on the way out must not
  // replace the diagnosis with its own.
  await assert.rejects(h.open({ launch: launchMockAgent("bad-protocol") }), /protocol version/);
});
