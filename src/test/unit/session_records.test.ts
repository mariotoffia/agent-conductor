import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readSessions, savesSettled } from "../../core/sessionStore.js";
import type { AgentExit, LogPort, SessionState, StoragePort } from "../../core/types.js";
import { fileStorage } from "../../vscode/config.js";
import { remember, type RecordedSession } from "../../vscode/sessionRecords.js";

/** A storage directory for one test, removed with it. */
const directory = async (t: TestContext): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), "conductor-records-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  return made;
};

// ---------------------------------------------------------------------------
// Writing a live Session down. `remember` takes the part of a Session it reads,
// structurally, so this needs no Agent process — and the compile-time assertion
// beside it is what keeps that shape honest against the real class.
// ---------------------------------------------------------------------------

const live = (over: Partial<RecordedSession> = {}): RecordedSession => ({
  sessionId: "sess-live",
  state: "idle",
  handshake: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  modelSelection: { requested: "opus", effective: "opus", verification: "verified" },
  effortSelection: { verification: "unavailable" },
  exited: new Promise(() => undefined),
  ...over,
});

const logged = (): { port: LogPort; lines: string[] } => {
  const lines: string[] = [];
  return { port: { log: (_level, text) => lines.push(text) }, lines };
};

/**
 * Settles once the writes `remember` started have run.
 *
 * On the queue itself, never on a delay: a wait long enough today is a test that
 * fails on a slower machine for a reason that has nothing to do with what it
 * protects. The turns are only there to let an `exited` handler queue its write.
 */
const written = async (storage: StoragePort): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  await savesSettled(storage);
};

test("a Session whose launch identity is unknown is not written down", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  const log = logged();

  // No fingerprint means nothing could re-derive whether it is safe to reattach,
  // so the record would be one that can never be used (ADR-0007).
  remember(live(), storage, log.port, {
    runtimeId: "claude",
    workspace: "/repo",
    secrets: [],
    window: "this-window",
  });

  await written(storage);
  assert.deepEqual(await readSessions(storage), []);
  // Declined, not attempted and refused: leaving it to the record schema to
  // reject would report a decision this Client made as something that failed.
  assert.deepEqual(log.lines, []);
});

test("a Session is written down when it opens and again when its process ends", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  let ended = (): void => undefined;
  let state: SessionState = "idle";
  const exited = new Promise<AgentExit>((resolve) => {
    ended = () => resolve({ code: 0, signal: null });
  });
  // The getter is defined after the spread, not passed through one: spreading an
  // object reads its getters, so a state that changes would arrive frozen.
  const session: RecordedSession = {
    ...live(),
    exited,
    get state() {
      return state;
    },
  };

  remember(session, storage, logged().port, {
    runtimeId: "claude",
    fingerprint: "fp-1",
    workspace: "/repo",
    secrets: [],
    window: "this-window",
  });
  await written(storage);
  assert.deepEqual(
    (await readSessions(storage)).map((entry) => entry.state),
    ["idle"],
  );

  state = "disposed";
  ended();
  await written(storage);

  const found = await readSessions(storage);
  assert.equal(found.length, 1, "the same Session, not a second one");
  assert.equal(found[0]?.state, "disposed", "the record says how it ended");
  assert.equal(found[0]?.loadable, true);
});

test("a Session whose Agent never offered to load one is written down as unresumable", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  remember(live({ handshake: { protocolVersion: 1 } }), storage, logged().port, {
    runtimeId: "gemini",
    fingerprint: "fp-1",
    workspace: "/repo",
    secrets: [],
    window: "this-window",
  });

  await written(storage);
  assert.equal((await readSessions(storage))[0]?.loadable, false);
});

test("a Session that cannot be written down says so in the log and nothing else", async () => {
  const log = logged();
  const refusing: StoragePort = {
    read: async () => undefined,
    writeAtomic: async () => {
      throw new Error("read-only filesystem");
    },
  };

  // Saving is a convenience. A Turn must not fail, and a rejection must not go
  // unhandled, because a file could not be written.
  remember(live(), refusing, log.port, {
    runtimeId: "claude",
    fingerprint: "fp-1",
    workspace: "/repo",
    secrets: [],
    window: "this-window",
  });

  await written(refusing);
  assert.match(log.lines.join("\n"), /claude: this session was not saved: read-only filesystem/);
});

test("a Session started with a credential does not log one when saving fails", async () => {
  const log = logged();
  const key = "sk-live-0123456789abcdef";
  const refusing: StoragePort = {
    read: async () => undefined,
    writeAtomic: async () => {
      throw new Error(`EACCES: /home/${key}/storage`);
    },
  };

  remember(live(), refusing, log.port, {
    runtimeId: "claude",
    fingerprint: "fp-1",
    workspace: "/repo",
    secrets: [key],
    window: "this-window",
  });

  await written(refusing);
  assert.equal(log.lines.join("\n").includes(key), false);
  assert.match(log.lines.join("\n"), /\[redacted\]/);
});

