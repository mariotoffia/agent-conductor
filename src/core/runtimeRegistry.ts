import { claudeSessionMeta, codexEnv, copilotExtraArgs } from "./policy.js";
import type { RuntimeSpec, SessionPolicy } from "./types.js";

/** Built-in runtime catalog. Launch specs may be overridden by user settings
 *  and refreshed from the ACP agent registry; never hardcode models beyond
 *  the fallback catalog (ADR-0005). */
export function builtinRuntimes(policy: SessionPolicy): RuntimeSpec[] {
  return [
    {
      id: "claude",
      displayName: "Claude Code",
      launch: { command: "npx", args: ["@agentclientprotocol/claude-agent-acp"], env: {} },
      loginCommand: "claude /login",
      detection: { binaries: ["claude"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: false, effortReadback: true, slashCommandAllowlist: ["compact", "init", "review", "plan"] },
      sessionMeta: claudeSessionMeta,
    },
    {
      id: "codex",
      displayName: "Codex",
      launch: { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], env: codexEnv(policy) },
      loginCommand: "codex login",
      detection: { binaries: ["codex"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: true, effortReadback: true, slashCommandAllowlist: ["review", "plan"] },
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      launch: { command: "gemini", args: ["--acp"], env: {} },
      loginCommand: "gemini",
      detection: { binaries: ["gemini"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [] },
    },
    {
      id: "copilot",
      displayName: "GitHub Copilot CLI",
      launch: { command: "copilot", args: ["--acp", "--stdio", ...copilotExtraArgs(policy)], env: {} },
      loginCommand: "copilot",
      detection: { binaries: ["copilot"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: true, effortReadback: false, slashCommandAllowlist: ["context", "plan", "review"] },
    },
  ];
}
