import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type * as vscode from "vscode";
import { z } from "zod";
import { EFFORT_LEVELS, message, redactSecrets, type StoragePort } from "../core/index.js";
import { CLIENT_OPERATIONS, type ClientOperation } from "./permissions.js";
import { DEFAULT_ENV_CHARS, MAX_ENV_CHARS } from "./terminals.js";

/**
 * State the host owns and the `vscode`-free core reaches through a port: the
 * `agentConductor.*` settings, the secret store behind their references, and
 * durable storage under the extension's global storage directory.
 *
 * Settings are user-editable, so nothing here throws: a key that does not
 * validate falls back to its manifest default and is reported as a problem, and
 * one malformed Runtime entry never takes the other Runtimes down with it. What
 * *is* refused is refused for a reason, and every refusal is fail-closed:
 * an automatic allow never survives a conflicting rejection, and a
 * `secretEnvironment` value that looks like a credential rather than a reference
 * is dropped without ever being echoed back (ADR-0010).
 */

/** Compile-time assertion: `Assert<false>` is a type error. */
type Assert<T extends true> = T;

/** One `agentConductor.*` value; `vscode.workspace.getConfiguration("agentConductor")`. */
export interface SettingsSource {
  /** Effective value for a dotted key, or `undefined` when unset. */
  get(key: string): unknown;
}

/** Secret store keyed by reference; `ExtensionContext.secrets`. */
export interface SecretsSource {
  get(key: string): PromiseLike<string | undefined>;
}

/**
 * The ports still describe the objects they stand for. They are structural so a
 * test can supply a plain object, and this is what keeps that freedom honest:
 * a signature that drifts from the VS Code API fails the build here rather than
 * at wiring time. `vscode` is imported as a type, so none of it survives to
 * runtime — which is what lets these services be tested under plain Node.
 */
export type PortsMatchVsCodeApi = [
  Assert<vscode.WorkspaceConfiguration extends SettingsSource ? true : false>,
  Assert<vscode.SecretStorage extends SecretsSource ? true : false>,
];

const effortLevel = z.enum(EFFORT_LEVELS);

/** Shell-safe environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Shape of a SecretStorage *reference*: short, opaque, printable. Settings are
 * synced and checked into repositories, so the value behind the name never
 * belongs here — only the key it is stored under (ADR-0010).
 */
const SECRET_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/**
 * Credential shapes recognisable on sight. A tripwire, not a guarantee: a
 * secret that happens to look like a key name cannot be told apart from one,
 * which is why nothing read out of `secretEnvironment` is ever printed — not the
 * value, and not the reference either. The check only catches the common
 * paste-into-settings mistake early and loudly.
 */
const CREDENTIAL_SHAPES = [
  /^sk-/i,
  /^[ps]k_(live|test)_/i,
  /^gh[pousr]_/,
  /^github_pat_/,
  /^glpat-/,
  /^npm_/,
  /^xox[baprs]-/,
  /^(AKIA|ASIA)[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{35}$/,
  /^eyJ[0-9A-Za-z_-]{8,}\./,
];

export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE.test(value) && !looksLikeCredential(value);
}

/** Whether a value is recognisably a credential. The same tripwire either way:
 *  a Suppression Plan's environment is written in the same settings file, which
 *  syncs and is often committed, and a plan value is never a secret (ADR-0010). */
export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_SHAPES.some((shape) => shape.test(value));
}

const secretReference = z
  .string()
  .refine(isSecretReference, "must be a SecretStorage key reference, not the secret value itself");

const suppressionSetting = z
  .object({
    args: z.array(z.string()).optional(),
    env: z
      .record(
        z.string().regex(ENV_NAME),
        z.string().refine((value) => !looksLikeCredential(value), "must not be a credential"),
      )
      .optional(),
    sessionMeta: z.record(z.unknown()).optional(),
    workspaceSettings: z
      .object({ file: z.string().min(1), merge: z.record(z.unknown()) })
      .strict()
      .optional(),
    delegationTools: z.array(z.string().min(1)).min(1),
  })
  .strict();

