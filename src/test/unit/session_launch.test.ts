import assert from "node:assert/strict";
import type * as acp from "@agentclientprotocol/sdk";
import { launchMockAgent, recordingProcessPort, type SentLine } from "../acp-harness.js";
import { readSessions, resolveRuntime, savesSettled, type AgentProcess, type ExecutablePort, type RuntimeSpec, type SessionPorts, type StoragePort } from "../../core/index.js";
import { launchSession, type SessionLaunch } from "../../vscode/sessionLaunch.js";
import type { Orchestration } from "../../vscode/orchestration.js";
import { SessionsTree } from "../../vscode/sessionsTree.js";
import { readSettings } from "../../vscode/config.js";
import { conditions, held } from "../session-fixtures.js";
import { sessionTest } from "../participant-fixtures.js";

/**
 * Starting one Session, whole.
 *
 * Every service below this has tests of its own; what only this can check is
 * that each is handed the right thing — the window's own answer about trust, the
 * folder the Session was created in, and the credential values everything the
 * Agent words is redacted against. None of those throws when it is wrong.
 */

const spec = (mode?: string): RuntimeSpec => ({
  id: "mock",
  displayName: "Mock Agent",
  launch: launchMockAgent(mode),
  policy: { suppressBuiltInSubagents: false },
  quirks: { processScopedConfig: false, effortReadback: true, slashCommandAllowlist: [] },
});

const executable: ExecutablePort = {
  async resolve(command) {
    return command === process.execPath ? { path: process.execPath } : undefined;
  },
};

interface Harness {
  launch: (over?: Partial<SessionLaunch>) => Promise<Awaited<ReturnType<typeof launchSession>>>;
  agents: AgentProcess[];
  sent: SentLine[];
  tree: SessionsTree;
  storage: StoragePort;
  portRoots: string[][];
  trusted: () => boolean;
  setTrusted: (value: boolean) => void;
}

function harnessFor(
  over: {
    roots?: string[];
    secrets?: Record<string, string>;
    mode?: string;
    entry?: { defaultModel?: string; defaultEffort?: string };
  } = {},
): Harness {
  const agents: AgentProcess[] = [];
  const sent: SentLine[] = [];
  const storage = held([]);
  const tree = new SessionsTree({ storage, conditions, now: () => 0 });
  const portRoots: string[][] = [];
  let trusted = true;
  const ports = (_settings: unknown, roots: string[]): SessionPorts => {
    portRoots.push([...roots]);
    return { process: recordingProcessPort([], sent, agents) };
  };
  const settings = readSettings({
    get: (key: string) => (key === "runtimes" && over.entry ? { mock: over.entry } : undefined),
  }).settings;
  return {
    agents,
    sent,
    tree,
    storage,
    portRoots,
    trusted: () => trusted,
    setTrusted: (value) => {
      trusted = value;
    },
    launch: async (extra = {}) =>
      launchSession({
        runtimeId: "mock",
        runtimes: () => [spec(over.mode)],
        settings: () => settings,
        roots: () => over.roots ?? [process.cwd()],
        workspaceTrusted: () => trusted,
        trustFor: () => ({ fingerprint: fingerprint as unknown as string }),
        secretsFor: async () => over.secrets ?? {},
        executable,
        ports: ports as SessionLaunch["ports"],
        onUpdate: () => undefined,
        storage,
        log: { log: () => undefined },
        sessions: tree,
        window: "this-window",
        ...extra,
      }),
  };
}

let fingerprint = "";
const trustedFingerprint = async (mode?: string): Promise<string> =>
  (await resolveRuntime(spec(mode), { executable })).fingerprint;

sessionTest("a workspace this window has not trusted starts nothing", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor();
  // Reaped whatever happens, so a window where the gate was bypassed reports a
  // failure rather than leaving a process behind and hanging the run.
  t.after(async () => {
    for (const agent of harness.agents) agent.kill("SIGKILL");
  });
  harness.setTrusted(false);

  await assert.rejects(harness.launch(), /not trusted/i);

  // The window's own answer, read at the moment of the spawn. Never asking it is
  // one token, throws nothing, and turns every untrusted workspace into a
  // trusted one (ADR-0007).
  assert.equal(harness.agents.length, 0, "a process was started for an untrusted workspace");
});

sessionTest("what the agent was started with is what its own words are redacted against", async (t) => {
  fingerprint = await trustedFingerprint("echo-secret");
  // An Agent reads its own environment and chooses its own session id. This one
  // does both, which is the case the redaction exists for (ADR-0010).
  const harness = harnessFor({
    mode: "echo-secret",
    secrets: { MOCK_SECRET: "s3cr3t-value-here" },
  });

  const session = await harness.launch();
  t.after(() => session.dispose());
  assert.match(session.sessionId, /s3cr3t-value-here/, "the agent did not echo it back");
  await savesSettled(harness.storage);

  // Both halves, because the same list has to reach both and neither complains
  // when it does not: the row on screen and the record on disk.
  const [row] = await harness.tree.getChildren();
  assert.equal(row.live, true);
  assert.doesNotMatch(String(harness.tree.getTreeItem(row).tooltip), /s3cr3t-value-here/);
  assert.doesNotMatch(JSON.stringify(await readSessions(harness.storage)), /s3cr3t-value-here/);
});

