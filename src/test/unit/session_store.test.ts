import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  MAX_RECORD_CHARS,
  MAX_SESSIONS,
  MAX_SESSIONS_TEXT,
  readSessions,
  resumableSessions,
  resumeBlock,
  savesSettled,
  saveSession,
  startupResume,
  type PersistedSession,
  type ResumeConditions,
  type SessionFacts,
} from "../../core/sessionStore.js";
import type { StoragePort } from "../../core/types.js";
import { fileStorage } from "../../vscode/config.js";

/** A storage directory for one test, removed with it. */
const directory = async (t: TestContext): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), "conductor-sessions-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  return made;
};

/** Everything a record holds for a Session with no selection, parent or
 *  worktree — the shape the file is allowed to have, spelled out. */
const BASE_FIELDS = [
  "createdAt",
  "fingerprint",
  "loadable",
  "runtimeId",
  "sessionId",
  "state",
  "updatedAt",
  "workspace",
];

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: "sess-1",
  runtimeId: "claude",
  fingerprint: "fp-1",
  workspace: "/repo",
  state: "idle",
  loadable: true,
  ...over,
});

test("a Session saved in one window is there when the next one opens", async (t) => {
  const home = await directory(t);

  await saveSession(fileStorage(home), facts({ sessionId: "sess-1" }), 1_000);

  // A second store over the same directory is what a restart looks like.
  const found = await readSessions(fileStorage(home));
  assert.deepEqual(
    found.map((record) => [record.sessionId, record.runtimeId, record.workspace]),
    [["sess-1", "claude", "/repo"]],
  );
  assert.deepEqual([found[0]?.createdAt, found[0]?.updatedAt], [1_000, 1_000]);
});

test("a store file nothing can parse reads as no sessions, not as a failure", async (t) => {
  const home = await directory(t);
  await fileStorage(home).writeAtomic("sessions.json", "{ half a document");

  // Resuming is a convenience; an unreadable file must not be able to stop a
  // window from opening one.
  assert.deepEqual(await readSessions(fileStorage(home)), []);
});

test("one record that does not validate does not take the others with it", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  await saveSession(storage, facts({ sessionId: "sess-good" }), 1_000);
  const stored = JSON.parse((await storage.read("sessions.json")) ?? "") as {
    sessions: unknown[];
  };
  stored.sessions.push({ sessionId: "sess-bad" }, { runtimeId: 7 });
  await storage.writeAtomic("sessions.json", JSON.stringify(stored));

  assert.deepEqual(
    (await readSessions(storage)).map((entry) => entry.sessionId),
    ["sess-good"],
  );
});

test("a store written under a version this build does not know is not read", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  await saveSession(storage, facts(), 1_000);
  const stored = JSON.parse((await storage.read("sessions.json")) ?? "") as { version: number };
  await storage.writeAtomic("sessions.json", JSON.stringify({ ...stored, version: 99 }));

  // Half-understanding a record is worse than forgetting it: every field here
  // decides whether a Session may be reattached to.
  assert.deepEqual(await readSessions(storage), []);
});

test("nothing an Agent worded reaches the file with a resolved secret still in it", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  const key = "sk-live-0123456789abcdef";

  // An Agent chooses its own session id and reports its own effective model, and
  // it was started with the credential in its environment.
  await saveSession(
    storage,
    facts({
      sessionId: `sess-${key}`,
      model: { requested: "opus", effective: `opus-${key}`, verification: "verified" },
    }),
    1_000,
    [key],
  );

  const written = (await storage.read("sessions.json")) ?? "";
  assert.equal(written.includes(key), false, "a credential reached durable storage");
  assert.match(written, /\[redacted\]/);
});

