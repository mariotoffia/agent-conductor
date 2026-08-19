import { isAbsolute } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { LaunchSpec } from "./types.js";

/**
 * What a Session is launched with, and the rules that description must satisfy
 * before anything is spawned. Kept apart from the Session's own behaviour: this
 * is all pure, so it can be checked without a process anywhere near it.
 */
export interface SessionSpec {
  /** Runtime identity, used in logs and failure messages. */
  runtimeId: string;
  /** Resolved absolute command, arguments, and catalog policy environment. */
  launch: LaunchSpec;
  /** Absolute session working directory. */
  cwd: string;
  /** Values resolved from SecretStorage by the UI adapter. Never logged. */
  secretEnvironment?: Record<string, string>;
  /** Extra absolute roots; sent only when the Agent advertises support. */
  additionalDirectories?: string[];
  /** Re-sent verbatim on load; always ordered by name before it goes out. */
  mcpServers?: acp.McpServer[];
  /** Per-session policy channel, e.g. a Suppression Plan (ADR-0004). */
  sessionMeta?: Record<string, unknown>;
  /**
   * Model and effort the user asked for, however they were asked for — a Preset,
   * or argv on a Runtime whose config is process-scoped. Read-back reports these
   * beside what the Agent says it actually runs; they never stand in for it.
   */
  requestedModel?: string;
  requestedEffort?: string;
  cancelGraceMs?: number;
  /** Deadline for each request made outside a Turn: the handshake, creating or
   *  loading the session, and setting a Config Option. */
  setupTimeoutMs?: number;
  /** Silence allowed within a Turn before it is ended; `0` disables the limit. */
  stallTimeoutMs?: number;
  clientVersion?: string;
  /** Every Update the Agent sends, including any whose `sessionId` is not ours. */
  onUpdate?: (notification: acp.SessionNotification) => void;
}

/** ACP requires absolute paths everywhere; reject before anything is spawned. */
export function validateSessionSpec(spec: SessionSpec): void {
  if (!isAbsolute(spec.cwd)) {
    throw new Error(`runtime ${spec.runtimeId}: session cwd must be absolute, got "${spec.cwd}"`);
  }
  for (const directory of spec.additionalDirectories ?? []) {
    if (!isAbsolute(directory)) {
      throw new Error(
        `runtime ${spec.runtimeId}: additional directory must be absolute, got "${directory}"`,
      );
    }
  }
  for (const server of spec.mcpServers ?? []) {
    if ("command" in server && !isAbsolute(server.command)) {
      throw new Error(
        `runtime ${spec.runtimeId}: mcp server "${server.name}" command must be absolute,` +
          ` got "${server.command}"`,
      );
    }
  }
}

/**
 * Orders MCP servers by name with a codepoint comparison — locale-aware sorting
 * would differ per machine, and agents fingerprint `(cwd, mcpServers)`.
 */
export function sortMcpServers(servers: acp.McpServer[] = []): acp.McpServer[] {
  return [...servers].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
