import { suppressionPlan, type SuppressionPlan } from "./policy.js";
import type { RuntimeSpec, SessionPolicy } from "./types.js";

/**
 * The built-in Runtime catalog: which CLIs this Client knows how to launch.
 *
 * Its own module because it is the part that grows — a Runtime is added here
 * and nowhere else (`AGENTS.md`, "Adding a runtime") — while resolving one
 * against a machine, fingerprinting it and applying a user's overrides is a
 * fixed amount of code beside it in `runtimeRegistry.ts`.
 */

/** A catalog entry before any policy is applied. Policy is not optional on a
 *  Runtime, so the only way to have one entry and two policies is to keep the
 *  policy-free half apart. */
export type BaseRuntime = Omit<RuntimeSpec, "policy">;

/**
 * Built-in Runtime catalog. Launch commands name an installed executable, never a
 * package runner: an Adapter is installed once at an exact version, then launched
 * like any other binary (ADR-0007). Settings may override every field, the Registry
 * refreshes Adapter versions, and models stay out of here beyond the fallback
 * catalog (ADR-0005). Policy is applied on top by `withPolicy`, never baked in
 * here: suppression is settable per Runtime.
 */
export function baseRuntimes(): BaseRuntime[] {
  return [
    {
      id: "claude",
      displayName: "Claude Code",
      launch: { command: "claude-agent-acp", args: [], env: {} },
      registryId: "claude-acp",
      adapter: {
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.70.0",
        bin: "claude-agent-acp",
      },
      loginCommand: "claude /login",
      // ADR-0010: a third-party product must not route through Free, Pro or Max
      // credentials, and the adapter ships this switch for exactly that.
      subscriptionAuth: { hideArgs: ["--hide-claude-auth"] },
      quirks: { processScopedConfig: false, effortReadback: true, slashCommandAllowlist: ["compact", "init", "review", "plan"] },
    },
    {
      id: "codex",
      displayName: "Codex",
      launch: { command: "codex-acp", args: [], env: {} },
      registryId: "codex-acp",
      adapter: { package: "@agentclientprotocol/codex-acp", version: "1.4.0", bin: "codex-acp" },
      loginCommand: "codex login",
      quirks: { processScopedConfig: true, effortReadback: true, slashCommandAllowlist: ["review", "plan"] },
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      launch: { command: "gemini", args: ["--acp"], env: {} },
      registryId: "gemini",
      loginCommand: "gemini",
      install: ["brew install gemini-cli", "npm install -g @google/gemini-cli"],
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [] },
    },
    {
      id: "copilot",
      displayName: "GitHub Copilot CLI",
      launch: { command: "copilot", args: ["--acp", "--stdio"], env: {} },
      registryId: "github-copilot-cli",
      loginCommand: "copilot",
      install: ["brew install --cask copilot-cli", "npm install -g @github/copilot"],
      quirks: { processScopedConfig: true, effortReadback: false, slashCommandAllowlist: ["context", "plan", "review"] },
    },
    {
      id: "dsh",
      // A developer preview by the vendor's own word, so the name says so. The
      // launch is dsh's own launcher booting a profile that holds DeepSeek's
      // ACP plugin (walkthrough/install.md has the two commands that make the
      // profile). Not in the ACP Registry, so the pin moves by catalog change.
      // Its ACP rejects `mcpServers`, so it is never injected (ADR-0014), and
      // no launch flag sets its model, so `/model` says there is nothing to pick.
      displayName: "DeepSeek Harness (preview)",
      launch: { command: "dsh", args: ["--profile", "acp"], env: {} },
      adapter: { package: "@deepseek-ai/dsh", version: "0.1.1-rc.2", bin: "dsh" },
      loginCommand: "dsh web",
      // Installed, dsh still will not speak ACP: the plugin that does lives in a
      // profile, and a session that would not open is where that shows up.
      setup: [
        "dsh plugin --profile acp add @deepseek-ai/dsh-acp@0.1.1-rc.2",
        `printf -- "- insert:\\n    - id: acp\\n      name: '@deepseek-ai/dsh-acp'\\n" > ~/.dsh/profiles/acp/cordis.patch.yml`,
      ],
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [], refusesMcpServers: true },
    },
  ];
}

/**
 * Applies one Runtime's effective policy.
 *
 * A Suppression Plan reaches its Agent through three channels, and they are not
 * interchangeable: argv and the environment are launch material, so they land in
 * the launch specification the user sees, while the plan itself travels on the
 * entry — its presence is what makes the Runtime eligible for Shim injection,
 * and no recorded evidence substitutes for it (ADR-0008).
 *
 * `ours`: the launch is still the catalog's own, so what the catalog knows can
 * be applied to it. A program somebody else named keeps the recipe but not the
 * arguments, so the approval says the switch exists and is unused (ADR-0010).
 */
export function withPolicy(
  base: BaseRuntime,
  policy: SessionPolicy,
  plan?: SuppressionPlan,
  ours = true,
): RuntimeSpec {
  // Only a Runtime with a recipe for hiding subscription authentication carries
  // that half, so one CLI's setting leaves every other identity alone. Hidden
  // only when the user said so: the CLI's own login is the default (ADR-0013).
  const effective: SessionPolicy = {
    suppressBuiltInSubagents: policy.suppressBuiltInSubagents,
    ...(base.subscriptionAuth
      ? { hideSubscriptionAuth: ours && policy.hideSubscriptionAuth === true }
      : {}),
  };
  const authArgs = effective.hideSubscriptionAuth ? (base.subscriptionAuth?.hideArgs ?? []) : [];
  // Kept as the entry had them, before anything below adds to them.
  const baseArgs = [...base.launch.args];
  const args = [...baseArgs, ...authArgs, ...(plan?.args ?? [])];
  return {
    ...base,
    policy: effective,
    baseArgs,
    ...(plan ? { suppression: plan } : {}),
    launch: {
      ...base.launch,
      args,
      ...(plan ? { env: { ...base.launch.env, ...plan.env } } : {}),
    },
  };
}

/** The built-in catalog under one window-wide policy. */
export function builtinRuntimes(policy: SessionPolicy): RuntimeSpec[] {
  return baseRuntimes().map((base) => withPolicy(base, policy, suppressionPlan(base.id, policy)));
}
