import { test, type TestContext } from "node:test";
import {
  ConductorSession,
  resolveRuntime,
  type AgentProcess,
  type ExecutablePort,
  type ModelHint,
  type RuntimeSpec,
  type RuntimeTrust,
  type SessionPorts,
} from "../core/index.js";
import { DiffDocuments } from "../vscode/diffDocs.js";
import type { ChatCommand } from "../vscode/chatSink.js";
import { ConductorParticipant, type RuntimeChoice } from "../vscode/participant.js";
import { openTrustedSession } from "../vscode/spawnGate.js";
import type { QuickItem } from "../vscode/elicitation.js";
import { launchMockAgent, recordingProcessPort, type SentLine } from "./acp-harness.js";

/**
 * Fixtures for driving the chat participant against a real mock-Agent process:
 * a trusted Runtime, a recording chat stream, a cancellation token a test fires
 * by hand, and hooks that hold the permission request, the quick pick or the
 * session open so a window can be caught mid-flight.
 */

export const sessionTest = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: 20_000 }, fn);

/** A Runtime whose launch really starts the mock Agent. */
export function mockRuntime(mode?: string): RuntimeSpec {
  return {
    id: "mock",
    displayName: "Mock Agent",
    launch: launchMockAgent(mode),
    policy: { suppressBuiltInSubagents: false },
    quirks: { processScopedConfig: false, effortReadback: true, slashCommandAllowlist: [] },
  };
}

export const executable: ExecutablePort = {
  async resolve(command) {
    return command === process.execPath ? { path: process.execPath } : undefined;
  },
};

/** Trust for exactly the identity this spec resolves to — what the wizard records. */
async function trustFor(spec: RuntimeSpec): Promise<RuntimeTrust> {
  const resolved = await resolveRuntime(spec, { executable });
  return { fingerprint: resolved.fingerprint };
}

/** Everything the participant writes, in order, so a test can read the turn. */
export function recordingStream() {
  const written: string[] = [];
  const buttons: ChatCommand[] = [];
  return {
    written,
    buttons,
    text: () => written.join("\n"),
    stream: {
      markdown: (value: string) => written.push(value),
      progress: (value: string) => written.push(value),
      button: (command: ChatCommand) => buttons.push(command),
    },
  };
}