const runtimeSetting = z
  .object({
    enabled: z.boolean().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    suppression: suppressionSetting.optional(),
    secretEnvironment: z.record(z.string().regex(ENV_NAME), secretReference).optional(),
    defaultModel: z.string().optional(),
    defaultEffort: effortLevel.optional(),
    suppressBuiltInSubagents: z.boolean().optional(),
    safeMode: z.boolean().optional(),
  })
  .strict();

const presetSetting = z
  .object({
    runtime: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
  })
  .strict();

export type RuntimeSetting = z.infer<typeof runtimeSetting>;
export type PresetSetting = z.infer<typeof presetSetting>;

/**
 * Every non-collection setting, keyed exactly as the manifest declares it. Flat
 * on purpose: the string a reader greps for in `package.json` is the string they
 * read here, so a default cannot quietly disagree with the one VS Code applies.
 */
const scalarSchema = z.object({
  defaultRuntime: z.string().min(1).default("claude"),
  "orchestration.enabled": z.boolean().default(false),
  "orchestration.maxConcurrentSubagents": z.number().int().min(1).max(16).default(3),
  "orchestration.maxSpawnDepth": z.number().int().min(0).default(1),
  "orchestration.maxSubagentsPerSession": z.number().int().min(1).max(200).default(20),
  "orchestration.subagentTimeoutMs": z.number().int().min(1_000).default(900_000),
  "orchestration.subagentIsolation": z.enum(["shared", "worktree"]).default("worktree"),
  "orchestration.budgetUsdPerSubagent": z.number().nonnegative().default(2),
  "orchestration.defaultSubagentPreset": z.string().default(""),
  "permissions.rememberAlwaysChoices": z.boolean().default(true),
  // Bounded by what one approval prompt can show: a larger budget would not be
  // shown, and what is not shown is what an Agent would hide behind.
  "permissions.maxEnvironmentChars": z
    .number()
    .int()
    .min(0)
    .max(MAX_ENV_CHARS)
    .default(DEFAULT_ENV_CHARS),
  "claude.hideSubscriptionAuth": z.boolean().default(false),
  "gemini.writeWorkspaceSettings": z.boolean().default(false),
  "registry.autoResolve": z.boolean().default(true),
  "registry.url": z
    .string()
    .url()
    .default("https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"),
  "registry.pin": z.record(z.string()).default({}),
  "sessions.resumeOnStartup": z.boolean().default(false),
  "worktrees.root": z.string().default(""),
  "ui.showThinking": z.boolean().default(true),
  "ui.slashCommandAllowlist": z
    .array(z.string())
    .default(["compact", "init", "review", "plan", "context"]),
  "logging.level": z.enum(["off", "error", "info", "debug", "trace"]).default("info"),
});

export type ConductorSettings = z.infer<typeof scalarSchema> & {
  runtimes: Record<string, RuntimeSetting>;
  presets: Record<string, PresetSetting>;
  "permissions.autoAllowClientOperations": ClientOperation[];
  "permissions.autoRejectClientOperations": ClientOperation[];
};

export interface SettingsRead {
  settings: ConductorSettings;
  /** What was refused and why, for the log and the wizard. Never carries a value
   *  read from `secretEnvironment` — that value may be the credential itself. */
  problems: string[];
}

/** Reads and validates the whole `agentConductor.*` namespace. Never throws. */
export function readSettings(source: SettingsSource): SettingsRead {
  const problems: string[] = [];
  const scalars = readScalars(source, problems);
  const runtimes = readEntries(source, "runtimes", "runtime", runtimeSetting, problems);
  const presets = readEntries(source, "presets", "preset", presetSetting, problems);
  const rejections = readOperations(source, "permissions.autoRejectClientOperations", [], problems);
  const rejected = rejections.operations;

  // Deny overrides allow. An operation named by both lists is a contradiction,
  // and the reading that never silently grants consent is the one to keep.
  const allowed = readOperations(
    source,
    "permissions.autoAllowClientOperations",
    ["fs.read"],
    problems,
  ).operations.filter((operation) => {
    if (!rejected.includes(operation)) return true;
    problems.push(
      `agentConductor.permissions: "${operation}" is both auto-allowed and auto-rejected;` +
        " the rejection wins",
    );
    return false;
  });

  return {
    settings: {
      ...scalars,
      // A rejection list that could not be read at all leaves what the user
      // refused unknowable. Approving anything without asking would then be a
      // guess in the one direction that cannot be taken back, so nothing is.
      "permissions.autoAllowClientOperations": rejections.unreadable ? [] : allowed,
      "permissions.autoRejectClientOperations": rejected,
      runtimes,
      presets,
    },
    problems,
  };
}

