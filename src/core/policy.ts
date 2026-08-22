import { isAbsolute } from "node:path";
import type { SessionPolicy, StoragePort } from "./types.js";

/**
 * Keys a Suppression Plan merges into a settings file the CLI reads from the
 * workspace. Writing into the user's repository is the most invasive channel a
 * plan has, so it is consent-gated, merged rather than written over, and
 * reversible (ADR-0004).
 */
export interface WorkspaceSettingsPatch {
  /** Workspace-relative file; the caller resolves it against the workspace root. */
  file: string;
  /** Deep-merged into that file. Arrays are unioned, never replaced. */
  merge: Record<string, unknown>;
}

/**
 * The complete recipe that disables one CLI's built-in delegation: every channel
 * it reaches the Agent through, plus the tool names its success is measured by.
 *
 * It is one value rather than four scattered fields because two questions are
 * asked of it as a whole — whether a Runtime has a plan at all, which is what
 * makes it eligible for Shim injection, and whether the plan demonstrably worked
 * (ADR-0008). Nothing can answer either from argv alone.
 */
export interface SuppressionPlan {
  /** Appended to the launch arguments. */
  args: string[];
  /** Merged into the launch environment. */
  env: Record<string, string>;
  /** Sent as `session/new` `_meta` — the only per-session channel. */
  sessionMeta?: Record<string, unknown>;
  /** Workspace file the plan has to edit, for CLIs offering nothing else. */
  workspaceSettings?: WorkspaceSettingsPatch;
  /**
   * Delegation tools the plan removes. These are what verification looks for in
   * the Agent's live tool list: a plan is only believed once the tools it claims
   * to disable are actually gone. Names rot — Claude's `Task` became `Agent` and
   * silently no-ops under the old name — which is why the list is checked against
   * a running Agent rather than trusted from the catalog (ADR-0004).
   */
  delegationTools: string[];
}

/**
 * The built-in plans. Each one is rebuilt per call: a Runtime holds its plan by
 * reference, and a shared mutable recipe would let one Runtime's edit reconfigure
 * every other.
 *
 * Traps encoded here: Claude's delegation tool is `Agent` — the old name `Task`
 * silently no-ops; Codex checks `features.multi_agent_v2` *before*
 * `agents.enabled`, so both must be set; Codex's config is process-scoped through
 * the environment, so its plan cannot change per Session.
 */
const BUILT_IN_PLANS: Record<string, () => SuppressionPlan> = {
  claude: () => ({
        args: [],
        env: {},
        sessionMeta: {
          claudeCode: { options: { disallowedTools: ["Agent", "SendMessage", "ListAgents"], agents: {} } },
        },
    delegationTools: ["Agent", "SendMessage", "ListAgents"],
  }),
  codex: () => ({
        args: [],
        env: {
          CODEX_CONFIG: JSON.stringify({
            agents: { enabled: false },
            features: { multi_agent_v2: false, collab: false },
          }),
        },
    delegationTools: ["spawn_agent"],
  }),
  gemini: () => ({
        args: [],
        env: {},
        workspaceSettings: {
          file: ".gemini/settings.json",
          merge: { experimental: { enableAgents: false }, tools: { exclude: ["invoke_agent"] } },
        },
    delegationTools: ["invoke_agent"],
  }),
  copilot: () => ({
        args: ["--excluded-tools", "task,read_agent"],
        env: {},
    delegationTools: ["task", "read_agent"],
  }),
};

function builtInPlan(runtimeId: string): SuppressionPlan | undefined {
  // Own keys only: a Runtime id comes from a settings key, and one spelled
  // `constructor` or `toString` would otherwise reach up the prototype chain
  // and hand back something that is not a plan.
  return Object.hasOwn(BUILT_IN_PLANS, runtimeId) ? BUILT_IN_PLANS[runtimeId]?.() : undefined;
}

/** Every delegation tool the catalog knows of, whichever Runtime it belongs to.
 *
 *  Verification measures a plan against this union rather than against the names
 *  the plan itself supplies. A plan that names only tools nobody has would
 *  otherwise certify itself: it would pass the moment an Agent turned out not to
 *  have them, with that Agent's real delegation still live. A superset is the safe
 *  direction — an Agent whose own tool happens to share one of these names simply
 *  does not become eligible for orchestration (ADR-0008). */
export function knownDelegationTools(): string[] {
  return [...new Set(Object.values(BUILT_IN_PLANS).flatMap((plan) => plan().delegationTools))];
}

/** The plan a Runtime runs under, or nothing: a policy that suppresses nothing
 *  has no plan, and neither does a Runtime the catalog knows no recipe for. */