sessionTest("a session is created in the folder it will run in, and reattached in its own", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor({ roots: ["/first", process.cwd()] });

  const session = await harness.launch({
    load: { sessionId: "mock-session-1", runtimeId: "mock", workspace: process.cwd() },
  });
  t.after(() => session.dispose());

  // On the wire, because the id alone proves nothing: this Agent numbers its
  // sessions from one per process.
  const load = harness.sent.find((line) => line.method === "session/load");
  assert.ok(load, "reattaching must send session/load");
  assert.equal((load.params as { cwd?: string }).cwd, process.cwd());
  // And the ports are built over every folder the window has, not just the cwd.
  assert.deepEqual(harness.portRoots[0], ["/first", process.cwd()]);
});

sessionTest("what a turn costs reaches the row it was spent on", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor();

  const session = await harness.launch();
  t.after(() => session.dispose());
  await session.prompt("hello");

  // Cost arrives only as an Update, so the row gets it only if this window puts
  // every notification in front of the tree as well as the participant.
  const [row] = await harness.tree.getChildren();
  assert.match(String(harness.tree.getTreeItem(row).description), /cost 0\.01 USD/);
});

sessionTest("the whole of what a session was started with is what a record says it was", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor({
    roots: [process.cwd(), "/second"],
    // Values this Agent really offers, so what is under test is that the
    // settings reach the launch — not that an Agent refuses a value it never had.
    entry: { defaultModel: "mock-model", defaultEffort: "low" },
  });

  const session = await harness.launch();
  t.after(() => session.dispose());
  await savesSettled(harness.storage);

  // The folder it ran in, and every other folder it was told about: an Agent
  // that is never told about the second root cannot read a file in it.
  const created = harness.sent.find((line) => line.method === "session/new");
  assert.equal((created?.params as { cwd?: string }).cwd, process.cwd());
  assert.deepEqual((created?.params as { additionalDirectories?: string[] }).additionalDirectories, [
    "/second",
  ]);
  // And the record: what ran, where, and what was asked for beside what the
  // agent reported. Without the launch identity nothing is written at all.
  const [saved] = await readSessions(harness.storage);
  assert.ok(saved, "no session was remembered");
  assert.equal(saved.runtimeId, "mock");
  assert.equal(saved.workspace, process.cwd());
  assert.equal(saved.fingerprint, fingerprint);
  // What the settings asked for, carried as a request and never as an effective
  // value — a Runtime configured with a model this window never passes on is one
  // whose Read-back has nothing to compare against (ADR-0005).
  assert.equal(saved.model?.requested, "mock-model");
  assert.equal(saved.effort?.requested, "low");
  // And that this window is the one holding it, so another window is told the
  // Session is in use and this one is not told so about its own (ADR-0008).
  assert.equal(saved.heldBy, "this-window");
  assert.ok(saved.heldAt !== undefined);
});

sessionTest("the participant sees every update the agent sends", async (t) => {
  fingerprint = await trustedFingerprint();
  const seen: string[] = [];
  const harness = harnessFor();

  const session = await harness.launch({
    onUpdate: (notification) => seen.push(notification.update.sessionUpdate),
  });
  t.after(() => session.dispose());
  await session.prompt("hello");

  // The tree gets the two things only an Update carries; everything a turn is
  // made of is drawn by the participant, and it only ever sees what is passed on.
  assert.ok(seen.includes("agent_message_chunk"), `saw: ${[...new Set(seen)].join(", ")}`);
});

sessionTest("a runtime the settings do not describe is refused by name", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor();

  await assert.rejects(harness.launch({ runtimeId: "not-configured" }), /not-configured.*Connect a CLI/s);
  assert.equal(harness.agents.length, 0);
  t.diagnostic("nothing started");
});


/**
 * Orchestration as this layer sees it: what was minted, what was attached, and
 * what was given back. The real one has its own tests; what only this can show
 * is that a Session start reaches all three at the right moments.
 */
