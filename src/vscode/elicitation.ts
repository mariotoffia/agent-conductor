import type * as acp from "@agentclientprotocol/sdk";
import { CreateElicitationRequest, ElicitationPropertySchema } from "@agentclientprotocol/sdk";
import type * as vscode from "vscode";
import type { ElicitationPort } from "../core/index.js";
import {
  clampForDisplay,
  MAX_DETAIL_CHARS,
  MAX_LABEL_CHARS,
  type Assert,
  type Unread,
} from "./permissions.js";

// ---------------------------------------------------------------------------
// Elicitation. An Agent that can ask the user a structured question does not
// have to disable the feature that asks it — which is what a Client advertising
// no elicitation leaves it to do.
// ---------------------------------------------------------------------------

export interface QuickItem {
  label: string;
  description?: string;
}

export interface FormInputOptions {
  title: string;
  prompt: string;
  value?: string;
  /** Returns a complaint to keep the box open, or `undefined` to accept. */
  validateInput?: (value: string) => string | undefined;
}

export interface FormPickOptions {
  title: string;
  placeHolder: string;
}

/** `canPickMany` is part of the shape because it is what makes the answer a
 *  list; an implementation that dropped it would return one item instead. */
export interface FormPickManyOptions extends FormPickOptions {
  canPickMany: true;
}

/** Input surfaces, each shaped as the `vscode.window` call it stands for. */
export interface FormHost {
  input(options: FormInputOptions): PromiseLike<string | undefined>;
  pick(items: readonly QuickItem[], options: FormPickOptions): PromiseLike<QuickItem | undefined>;
  pickMany(
    items: readonly QuickItem[],
    options: FormPickManyOptions,
  ): PromiseLike<readonly QuickItem[] | undefined>;
}

/**
 * The ports still describe the calls they stand for. Structural so a test can
 * supply a plain object, and checked here so that freedom cannot drift.
 *
 * Signature assignability alone is too weak to catch the drift that matters: a
 * VS Code options object is all-optional, so a port that misnamed `validateInput`
 * would still be assignable — and would quietly validate nothing in production
 * while type-checking against a fake. So every option key is checked to be one
 * the host actually reads, and the last entry proves that check can still fail.
 * `vscode` is imported as a type; none of this survives to runtime.
 */
export type FormPortsMatchVsCodeApi = [
  Assert<typeof vscode.window.showInputBox extends FormHost["input"] ? true : false>,
  Assert<typeof vscode.window.showQuickPick extends FormHost["pick"] ? true : false>,
  Assert<typeof vscode.window.showQuickPick extends FormHost["pickMany"] ? true : false>,
  Assert<[Unread<FormInputOptions, vscode.InputBoxOptions>] extends [never] ? true : false>,
  Assert<[Unread<FormPickOptions, vscode.QuickPickOptions>] extends [never] ? true : false>,
  Assert<[Unread<FormPickManyOptions, vscode.QuickPickOptions>] extends [never] ? true : false>,
  Assert<[Unread<QuickItem, vscode.QuickPickItem>] extends [never] ? true : false>,
  // The gate's own self-test: the misnaming above is one this check rejects.
  Assert<[Unread<{ validate: unknown }, vscode.InputBoxOptions>] extends [never] ? false : true>,
];

/** The user walked away from the question. */
const CANCELLED: acp.CreateElicitationResponse = { action: "cancel" };
/** We cannot ask this question, so we say so rather than answer it badly. */
const DECLINED: acp.CreateElicitationResponse = { action: "decline" };

/**
 * Choices a person can actually be asked to choose between. Past this the
 * question is one this Client cannot put to somebody, which is a decline —
 * falling back to a free-text box would accept an answer the schema forbids.
 */
const MAX_CHOICES = 1_000;

const CANCEL = Symbol("cancelled");
const UNRENDERABLE = Symbol("unrenderable");
type Answer = acp.ElicitationContentValue | typeof CANCEL | typeof UNRENDERABLE;

/**
 * `elicitation/create`, form flavour — the only one the Client advertises.
 *
 * Every field is asked in the order the Agent declared it, and a dismissed input
 * cancels the whole elicitation: there is no way to tell "skip this one" from
 * "stop asking" through a plain input box, and guessing wrong would send the
 * Agent an answer the user never gave.
 */
export class FormElicitor implements ElicitationPort {
  readonly #host: FormHost;

  constructor(host: FormHost) {
    this.#host = host;
  }

  async createElicitation(
    request: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    // A URL or custom elicitation is a capability this Client never advertised.
    if (!CreateElicitationRequest.isForm(request)) return DECLINED;
    const properties = request.requestedSchema.properties ?? {};
    const required = request.requestedSchema.required ?? [];
    // A required field with no property to render is a form that cannot be
    // satisfied; accepting without it would answer a question never asked.
    if (required.some((name) => !Object.hasOwn(properties, name))) return DECLINED;
    const content: Record<string, acp.ElicitationContentValue> = {};
    for (const [name, property] of Object.entries(properties)) {
      const answer = await this.#ask(request.message, name, property);
      if (answer === CANCEL) return CANCELLED;
      if (answer === UNRENDERABLE) {
        // Optional and unrenderable is a field to leave out; required and
        // unrenderable is a question this Client cannot put to the user.
        if (required.includes(name)) return DECLINED;
        continue;
      }
      content[name] = answer;
    }
    return { action: "accept", content };
  }

