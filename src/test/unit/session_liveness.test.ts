import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  HELD_BEAT_MS,
  HELD_STALE_MS,
  readSessions,
  resumeBlock,
  savesSettled,
  type PersistedSession,
  type ResumeConditions,
  type StoragePort,
} from "../../core/index.js";
import { fileStorage } from "../../vscode/config.js";
import { remember, type RecordedSession } from "../../vscode/sessionRecords.js";
import { SessionsTree } from "../../vscode/sessionsTree.js";
import { actionHarness } from "../session-fixtures.js";
import type { AgentExit, LogPort } from "../../core/index.js";

/**
 * Whether somebody else still has a Session open.
 *
 * Sessions are remembered per machine, not per window: two windows share one
 * store, and nothing in a record used to say that a Session was in use. So a
 * Session another window was running was offered back here as one that had
 * ended, and picking it up ran two Agents on one conversation.
 *
 * The record therefore carries when its window last said it still had it. That
 * has to answer two questions with one field: a window that is still there says
 * so repeatedly, and a window that was killed stops saying it — and the second
 * is why this cannot simply be a flag. A flag left set by a crash would make a
 * Session unresumable for ever, and crash recovery is what resuming is for.
 */

const held = (over: Partial<PersistedSession> = {}): PersistedSession => ({
  sessionId: "sess-1",
  runtimeId: "claude",
  fingerprint: "fp-claude",
  workspace: "/repo",
  state: "idle",
  loadable: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const conditions = (now: number, window = "this-window"): ResumeConditions => ({
  fingerprints: new Map([["claude", "fp-claude"]]),
  workspaces: ["/repo"],
  now,
  window,
});

test("a session another window still has open is not offered back", () => {
  const now = 1_000_000;

  assert.equal(resumeBlock(held({ heldAt: now - 1_000 }), conditions(now)), "held-elsewhere");
});

test("a session whose window went away without a word is offered back again", () => {
  const now = 1_000_000;

  // The window was killed, so it never wrote that the Session had ended. Left
  // blocked on that alone, the conversation would be unreachable for ever.
  assert.equal(resumeBlock(held({ heldAt: now - HELD_STALE_MS - 1 }), conditions(now)), undefined);
});

test("a session remembered before any window said anything is offered back", () => {
  // Records written by a build that did not stamp them, and records whose window
  // wrote that they had ended. Neither is in use.
  assert.equal(resumeBlock(held(), conditions(1_000_000)), undefined);
});

/** A storage directory for one test, removed with it. */
const directory = async (t: TestContext): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), "conductor-liveness-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  return made;
};

const logged = (): LogPort => ({ log: () => undefined });

/** A clock a test moves by hand, so no wall-clock guess decides anything. */
function handClock() {
  const pending: { at: number; run: () => void }[] = [];
  let at = 0;
  return {
    port: {
      after(ms: number, run: () => void) {
        const entry = { at: at + ms, run };
        pending.push(entry);
        return () => {
          const found = pending.indexOf(entry);
          if (found >= 0) pending.splice(found, 1);
        };
      },
    },
    /** Runs everything due within `ms`, one due callback at a time. */
    async advance(ms: number): Promise<void> {
      at += ms;
      for (let guard = 0; guard < 100; guard += 1) {
        const due = pending.findIndex((entry) => entry.at <= at);
        if (due < 0) break;
        const [entry] = pending.splice(due, 1);
        entry.run();
        await Promise.resolve();
      }
    },
    get waiting(): number {
      return pending.length;
    },
  };
}

const live = (exited: Promise<AgentExit>): RecordedSession => ({
  sessionId: "sess-live",
  state: "idle",
  handshake: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  modelSelection: { verification: "unavailable" },
  effortSelection: { verification: "unavailable" },
  exited,
});

const settled = async (storage: StoragePort): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  await savesSettled(storage);
};

