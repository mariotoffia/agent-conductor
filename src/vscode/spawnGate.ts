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
  additionalDirectories?: string[];
  secretEnvironment?: Record<string, string>;
  requestedModel?: string;
  requestedEffort?: string;
  onUpdate: (notification: acp.SessionNotification) => void;
  ports: SessionPorts;
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
export async function openTrustedSession(request: TrustedSessionRequest): Promise<ConductorSession> {
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
  const spec: SessionSpec = {
    runtimeId: runtime.id,
    launch: trustedLaunch(runtime),
    cwd: request.cwd,
    // Taken from the resolved Runtime, so the policy channel is the one the
    // fingerprint covers rather than one a caller composed (ADR-0004).
    ...(runtime.sessionMeta ? { sessionMeta: runtime.sessionMeta } : {}),
    ...(request.additionalDirectories?.length
      ? { additionalDirectories: request.additionalDirectories }
      : {}),
    ...(request.secretEnvironment ? { secretEnvironment: request.secretEnvironment } : {}),
    ...(request.requestedModel ? { requestedModel: request.requestedModel } : {}),
    ...(request.requestedEffort ? { requestedEffort: request.requestedEffort } : {}),
    onUpdate: request.onUpdate,
  };
  return ConductorSession.open(spec, request.ports);
}