test("a record has nowhere to put a prompt, and the file gets none", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  const smuggled = {
    ...facts(),
    prompt: "the user's question",
    toolCalls: [{ input: "/etc/passwd" }],
    apiKey: "sk-live-0123456789abcdef",
  } as SessionFacts;

  await saveSession(storage, smuggled, 1_000);

  const written = (await storage.read("sessions.json")) ?? "";
  for (const absent of ["the user's question", "/etc/passwd", "sk-live-0123456789abcdef"]) {
    assert.equal(written.includes(absent), false, `${absent} was persisted`);
  }
  const [found] = await readSessions(storage);
  assert.ok(found, "the session itself is still saved");
  // The field set, not just the absence of these three: a record that grows a
  // field nobody thought about is how the next one gets in.
  assert.deepEqual(Object.keys(found).sort(), BASE_FIELDS);
});

test("a value the Agent made absurdly long is refused rather than written", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  await saveSession(storage, facts({ sessionId: "sess-real" }), 1_000);

  await assert.rejects(
    saveSession(storage, facts({ sessionId: "s".repeat(MAX_RECORD_CHARS + 1) }), 2_000),
    /too long/,
  );

  // Refused, not half-written: what the store already held is untouched.
  assert.deepEqual(
    (await readSessions(storage)).map((entry) => entry.sessionId),
    ["sess-real"],
  );
});

test("the store keeps the most recent Sessions and forgets the rest", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  for (let index = 0; index <= MAX_SESSIONS; index += 1) {
    await saveSession(storage, facts({ sessionId: `sess-${index}` }), 1_000 + index);
  }

  const found = await readSessions(storage);
  assert.equal(found.length, MAX_SESSIONS, "a window that opens sessions all day must not grow a file");
  assert.equal(found[0]?.sessionId, `sess-${MAX_SESSIONS}`);
  assert.equal(
    found.some((entry) => entry.sessionId === "sess-0"),
    false,
    "the oldest is the one that goes",
  );
});

test("a store file too large to be one is not parsed", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  await saveSession(storage, facts({ sessionId: "sess-real" }), 1_000);
  // Padded with whitespace *between JSON tokens*, so the document is still valid
  // and still holds a real record. Padding with garbage would prove nothing: an
  // unparseable file is already refused, which would leave the size gate — the
  // only thing under test here — able to be deleted with this test still green.
  const padded = ((await storage.read("sessions.json")) ?? "").replace(
    '{"version"',
    `{${" ".repeat(MAX_SESSIONS_TEXT)}"version"`,
  );
  assert.ok(padded.length > MAX_SESSIONS_TEXT);
  assert.equal(
    (JSON.parse(padded) as { sessions: unknown[] }).sessions.length,
    1,
    "the fixture has to be a store this would otherwise read",
  );
  await storage.writeAtomic("sessions.json", padded);

  assert.deepEqual(await readSessions(storage), []);
});

test("a store that could not be read is not replaced by the save that follows", async () => {
  const unreadable: StoragePort = {
    read: async () => {
      throw new Error("EIO: the disk answered nothing");
    },
    writeAtomic: async () => {
      throw new Error("this store must never be written");
    },
  };

  // A read that failed is not a store that is empty. Treating it as empty would
  // put one Session on top of every Session it could not see.
  await assert.rejects(saveSession(unreadable, facts(), 1_000), /EIO/);
});

test("a record carrying fields this build does not know loses them on the way in", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  await saveSession(storage, facts(), 1_000);
  const stored = JSON.parse((await storage.read("sessions.json")) ?? "") as {
    sessions: Record<string, unknown>[];
  };
  // What another build — or somebody editing the file — could put beside a record.
  stored.sessions[0] = {
    ...stored.sessions[0],
    prompt: "the user's question",
    apiKey: "sk-live-0123456789abcdef",
  };
  await storage.writeAtomic("sessions.json", JSON.stringify(stored));

  const [found] = await readSessions(storage);
  assert.deepEqual(Object.keys(found ?? {}).sort(), BASE_FIELDS);
});

/** What is true in this window right now. */
const conditions = (over: Partial<ResumeConditions> = {}): ResumeConditions => ({
  fingerprints: new Map([["claude", "fp-1"]]),
  workspaces: ["/repo"],
  ...over,
});

