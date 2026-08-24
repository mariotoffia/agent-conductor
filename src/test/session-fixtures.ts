import { SESSIONS_KEY, SESSIONS_VERSION } from "../core/sessionStore.js";
import type { PersistedSession, ResumeConditions, StoragePort } from "../core/index.js";
import { sessionActions } from "../vscode/sessionActions.js";
import type { SessionNode, TrackedSession } from "../vscode/sessionsTree.js";

/**
 * Fixtures for the Sessions tree: a store holding exactly the records a test
 * wrote, one Persisted Session, one live Session, and the conditions a window
 * re-derives resumability against.
 */

/** A store holding exactly the records a test wrote into it. */
export const held = (sessions: PersistedSession[]): StoragePort => {
  let value = JSON.stringify({ version: SESSIONS_VERSION, sessions });
  return {
    read: async (key) => (key === SESSIONS_KEY ? value : undefined),
    writeAtomic: async (key, written) => {
      if (key === SESSIONS_KEY) value = written;
    },
  };
};

export const record = (over: Partial<PersistedSession> = {}): PersistedSession => ({
  sessionId: "sess-parent",
  runtimeId: "claude",
  fingerprint: "fp-claude",
  workspace: "/repo",
  state: "disposed",
  loadable: true,
  model: { requested: "opus", effective: "opus", verification: "verified" },
  createdAt: 1_000,
  updatedAt: 61_000,
  ...over,
});

export const conditions = (over: Partial<ResumeConditions> = {}): ResumeConditions => ({
  fingerprints: new Map([["claude", "fp-claude"]]),
  workspaces: ["/repo"],
  now: 0,
  window: "this-window",
  ...over,
});

export const liveSession = (over: Partial<TrackedSession> = {}): TrackedSession => ({
  sessionId: "sess-live",
  runtimeId: "claude",
  state: "prompting",
  modelSelection: { verification: "unavailable" },
  effortSelection: { verification: "unavailable" },
  exited: new Promise(() => undefined),
  ...over,
});

/** One row, as a command receives it. */
export const rowNode = (over: Partial<SessionNode> = {}): SessionNode => ({
  key: "6:claude5:/repo11:sess-parent",
  id: "sess-parent",
  shownId: "sess-parent",
  runtimeId: "claude",
  workspace: "/repo",
  shownWorkspace: "/repo",
  state: "disposed",
  fingerprint: "fp-claude",
  loadable: true,
  live: false,
  children: [],
  ...over,
});

/** The row actions, with every window surface and the participant recorded. */
export function actionHarness(
  over: {
    workspaces?: string[];
    conditions?: () => ResumeConditions;
    /** Answers to the confirmations this harness will be asked, in order. An
     *  unanswered question is `false`, which is what dismissing one means. */
    confirmations?: boolean[];
    releaseWorktree?(path: string, options?: { force?: boolean }): Promise<{
      removed: boolean;
      reason?: string;
    }>;
  } = {},
) {
  const resumed: unknown[] = [];
  const asked: string[] = [];
  const confirmations = [...(over.confirmations ?? [])];
  const cancelled: (string | undefined)[] = [];
  let disposals = 0;
  const executed: unknown[][] = [];
  const said: string[] = [];
  let refuse: Error | undefined;
  const actions = sessionActions({
    participant: {
      dispose: async () => {
        disposals += 1;
      },
      cancel: async (sessionId) => {
        cancelled.push(sessionId);
      },
      resume: async (saved) => {
        if (refuse) throw refuse;
        resumed.push(saved);
      },
    },
    host: {
      execute: async (command, ...args) => {
        executed.push([command, ...args]);
        if (refuse) throw refuse;
        return undefined;
      },
      inform: (text) => said.push(text),
      fail: (text) => said.push(text),
      confirm: async (text) => {
        asked.push(text);
        return confirmations.shift() ?? false;
      },
    },
    workspaces: () => over.workspaces ?? ["/repo"],
    storage: held([]),
    conditions: over.conditions ?? conditions,
    resumeOnStartup: () => false,
    ...(over.releaseWorktree ? { releaseWorktree: over.releaseWorktree } : {}),
  });
  return {
    actions,
    asked,
    resumed,
    cancelled,
    disposals: () => disposals,
    executed,
    said,
    resume: async (saved: unknown) => {
      resumed.push(saved);
    },
    host: {
      execute: async (command: string, ...args: unknown[]) => {
        executed.push([command, ...args]);
        return undefined;
      },
      confirm: async (text: string) => {
        asked.push(text);
        return confirmations.shift() ?? false;
      },
      inform: (text: string) => said.push(text),
      fail: (text: string) => said.push(text),
    },
    refuseWith: (error: Error) => {
      refuse = error;
    },
  };
}
