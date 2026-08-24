import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  ConductorSession,
  ExecutablePort,
  LogPort,
  RuntimeSpec,
  RuntimeTrust,
  SessionPorts,
  StoragePort,
} from "../core/index.js";
import type { Orchestration } from "./orchestration.js";
import type { ConductorSettings } from "./config.js";
import type { SavedSession } from "./participantPorts.js";
import { remember } from "./sessionRecords.js";
import type { SessionsTree } from "./sessionsTree.js";
import { openTrustedSession, sessionFolders } from "./spawnGate.js";

/**
 * Starting one Session and handing it to everything that has to know.
 *
 * Apart from the composition root because it is the wiring that fails silently:
 * a workspace-trust answer that is never asked, a credential list that never
 * reaches the redaction, a reattach that quietly opens a new conversation — each
 * of those is one token, none of them throws, and every service underneath goes
 * on passing its own tests. Here it is `vscode`-free and can be driven whole.
 */

/**
 * What makes this Session a Subagent rather than one the user started.
 *
 * All of it is the Orchestrator's, decided under a capability minted before the
 * parent's Agent ever ran. Nothing here can be named by an Agent.
 */
export interface SubagentLaunch {
  /** How the Orchestrator names this Session, and the key its own Shim acts
   *  under. Not the Agent's session id: that does not exist until `session/new`
   *  has been answered, and `mcpServers` goes out inside that very request. */
  sessionKey: string;
  parentSessionKey: string;
  /** The parent's ACP session id, which is what the Subagent tree is drawn from. */
  parentSessionId: string;
  depth: number;
  /** Where this Subagent works — its own worktree, or its parent's folder. */
  cwd: string;
  requestedModel?: string;
  requestedEffort?: string;
  worktree?: { path: string; branch: string };
  /**
   * Every Update this Subagent's Agent sends, back to the Orchestrator.
   *
   * Required, and not optional, because it is what the result is made of — the
   * child's final message and what it cost are read off nothing else. A caller
   * that forgets it produces a Subagent that finishes and tells its parent
   * nothing, which throws nowhere and looks exactly like an Agent that had
   * nothing to say.
   */
  observe(notification: acp.SessionNotification): void;
}

export interface SessionLaunch {
  /** Runtime the user asked for. */
  runtimeId: string;
  /** Reattach to this saved Session instead of creating a new one. */
  load?: SavedSession | undefined;
  /** Every Runtime the settings describe, at its pinned Adapter version. */
  runtimes(): RuntimeSpec[];
  settings(): ConductorSettings;
  /** Absolute `file` folders open in this window. */
  roots(): string[];
  /** `vscode.workspace.isTrusted`, asked at spawn time rather than cached: a
   *  workspace can be trusted after the extension started. */
  workspaceTrusted(): boolean;
  /** Runtime Trust the connection wizard recorded, if any. */
  trustFor(spec: RuntimeSpec): RuntimeTrust | undefined;
  /** Values behind this Runtime's `secretEnvironment` references. */
  secretsFor(spec: RuntimeSpec, references?: Record<string, string>): Promise<Record<string, string>>;
  executable: ExecutablePort;
  /** The Client Ports one Session is served through. */
  ports(settings: ConductorSettings, roots: string[], agentLabel: string): SessionPorts;
  /** Where the participant draws its Updates. */
  onUpdate(notification: acp.SessionNotification): void;
  storage: StoragePort;
  log: LogPort;
  sessions: SessionsTree;
  /** This window's own id, written beside a Session's hold so that another
   *  window can tell a Session that ended from one still running here. */
  window: string;
  /** Orchestration, when this window has it. Absent means no Shim is ever
   *  injected and no Session is ever attached to a spawn tree. */
  orchestration?: Orchestration;
  /** Set only when this Session is a Subagent (ADR-0004). */
  child?: SubagentLaunch;
}