test("an agent that died mid-turn is not remembered as still taking one", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  let died = (): void => undefined;
  const exited = new Promise<AgentExit>((settle) => {
    died = () => settle({ code: null, signal: "SIGSEGV" });
  });
  // What a crash leaves behind: the process is gone, and nothing has yet moved
  // the Session off the state it was in when it went.
  const session = live({ state: "prompting", exited });

  remember(session, storage, logged().port, {
    runtimeId: "claude",
    fingerprint: "fp",
    workspace: "/repo",
    secrets: [],
    window: "this-window",
  });
  died();
  await written(storage);

  const [saved] = await readSessions(storage);
  // Not `prompting`: a record is how a Session ended, and a Session whose
  // process is gone is not still taking a turn. Left as it was, every window
  // afterwards draws that row as one still working, for good.
  assert.equal(saved.state, "failed");
});

/** Every `.ts` file beneath a directory, as `[name, text]`. */
async function sources(root: URL): Promise<(readonly [string, string])[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const at = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
      if (entry.isDirectory()) return entry.name === "test" ? [] : sources(at);
      return entry.name.endsWith(".ts") ? [[entry.name, await readFile(at, "utf8")] as const] : [];
    }),
  );
  return found.flat();
}

test("one place writes a record, and every field it has room for is filled there", async () => {
  // Every source file under the two layers, at any depth: a writer put in a
  // subdirectory is exactly the one this check would otherwise miss.
  const files = await sources(new URL("../../", import.meta.url));

  // One writer, found rather than assumed: a second would be a second place for
  // a field to be filled in differently, or not at all.
  const writers = files
    .filter(([name, text]) => name !== "sessionStore.ts" && text.includes("saveSession("))
    .map(([name]) => name);
  assert.deepEqual(writers, ["sessionRecords.ts"]);

  const written = files.find(([name]) => name === "sessionRecords.ts")?.[1] ?? "";
  // The two the Sessions tree draws its hierarchy and its worktree row from.
  // Unfilled, both surfaces exist and show nothing, which reads as an
  // Orchestrator that ran and recorded nothing rather than as one that did not.
  for (const field of ["parentSessionId", "worktree"]) {
    assert.equal(written.includes(`${field}:`), true, `nothing writes ${field}`);
  }
});

test("a Subagent is recorded under its parent, with the checkout it worked in", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  let died = (): void => undefined;
  const exited = new Promise<AgentExit>((settle) => {
    died = () => settle({ code: 0, signal: null });
  });

  remember(live({ exited }), storage, logged().port, {
    runtimeId: "claude",
    fingerprint: "fp",
    workspace: "/worktrees/child",
    secrets: [],
    window: "this-window",
    parentSessionId: "parent-acp",
    worktree: { path: "/worktrees/child", branch: "agent-conductor/child" },
  });
  died();
  await written(storage);

  const [saved] = await readSessions(storage);
  assert.equal(saved.parentSessionId, "parent-acp");
  assert.deepEqual(saved.worktree, { path: "/worktrees/child", branch: "agent-conductor/child" });
});

test("a turn somebody stopped is not remembered as one that broke", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  let stopped = (): void => undefined;
  const exited = new Promise<AgentExit>((settle) => {
    stopped = () => settle({ code: 0, signal: null });
  });

  remember(live({ state: "cancelling", exited }), storage, logged().port, {
    runtimeId: "claude",
    fingerprint: "fp",
    workspace: "/repo",
    secrets: [],
    window: "this-window",
  });
  stopped();
  await written(storage);

  // An Agent that answers `session/cancel` by exiting leaves the Session on
  // `cancelling`. That is a Session somebody stopped, and drawing it afterwards
  // as broken says something about the Agent that is not true.
  assert.equal((await readSessions(storage))[0].state, "disposed");
});

test("what was asked for beside what the agent reported is part of the record", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  remember(
    live({
      modelSelection: { requested: "opus", effective: "sonnet", verification: "verified" },
      effortSelection: { requested: "high", verification: "unavailable" },
    }),
    storage,
    logged().port,
    { runtimeId: "claude", fingerprint: "fp", workspace: "/repo", secrets: [], window: "w" },
  );
  await written(storage);

  // Both halves of a Read-back, and the record is the only thing that carries
  // them past the end of the window (ADR-0005).
  const [saved] = await readSessions(storage);
  assert.deepEqual(saved.model, { requested: "opus", effective: "sonnet", verification: "verified" });
  assert.deepEqual(saved.effort, { requested: "high", verification: "unavailable" });
});