/**
 * One list of Client Operations, validated entry by entry.
 *
 * Deliberately not part of the schema above, whose recovery from a failed key is
 * that key's manifest default. The default rejection list is empty, so a single
 * typo would turn "never do this" into no policy at all — a fail-open recovery
 * for the one setting whose whole purpose is to refuse. An unrecognised entry is
 * dropped and reported; the entries around it still stand.
 */
function readOperations(
  source: SettingsSource,
  key: string,
  fallback: ClientOperation[],
  problems: string[],
): { operations: ClientOperation[]; unreadable: boolean } {
  const raw = source.get(key);
  if (raw === undefined) return { operations: [...fallback], unreadable: false };
  if (!Array.isArray(raw)) {
    problems.push(`agentConductor.${key}: expected a list of client operations`);
    // Not the default: for a rejection list that would be no policy at all.
    return { operations: [], unreadable: true };
  }
  const known = new Set<string>(CLIENT_OPERATIONS);
  const operations: ClientOperation[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && known.has(entry)) {
      operations.push(entry as ClientOperation);
      continue;
    }
    problems.push(`agentConductor.${key}: "${String(entry)}" is not a client operation — ignored`);
  }
  return { operations, unreadable: false };
}

function readScalars(source: SettingsSource, problems: string[]): z.infer<typeof scalarSchema> {
  const values: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(scalarSchema.shape)) {
    const raw = source.get(key);
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      values[key] = parsed.data;
      continue;
    }
    // The manifest default is what VS Code would have handed us; using it keeps
    // one bad key from disabling the feature it configures.
    values[key] = schema.parse(undefined);
    problems.push(`agentConductor.${key}: ${firstIssue(parsed.error)} — using the default`);
  }
  return values as z.infer<typeof scalarSchema>;
}

/**
 * One keyed collection — Runtimes, Presets. Validated per entry so a typo in one
 * Runtime cannot take away the Runtimes that are still fine.
 */
function readEntries<T extends z.ZodTypeAny>(
  source: SettingsSource,
  key: string,
  noun: string,
  schema: T,
  problems: string[],
): Record<string, z.infer<T>> {
  const raw = source.get(key);
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`agentConductor.${key}: expected an object keyed by id — ignored`);
    return {};
  }
  const entries: Record<string, z.infer<T>> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      entries[id] = parsed.data;
      continue;
    }
    problems.push(`${noun} "${id}": ${firstIssue(parsed.error)} — ignored`);
  }
  return entries;
}

/**
 * One problem line from a validation failure: the field that failed and why.
 * Only the leading path segment is used — a deeper path can carry a user-written
 * key, and under `secretEnvironment` that key is next to a value we must not
 * assume is safe to print.
 */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const field = issue.path[0];
  // An array index is not a field name; naming it as one reads like a setting.
  return typeof field === "string" ? `${field} ${issue.message}` : issue.message;
}

/** Re-exported: redaction is the core's, so an Agent's own stderr passes
 *  through it before it ever reaches a log or a transcript (ADR-0010). */
export { redactSecrets };

/**
 * Resolves a Runtime's `secretEnvironment` references into the environment its
 * process is spawned with. Fails closed: a reference with no stored secret stops
 * the launch rather than starting an Agent that would fail obscurely later.
 *
 * No resolved value ever reaches the message — including through an error raised
 * by the store itself.
 */