export async function launchSession(launch: SessionLaunch): Promise<ConductorSession> {
  const settings = launch.settings();
  const spec = launch.runtimes().find((entry) => entry.id === launch.runtimeId);
  if (!spec) {
    throw new Error(
      `runtime ${launch.runtimeId} is not configured — run "Agent Conductor: Connect a CLI…"`,
    );
  }
  const roots = launch.roots();
  const child = launch.child;
  // A Subagent works where the Orchestrator put it — its own worktree, or its
  // parent's folder — and is told about nothing else. Handing a child the parent
  // repository by default would defeat the separation the worktree exists for,
  // and could not make it read-only in any case (ADR-0009).
  const folders = child
    ? { cwd: child.cwd, additionalDirectories: [] }
    : sessionFolders(spec.id, roots, launch.load);
  const { cwd, additionalDirectories } = folders;
  const trust = launch.trustFor(spec);
  const orchestration = launch.orchestration;
  const entry = settings.runtimes[spec.id];
  // Minted here, before anything is sent, because `mcpServers` travels inside
  // `session/new` and the Agent has not chosen its own id by then.
  const sessionKey = child?.sessionKey ?? randomUUID();
  const { session, secrets, revokeOrchestration } = await openTrustedSession({
    spec,
    executable: launch.executable,
    workspaceTrusted: launch.workspaceTrusted(),
    ...(trust ? { trust } : {}),
    cwd,
    additionalDirectories,
    ...(launch.load ? { loadSessionId: launch.load.sessionId } : {}),
    secretEnvironment: () => launch.secretsFor(spec, entry?.secretEnvironment),
    ...(child?.requestedModel ?? entry?.defaultModel
      ? { requestedModel: child?.requestedModel ?? entry?.defaultModel }
      : {}),
    ...(child?.requestedEffort ?? entry?.defaultEffort
      ? { requestedEffort: child?.requestedEffort ?? entry?.defaultEffort }
      : {}),
    ...(orchestration
      ? {
          orchestrate: (runtime) =>
            orchestration.inject({
              runtime,
              sessionKey,
              ...(child ? { parentSessionKey: child.parentSessionKey } : {}),
              depth: child?.depth ?? 0,
              roots: [cwd, ...additionalDirectories],
            }),
        }
      : {}),
    onUpdate: (notification) => {
      // The tree draws the two things only an Update carries; the participant
      // draws the rest. Both see every one, and the tree first, so a participant
      // that throws on one cannot take the row's figure with it.
      launch.sessions.observe(notification.sessionId, notification.update);
      // And the Orchestrator, when this Session is a Subagent: what its parent
      // is eventually handed is read off these and nowhere else.
      child?.observe(notification);
      launch.onUpdate(notification);
    },
    ports: launch.ports(settings, roots, spec.displayName),
  });
  // Recorded before it is tracked, and in this order on purpose: the tree waits
  // for the writes queued against the store when a Session ends, so the write
  // that says how it ended has to be queued by then — otherwise the row that
  // replaces it says how it began, for good.
  remember(session, launch.storage, launch.log, {
    runtimeId: spec.id,
    workspace: cwd,
    secrets,
    window: launch.window,
    // The launch this Session ran under. `openTrustedSession` only returns for a
    // Runtime whose fingerprint matched, so this is that fingerprint.
    ...(trust ? { fingerprint: trust.fingerprint } : {}),
    ...(child ? { parentSessionId: child.parentSessionId } : {}),
    ...(child?.worktree ? { worktree: child.worktree } : {}),
  });
  launch.sessions.track(session, {
    workspace: cwd,
    secrets,
    // A live row's worktree comes from here, not from the record: a session this
    // window is running is drawn from the session and never from the file, so a
    // worktree only written down is one no row offers until the session ends.
    ...(child?.worktree ? { worktree: child.worktree } : {}),
  });
  // Only now: a Session that is running is one a Shim may act for, and one whose
  // own children have somewhere to hang. Both end together — the capability is
  // withdrawn and everything below it is cancelled the moment the process is
  // gone, whether it was disposed, cancelled, or simply died (ADR-0008).
  orchestration?.attach(sessionKey, {
    sessionId: session.sessionId,
    runtimeId: spec.id,
    cwd,
  });
  void session.exited.then(() => {
    revokeOrchestration();
    void orchestration?.release(sessionKey);
  });
  return session;
}
