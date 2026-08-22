import type * as acp from "@agentclientprotocol/sdk";
import type * as vscode from "vscode";
import { methods } from "@agentclientprotocol/sdk";
import { REORDERING, type PermissionPort } from "../core/index.js";

/**
 * Consent routing for everything an Agent asks a human to approve.
 *
 * Two kinds of question arrive here and they are not interchangeable. The
 * Client's own filesystem and terminal work is keyed by **Client Operation** —
 * derived from the ACP method and its normalized arguments — and that key is what
 * automatic policy is written against. An Agent's *own* tool call arrives through
 * `session/request_permission` carrying a `ToolKind`; that value is chosen by the
 * Agent, so it is shown and never decided on. No automatic policy applies to it:
 * there is no Client Operation to key one by, and the harness itself remembers
 * the `_always` option we hand back (ADR-0007).
 *
 * None of this confines the Agent process. It is consent and audit.
 */

/** Client Operations, exactly as the settings enum lists them. */
export const CLIENT_OPERATIONS = [
  "fs.read",
  "fs.write",
  "terminal.spawn",
  "terminal.wait",
  "terminal.kill",
  "terminal.release",
] as const;

export type ClientOperation = (typeof CLIENT_OPERATIONS)[number];

const OPERATION_BY_METHOD: Record<string, ClientOperation> = {
  [methods.client.fs.readTextFile]: "fs.read",
  [methods.client.fs.writeTextFile]: "fs.write",
  [methods.client.terminal.create]: "terminal.spawn",
  [methods.client.terminal.waitForExit]: "terminal.wait",
  [methods.client.terminal.kill]: "terminal.kill",
  [methods.client.terminal.release]: "terminal.release",
};

/**
 * The Client Operation a method authorizes under, or `undefined` when the method
 * is not one the Client performs on the Agent's behalf.
 *
 * `terminal/output` has no key of its own: it reads back a buffer produced by a
 * command already authorized at `terminal.spawn`, so a second question about the
 * same command would be theatre.
 */
export function clientOperation(method: string): ClientOperation | undefined {
  return OPERATION_BY_METHOD[method];
}

/** What each operation is called when a human is asked about it. */
const OPERATION_VERB: Record<ClientOperation, string> = {
  "fs.read": "read a file",
  "fs.write": "write to a file",
  "terminal.spawn": "run a command",
  "terminal.wait": "wait for a command to finish",
  "terminal.kill": "kill a running command",
  "terminal.release": "release a terminal",
};

/**
 * Consent as its callers need it. Two questions, because they are different
 * questions: whether to *start* something, which a human may have to answer, and
 * whether a follow-up to something already consented to is still allowed, which
 * only policy answers.
 */
export interface Consent {
  /** Consent for an operation, asking the user when policy has no opinion. */
  authorize(operation: ClientOperation, detail: string): Promise<boolean>;
  /** Policy-only: does an explicit rejection stand against this operation? */
  permits(operation: ClientOperation): boolean;
}

export interface PermissionPolicy {
  /** Operations approved without asking. */
  autoAllow: readonly ClientOperation[];
  /** Operations refused without asking. Wins over `autoAllow` (see config). */
  autoReject: readonly ClientOperation[];
  /** Whether an "always" answer holds for the rest of the Session. */
  rememberAlwaysChoices: boolean;
}

/** Options for the modal below; the keys are checked against VS Code's own. */
export interface ConsentOptions {
  modal: true;
  detail: string;
}

/**
 * Modal consent. Shaped as the call it stands for:
 * `vscode.window.showWarningMessage(message, { modal: true, detail }, ...choices)`.
 */
export interface ConsentHost {
  ask(
    message: string,
    options: ConsentOptions,
    ...choices: string[]
  ): PromiseLike<string | undefined>;
}

const ALLOW_ONCE = "Allow";
const ALLOW_ALWAYS = "Always allow";
const REJECT_ONCE = "Reject";
const REJECT_ALWAYS = "Always reject";

/** Agent-supplied strings reach a modal; bound what one can put in front of a user. */
export const MAX_LABEL_CHARS = 80;
/** Everything a single consent dialog will show. Callers that compose a detail
 *  from several parts size those parts against this. */