export function suppressionPlan(runtimeId: string, policy: SessionPolicy): SuppressionPlan | undefined {
  return policy.suppressBuiltInSubagents ? builtInPlan(runtimeId) : undefined;
}

/** What a Probe Session observed about a plan that has already been applied. */
export interface SuppressionEvidence {
  /** Tool names the Agent advertised. Absent means the list could not be read,
   *  which is not the same as an empty one and never counts as success. */
  tools?: string[];
  /** The user agreed to the workspace file the plan edits, and it was written. */
  workspaceSettingsConsent?: boolean;
}

export interface SuppressionVerdict {
  verified: boolean;
  /** Why not, in words a wizard can show. Absent when verified. */
  reason?: string;
}

/**
 * Decides whether a Suppression Plan demonstrably worked. Everything unknown is a
 * failure: an unreadable tool list, an unapplied workspace file, or no plan at all
 * leaves built-in delegation possibly live, and orchestration must then fail
 * closed rather than inject the Shim beside a working `spawn_agent` (ADR-0008).
 */
export function verifySuppression(
  plan: SuppressionPlan | undefined,
  evidence: SuppressionEvidence,
): SuppressionVerdict {
  if (!plan) return { verified: false, reason: "this runtime has no suppression plan" };
  if (plan.workspaceSettings && evidence.workspaceSettingsConsent !== true) {
    return { verified: false, reason: `suppression needs consent to write ${plan.workspaceSettings.file}` };
  }
  // An empty list is what a probe that saw nothing produces, and ACP has no call
  // that asks an Agent to enumerate its tools. Absence of evidence stays absence.
  if (!evidence.tools || evidence.tools.length === 0) {
    return { verified: false, reason: "the agent's tool list could not be read" };
  }
  // Compared case-insensitively: a CLI that renames `task` to `Task` has not
  // removed it, and guessing in the permissive direction is how a live
  // delegation tool passes for a suppressed one.
  const live = new Set(evidence.tools.map((tool) => tool.toLowerCase()));
  const mustBeGone = new Set([...plan.delegationTools, ...knownDelegationTools()]);
  const remaining = [...mustBeGone].filter((tool) => live.has(tool.toLowerCase()));
  if (remaining.length > 0) {
    return { verified: false, reason: `delegation tools still available: ${remaining.join(", ")}` };
  }
  return { verified: true };
}

/** The user's half of a Suppression Plan, as it arrives from settings: hand-edited
 *  JSON, so every field is checked rather than trusted. */
export interface SuppliedSuppression {
  args?: string[];
  env?: Record<string, string>;
  sessionMeta?: Record<string, unknown>;
  workspaceSettings?: { file: string; merge: Record<string, unknown> };
  /** Tool names whose disappearance proves the plan worked. Required: a plan that
   *  names nothing would be "verified" by an Agent that suppressed nothing. */
  delegationTools?: string[];
}

/** A settings-supplied plan, once checked: one or the other, never both. */
export interface ParsedSuppressionPlan {
  plan?: SuppressionPlan;
  /** Why the plan was refused, in words a settings editor can show. */
  error?: string;
}

/**
 * Validates a Suppression Plan that came from settings.
 *
 * Everything here is hand-edited JSON that ends up in a launch, an environment, a
 * `session/new` `_meta`, or a file written into the user's repository, so a
 * malformed plan disables its Runtime rather than being partly applied — half a
 * plan suppresses nothing while looking like it does.
 */