/** A cancellation token a test fires by hand, as the chat host would. */
export function cancellation() {
  const listeners: (() => void)[] = [];
  let requested = false;
  return {
    token: {
      get isCancellationRequested() {
        return requested;
      },
      onCancellationRequested(listener: () => void) {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    },
    cancel() {
      requested = true;
      for (const listener of listeners) listener();
    },
  };
}

export interface Harness {
  participant: ConductorParticipant;
  diffs: DiffDocuments;
  offered: QuickItem[][];
  /** Every agent process the participant started, in order. */
  agents: AgentProcess[];
  /** Every JSON-RPC line this Client wrote to an Agent, in order. */
  sent: SentLine[];
  /** What each quick pick was headed with, in order. */
  pickOptions: ({ title?: string; placeHolder?: string } | undefined)[];
  /** Everything the participant and its sink recorded. */
  logged: string[];
  /** How many times the participant has said that what it owns has moved. */
  changes(): number;
  /** The state of every session it owns, snapshotted at each of those moments —
   *  what a view drawing itself from the event would have seen. */
  drawnStates(): string[][];
  /** The Runtime id each session was opened for, in order. */
  opened: string[];
  choose(label: string | undefined): void;
  /** Picks by position, as a user clicking a list does. */
  chooseAt(index: number): void;
  hideThinking(): void;
  /** Holds the agent's permission request open, so a turn can be held mid-flight. */
  holdPermission(): void;
  /** Holds the session open, so teardown can be caught mid-start. */
  holdOpen(): void;
  /** Resolves once the agent process exists but the session is not yet adopted. */
  openStarted: Promise<void>;
  allowOpen(): void;
  /** Holds the quick pick open, so a command can be caught mid-decision. */
  holdPick(): void;
  /** Resolves once the pick has been offered. */
  pickOffered: Promise<void>;
  allowPick(): void;
  /** Resolves once the agent has asked, and lets the held request through. */
  permissionAsked: Promise<void>;
  allowPermission(): void;
}

/** Participant wired to a real mock-Agent process on a trusted Runtime. */
export function participantOn(
  t: TestContext,
  spec: RuntimeSpec,
  overrides: {
    trusted?: boolean;
    workspaceTrusted?: boolean;
    secretEnvironment?: () => Promise<Record<string, string>>;
    onChanged?: () => void;
    log?: () => void;
    runtimeChoice?: RuntimeChoice;
    /** Runtimes the picker offers; `[]` is a window with none configured. */
    runtimes?: RuntimeChoice[];
    /** The Runtime catalog's own model hints, for an Agent that exposes none. */
    modelCatalog?: ModelHint[];
  } = {},
): Harness {
  const diffs = new DiffDocuments();
  const offered: QuickItem[][] = [];
  const pickOptions: ({ title?: string; placeHolder?: string } | undefined)[] = [];
  let answer: string | undefined;
  let answerAt: number | undefined;
  let thinking = true;
  let openHeld = false;
  let noteOpenStarted = (): void => undefined;
  const openStarted = new Promise<void>((resolve) => {
    noteOpenStarted = resolve;
  });
  let releaseOpen = (): void => undefined;
  const openAllowed = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let pickHeld = false;
  let notePickOffered = (): void => undefined;
  const pickOffered = new Promise<void>((resolve) => {
    notePickOffered = resolve;
  });
  let releasePick = (): void => undefined;
  const pickAllowed = new Promise<void>((resolve) => {
    releasePick = resolve;
  });
  let held = false;
  const agents: AgentProcess[] = [];
  const sent: SentLine[] = [];
  let changes = 0;
  const opened: string[] = [];
  const logged: string[] = [];
  const started: ConductorSession[] = [];
  const drawnStates: string[][] = [];
  let noteAsked = (): void => undefined;
  const permissionAsked = new Promise<void>((resolve) => {
    noteAsked = resolve;
  });
  let release = (): void => undefined;
  const allowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ports: SessionPorts = {
    process: recordingProcessPort([], sent, agents),
    permission: {
      requestPermission: async () => {
        noteAsked();
        if (held) await allowed;
        return { outcome: { outcome: "selected", optionId: "allow" } as const };
      },
    },
  };
  const participant = new ConductorParticipant({
    diffs,
    log: {
      log: (_severity, text) => {
        logged.push(text);
        overrides.log?.();
      },
    },
    defaultRuntimeId: () => spec.id,
    showThinking: () => thinking,
    runtimes: async (): Promise<RuntimeChoice[]> =>
      overrides.runtimes ?? [overrides.runtimeChoice ?? { id: spec.id, label: spec.displayName }],
    runtimeQuirks: () => spec.quirks,
    ...(overrides.modelCatalog ? { modelCatalog: () => overrides.modelCatalog ?? [] } : {}),
    onChanged: () => {
      changes += 1;
      drawnStates.push(started.map((session) => session.state));
      overrides.onChanged?.();
    },
    pick: async (items, options) => {
      offered.push([...items]);
      pickOptions.push(options);
      notePickOffered();
      if (pickHeld) await pickAllowed;
      // VS Code answers with the very object it was handed; so does this.
      return answerAt === undefined
        ? items.find((item) => item.label === answer)
        : items[answerAt];
    },
    open: async (runtimeId, onUpdate, load) => {
      opened.push(runtimeId);
      const { session } = await openTrustedSession({
        spec: runtimeId === spec.id ? spec : { ...spec, id: runtimeId },
        executable,
        trust: overrides.trusted === false ? undefined : await trustFor(spec),
        workspaceTrusted: overrides.workspaceTrusted ?? true,
        cwd: load?.workspace ?? process.cwd(),
        ...(overrides.secretEnvironment ? { secretEnvironment: overrides.secretEnvironment } : {}),
        ...(load ? { loadSessionId: load.sessionId } : {}),
        onUpdate,
        ports,
      });
      started.push(session);
      // The window between the agent process existing and the participant
      // adopting the session it belongs to.
      noteOpenStarted();
      if (openHeld) await openAllowed;
      return session;
    },
  });
  t.after(() => participant.dispose());
  return {
    participant,
    diffs,
    offered,
    pickOptions,
    logged,
    agents,
    sent,
    changes: () => changes,
    drawnStates: () => drawnStates,
    opened,
    choose: (label) => {
      answer = label;
    },
    chooseAt: (index) => {
      answerAt = index;
    },
    hideThinking: () => {
      thinking = false;
    },
    holdPermission: () => {
      held = true;
    },
    permissionAsked,
    allowPermission: release,
    holdOpen: () => {
      openHeld = true;
    },
    openStarted,
    allowOpen: () => releaseOpen(),
    holdPick: () => {
      pickHeld = true;
    },
    pickOffered,
    allowPick: () => releasePick(),
  };
}

/** Polls a predicate; the timeout is the test's own. */
export async function waitFor(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}