export const MAX_DETAIL_CHARS = 2_000;

export class PermissionRouter implements PermissionPort, Consent {
  readonly #policy: PermissionPolicy;
  readonly #host: ConsentHost;
  readonly #label: string;
  /** "Always" answers, keyed by Client Operation — the only key policy uses. */
  readonly #remembered = new Map<ClientOperation, boolean>();

  constructor(policy: PermissionPolicy, host: ConsentHost, label = "The agent") {
    this.#policy = policy;
    this.#host = host;
    // A custom Runtime's display name is its settings key, so it is as
    // unbounded and as free-form as anything else settings hold — and it leads
    // every dialog this router writes.
    this.#label = oneLine(label, MAX_LABEL_CHARS);
  }

  /**
   * Consent for one Client Operation. `detail` is the normalized argument the
   * caller resolved — the real path, the command line — never the Agent's own
   * description of what it is doing.
   *
   * Fails closed: a dismissed dialog is a refusal.
   */
  async authorize(operation: ClientOperation, detail: string): Promise<boolean> {
    if (this.#policy.autoReject.includes(operation)) return false;
    if (this.#policy.autoAllow.includes(operation)) return true;
    const remembered = this.#remembered.get(operation);
    if (remembered !== undefined) return remembered;

    const answer = await this.#host.ask(
      `${this.#label} wants to ${OPERATION_VERB[operation]}`,
      { modal: true, detail: clampForDisplay(detail, MAX_DETAIL_CHARS) },
      ALLOW_ONCE,
      ALLOW_ALWAYS,
      REJECT_ONCE,
      REJECT_ALWAYS,
    );
    const always = answer === ALLOW_ALWAYS || answer === REJECT_ALWAYS;
    const allowed = answer === ALLOW_ONCE || answer === ALLOW_ALWAYS;
    if (always && this.#policy.rememberAlwaysChoices) this.#remembered.set(operation, allowed);
    return allowed;
  }

  /**
   * Whether a follow-up to an already-authorized operation may proceed: waiting
   * for, killing, or releasing a command the user let start. Consent for the
   * command was given when it started, so silence here is not a new question —
   * but an operation the user auto-rejected stays rejected.
   */
  permits(operation: ClientOperation): boolean {
    return !this.#policy.autoReject.includes(operation);
  }

  /**
   * Consent for a tool the *Agent* runs itself. Always asked: the options and
   * their `_always` kinds belong to the Agent, which is also what remembers them,
   * and `toolCall.kind` is a label rather than an authorization input.
   */
  async requestPermission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const options = request.options ?? [];
    // Nothing to consent to is not consent.
    if (options.length === 0) return { outcome: { outcome: "cancelled" } };

    // Labels are Agent-supplied: clamped for display, and kept unique so the
    // answer maps back to exactly the option the user saw.
    const byLabel = new Map<string, acp.PermissionOptionId>();
    for (const option of options) {
      let label = clampForDisplay(option.name, MAX_LABEL_CHARS);
      for (let n = 2; byLabel.has(label); n += 1) label = `${clampForDisplay(option.name, MAX_LABEL_CHARS)} (${n})`;
      byLabel.set(label, option.optionId);
    }

    const answer = await this.#host.ask(
      // The Agent's own words, said to be the Agent's. Its title is the whole
      // headline otherwise, and a headline can be written to read as ours.
      `${this.#label} asks: ${oneLine(request.toolCall.title ?? "to do something it did not describe", MAX_LABEL_CHARS)}`,
      { modal: true, detail: describeToolCall(request.toolCall) },
      ...byLabel.keys(),
    );
    const optionId = answer === undefined ? undefined : byLabel.get(answer);
    return optionId === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } };
  }
}

/**
 * What the Agent says it is about to do, marked as its own account of it.
 *
 * Every part is bounded on its own and printed on one line, as a command's
 * environment is: a long first path must not be how the second one goes unread,
 * and no part may write a line this Client did not (ARCHITECTURE §Client
 * services).
 */
