import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { customRuntimes } from "./customRuntimes.js";
import { isPackageRunner } from "./executables.js";
import {
  parseSuppressionPlan,
  stableJson,
  suppressionPlan,
  verifySuppression,
  type SuppliedSuppression,
  type SuppressionPlan,
} from "./policy.js";
import {
  isExactVersion,
  isNewerVersion,
  registryAdapterVersion,
  type RegistrySnapshot,
} from "./registryCache.js";
import type {
  ExecutablePort,
  LaunchSpec,
  ResolvedRuntime,
  RuntimeSpec,
  RuntimeTrust,
  SessionPolicy,
} from "./types.js";

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
function baseRuntimes(): BaseRuntime[] {
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
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [] },
    },
    {
      id: "copilot",
      displayName: "GitHub Copilot CLI",
      launch: { command: "copilot", args: ["--acp", "--stdio"], env: {} },
      registryId: "github-copilot-cli",
      loginCommand: "copilot",
      quirks: { processScopedConfig: true, effortReadback: false, slashCommandAllowlist: ["context", "plan", "review"] },
    },
    {
      id: "dsh",
      // The vendor calls dsh a developer preview with breaking changes ahead,
      // and no adapter has yet completed an ACP handshake against it — so the
      // name says both, on every surface that draws it, since the wizard would
      // otherwise offer an install that leads nowhere. Its own
      // @deepseek-ai/dsh-acp ships no executable yet; the pin is the third-party
      // ACP server, not in the ACP Registry, and moves only by catalog change.
      // No suppression recipe is documented, so dsh carries no plan and cannot
      // host the Shim (ADR-0008).
      displayName: "DeepSeek Harness (preview — no adapter has connected yet)",
      launch: { command: "dsh-acp", args: [], env: {} },
      adapter: { package: "@openma/deepseek-harness-acp", version: "0.4.24", bin: "dsh-acp" },
      loginCommand: "dsh-acp login",
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [] },
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
function withPolicy(
  base: BaseRuntime,
  policy: SessionPolicy,
  plan?: SuppressionPlan,
  ours = true,
): RuntimeSpec {
  // Only a Runtime with a recipe for hiding subscription authentication carries
  // that half, so a setting about one CLI does not change the identity of every
  // other one.
  const effective: SessionPolicy = {
    suppressBuiltInSubagents: policy.suppressBuiltInSubagents,
    ...(base.subscriptionAuth
      ? { hideSubscriptionAuth: ours && policy.hideSubscriptionAuth !== false }
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

/** Everything that decides what an approved Session actually runs. */
export interface LaunchIdentity {
  runtimeId: string;
  launch: LaunchSpec;
  /** Suppression reaches an Agent through argv, env, and the `session/new` `_meta`
   *  channel. Only the first two show up in `launch`, so the policy travels here as
   *  well — otherwise switching suppression off would inherit its approval. It is
   *  folded in whole, so a policy that grows a field grows the identity with it. */
  policy: SessionPolicy;
  /** The plan those channels carry. A built-in's plan follows from its policy, but
   *  a user-supplied one is free-form data, so approving the policy would approve
   *  an unseen `_meta` payload and an unseen workspace edit along with it. */
  suppression?: SuppressionPlan;
  /** Which variables are filled from SecretStorage and from which keys. Names
   *  only: the values arrive per Session and never reach anything hashed,
   *  logged or persisted (ADR-0010). */
  secretEnvironment?: Record<string, string>;
  /** Digest of the artifact, when the host computed one. */
  digest?: string;
}

/**
 * The identity a user approves and the Client re-verifies before every spawn.
 *
 * Covers the canonical artifact and the effective launch specification: command,
 * arguments, catalog policy environment, and per-session policy. Values resolved
 * from SecretStorage are deliberately absent — they arrive per Session and must
 * never reach something logged or persisted (ADR-0010).
 */
export function launchFingerprint(identity: LaunchIdentity): string {
  const { runtimeId, launch, policy, suppression, secretEnvironment, digest } = identity;
  const material = stableJson([
    runtimeId,
    launch.command,
    launch.args,
    launch.env,
    policy,
    suppression ?? null,
    digest ?? null,
    secretEnvironment ?? null,
  ]);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export interface ResolveRuntimeOptions {
  executable: ExecutablePort;
  /** What the user approved for this Runtime, if anything. */
  trust?: RuntimeTrust;
  /** Absolute root of the workspace this Runtime would run in. A plan that
   *  suppresses through a workspace file only holds where that file was written,
   *  so evidence from another workspace does not apply here. */
  workspace?: string;
}

/**
 * Turns a catalog entry into something launchable, or refuses it. Here rather
 * than at spawn time, so the wizard shows the same executable a Session would
 * run and a command that cannot be named with certainty — relative to an unknown
 * directory, absent from PATH, a package runner — is refused before a process
 * exists.
 */
export async function resolveRuntime(
  spec: RuntimeSpec,
  options: ResolveRuntimeOptions,
): Promise<ResolvedRuntime> {
  const refuse = (why: string): Error => new Error(`runtime ${spec.id}: ${why}`);
  if (spec.unavailable) throw refuse(spec.unavailable);

  const { args, env } = spec.launch;
  // Trailing space is invisible in settings and meaningful to no filesystem.
  const command = spec.launch.command.trim();
  if (!command) throw refuse("launch command is empty");
  if (!isAbsolute(command) && /[/\\]/.test(command)) {
    throw refuse(`launch command must be absolute or a bare name, got "${command}"`);
  }
  if (isPackageRunner(command)) {
    throw refuse(`"${command}" fetches and runs code — install the agent, then launch it directly`);
  }

  const found = await options.executable.resolve(command);
  if (!found) {
    const hint = spec.adapter
      ? ` — install ${spec.adapter.package}@${spec.adapter.version} from the connection wizard`
      : "";
    throw refuse(`launch command "${command}" was not found${hint}`);
  }
  if (!isAbsolute(found.path)) {
    throw refuse(`launch command resolved to a relative path "${found.path}"`);
  }
  // A bare name can be a symlink onto a package runner; judge what actually runs.
  if (isPackageRunner(found.path)) {
    throw refuse(`"${command}" resolves to ${found.path}, which fetches and runs code`);
  }

  const launch: LaunchSpec = { command: found.path, args: [...args], env: { ...env } };
  // A blank digest distinguishes no two artifacts, so it is not one. The trimmed
  // value is what gets hashed, so a host that later stops emitting a stray newline
  // does not invalidate every trust record it ever stored.
  const digest = found.digest?.trim() || undefined;
  const fingerprint = launchFingerprint({
    runtimeId: spec.id,
    launch,
    policy: spec.policy,
    suppression: spec.suppression,
    ...(spec.secretEnvironment ? { secretEnvironment: spec.secretEnvironment } : {}),
    digest,
  });
  const trusted = options.trust?.fingerprint === fingerprint;

  return {
    id: spec.id,
    displayName: spec.displayName,
    launch,
    quirks: spec.quirks,
    policy: spec.policy,
    // Taken from the plan the fingerprint covers, so no later caller can spawn
    // under a policy channel nobody approved.
    sessionMeta: spec.suppression?.sessionMeta,
    custom: spec.custom === true,
    ...(spec.secretEnvironment ? { secretEnvironment: { ...spec.secretEnvironment } } : {}),
    ...(spec.subscriptionAuth ? { subscriptionAuth: spec.subscriptionAuth } : {}),
    fingerprint,
    trusted,
    artifactVerified: digest !== undefined,
    capabilities: {
      readback: spec.quirks.effortReadback,
      // Evidence is recorded against one fingerprint, so it lapses with the trust
      // that carried it — a re-resolved Runtime cannot inherit it. The verdict is
      // recomputed here rather than read: nothing may record that a plan was
      // verified, only what was seen while verifying it (ADR-0008).
      suppression: trusted && suppressionHoldsHere(spec, options),
      budget: trusted && options.trust?.budget === true,
    },
  };
}

/** Whether verified suppression still describes this workspace. Most plans travel
 *  with the process, so where it runs changes nothing. One that writes a workspace
 *  file does not: it was written where the plan was verified and the next
 *  workspace never received it (ADR-0008). */
function suppressionHoldsHere(spec: RuntimeSpec, options: ResolveRuntimeOptions): boolean {
  const record = options.trust?.suppression;
  // No plan means nothing was ever verifiable, whatever a settings file recorded.
  if (!spec.suppression || !record) return false;
  if (!verifySuppression(spec.suppression, record).verified) return false;
  if (!spec.suppression.workspaceSettings) return true;
  if (options.workspace === undefined || !isAbsolute(options.workspace)) return false;
  return record.workspace === options.workspace;
}

/**
 * The gate every spawn passes: it yields a launch specification only while the
 * resolved identity is still the one the user approved. Untrusted means they never
 * approved this identity, or approved a different one — either way the Client
 * fails closed rather than starting the process (ADR-0007).
 */
export function trustedLaunch(runtime: ResolvedRuntime): LaunchSpec {
  if (!runtime.trusted) {
    throw new Error(
      `runtime ${runtime.id}: launch identity ${runtime.fingerprint} is not trusted —` +
        " approve it in the connection wizard before starting a session",
    );
  }
  return runtime.launch;
}

/** One entry of `agentConductor.runtimes`; an id with no built-in is custom. */
export interface RuntimeOverride {
  enabled?: boolean;
  command?: string;
  args?: string[];
  /** Overrides the window's suppression policy for this Runtime alone. */
  suppressBuiltInSubagents?: boolean;
  /** A Suppression Plan for a Runtime the catalog knows no recipe for — a custom
   *  agent, or a built-in whose launch was replaced. Supplying one makes the
   *  Runtime eligible to be verified; it does not make it verified (ADR-0008). */
  suppression?: SuppliedSuppression;
  /** Environment variable name to SecretStorage key. Names only; the values are
   *  resolved per Session by the UI adapter and never come through here. */
  secretEnvironment?: Record<string, string>;
}

export interface CatalogOptions {
  policy: SessionPolicy;
  /** `agentConductor.runtimes`, keyed by Runtime id. */
  overrides?: Record<string, RuntimeOverride>;
  /** Validated Registry snapshot, when one has been cached. */
  registry?: RegistrySnapshot;
  /** `agentConductor.registry.pin`, keyed by Registry id — a Runtime id is
   *  accepted too, since that is what the user sees everywhere else. */
  pins?: Record<string, string>;
}

/** Adapter version to install: a pin, then the Registry, then the built-in
 *  default — so a machine that never reached the network still has one. */
function pinnedAdapter(spec: RuntimeSpec, options: CatalogOptions): RuntimeSpec {
  if (!spec.adapter || !spec.registryId) return spec;
  const pin = options.pins?.[spec.registryId] ?? options.pins?.[spec.id];
  if (pin !== undefined && !isExactVersion(pin)) {
    // Only this Runtime stops working: one typo must not empty the whole catalog.
    // The Adapter goes with it, so no install can quietly substitute the default.
    return { ...spec, adapter: undefined, unavailable: `registry pin must name an exact version, got "${pin}"` };
  }
  const published = registryAdapterVersion(options.registry, spec.registryId, spec.adapter.package);
  // The Registry may move an Adapter forward, never backward: serving an older
  // artifact is how a compromised or rolled-back feed downgrades a machine. A user
  // who genuinely wants the older release pins it and says so.
  const version =
    pin ?? (published && isNewerVersion(published, spec.adapter.version) ? published : spec.adapter.version);
  return { ...spec, adapter: { ...spec.adapter, version } };
}

/**
 * Applies one settings override. A Runtime whose launch the user replaced is no
 * longer the catalog's: it is marked custom and renamed, because the identity at
 * the trust prompt is the user's only defence against approving something under
 * a familiar name, and its Adapter stops applying. The Suppression Plan is
 * decided by `planFor`, which withholds the recipe from exactly these entries.
 */
function overridden(spec: BaseRuntime, override: RuntimeOverride | undefined, replacedLaunch: boolean): BaseRuntime {
  const { command, args } = override ?? {};
  if (command === undefined && args === undefined) return spec;
  // Settings are hand-editable JSON, so this is a trust boundary rather than a
  // type guarantee. Refuse the one Runtime instead of throwing the catalog away.
  if (command !== undefined && typeof command !== "string") {
    return { ...spec, custom: true, unavailable: "launch command must be a string" };
  }
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
    return { ...spec, custom: true, unavailable: "launch arguments must be a list of strings" };
  }
  return {
    ...spec,
    // The suffix warns that a familiar catalog name no longer describes what runs,
    // so it belongs on a built-in only — a user-defined Runtime never claimed one.
    // Renamed and marked custom only where the launch genuinely differs: an
    // override that repeats what the catalog already says replaces nothing.
    ...(spec.custom || !replacedLaunch ? {} : { displayName: `${spec.displayName} (custom launch)` }),
    custom: spec.custom === true || replacedLaunch,
    launch: {
      ...spec.launch,
      // A blank command is kept, not ignored: it resolves to a refusal that names
      // the problem, where falling back to the built-in would hide it.
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args: [...args] }),
    },
    // The Adapter describes the catalog's program, not whatever replaced it; the
    // authentication recipe stays, so the approval can say the switch exists.
    ...(replacedLaunch ? { adapter: undefined } : {}),
  };
}

/**
 * Every Runtime the user could start: the built-ins at their pinned Adapter
 * versions, their settings overrides, and any custom Runtime, with the disabled
 * ones removed. Composition only — nothing here touches PATH or spawns anything;
 * `resolveRuntime` decides whether an entry can actually launch.
 */
export function runtimeCatalog(options: CatalogOptions): RuntimeSpec[] {
  const overrides = options.overrides ?? {};
  /** Whether an override actually replaces the launch the catalog describes. The
   *  presence of a `command` or `args` key is not the question: `args: []` on a
   *  Runtime whose catalog arguments are already empty replaces nothing, and
   *  calling it a replacement would hand a settings file the one route by which a
   *  supplied plan may stand in for a built-in recipe. Malformed counts as
   *  replaced — the entry is refused anyway, and no plan may survive on it. */
  const replaced = (base: BaseRuntime, override?: RuntimeOverride): boolean => {
    const { command, args } = override ?? {};
    if (command !== undefined && (typeof command !== "string" || command.trim() !== base.launch.command)) {
      return true;
    }
    if (args === undefined) return false;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return true;
    return args.length !== base.launch.args.length || args.some((arg, at) => arg !== base.launch.args[at]);
  };

  const policyFor = (
    base: BaseRuntime,
    override: RuntimeOverride | undefined,
    supplied?: SuppressionPlan,
  ): SessionPolicy => {
    // A replaced launch takes the built-in Suppression Plan with it — every channel
    // a plan uses comes from the catalog entry being replaced: argv, the
    // environment, and the `_meta` payload. Asking for suppression cannot bring
    // back a plan that is gone, so such an entry suppresses nothing until the user
    // supplies a plan for their own launch (ADR-0008).
    if (replaced(base, override) && !supplied) {
      return {
        suppressBuiltInSubagents: false,
        ...(options.policy.hideSubscriptionAuth === undefined
          ? {}
          : { hideSubscriptionAuth: options.policy.hideSubscriptionAuth }),
      };
    }
    return {
      suppressBuiltInSubagents:
        override?.suppressBuiltInSubagents ?? options.policy.suppressBuiltInSubagents,
      ...(options.policy.hideSubscriptionAuth === undefined
        ? {}
        : { hideSubscriptionAuth: options.policy.hideSubscriptionAuth }),
    };
  };

  /** The plan one entry ends up under: the catalog's recipe where there is one,
   *  what the user supplied where there is not, and nothing at all once the launch
   *  the recipe described is gone. */
  const planFor = (
    base: BaseRuntime,
    policy: SessionPolicy,
    override: RuntimeOverride | undefined,
    supplied?: SuppressionPlan,
  ): SuppressionPlan | undefined => {
    if (!policy.suppressBuiltInSubagents) return undefined;
    if (replaced(base, override)) return supplied;
    return suppressionPlan(base.id, policy) ?? supplied;
  };

  /** A supplied plan is for a Runtime the catalog knows no recipe for. Letting one
   *  displace a built-in recipe would let a settings file swap a working plan for
   *  a plan-shaped nothing that names tools the Agent never had, and pass
   *  verification with built-in delegation still live (ADR-0008). */
  const displacesBuiltIn = (base: BaseRuntime, override: RuntimeOverride | undefined): boolean =>
    override?.suppression !== undefined && !replaced(base, override) && builtInIds.has(base.id);

  const builtInIds = new Set(baseRuntimes().map((base) => base.id));
  return [...baseRuntimes(), ...customRuntimes(overrides, builtInIds)]
    .filter((base) => overrides[base.id]?.enabled !== false)
    .map((base) => {
      const override = overrides[base.id];
      const supplied = displacesBuiltIn(base, override)
        ? { error: `${base.id} has a built-in suppression plan; replace its launch to supply one` }
        : parseSuppressionPlan(override?.suppression);
      const policy = policyFor(base, override, supplied.plan);
      // Override first: a replaced launch drops the Adapter, and a pin for an
      // Adapter that is no longer used must not go on disabling the Runtime.
      const replacedLaunch = replaced(base, override);
      const spec = withPolicy(
        overridden(base, override, replacedLaunch),
        policy,
        planFor(base, policy, override, supplied.plan),
        !replacedLaunch,
      );
      // Carried onto the Runtime so it reaches the fingerprint and the approval
      // prompt: it decides what the process is started with.
      if (override?.secretEnvironment) spec.secretEnvironment = { ...override.secretEnvironment };
      return pinnedAdapter(supplied.error ? { ...spec, unavailable: supplied.error } : spec, options);
    });
}
