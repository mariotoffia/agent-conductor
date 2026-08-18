import type { SessionPolicy } from "./types.js";

/** Claude (claude-agent-acp): per-session policy via `session/new` `_meta`.
 *  The delegation tool is `Agent` — the old name `Task` silently no-ops. */
export function claudeSessionMeta(policy: SessionPolicy): Record<string, unknown> | undefined {
  if (!policy.suppressBuiltInSubagents) return undefined;
  return {
    claudeCode: {
      options: {
        disallowedTools: ["Agent", "SendMessage", "ListAgents"],
        agents: {},
      },
    },
  };
}

/** Codex (codex-acp): config is process-scoped via the CODEX_CONFIG env JSON.
 *  `features.multi_agent_v2` is checked BEFORE `agents.enabled` — set both. */
export function codexEnv(policy: SessionPolicy): Record<string, string> {
  if (!policy.suppressBuiltInSubagents) return {};
  return {
    CODEX_CONFIG: JSON.stringify({
      agents: { enabled: false },
      features: { multi_agent_v2: false, collab: false },
    }),
  };
}

/** Gemini: suppression lives in workspace `.gemini/settings.json` (consent-gated).
 *  Returns the keys to MERGE into the existing file — never clobber it. */
export function geminiWorkspaceSettings(policy: SessionPolicy): Record<string, unknown> | undefined {
  if (!policy.suppressBuiltInSubagents) return undefined;
  return {
    experimental: { enableAgents: false },
    tools: { exclude: ["invoke_agent"] },
  };
}

/** Copilot: startup flags only; applies to every session of the process.
 *  Tool names are unverified upstream — confirm against the live tool list. */
export function copilotExtraArgs(policy: SessionPolicy): string[] {
  if (!policy.suppressBuiltInSubagents) return [];
  return ["--excluded-tools", "task,read_agent"];
}