export function parseSuppressionPlan(supplied: SuppliedSuppression | undefined): ParsedSuppressionPlan {
  if (supplied === undefined) return {};
  const strings = (value: unknown): boolean =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  const record = (value: unknown): boolean =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  if (!record(supplied)) return { error: "suppression plan must be an object" };
  if (supplied.args !== undefined && !strings(supplied.args)) {
    return { error: "suppression plan arguments must be a list of strings" };
  }
  if (
    supplied.env !== undefined &&
    (!record(supplied.env) || Object.values(supplied.env).some((value) => typeof value !== "string"))
  ) {
    return { error: "suppression plan environment must map names to strings" };
  }
  if (supplied.sessionMeta !== undefined && !record(supplied.sessionMeta)) {
    return { error: "suppression plan session metadata must be an object" };
  }
  const workspace = supplied.workspaceSettings;
  if (workspace !== undefined) {
    if (!record(workspace) || typeof workspace.file !== "string" || !record(workspace.merge)) {
      return { error: "suppression plan workspace settings need a file and an object to merge" };
    }
    // The file is joined to the workspace root by whoever applies the plan, so
    // this is where a path that would escape it has to be refused: a plan arrives
    // from settings, and settings can be a file inside the repository itself.
    const segments = workspace.file.split(/[/\\]/);
    if (workspace.file === "" || isAbsolute(workspace.file) || segments.some((step) => step === "..")) {
      return { error: `suppression plan workspace file must stay inside the workspace, got "${workspace.file}"` };
    }
  }
  // Without them nothing could ever falsify the plan, and an unfalsifiable plan
  // would pass verification while built-in delegation kept working (ADR-0008).
  if (!strings(supplied.delegationTools) || supplied.delegationTools?.length === 0) {
    return { error: "suppression plan must name the delegation tools it disables" };
  }
  // A plan reaches its Agent through argv, the environment, `_meta`, or a
  // workspace file. One that uses none of them changes nothing, yet would be
  // "verified" the moment an Agent turned out not to have the tools it names.
  const sessionMeta = Object.keys(supplied.sessionMeta ?? {}).length > 0 ? supplied.sessionMeta : undefined;
  if (
    (supplied.args ?? []).length === 0 &&
    Object.keys(supplied.env ?? {}).length === 0 &&
    sessionMeta === undefined &&
    (workspace === undefined || usableKeys(workspace.merge).length === 0)
  ) {
    return { error: "suppression plan disables nothing: it sets no argument, variable, metadata, or setting" };
  }
  return {
    plan: {
      args: [...(supplied.args ?? [])],
      env: { ...(supplied.env ?? {}) },
      ...(sessionMeta === undefined ? {} : { sessionMeta: structuredClone(sessionMeta) }),
      ...(workspace === undefined
        ? {}
        : { workspaceSettings: { file: workspace.file, merge: structuredClone(workspace.merge) } }),
      delegationTools: [...(supplied.delegationTools ?? [])],
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace settings channel: merge, revert, and the writes in between.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that address the object model rather than the document. `JSON.parse` puts
 *  them in as ordinary properties, but assigning one onto a plain object reaches
 *  every object in the extension host, so no settings file gets to name them. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Keys of a patch that the merge would actually apply. */
function usableKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => !UNSAFE_KEYS.has(key));
}

/** Same-value comparison for list entries, which are as likely to be objects as
 *  strings. Identity would append a duplicate of every object on each apply. */
function sameItem(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  return stableJson(left) === stableJson(right);
}

/** JSON with every object's keys in codepoint order, at every depth.
 *
 *  Two spellings of one thing must compare equal: a settings file rewritten by
 *  another tool says the same in another key order, and a launch identity must
 *  hash the same however its environment happened to be written. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
}

/** One reversal step: enough to put back exactly what the merge changed, and
 *  nothing the user changed themselves in between. */
export interface SettingsRevertEntry {
  /** Key path from the document root. */
  path: string[];
  /** Value to restore. Absent means the key was not there before. */
  previous?: unknown;
  /** Items appended to a list. Removed on revert, so entries the user added to
   *  the same list afterwards survive it. */
  added?: unknown[];
  /** The list was already there. It stays on revert, emptied of what the plan
   *  added; only a list the plan brought into being is removed with its items. */
  existed?: true;
  /** What the merge left at this path. Revert compares before acting: a value the
   *  user has changed since is no longer the plan's to take back. */
  wrote?: unknown;
  /** The merge created this section. Removed on revert only if it is empty by
   *  then, so anything the user put inside it survives. */
  created?: true;
}

function applyMerge(target: JsonObject, patch: JsonObject, prefix: string[], revert: SettingsRevertEntry[]): void {
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const path = [...prefix, key];
    const current = target[key];
    if (isJsonObject(value)) {
      if (!isJsonObject(current)) {
        // A section we create is recorded as created rather than as a value to
        // delete: by the time anyone reverts, it may hold the user's own settings.
        revert.push(current === undefined ? { path, created: true } : { path, previous: current, created: true });
        target[key] = {};
      }
      applyMerge(target[key] as JsonObject, value, path, revert);
      continue;
    }
    if (Array.isArray(value)) {
      // A list is extended, never replaced — unless what is there is not a list,
      // which is the one case where the old value cannot be kept alongside.
      if (Array.isArray(current)) {
        const added = value.filter((item) => !current.some((existing) => sameItem(existing, item)));
        if (added.length === 0) continue;
        revert.push({ path, added, existed: true });
        target[key] = [...current, ...added];
        continue;
      }
      revert.push(current === undefined ? { path, added: [...value] } : { path, previous: current, wrote: [...value] });
      target[key] = [...value];
      continue;
    }
    if (current === value) continue;
    revert.push(current === undefined ? { path, wrote: value } : { path, previous: current, wrote: value });
    target[key] = value;
  }
}