function describeToolCall(toolCall: acp.ToolCallUpdate): string {
  const lines: string[] = [];
  if (toolCall.kind) lines.push(`Tool kind: ${oneLine(toolCall.kind, MAX_LABEL_CHARS)} (reported by the agent)`);
  const all = toolCall.locations ?? [];
  const shown = all.slice(0, MAX_LOCATIONS).map((location) => oneLine(location.path, MAX_PATH_CHARS));
  if (shown.length > 0) {
    // The count is said when not all of them are: an agent choosing how many to
    // send must not thereby choose how many go unmentioned.
    lines.push(
      all.length > shown.length
        ? `${shown.join("\n")}\n…and ${all.length - shown.length} more the agent listed`
        : shown.join("\n"),
    );
  }
  return clampForDisplay(lines.join("\n\n") || "The agent did not describe this action.", MAX_DETAIL_CHARS);
}

/** Enough of a path to recognise it, bounded so that a list of them stays a
 *  list rather than becoming one path and a truncation. */
const MAX_PATH_CHARS = 120;
/** How many of them a dialog shows before it says how many more there are. */
const MAX_LOCATIONS = 12;

/** Bounds an Agent-supplied string on its way to a dialog. */
export function clampForDisplay(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // A caller that spent its budget on its own sentences first can arrive with
  // nothing left, and `slice` counts a negative end from the end of the string —
  // so without this a budget of -1 lets all but two characters through, which is
  // the one case a bound exists for.
  return limit >= 1 ? `${text.slice(0, limit - 1)}…` : "";
}

/** Compile-time assertion: `Assert<false>` is a type error. */
export type Assert<T extends true> = T;

/** Option keys this Client sets that the VS Code call would not read. */
export type Unread<Options, HostOptions> = Exclude<keyof Options, keyof HostOptions>;

/** The consent dialog is the call it stands for; see `FormPortsMatchVsCodeApi`
 *  for what these checks are worth and why the keys are checked too. */
export type ConsentPortMatchesVsCodeApi = [
  Assert<typeof vscode.window.showWarningMessage extends ConsentHost["ask"] ? true : false>,
  Assert<[Unread<ConsentOptions, vscode.MessageOptions>] extends [never] ? true : false>,
  // This tuple's own self-test: a key the dialog would not read must be caught
  // here too, so deleting the other tuple cannot leave this check unproven.
  Assert<[Unread<{ isModal: unknown }, vscode.MessageOptions>] extends [never] ? false : true>,
];

// ---------------------------------------------------------------------------
// What a command's approval dialog says. Kept beside the dialog itself, because
// the budgets below are only meaningful against `MAX_DETAIL_CHARS`: the parts
// have to add up to less than the whole a person is shown.
// ---------------------------------------------------------------------------

// Agent-supplied text reaches a consent dialog. Each part of that dialog gets
// its own budget: one clamp over the whole thing would let a padded environment
// push the command line — the one thing being approved — off the end of it.
// The budgets sum to less than the dialog's own limit, so nothing is crowded out.
export const MAX_COMMAND_CHARS = 600;

/** Said in every command dialog, whether or not the Agent set a variable. */
export const INHERITS_ENVIRONMENT = "It also inherits this window's own environment.";
export const MAX_CWD_CHARS = 240;
const MAX_ENV_NAME_CHARS = 40;
const MAX_ENV_VALUE_CHARS = 80;
/**
 * What the user is approving. The command comes first, because it is the thing
 * being decided on; the directory and the environment follow. Every
 * Agent-supplied part is rendered on one line, so none of them can forge a line
 * this Client writes.
 *
 * Shown in full or refused, and that goes for the command as much as for the
 * environment — see `environmentLines`. A command line cut at a budget lets the
 * Agent choose the part nobody reads: forty harmless flags and then the one that
 * matters, and the user approves something they were never shown.
 */