function fakeOrchestration(over: { servers?: unknown[] } = {}) {
  const record = {
    injected: [] as Array<{ sessionKey: string; depth: number; roots: readonly string[] }>,
    revoked: 0,
    attached: [] as Array<{ sessionKey: string; sessionId: string; cwd: string }>,
    released: [] as string[],
  };
  const orchestration: Orchestration = {
    address: () => undefined,
    targets: async () => [],
    async inject(request) {
      record.injected.push({
        sessionKey: request.sessionKey,
        depth: request.depth,
        roots: request.roots,
      });
      return {
        servers: (over.servers ?? []) as never,
        revoke: () => {
          record.revoked += 1;
        },
      };
    },
    attach(sessionKey, parent) {
      record.attached.push({ sessionKey, sessionId: parent.sessionId, cwd: parent.cwd });
    },
    async release(sessionKey) {
      record.released.push(sessionKey);
    },
    reconcile: async () => undefined,
    releaseWorktree: async () => ({ removed: false }),
    dispose: async () => undefined,
  };
  return { orchestration, record };
}

sessionTest("a session that never started leaves no capability behind", async (t) => {
  fingerprint = await trustedFingerprint("crash-on-session-new");
  const harness = harnessFor({ mode: "crash-on-session-new" });
  t.after(() => {
    for (const agent of harness.agents) agent.kill("SIGKILL");
  });
  const { orchestration, record } = fakeOrchestration();

  await assert.rejects(harness.launch({ orchestration }));

  assert.equal(record.injected.length, 1, "the shim is decided before the process starts");
  assert.equal(
    record.revoked,
    1,
    "authority minted for a session that never ran is authority nothing will ever end",
  );
  assert.deepEqual(record.attached, [], "nothing is attached to a spawn tree that has no session");
});

sessionTest("a live session is attached to the spawn tree, and released when its process is gone", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor();
  const { orchestration, record } = fakeOrchestration();

  const session = await harness.launch({ orchestration });
  const attached = record.attached[0];
  assert.ok(attached);
  assert.equal(attached.sessionId, session.sessionId, "a Shim acts for the Agent's own session");
  assert.equal(attached.cwd, process.cwd());
  assert.equal(record.injected[0]?.depth, 0, "a session the user started is a root");

  await session.dispose();
  await session.exited;
  // Awaited through the same turn the `exited` handlers run in.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.revoked, 1);
  assert.deepEqual(record.released, [attached.sessionKey]);
  t.diagnostic(`session ${session.sessionId}`);
});

/** A Subagent launch, with somewhere for its Updates to go. */
function childLaunch(observed: acp.SessionNotification[] = []) {
  return {
    observed,
    child: {
      sessionKey: "child-key",
      parentSessionKey: "parent-key",
      parentSessionId: "parent-acp",
      depth: 1,
      cwd: process.cwd(),
      worktree: { path: process.cwd(), branch: "agent-conductor/child" },
      observe: (notification: acp.SessionNotification) => observed.push(notification),
    },
  };
}

sessionTest("a Subagent runs where the orchestrator put it and is told about nothing else", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor({ roots: [process.cwd(), "/another-root"] });
  const { orchestration, record } = fakeOrchestration();

  const session = await harness.launch({ orchestration, ...childLaunch() });
  t.after(() => session.dispose());
  await savesSettled(harness.storage);

  assert.deepEqual(
    record.injected[0],
    { sessionKey: "child-key", depth: 1, roots: [process.cwd()] },
    "the parent repository is not a child's to be told about by default (ADR-0009)",
  );
  const [saved] = await readSessions(harness.storage);
  assert.equal(saved.parentSessionId, "parent-acp");
  assert.deepEqual(saved.worktree, { path: process.cwd(), branch: "agent-conductor/child" });
});

sessionTest("what a Subagent's Agent says reaches the orchestrator that will report it", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor();
  const { orchestration } = fakeOrchestration();
  const { observed, child } = childLaunch();

  const session = await harness.launch({ orchestration, child });
  t.after(() => session.dispose());
  await session.prompt("Reply with exactly: OK");

  // The child's final message and what it cost are read off these and nothing
  // else, so a launch that drops them is a Subagent that answers its parent with
  // silence — and throws nowhere while doing it.
  const said = observed
    .flatMap((notification) => {
      const update = notification.update as { sessionUpdate?: string; content?: { text?: string } };
      return update.sessionUpdate === "agent_message_chunk" ? [update.content?.text ?? ""] : [];
    })
    .join("");
  assert.equal(said, "OK");
});

sessionTest("a live Subagent's row offers the checkout it is working in", async (t) => {
  fingerprint = await trustedFingerprint();
  const harness = harnessFor();
  const { orchestration } = fakeOrchestration();

  const session = await harness.launch({ orchestration, ...childLaunch() });
  t.after(() => session.dispose());

  // Drawn from the Session rather than from its record, so a worktree only
  // written down is one no row offers until the Session has ended — which is
  // exactly when looking at its changes stops being useful.
  const [row] = await harness.tree.getChildren();
  assert.equal(row.live, true);
  assert.deepEqual(row.worktree, { path: process.cwd(), branch: "agent-conductor/child" });
});