/**
 * Merges the plan's keys into an existing settings document.
 *
 * Everything the plan does not name is preserved untouched — the file belongs to
 * the user, and a CLI's settings routinely hold far more than delegation. An empty
 * reversal list means the document already said what the plan wanted.
 */
export function mergeSettings(
  existing: JsonObject,
  patch: JsonObject,
): { settings: JsonObject; revert: SettingsRevertEntry[] } {
  const settings = structuredClone(existing);
  const revert: SettingsRevertEntry[] = [];
  applyMerge(settings, patch, [], revert);
  return { settings, revert };
}

/** Undoes a merge against the document as it stands now, which may have moved on
 *  since. Paths that no longer lead anywhere are skipped rather than recreated. */
export function revertSettings(existing: JsonObject, revert: SettingsRevertEntry[]): JsonObject {
  const settings = structuredClone(existing);
  // Deepest last on the way in, so undone first on the way out: a section can
  // only be judged empty once everything the merge put in it is gone.
  for (const entry of [...revert].reverse()) {
    if (entry.path.some((step) => UNSAFE_KEYS.has(step))) continue;
    let container: JsonObject = settings;
    let reachable = true;
    for (const step of entry.path.slice(0, -1)) {
      const next = container[step];
      if (!isJsonObject(next)) {
        reachable = false;
        break;
      }
      container = next;
    }
    if (!reachable) continue;
    const key = entry.path[entry.path.length - 1];
    const current = container[key];

    if (entry.created) {
      // Whatever the user added here is theirs; only an empty shell goes.
      if (isJsonObject(current) && Object.keys(current).length === 0) {
        if (entry.previous === undefined) delete container[key];
        else container[key] = entry.previous;
      }
      continue;
    }
    if (entry.added) {
      // Removing items from something that is no longer a list cannot mean
      // deleting it: the user replaced it, and what is there now is theirs.
      if (!Array.isArray(current)) continue;
      const kept = current.filter((item) => !entry.added?.some((mine) => sameItem(mine, item)));
      // A list the plan created goes when nothing of it is left; one that was
      // already there stays, even emptied — the key is not the plan's to remove.
      if (kept.length === 0 && !entry.existed) delete container[key];
      else container[key] = kept;
      continue;
    }
    // Only undo what is still the plan's doing.
    if ("wrote" in entry && !sameItem(current, entry.wrote)) continue;
    if (entry.previous === undefined) delete container[key];
    else container[key] = entry.previous;
  }
  return settings;
}

/** How a settings document is written back: stable indentation and a trailing
 *  newline, so a plan that changes nothing also changes no diff. */
function serialize(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function parseSettings(file: string, text: string | undefined): JsonObject {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Refusing beats repairing: a file we cannot read is one we cannot merge into
    // without destroying whatever it actually said (comments included).
    throw new Error(`${file} is not valid JSON — fix or move it, then retry`);
  }
  if (!isJsonObject(parsed)) throw new Error(`${file} must contain a JSON object`);
  return parsed;
}

/**
 * Applies the plan's workspace channel, and returns what would undo it.
 *
 * Consent is an argument rather than a setting lookup so that no path into this
 * function can omit it. The write goes through the storage port in one call: a
 * settings file half-written by a crashed extension host is a broken CLI, so the
 * port's atomic replacement is the only writing primitive used here.
 */
export async function applyWorkspaceSuppression(
  storage: StoragePort,
  file: string,
  plan: SuppressionPlan,
  options: { consent: boolean },
): Promise<SettingsRevertEntry[] | undefined> {
  const patch = plan.workspaceSettings;
  if (!patch) return undefined;
  if (!options.consent) {
    throw new Error(`writing ${patch.file} needs the user's recorded consent`);
  }
  if (!isAbsolute(file)) throw new Error(`settings path must be absolute, got "${file}"`);

  const { settings, revert } = mergeSettings(parseSettings(file, await storage.read(file)), patch.merge);
  // Already suppressed: writing would only restamp the file and dirty the repo.
  if (revert.length > 0) await storage.writeAtomic(file, serialize(settings));
  return revert;
}

/** Puts the workspace file back, leaving every unrelated edit made since in place. */
export async function revertWorkspaceSuppression(
  storage: StoragePort,
  file: string,
  revert: SettingsRevertEntry[],
): Promise<void> {
  if (revert.length === 0) return;
  if (!isAbsolute(file)) throw new Error(`settings path must be absolute, got "${file}"`);
  const current = parseSettings(file, await storage.read(file));
  await storage.writeAtomic(file, serialize(revertSettings(current, revert)));
}