test("a window with a session open keeps saying so", async (t) => {
  const storage = fileStorage(await directory(t));
  const clock = handClock();
  let end = (): void => undefined;
  const exited = new Promise<AgentExit>((settle) => {
    end = () => settle({ code: 0, signal: null });
  });

  remember(live(exited), storage, logged(), {
    runtimeId: "claude",
    fingerprint: "fp",
    workspace: "/repo",
    secrets: [],
    window: "window-a",
    clock: clock.port,
  });
  await settled(storage);
  const opened = (await readSessions(storage))[0].heldAt;

  // Across several beats, not one: a window says so again and again for as long
  // as the Session lives. Saying it once and stopping would let the hold go
  // stale under a Session that is still running, and another window would offer
  // it back.
  for (let beat = 0; beat < 3; beat += 1) {
    await clock.advance(HELD_BEAT_MS);
    await settled(storage);
    assert.equal(clock.waiting, 1, `nothing was scheduled to say it again after beat ${beat + 1}`);
  }
  await clock.advance(HELD_STALE_MS);
  await settled(storage);
  const later = (await readSessions(storage))[0].heldAt;

  // Repeatedly, and often enough that the stamp never goes stale while the
  // window is alive — otherwise another window offers the session back under it.
  assert.ok(opened !== undefined && later !== undefined);
  assert.ok(later > opened, `the stamp did not move: ${opened} -> ${later}`);
  // And who said it, so that this window's own hold does not stop this window.
  assert.equal((await readSessions(storage))[0].heldBy, "window-a");

  end();
  await settled(storage);
  // Ended, so it is not in use, and can be picked up at once rather than after
  // the stamp has aged out.
  assert.equal((await readSessions(storage))[0].heldAt, undefined);
  assert.equal((await readSessions(storage))[0].heldBy, undefined);
  assert.equal(clock.waiting, 0, "the heartbeat outlived the session it was about");
});

test("a row for a session somebody else has open says so, and refuses the click", async () => {
  const now = 1_000_000;
  const store: StoragePort = {
    read: async () =>
      JSON.stringify({
        version: 1,
        sessions: [held({ sessionId: "sess-elsewhere", heldAt: now - 1_000 })],
      }),
    writeAtomic: async () => undefined,
  };
  const tree = new SessionsTree({
    storage: store,
    conditions: () => conditions(now),
    now: () => now,
  });
  const harness = actionHarness({ conditions: () => conditions(now) });

  const [row] = await tree.getChildren();
  assert.equal(row.blocked, "held-elsewhere");
  // Marked as held, not merely as past: a Session this window cannot resume is
  // still one whose leftovers it may clear up, and a Session another window is
  // *running* is not — and the two are told apart nowhere else.
  assert.equal(tree.getTreeItem(row).contextValue, "agentConductor.session.past.held");
  assert.match(String(tree.getTreeItem(row).tooltip), /another window still has it open/);

  await harness.actions.resume(row);

  // Worked out again at the click: the other window may have closed since the
  // row was drawn, and it may equally have opened it since.
  assert.deepEqual(harness.resumed, []);
});

test("a session this window is running is still its own to see", async () => {
  const now = 1_000_000;
  const store: StoragePort = {
    read: async () =>
      JSON.stringify({ version: 1, sessions: [held({ sessionId: "sess-live", heldAt: now })] }),
    writeAtomic: async () => undefined,
  };
  const tree = new SessionsTree({
    storage: store,
    conditions: () => conditions(now),
    now: () => now,
  });
  tree.track(
    {
      sessionId: "sess-live",
      runtimeId: "claude",
      state: "prompting",
      modelSelection: { verification: "unavailable" },
      effortSelection: { verification: "unavailable" },
      exited: new Promise(() => undefined),
    },
    { workspace: "/repo" },
  );

  const [row] = await tree.getChildren();

  // The window's own hold must not make its own Session read as somebody
  // else's: a live row wins over the record, and is never a resume candidate.
  assert.equal(row.live, true);
  assert.equal(row.blocked, undefined);
  assert.equal(tree.getTreeItem(row).contextValue, "agentConductor.session.live");
});

test("a window's own hold is not somebody else's", () => {
  const now = 1_000_000;
  const mine = conditions(now, "window-a");

  // The window that wrote the stamp is the one window it must not stop. Its own
  // record is stamped from the moment the Session opens until the moment it is
  // written down as ended, and in between the row is its own to act on.
  assert.equal(resumeBlock(held({ heldAt: now, heldBy: "window-a" }), mine), undefined);
  assert.equal(resumeBlock(held({ heldAt: now, heldBy: "window-b" }), mine), "held-elsewhere");
  // A window that was killed comes back as a different window, so its old hold
  // is another window's — and ages out rather than being believed for ever.
  assert.equal(
    resumeBlock(held({ heldAt: now - HELD_STALE_MS - 1, heldBy: "window-b" }), mine),
    undefined,
  );
});
