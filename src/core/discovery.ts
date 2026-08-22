import type * as acp from "@agentclientprotocol/sdk";
import type { EffectiveSelection, ModelHint } from "./types.js";

/**
 * Config Option discovery and Read-back (ADR-0005).
 *
 * Almost all of it is a pure projection of the complete Config Option array the
 * Agent last reported. The array is the only source of truth: model lists are
 * never synthesized, and a value is only ever called *effective* when the Agent
 * itself reported it as current. The exception is `applyRequestedSelections`,
 * the one step that acts on that array rather than reading it — kept here so
 * that everything ADR-0005 decides is in one file.
 */

/** One selectable value of a Config Option, flattened out of its group. */
export interface ConfigChoice {
  value: string;
  label: string;
  /** Display name of the group the Agent placed this value in, if any. */
  group?: string;
}

/** A single-select Config Option, ready to render as a picker. */
export interface ConfigSelector {
  id: string;
  name: string;
  /** What the Agent reports as selected right now — the Read-back value. */
  currentValue: string;
  choices: ConfigChoice[];
}

export interface DiscoveredConfig {
  /** The `model` category selector, when the Agent exposes one. */
  model?: ConfigSelector;
  /** The `thought_level` category selector, when the Agent exposes one. */
  effort?: ConfigSelector;
  /**
   * Every option the categories did not claim, verbatim and in Agent order:
   * unknown categories, uncategorized options, booleans, and any second option
   * claiming a category already taken. Nothing the Agent sends is dropped.
   */
  other: acp.SessionConfigOption[];
}

/** Where a picker's values came from — the Agent, or the Runtime catalog. */
export interface ChoiceSource {
  choices: ConfigChoice[];
  source: "agent" | "catalog" | "none";
}

/**
 * Splits the Agent's Config Options into the two pickers the conductor drives
 * and everything else. Categories are UX hints and may be missing or unknown,
 * so an option is claimed only when its category matches *and* it is a select:
 * a boolean cannot carry a model id.
 *
 * Takes `unknown` because its real input is an Agent's unvalidated answer, not
 * the type that answer claims to have — see `asConfigOptions`.
 */
export function discoverConfig(options: unknown = []): DiscoveredConfig {
  const config: DiscoveredConfig = { other: [] };
  for (const option of asConfigOptions(options)) {
    // A `select` is the only shape that can carry a model id or an effort level.
    // Its tag is only worth reading because `asConfigOptions` has already proved
    // the payload matches it: a boolean must never pose as a model picker.
    if (option.type === "select") {
      const slot = categorySlot(option.category);
      if (slot && !config[slot]) {
        config[slot] = {
          id: option.id,
          name: option.name,
          currentValue: option.currentValue,
          choices: flattenChoices(option.options),
        };
        continue;
      }
    }
    config.other.push(option);
  }
  return config;
}

/**
 * Narrows whatever an Agent put on the wire to the Config Options this Client
 * can trust.
 *
 * The SDK schema-checks the notifications it receives but not the responses to
 * requests this Client sends, so `session/new`, `session/load`, and
 * `session/set_config_option` all deliver this array unvalidated — and the Agent
 * is not trusted (ADR-0007). Every field the projection later reads is checked
 * here, so a declared type is never a promise about an Agent's behaviour.
 * Options that fail the check are dropped: an option whose values cannot be read
 * cannot be rendered or set, and presenting part of one would be a guess.
 */
export function asConfigOptions(options: unknown): acp.SessionConfigOption[] {
  return Array.isArray(options) ? options.filter(isConfigOption) : [];
}

function isConfigOption(option: unknown): option is acp.SessionConfigOption {
  if (!isRecord(option)) return false;
  const candidate = option as Partial<acp.SessionConfigOption>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return false;
  // Display-only fields are checked too: a consumer that renders `other` must
  // not be handed something other than the string their types promise.
  if (!isOptionalString(candidate.category) || !isOptionalString(candidate.description)) return false;
  if (candidate.type === "boolean") return typeof candidate.currentValue === "boolean";
  if (candidate.type !== "select") return false;
  return typeof candidate.currentValue === "string" && isSelectOptions(candidate.options);
}

/**
 * A mixed array of bare values and groups is tolerated on purpose: the schema
 * says one or the other, but reading both costs nothing and refusing a whole
 * picker over the distinction would help nobody.
 */
function isSelectOptions(options: unknown): options is acp.SessionConfigSelectOptions {
  return (
    Array.isArray(options) &&
    options.every((entry) => isSelectGroup(entry) || isSelectValue(entry))
  );
}

/**
 * The one place the two shapes are told apart. Validation and rendering must
 * never discriminate differently: an entry accepted as a bare value and then
 * read as a group would dereference values nothing ever checked.
 */
function isSelectGroup(entry: unknown): entry is acp.SessionConfigSelectGroup {
  return (
    isRecord(entry) &&
    typeof entry.group === "string" &&
    typeof entry.name === "string" &&
    Array.isArray(entry.options) &&
    entry.options.every(isSelectValue)
  );
}