  /**
   * URL elicitations are the only ones that carry an id to complete, and this
   * Client never opens one — there is no open form this could be about.
   */
  completeElicitation(): void {}

  async #ask(
    message: string,
    name: string,
    property: acp.ElicitationPropertySchema,
  ): Promise<Answer> {
    const label = clampForDisplay(typeof property.title === "string" ? property.title : name, MAX_LABEL_CHARS);
    const described = typeof property.description === "string" ? property.description : label;
    const prompt = clampForDisplay(described, MAX_DETAIL_CHARS);
    // Agent-supplied, like every option label below it.
    const options = { title: clampForDisplay(message, MAX_LABEL_CHARS), prompt, placeHolder: prompt };

    // The SDK's own guards narrow these: a property whose payload does not
    // validate is one we cannot render, which is the same answer as a type we
    // have never heard of.
    if (ElicitationPropertySchema.isBoolean(property)) {
      const choice = await this.#host.pick([{ label: "Yes" }, { label: "No" }], options);
      return choice === undefined ? CANCEL : choice.label === "Yes";
    }
    if (ElicitationPropertySchema.isString(property)) {
      const choices = enumChoices(property.enum, property.oneOf);
      // Choices were offered but cannot be presented: a free-text box in their
      // place would accept anything, which is not the question that was asked.
      if (!choices && (property.enum ?? property.oneOf)) return UNRENDERABLE;
      if (choices) {
        const choice = await this.#host.pick(choices, options);
        return choice === undefined ? CANCEL : (choice.description ?? choice.label);
      }
      // The Agent's `pattern` is displayed rather than enforced. Enforcing it
      // means running an Agent-supplied regular expression on the editor's UI
      // thread, per keystroke, where one that backtracks catastrophically —
      // `^(a+)+$` against a rejecting input — freezes the window for as long as
      // it likes. The Agent validates its own answer; the user is told the shape.
      const expected = typeof property.pattern === "string" ? property.pattern : undefined;
      const answer = await this.#host.input({
        ...options,
        ...(expected
          ? { prompt: clampForDisplay(`${options.prompt} (expected form: ${expected})`, MAX_DETAIL_CHARS) }
          : {}),
        ...(typeof property.default === "string" ? { value: property.default } : {}),
        validateInput: (value) => textComplaint(value, property),
      });
      return answer ?? CANCEL;
    }
    if (ElicitationPropertySchema.isNumber(property) || ElicitationPropertySchema.isInteger(property)) {
      const integer = property.type === "integer";
      const answer = await this.#host.input({
        ...options,
        ...(typeof property.default === "number" ? { value: String(property.default) } : {}),
        validateInput: (value) => numberComplaint(value, integer, property),
      });
      if (answer === undefined) return CANCEL;
      // The input box refuses this on the way in; checked again on the way out,
      // because `NaN` is not a value any agent can be sent.
      const parsed = Number(answer);
      return Number.isFinite(parsed) ? parsed : CANCEL;
    }
    if (ElicitationPropertySchema.isArray(property)) {
      // Either spelling of the item list, read without assuming which one this is.
      const items: Record<string, unknown> = { ...property.items };
      const choices = enumChoices(items.enum, items.anyOf);
      if (!choices) return UNRENDERABLE;
      const picked = await this.#host.pickMany(choices, { ...options, canPickMany: true });
      return picked === undefined ? CANCEL : picked.map((item) => item.description ?? item.label);
    }
    // A property type this Client has no input for — including one ACP adds later.
    return UNRENDERABLE;
  }
}

/**
 * Choices for a select, from either spelling ACP allows. The value the Agent
 * gets is carried in `description`, so a titled option answers with its `const`
 * rather than with the words the user read.
 */
function enumChoices(
  values: unknown,
  titled: unknown,
): QuickItem[] | undefined {
  if (Array.isArray(values) && values.length > MAX_CHOICES) return undefined;
  if (Array.isArray(titled) && titled.length > MAX_CHOICES) return undefined;
  if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
    return values.map((value: string) => ({
      label: clampForDisplay(value, MAX_LABEL_CHARS),
      description: value,
    }));
  }
  if (Array.isArray(titled)) {
    const options = titled as acp.EnumOption[];
    return options.map((option) => ({
      label: clampForDisplay(option.title, MAX_LABEL_CHARS),
      description: option.const,
    }));
  }
  return undefined;
}

function textComplaint(value: string, property: acp.StringPropertySchema): string | undefined {
  if (typeof property.minLength === "number" && value.length < property.minLength) {
    return `at least ${property.minLength} characters`;
  }
  if (typeof property.maxLength === "number" && value.length > property.maxLength) {
    return `at most ${property.maxLength} characters`;
  }
  return undefined;
}

function numberComplaint(
  value: string,
  integer: boolean,
  bounds: { minimum?: number | null; maximum?: number | null },
): string | undefined {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) return "expected a number";
  if (integer && !Number.isInteger(parsed)) return "expected a whole number";
  if (typeof bounds.minimum === "number" && parsed < bounds.minimum) {
    return `at least ${bounds.minimum}`;
  }
  if (typeof bounds.maximum === "number" && parsed > bounds.maximum) {
    return `at most ${bounds.maximum}`;
  }
  return undefined;
}
