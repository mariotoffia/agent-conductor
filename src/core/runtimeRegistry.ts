import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { claudeSessionMeta, codexEnv, copilotExtraArgs } from "./policy.js";
import {
  isExactVersion,
  isNewerVersion,
  registryAdapterVersion,
  type RegistrySnapshot,
} from "./registryCache.js";
import type {
  AdapterPackage,
  ExecutablePort,
  LaunchSpec,
  ResolvedRuntime,
  RuntimeSpec,
  RuntimeTrust,
  SessionPolicy,
} from "./types.js";

/**
 * Built-in Runtime catalog. Launch commands name an installed executable, never a
 * package runner: an Adapter is installed once at an exact version, then launched
 * like any other binary (ADR-0007). Settings may override every field, the Registry
 * refreshes Adapter versions, and models stay out of here beyond the fallback
 * catalog (ADR-0005).
 */
export function builtinRuntimes(policy: SessionPolicy): RuntimeSpec[] {
  return [
    {
      id: "claude",
      policy,
      displayName: "Claude Code",
      launch: { command: "claude-agent-acp", args: [], env: {} },
      registryId: "claude-acp",
      adapter: {
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.70.0",
        bin: "claude-agent-acp",
      },
      loginCommand: "claude /login",
      detection: { binaries: ["claude"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: false, effortReadback: true, slashCommandAllowlist: ["compact", "init", "review", "plan"] },
      sessionMeta: claudeSessionMeta,
    },
    {
      id: "codex",
      policy,
      displayName: "Codex",
      launch: { command: "codex-acp", args: [], env: codexEnv(policy) },
      registryId: "codex-acp",
      adapter: { package: "@agentclientprotocol/codex-acp", version: "1.4.0", bin: "codex-acp" },
      loginCommand: "codex login",
      detection: { binaries: ["codex"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: true, effortReadback: true, slashCommandAllowlist: ["review", "plan"] },
    },
    {
      id: "gemini",
      policy,
      displayName: "Gemini CLI",
      launch: { command: "gemini", args: ["--acp"], env: {} },
      registryId: "gemini",
      loginCommand: "gemini",
      detection: { binaries: ["gemini"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [] },
    },
    {
      id: "copilot",
      policy,
      displayName: "GitHub Copilot CLI",
      launch: { command: "copilot", args: ["--acp", "--stdio", ...copilotExtraArgs(policy)], env: {} },
      registryId: "github-copilot-cli",
      loginCommand: "copilot",
      detection: { binaries: ["copilot"], versionArgs: ["--version"] },
      quirks: { processScopedConfig: true, effortReadback: false, slashCommandAllowlist: ["context", "plan", "review"] },
    },
  ];
}

/**
 * Commands whose whole purpose is to fetch code and run or install it. Naming one
 * as a launch command is a mistake rather than a choice — what it downloads is
 * decided at launch time, so no fingerprint the user approved can describe it
 * (ADR-0007), and installing an Adapter is a separate exact-version wizard action.
 *
 * General-purpose runtimes (`node`, `bun`, `deno`) are deliberately absent, because
 * refusing them would refuse every locally installed agent that ships as a script.
 * They can reach the network too (`deno run https://…`), which is why the guarantee
 * does not rest here: the whole argv is fingerprinted, so a launch that fetches
 * through one of them is one the user approved by sight (ADR-0007).
 */
const PACKAGE_RUNNERS = new Set([
  "npx", "pnpx", "bunx", "uvx", "pipx",
  "npm", "pnpm", "yarn", "corepack", "uv", "pip", "pip3",
]);

/** Extensions Windows appends to an executable, possibly stacked. */
const WINDOWS_EXECUTABLE_SUFFIX = /(?:\.(?:exe|cmd|bat|ps1|com))+$/;

/** The name the operating system would actually look up: Windows discards
 *  trailing dots and spaces, and an extension says nothing about what runs. */
function commandName(command: string): string {
  const separator = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  return command
    .slice(separator + 1)
    .toLowerCase()
    .replace(/[.\s]+$/, "")
    .replace(WINDOWS_EXECUTABLE_SUFFIX, "");
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
  const { runtimeId, launch, policy, digest } = identity;
  // Codepoint order, so the same identity hashes the same on every machine.
  const byKey = (left: [string, unknown], right: [string, unknown]): number =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  const material = JSON.stringify([
    runtimeId,
    launch.command,
    launch.args,
    Object.entries(launch.env).sort(byKey),
    Object.entries(policy).sort(byKey),
    digest ?? null,
  ]);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export interface ResolveRuntimeOptions {
  executable: ExecutablePort;
  /** What the user approved for this Runtime, if anything. */
  trust?: RuntimeTrust;
}

/**
 * Turns a catalog entry into something launchable, or refuses it.
 *
 * Resolution happens here rather than at spawn time so the wizard shows the user
 * the same executable a Session would run, and so a command that cannot be named
 * with certainty — relative to an unknown directory, absent from PATH, or a
 * package runner — is rejected before any process exists.
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
  if (PACKAGE_RUNNERS.has(commandName(command))) {
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
  if (PACKAGE_RUNNERS.has(commandName(found.path))) {
    throw refuse(`"${command}" resolves to ${found.path}, which fetches and runs code`);
  }

  const launch: LaunchSpec = { command: found.path, args: [...args], env: { ...env } };
  // A blank digest distinguishes no two artifacts, so it is not one. The trimmed
  // value is what gets hashed, so a host that later stops emitting a stray newline
  // does not invalidate every trust record it ever stored.
  const digest = found.digest?.trim() || undefined;
  const fingerprint = launchFingerprint({ runtimeId: spec.id, launch, policy: spec.policy, digest });
  const trusted = options.trust?.fingerprint === fingerprint;

  return {
    id: spec.id,
    displayName: spec.displayName,
    launch,
    quirks: spec.quirks,
    policy: spec.policy,
    // Applied here, against the policy the fingerprint covers: leaving it a
    // function would let a later caller spawn under a policy nobody approved.
    sessionMeta: spec.sessionMeta?.(spec.policy),
    custom: spec.custom === true,
    fingerprint,
    trusted,
    artifactVerified: digest !== undefined,
    capabilities: {
      readback: spec.quirks.effortReadback,
      // Evidence is recorded against one fingerprint, so it lapses with the trust
      // that carried it — a re-resolved Runtime cannot inherit it (ADR-0008).
      suppression: trusted && options.trust?.suppression === true,
      budget: trusted && options.trust?.budget === true,
    },
  };
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

/** One entry of `agentConductor.runtimes`. An id with no built-in is a custom Runtime. */
export interface RuntimeOverride {
  enabled?: boolean;
  command?: string;
  args?: string[];
  /** Overrides the window's suppression policy for this Runtime alone. */
  suppressBuiltInSubagents?: boolean;
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

/** Adapter version to install: a pin first, then the Registry, then the built-in
 *  default — so a machine that has never reached the network still has one. */
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
 * Applies one settings override.
 *
 * A Runtime whose launch the user replaced is no longer the catalog's Runtime: it
 * is marked custom and renamed, because the identity shown at the trust prompt is
 * the user's only defence against approving something under a familiar name. Its
 * Adapter stops applying too, and for a replaced executable so does the `_meta`
 * builder. The rest of the Suppression Plan is already absent by then: the entry
 * was rebuilt under a policy that suppresses nothing.
 */
function overridden(spec: RuntimeSpec, override?: RuntimeOverride): RuntimeSpec {
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
    ...(spec.custom ? {} : { displayName: `${spec.displayName} (custom launch)` }),
    custom: true,
    launch: {
      ...spec.launch,
      // A blank command is kept, not ignored: it resolves to a refusal that names
      // the problem, where falling back to the built-in would hide it.
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args: [...args] }),
    },
    ...(command === undefined ? {} : { adapter: undefined, sessionMeta: undefined }),
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
  const policyFor = (id: string): SessionPolicy => {
    const override = overrides[id];
    // A replaced launch takes the Suppression Plan with it — every channel a plan
    // uses comes from the catalog entry being replaced: argv, the environment, and
    // the `_meta` builder. Asking for suppression cannot bring back a plan that is
    // gone, so the entry stops claiming one and this branch comes first. Such a
    // Runtime earns the capability back only by verifying a plan for its own
    // launch identity (ADR-0008).
    if (override?.command !== undefined || override?.args !== undefined) {
      return { suppressBuiltInSubagents: false };
    }
    if (override?.suppressBuiltInSubagents !== undefined) {
      return { suppressBuiltInSubagents: override.suppressBuiltInSubagents };
    }
    return { suppressBuiltInSubagents: options.policy.suppressBuiltInSubagents };
  };
  // Each built-in is built under its own effective policy: suppression is settable
  // per Runtime, and it reaches the Agent through that entry's argv, env and meta.
  const builtIns = builtinRuntimes(options.policy).map(
    (spec) => builtinRuntimes(policyFor(spec.id)).find((entry) => entry.id === spec.id) ?? spec,
  );
  const builtInIds = new Set(builtIns.map((spec) => spec.id));
  const custom: RuntimeSpec[] = Object.entries(overrides)
    .filter(([id]) => !builtInIds.has(id))
    .map(([id, override]) => ({
      id,
      displayName: id,
      // An entry with no command stays listed and fails when resolved, which
      // names the problem far better than quietly vanishing from the picker.
      launch: { command: override.command ?? "", args: [], env: {} },
      detection: { binaries: override.command ? [override.command] : [], versionArgs: ["--version"] },
      custom: true,
      policy: policyFor(id),
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [] },
    }));

  return [...builtIns, ...custom]
    .filter((spec) => overrides[spec.id]?.enabled !== false)
    // Override first: a replaced launch drops the Adapter, and a pin for an Adapter
    // that is no longer used must not go on disabling the Runtime.
    .map((spec) => pinnedAdapter(overridden(spec, overrides[spec.id]), options));
}

/** An npm package name, optionally scoped. Checked because the name becomes an
 *  argument to a package manager: anything else could be a flag redirecting the
 *  install, or something a terminal would read as more than a name. */
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;

/**
 * Command the connection wizard runs — deliberately, with the user watching — to
 * install an Adapter at one exact version. It is the only place the extension
 * names a package manager, and no Session path calls it: starting a Session must
 * never install or fetch anything (ADR-0007).
 */
export function adapterInstallCommand(adapter: AdapterPackage): { command: string; args: string[] } {
  if (!PACKAGE_NAME.test(adapter.package)) {
    throw new Error(`adapter package name is not one: "${adapter.package}"`);
  }
  if (!isExactVersion(adapter.version)) {
    throw new Error(
      `adapter ${adapter.package}: installation needs an exact version, got "${adapter.version}"`,
    );
  }
  return { command: "npm", args: ["install", "--global", `${adapter.package}@${adapter.version}`] };
}