const saved = (over: Partial<SessionFacts> = {}): PersistedSession => ({
  ...facts(over),
  createdAt: 1_000,
  updatedAt: 1_000,
});

test("a Session whose Runtime is no longer configured cannot be resumed", () => {
  assert.equal(
    resumeBlock(saved(), conditions({ fingerprints: new Map() })),
    "runtime-gone",
  );
});

test("a Session whose Runtime no longer launches the same thing cannot be resumed", () => {
  // The launch was replaced, or the executable moved: whatever the user approved
  // for this Runtime, it is not what that conversation ran under (ADR-0007).
  assert.equal(
    resumeBlock(saved(), conditions({ fingerprints: new Map([["claude", "fp-other"]]) })),
    "trust-changed",
  );
});

test("a Session belonging to a folder this window has not opened cannot be resumed", () => {
  assert.equal(
    resumeBlock(saved(), conditions({ workspaces: ["/somewhere-else"] })),
    "workspace-closed",
  );
});

test("a Session an Agent has no way to reattach to cannot be resumed", () => {
  // ACP v1 has no resume token: the session id is the handle, and it is worth
  // nothing against an Agent that never advertised `loadSession`.
  assert.equal(resumeBlock(saved({ loadable: false }), conditions()), "agent-cannot-load");
});

test("a Session whose Runtime, launch and folder all still hold can be resumed", () => {
  assert.equal(resumeBlock(saved(), conditions()), undefined);
});

test("nothing is started for a saved Session unless the setting asks for it", () => {
  const records = [saved({ sessionId: "sess-1" })];

  assert.equal(startupResume(records, conditions(), false), undefined);
  assert.equal(startupResume(records, conditions(), true)?.sessionId, "sess-1");
});

test("the Session resumed at startup is the most recent one that is still resumable", () => {
  const records = [
    { ...saved({ sessionId: "sess-newest", fingerprint: "fp-stale" }), updatedAt: 3_000 },
    { ...saved({ sessionId: "sess-resumable" }), updatedAt: 2_000 },
    { ...saved({ sessionId: "sess-older" }), updatedAt: 1_000 },
  ];

  // One folder opening must start one Agent at most, and only where every gate
  // a session start has still passes.
  assert.equal(startupResume(records, conditions(), true)?.sessionId, "sess-resumable");
});

test("what may be offered is every resumable Session, newest first", () => {
  const records = [
    { ...saved({ sessionId: "sess-blocked", loadable: false }), updatedAt: 3_000 },
    { ...saved({ sessionId: "sess-a" }), updatedAt: 2_000 },
    { ...saved({ sessionId: "sess-b" }), updatedAt: 1_000 },
  ];

  assert.deepEqual(
    resumableSessions(records, conditions()).map((entry) => entry.sessionId),
    ["sess-a", "sess-b"],
  );
});

test("a Session saved again as it ends keeps when it started", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  await saveSession(storage, facts({ state: "prompting" }), 1_000);
  await saveSession(storage, facts({ state: "disposed" }), 5_000);

  const found = await readSessions(storage);
  assert.equal(found.length, 1, "an update is not a second Session");
  assert.deepEqual(
    [found[0]?.state, found[0]?.createdAt, found[0]?.updatedAt],
    ["disposed", 1_000, 5_000],
  );
});

test("one Agent's session id says nothing about another's", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  // ACP session ids are unique to the Agent that issued them and to nothing
  // beyond it, so two Runtimes may both call a session `1`.
  await saveSession(storage, facts({ sessionId: "1", runtimeId: "claude" }), 1_000);
  await saveSession(storage, facts({ sessionId: "1", runtimeId: "codex" }), 2_000);
  await saveSession(storage, facts({ sessionId: "1", workspace: "/other" }), 3_000);

  assert.equal((await readSessions(storage)).length, 3);
});