export function commandDetail(
  cwd: string,
  variables: acp.EnvVariable[] = [],
  commandLine: string,
  budget: number,
): string {
  const rest = [
    "",
    `Directory: ${oneLine(cwd, MAX_CWD_CHARS)}`,
    // Above the list: a list of two reads as the whole environment, when what
    // runs also has everything this window was started with — which on the
    // machine somebody develops on is where their credentials are. Last, it
    // would be the part a padded environment pushed off the end.
    INHERITS_ENVIRONMENT,
    ...environmentLines(variables, budget),
  ];
  // The command gets everything the rest of the dialog does not need, and the
  // environment's own ceiling is what guarantees that is never less than
  // `MAX_COMMAND_CHARS`. A fixed share would refuse a test runner given a
  // monorepo's worth of paths — ordinary, and nothing an Agent gains by.
  const command = oneLine(commandLine, commandLine.length);
  const room = MAX_DETAIL_CHARS - rest.join("\n").length - 1;
  if (command.length > room) {
    throw new Error(
      `terminal.spawn: refused — the command line is ${command.length} characters and only ${room}` +
        " can be shown for approval; a command that cannot be described in full is not one to approve",
    );
  }
  return [command, ...rest].join("\n");
}

/**
 * The variables the command would run with, all of them.
 *
 * A dialog that showed the first few and counted the rest would let the Agent
 * choose which one the user does not read — eight lines of locale settings and a
 * footnote, with `NODE_OPTIONS` inside the footnote. So when the environment does
 * not fit in a dialog a person will actually read, the command is refused rather
 * than described in part. The bound is on size, not count: a command setting a
 * dozen short variables is fine, one hiding behind padded names is not.
 */
function environmentLines(variables: acp.EnvVariable[], budget: number): string[] {
  const lines = variables.map(
    (variable) =>
      `${oneLine(variable.name, MAX_ENV_NAME_CHARS)}=${oneLine(variable.value, MAX_ENV_VALUE_CHARS)}`,
  );
  const shown = lines.reduce((total, line) => total + line.length + 1, 0);
  if (shown > budget) {
    throw new Error(
      `terminal.spawn: refused — ${variables.length} environment variable(s) are more than can be` +
        " shown for approval; a command whose environment cannot be described is not one to approve",
    );
  }
  return lines;
}

/**
 * One line of somebody else's text, ready to sit inside a line this Client
 * wrote (UBIQUITOUS.md: Sealing).
 *
 * A modal is a list of lines, so a value holding a newline can write lines of
 * its own — a plausible-looking end of the dialog, then blank space, then the
 * variable nobody scrolled to.
 *
 * The characters that reorder text go with them, and are removed rather than
 * escaped because there is no escaping them: a right-to-left override draws the
 * rest of its line backwards, so a value ending in one decides how this
 * Client's own words beside it read. Text that meant them loses them, and that
 * is the right trade here — a path or an argument in Hebrew or Arabic still
 * renders from its own letters, and this dialog is the last thing shown before
 * a command runs or a launch is trusted (ADR-0007), so a line that reads a
 * little differently beats a line that reads as something else.
 *
 * Exported because the approval dialog needs the same rule without a limit:
 * two copies of it are how one of them came to be missing what the other had.
 */
export function flatLine(text: string): string {
  return text.replace(REORDERING, "").replace(/\s+/g, " ").trim();
}

/**
 * One line of at most `limit` characters, whatever the Agent sent. Arguments
 * that a shell would have needed quotes for keep them, so what the user reads
 * still says where one argument ends and the next begins.
 */
function oneLine(text: string, limit: number): string {
  return clampForDisplay(flatLine(text), limit);
}

/** The command line as the user should read it: one argument, one word. */
export function commandLineOf(command: string, args: string[]): string {
  // Sealed a word at a time and before quoting, not over the finished line:
  // `quoted` decides on the characters a shell would need quotes for, and a
  // control about to be removed must not be what puts an argument in quotes it
  // never needed. The whitespace inside an argument is left as it is — this
  // line is what is being approved, and `quoted` already keeps it one word.
  return [command, ...args].map((word) => quoted(word.replace(REORDERING, ""))).join(" ");
}

function quoted(word: string): string {
  // `+`, not `*`: an empty argument is a word too, and rendering it as nothing
  // would show a command line that is not the one being run.
  return /^[\w./:=@+-]+$/.test(word) ? word : JSON.stringify(word);
}
