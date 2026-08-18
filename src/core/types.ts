/** Reasoning-effort levels understood by the conductor. Agents may clamp —
 *  the effective value must always be read back (ADR-0005). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ModelHint {
  id: string;
  label: string;
  /** Effort levels this model accepts; undefined = model ignores effort. */
  efforts?: EffortLevel[];
}

export interface RuntimeQuirks {
  /** Model/effort/tool config can only be set at process start (codex, copilot). */
  processScopedConfig: boolean;
  /** Agent reports the effective model/effort so Read-back is possible. */
  effortReadback: boolean;
  /** Agent slash commands safe to surface (interactive TUI commands hang ACP). */
  slashCommandAllowlist: string[];
}

export interface SessionPolicy {
  suppressBuiltInSubagents: boolean;
}

export interface RuntimeSpec {
  id: string;
  displayName: string;
  launch: LaunchSpec;
  /** Command the wizard opens in a terminal when the agent reports auth is required. */
  loginCommand?: string;
  detection: { binaries: string[]; versionArgs: string[] };
  /** Fallback picker source when the agent exposes no configOptions. */
  modelCatalog?: ModelHint[];
  quirks: RuntimeQuirks;
  /** Builds the `_meta` object for `session/new` (per-session policy channel). */
  sessionMeta?: (policy: SessionPolicy) => Record<string, unknown> | undefined;
}
