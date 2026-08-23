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
  const { cwd, additionalDirectories } = sessionFolders(spec.id, roots, launch.load);
  const trust = launch.trustFor(spec);
  const entry = settings.runtimes[spec.id];
  const { session, secrets } = await openTrustedSession({
    spec,
    executable: launch.executable,
    workspaceTrusted: launch.workspaceTrusted(),
    ...(trust ? { trust } : {}),
    cwd,
    additionalDirectories,
    ...(launch.load ? { loadSessionId: launch.load.sessionId } : {}),
    secretEnvironment: () => launch.secretsFor(spec, entry?.secretEnvironment),
    ...(entry?.defaultModel ? { requestedModel: entry.defaultModel } : {}),
    ...(entry?.defaultEffort ? { requestedEffort: entry.defaultEffort } : {}),
    onUpdate: (notification) => {
      // The tree draws the two things only an Update carries; the participant
      // draws the rest. Both see every one, and the tree first, so a participant
      // that throws on one cannot take the row's figure with it.
      launch.sessions.observe(notification.sessionId, notification.update);
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
  });
  launch.sessions.track(session, { workspace: cwd, secrets });
  return session;
}
