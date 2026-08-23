import assert from "node:assert/strict";
import { test } from "node:test";
import type { PersistedSession, SessionFacts } from "../../core/sessionStore.js";
import {
  resumableSessions,
  resumeBlock,
  startupResume,
  type ResumeConditions,
} from "../../core/sessionResume.js";

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: "sess-1",
  runtimeId: "claude",
  fingerprint: "fp-1",
  workspace: "/repo",
  state: "disposed",
  loadable: true,
  ...over,
});

/**
 * Whether a saved Session may be reattached to.
 *
 * Worked out afresh every time from what holds now, never read off the record:
 * trust recorded once is trust that outlives the launch it was granted for, and
 * a folder that was open when a row was drawn need not be open when somebody
 * clicks it (ADR-0007, ADR-0008).
 */

const conditions = (over: Partial<ResumeConditions> = {}): ResumeConditions => ({
  fingerprints: new Map([["claude", "fp-1"]]),
  workspaces: ["/repo"],
  now: 0,
  window: "this-window",
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