export async function resolveSecretEnvironment(
  secrets: SecretsSource,
  runtimeId: string,
  references: Record<string, string> = {},
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, reference] of Object.entries(references)) {
    // Checked here as well as in settings: a name carrying `=` or a separator
    // would not be one variable in the child's environment.
    if (!ENV_NAME.test(name)) {
      throw new Error(`runtime ${runtimeId}: "${name}" is not an environment variable name`);
    }
    // Checked here too, not only where settings are validated: this is the last
    // point before a value would be printed, and a caller may not have validated.
    if (!isSecretReference(reference)) {
      throw new Error(
        `runtime ${runtimeId}: ${name} is not a SecretStorage key reference` +
          " — store the secret and reference it by key",
      );
    }
    let value: string | undefined;
    try {
      value = await secrets.get(reference);
    } catch (error) {
      throw new Error(
        `runtime ${runtimeId}: reading the stored secret for ${name} failed:` +
          ` ${redactSecrets(message(error), Object.values(resolved))}`,
      );
    }
    if (!value) {
      // The reference itself is not printed: a mis-pasted credential that no
      // recognisable shape catches would be exactly the string in hand here.
      throw new Error(
        `runtime ${runtimeId}: no stored secret for ${name}` +
          " — connect the runtime again to store it",
      );
    }
    resolved[name] = value;
  }
  return resolved;
}


// ---------------------------------------------------------------------------
// Durable storage. The core writes through `StoragePort` — the Registry cache
// under the extension's global storage, and the workspace settings file a
// Suppression Plan merges into (ADR-0004).
// ---------------------------------------------------------------------------

/**
 * Files under `directory` — `ExtensionContext.globalStorageUri.fsPath` in
 * production. A key is either a name, resolved inside that directory and unable
 * to climb out of it, or an absolute path — which is how the workspace-settings
 * channel names a file in the user's repository, and is therefore as unrestricted
 * as the caller that composed it. The core validates that path before it gets
 * here: a supplied plan's settings file must be workspace-relative and free of
 * `..` (ADR-0004).
 *
 * Writes replace the whole file through a rename, so a crash mid-write leaves
 * the previous content rather than half of the new one. That holds on one
 * filesystem, which is where the temporary file is put.
 */
/**
 * How old a scratch file must be before it is nobody's.
 *
 * By age rather than by name: the name is deliberately unique per write, and
 * another writer's in-flight file matches the same pattern. Two windows can
 * share one storage directory, so "mine" is not something a sweep can tell —
 * but nothing in flight is an hour old.
 */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

/** Scratch files an earlier write never renamed. Failures are ignored: this is
 *  tidying, and a write that still succeeds is the point. */
async function removeStale(directory: string, name: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    const abandoned = entries.filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith(".tmp"));
    await Promise.all(
      abandoned.map(async (entry) => {
        const scratch = join(directory, entry);
        const details = await stat(scratch).catch(() => undefined);
        if (details && Date.now() - details.mtimeMs > STALE_SCRATCH_MS) {
          await rm(scratch, { force: true });
        }
      }),
    );
  } catch {
    // Nothing to tidy, or nothing we may tidy.
  }
}

export function fileStorage(directory: string): StoragePort {
  const pathOf = (key: string): string => {
    if (isAbsolute(key)) return key;
    const base = resolve(directory);
    const target = resolve(base, key);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`storage key "${key}" resolves outside the storage directory`);
    }
    return target;
  };
  return {
    async read(key) {
      try {
        return await readFile(pathOf(key), "utf8");
      } catch (error) {
        // Absent is an answer; anything else is a failure worth reporting.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeAtomic(key, value) {
      const target = pathOf(key);
      await mkdir(dirname(target), { recursive: true });
      // A host killed between the write and the rename leaves its scratch file
      // behind, and nothing else ever looks at one. Cleared here rather than on
      // a timer: this is the only code that makes them.
      await removeStale(dirname(target), basename(target));
      // Unique per write, not per process: two writes to one name in flight
      // together would otherwise rename the same scratch file twice, and the
      // loser would report a failure that never happened.
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, value, "utf8");
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}