function isSelectValue(option: unknown): option is acp.SessionConfigSelectOption {
  return isRecord(option) && typeof option.value === "string" && typeof option.name === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** Arrays are objects; nothing here ever means one when it says record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-back for one picker: what was asked for beside what the Agent reports.
 *
 * A missing selector means the Agent never reported an effective value, so the
 * selection stays `unavailable` — a requested value is never echoed back as
 * effective on the strength of a catalog or an argv flag alone (ADR-0005).
 */
export function readBack(selector: ConfigSelector | undefined, requested?: string): EffectiveSelection {
  return selector
    ? { ...(requested === undefined ? {} : { requested }), effective: selector.currentValue, verification: "verified" }
    : { ...(requested === undefined ? {} : { requested }), verification: "unavailable" };
}

/**
 * True when the Agent verifiably runs something other than what was requested —
 * the clamp that Read-back exists to surface. Unverified selections are unknown,
 * not mismatched.
 */
export function isMismatch(selection: EffectiveSelection): boolean {
  return (
    selection.verification === "verified" &&
    selection.requested !== undefined &&
    selection.requested !== selection.effective
  );
}

/**
 * Model picker values: the Agent's own list when it exposes one, otherwise the
 * Runtime catalog. The catalog is consulted only in the Agent's silence, and
 * an empty catalog yields no choices rather than an invented list.
 */
export function pickModelChoices(config: DiscoveredConfig, catalog: ModelHint[] = []): ChoiceSource {
  if (config.model) return { choices: config.model.choices, source: "agent" };
  const choices = catalog.map((hint) => ({ value: hint.id, label: hint.label }));
  return choices.length > 0 ? { choices, source: "catalog" } : { choices: [], source: "none" };
}

/**
 * Effort picker values, on the same terms as the model picker. The fallback is
 * what the chosen model declares it accepts; a model that ignores effort offers
 * nothing rather than the conductor's full vocabulary.
 */
export function pickEffortChoices(config: DiscoveredConfig, model?: ModelHint): ChoiceSource {
  if (config.effort) return { choices: config.effort.choices, source: "agent" };
  const choices = (model?.efforts ?? []).map((effort) => ({ value: effort, label: effort }));
  return choices.length > 0 ? { choices, source: "catalog" } : { choices: [], source: "none" };
}

/** Which picker a Config Option id drives in this projection, if either. */
export function selectorSlot(config: DiscoveredConfig, configId: string): "model" | "effort" | undefined {
  if (config.model?.id === configId) return "model";
  if (config.effort?.id === configId) return "effort";
  return undefined;
}

function categorySlot(category: string | null | undefined): "model" | "effort" | undefined {
  if (category === "model") return "model";
  if (category === "thought_level") return "effort";
  return undefined;
}

/** Groups are a display device; the picker needs one flat list of values. */
function flattenChoices(options: acp.SessionConfigSelectOptions): ConfigChoice[] {
  return options.flatMap((entry) =>
    isSelectGroup(entry)
      ? entry.options.map((value) => ({ ...choice(value), group: entry.name }))
      : [choice(entry)],
  );
}

function choice(option: acp.SessionConfigSelectOption): ConfigChoice {
  return { value: option.value, label: option.name };
}

/** Just enough of a Session to set a Config Option on it. */
export interface ConfigurableSession {
  readonly config: DiscoveredConfig;
  setConfigOption(configId: string, value: string): Promise<DiscoveredConfig>;
}

/**
 * Asks the Agent for the model and effort a Session was opened with.
 *
 * Without this a selection is only half a Read-back: the value chosen when the
 * Runtime was connected would sit in settings while every Turn ran the Agent's
 * own default, reported as a mismatch forever.
 *
 * A Runtime exposing no matching Config Option is not asked — its configuration
 * is fixed when its process starts. Neither is a value the Agent already
 * reports, nor one it does not list. A refusal is handed to the caller rather
 * than raised: the Agent keeps its own default, and Read-back is what says so.
 *
 * The array is re-read per slot, because setting one returns a whole refreshed
 * array in which the other selector's id need not have survived.
 */
export async function applyRequestedSelections(
  session: ConfigurableSession,
  requested: { model?: string; effort?: string },
  refused: (slot: "model" | "effort", value: string, error: unknown) => void,
): Promise<void> {
  for (const slot of ["model", "effort"] as const) {
    const value = requested[slot];
    const selector = session.config[slot];
    if (!selector || value === undefined || selector.currentValue === value) continue;
    // Only for a value the Agent lists. A stale id — the ordinary result of a
    // CLI dropping a model — would be refused, and a refused set leaves the
    // Session with no Config Options at all, so both pickers and both
    // Read-backs would be lost to a setting that is merely out of date.
    if (!selector.choices.some((choice) => choice.value === value)) continue;
    try {
      await session.setConfigOption(selector.id, value);
    } catch (error) {
      refused(slot, value, error);
      // Stop at the first failure. An Agent that could not answer this one will
      // not answer the next, and each attempt is bounded by a Setup Deadline —
      // so carrying on doubles how long a silent Runtime holds up a Session.
      return;
    }
  }
}