test("two Sessions saved at the same moment do not lose each other", async (t) => {
  const home = await directory(t);
  // One store, as a window has: every Session in it saves through the same file.
  const storage = fileStorage(home);

  await Promise.all([
    saveSession(storage, facts({ sessionId: "sess-a" }), 1_000),
    saveSession(storage, facts({ sessionId: "sess-b" }), 2_000),
    saveSession(storage, facts({ sessionId: "sess-c" }), 3_000),
  ]);

  // A save is a read and a replace, so two in flight together would otherwise
  // read the same file and the later one would write the earlier one away.
  assert.deepEqual(
    (await readSessions(storage)).map((entry) => entry.sessionId).sort(),
    ["sess-a", "sess-b", "sess-c"],
  );
});

test("a save that fails does not stop the next one", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  const refused = saveSession(storage, facts({ sessionId: "x".repeat(MAX_RECORD_CHARS + 1) }), 1_000);
  const accepted = saveSession(storage, facts({ sessionId: "sess-after" }), 2_000);

  await assert.rejects(refused, /too long/);
  await accepted;
  assert.deepEqual(
    (await readSessions(storage)).map((entry) => entry.sessionId),
    ["sess-after"],
  );
});

test("a store written under another version is kept aside, not written over", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  await saveSession(storage, facts({ sessionId: "sess-old" }), 1_000);
  const document = JSON.parse((await storage.read("sessions.json")) ?? "") as object;
  await storage.writeAtomic("sessions.json", JSON.stringify({ ...document, version: 99 }));
  const superseded = (await storage.read("sessions.json")) ?? "";

  await saveSession(storage, facts({ sessionId: "sess-new" }), 2_000);

  // A version bump makes every existing record unreadable. The user's next
  // ordinary session must not be what destroys them beyond recovery.
  assert.equal(await storage.read("sessions.superseded.99.json"), superseded);
  assert.deepEqual(
    (await readSessions(storage)).map((entry) => entry.sessionId),
    ["sess-new"],
  );
});

test("a Session saved with an older stamp does not push out a newer one", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  for (let index = 0; index < MAX_SESSIONS; index += 1) {
    await saveSession(storage, facts({ sessionId: `sess-${index}` }), 1_000_000 + index);
  }

  // A clock that stepped back, or a second window: what is being written is not
  // always the newest thing in the store.
  await saveSession(storage, facts({ sessionId: "sess-behind" }), 1);

  const found = await readSessions(storage);
  assert.equal(found.length, MAX_SESSIONS);
  assert.equal(found[0]?.sessionId, `sess-${MAX_SESSIONS - 1}`, "the newest survives");
  assert.equal(
    found.some((entry) => entry.sessionId === "sess-behind"),
    false,
    "the oldest stamp is the one that goes, whoever wrote it",
  );
});

test("waiting on a store settles the saves already queued against it", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  // What a window closing does: the saves were started with nothing waiting on
  // them, and something now has to.
  void saveSession(storage, facts({ sessionId: "sess-queued" }), 1_000);
  await savesSettled(storage);

  assert.deepEqual(
    (await readSessions(storage)).map((entry) => entry.sessionId),
    ["sess-queued"],
  );
});

test("a second store from another version does not lose the first one kept aside", async (t) => {
  const home = await directory(t);
  const storage = fileStorage(home);
  /** Saves a Session, then restamps the store as some other build's. */
  const stamp = async (version: number, sessionId: string): Promise<string> => {
    await saveSession(storage, facts({ sessionId }), 1_000);
    const document = JSON.parse((await storage.read("sessions.json")) ?? "") as object;
    const restamped = JSON.stringify({ ...document, version });
    await storage.writeAtomic("sessions.json", restamped);
    return restamped;
  };

  const first = await stamp(98, "sess-first");
  await saveSession(storage, facts({ sessionId: "sess-a" }), 2_000);
  const second = await stamp(99, "sess-second");
  await saveSession(storage, facts({ sessionId: "sess-b" }), 3_000);

  // Two bumps with no migration written in between is ordinary. One name for
  // what is kept aside would make the second of them destroy the first.
  assert.equal(await storage.read("sessions.superseded.98.json"), first);
  assert.equal(await storage.read("sessions.superseded.99.json"), second);
});
