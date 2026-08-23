import type * as acp from "@agentclientprotocol/sdk";
import {
  ConductorSession,
  resolveRuntime,
  trustedLaunch,
  type ExecutablePort,
  type RuntimeSpec,
  type RuntimeTrust,
  type SessionPorts,
  type SessionSpec,
} from "../core/index.js";

/**
 * The one way this layer starts an Agent.
 *
 * Apart from everything that wants to start one, so there is a single place to
 * read when asking what a spawn is gated on — and a single place a new caller
 * has to go through (ADR-0007).
 */

export interface TrustedSessionRequest {
  spec: RuntimeSpec;
  executable: ExecutablePort;
  /** What the user approved for this Runtime, if anything. */
  trust?: RuntimeTrust;
  /** `vscode.workspace.isTrusted`. */
  workspaceTrusted: boolean;
  /** Absolute session working directory. */
  cwd: string;
  /** Reattach to this Session (`session/load`) instead of creating a new one.
   *  The `cwd` above must be the one it was created with — an Agent may refuse
   *  a different one, and a folder nobody opened is a folder nobody agreed to
   *  run an Agent in (ADR-0008). */
  loadSessionId?: string;
  additionalDirectories?: string[];
  /** Resolves the values behind this Runtime's `secretEnvironment` references.
   *  A function, and called only once both gates have passed: reading a
   *  credential out of SecretStorage for a launch that is about to be refused
   *  puts it in this process for no reason at all (ADR-0007). */
  secretEnvironment?: () => Promise<Record<string, string>>;
  requestedModel?: string;
  requestedEffort?: string;
  onUpdate: (notification: acp.SessionNotification) => void;
  ports: SessionPorts;
}

/**
 * The folders a window has that a Session may be run in.
 *
 * Only `file` ones. A workspace folder can be served by a virtual filesystem —
 * a remote, an archive, a source-control view — and its `fsPath` is a path that
 * exists nowhere; handed to a spawn as a `cwd` it is a process that fails to
 * start, or worse, one that starts somewhere else entirely.
 */
export function fileRoots(
  folders: readonly { readonly uri: { readonly scheme: string; readonly fsPath: string } }[],
): string[] {
  return folders.filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
}

/**
 * Where one Session runs: its `cwd`, and the other roots it may be told about.
 *
 * A reattached Session is re-created in the folder it was created in —
 * `session/load` re-sends the `cwd` and an Agent may refuse a different one —
 * and only while this window still holds that folder. A tree is drawn from a
 * file and then sat on, so the folder may have been closed since; running an
 * Agent in one nobody opened is the thing to refuse (ADR-0007, ADR-0008).
 */
export function sessionFolders(
  runtimeId: string,
  roots: readonly string[],
  load?: { workspace: string },
): { cwd: string; additionalDirectories: string[] } {
  const first = roots[0];
  if (first === undefined) {
    throw new Error("open a folder before starting a session — ACP requires an absolute cwd");
  }
  if (load && !roots.includes(load.workspace)) {
    throw new Error(
      `runtime ${runtimeId}: that session ran in a folder this window does not have open`,
    );
  }
  const cwd = load?.workspace ?? first;
  return { cwd, additionalDirectories: roots.filter((root) => root !== cwd) };
}

/**
 * The only way this layer starts an Agent.
 *
 * Two gates, in this order: the window's trust, then the Runtime's. Workspace
 * trust comes first because a repository nobody vouched for must not even get to
 * name a Runtime, and Runtime Trust is re-derived from a fresh resolution rather
 * than read from a record — an executable that moved or changed is a different
 * identity, and fails closed here (ADR-0007).
 */
export interface TrustedSession {
  session: ConductorSession;
  /** The credential values this Session's Agent was started with, handed back
   *  rather than captured by the caller: they are what everything the Agent
   *  words is redacted against, on a row and in a record alike, and a caller
   *  that has to remember to keep them is a caller that will forget (ADR-0010). */
  secrets: string[];
}

export async function openTrustedSession(request: TrustedSessionRequest): Promise<TrustedSession> {
  if (!request.workspaceTrusted) {
    throw new Error(
      `runtime ${request.spec.id}: this workspace is not trusted, and agents execute code` +
        " — trust the workspace before starting a session",
    );
  }
  const runtime = await resolveRuntime(request.spec, {
    executable: request.executable,
    ...(request.trust ? { trust: request.trust } : {}),
    workspace: request.cwd,
  });
  // The Runtime's gate, before anything is read or started: `trustedLaunch`
  // throws for an identity the user has not approved.
  const launch = trustedLaunch(runtime);
  const secretEnvironment = await request.secretEnvironment?.();
  const spec: SessionSpec = {
    runtimeId: runtime.id,
    launch,
    cwd: request.cwd,
    // Taken from the resolved Runtime, so the policy channel is the one the
    // fingerprint covers rather than one a caller composed (ADR-0004).
    ...(runtime.sessionMeta ? { sessionMeta: runtime.sessionMeta } : {}),
    ...(request.additionalDirectories?.length
      ? { additionalDirectories: request.additionalDirectories }
      : {}),
    ...(secretEnvironment ? { secretEnvironment } : {}),
    ...(request.requestedModel ? { requestedModel: request.requestedModel } : {}),
    ...(request.requestedEffort ? { requestedEffort: request.requestedEffort } : {}),
    onUpdate: request.onUpdate,
  };
  // Both go through this one gate: reattaching starts an Agent process exactly
  // as creating a Session does, so it is trusted on exactly the same terms.
  const session = await (request.loadSessionId === undefined
    ? ConductorSession.open(spec, request.ports)
    : ConductorSession.load({ ...spec, sessionId: request.loadSessionId }, request.ports));
  return { session, secrets: Object.values(secretEnvironment ?? {}) };
}
