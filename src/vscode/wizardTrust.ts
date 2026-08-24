import { resolveRuntime, stableJson, type ResolvedRuntime, type SuppressionPlan } from "../core/index.js";
import { commandLineOf, flatLine as flat, MAX_DETAIL_CHARS } from "./permissions.js";
import { shownName } from "./wizardAsk.js";
import type { Connection, WizardPorts } from "./wizardPorts.js";

/**
 * What the user is shown before they approve a launch identity, and the rule
 * that keeps it honest.
 *
 * Runtime Trust covers the artifact, the whole launch specification — arguments
 * and environment — the per-session policy, and any Suppression Plan riding
 * along (ADR-0007). All of that can come from settings, and `agentConductor.
 * runtimes` can be set by a workspace, so a repository can supply part of it. This
 * prompt is the user's only defence, so it shows every part of what it is
 * asking about, and refuses to ask at all rather than describe it in part:
 * whoever supplied a value must not get to choose which one nobody reads.
 */

/** The one part with a budget of its own: a plan's `session/new` payload, which
 *  is refused above this rather than shown in part. Everything else shares
 *  what a dialog holds, and the whole thing fits or is refused. */
const MAX_META_CHARS = 600;

// `flat` is imported rather than written again: a dialog is a list of lines, and
// a value that can write one of its own — with a newline, or with a control that
// draws the rest of the line backwards — chooses what the user reads. The
// sibling consent dialog needs exactly that, and two copies of the rule is how
// one of them came to be missing what the other had. Only its clamp is left
// behind: nothing here truncates, because what is too long to show is refused.

/**
 * The approval dialog's body: everything the fingerprint covers.
 *
 * Throws rather than truncating. A launch whose environment or policy payload
 * cannot be shown in full is one nobody can meaningfully approve, and the
 * failure names which part was too large so it can be fixed in settings.
 */
export function identityDetail(runtime: ResolvedRuntime, plan?: SuppressionPlan): string {
  const meta = plan?.sessionMeta ? stableJson(plan.sessionMeta) : undefined;
  if (meta !== undefined && meta.length > MAX_META_CHARS) {
    throw new Error(
      `runtime ${runtime.id}: its suppression plan sends ${meta.length} characters of session` +
        " metadata, more than can be shown for approval — shorten it in settings",
    );
  }
  // Nothing here is trimmed. A repository can supply the command, the arguments
  // and the environment through its own workspace settings, so a budget spent on
  // one must not be taken from another: it all fits, or there is no dialog.
  const environment = Object.entries(runtime.launch.env).map(
    ([name, value]) => ({ name, value }),
  );
  const detail = [
    "An agent runs with your own permissions. Read this before approving it.",
    // Quoted the way the terminal prompt quotes: an argument with a space in it
    // must not read as two.
    `Command: ${commandLineOf(runtime.launch.command, runtime.launch.args)}`,
    authenticationLine(runtime),
    ...suppressionLines(runtime, plan, meta),
    runtime.artifactVerified
      ? "Approval covers this file, though not the code it loads: replacing it asks again."
      : "This file could not be read for a digest, so approval covers its path only.",
    // Names and the keys behind them, never a value: which variable a stored
    // secret fills is settings a workspace can write, so it is part of what is
    // being approved — the secret itself never is (ADR-0010).
    ...secretReferenceLines(runtime.secretEnvironment ?? {}),
    `Environment:${environment.length > 0 ? "" : " (none)"}`,
    ...environment.map(({ name, value }) => `${flat(name)}=${flat(value)}`),
  ].join("\n");
  if (detail.length > MAX_DETAIL_CHARS) {
    throw new Error(
      `runtime ${runtime.id}: its launch is larger than can be shown for approval` +
        ` (${detail.length} characters) — an identity that cannot be described in full is not` +
        " one to approve; shorten its arguments or environment in settings",
    );
  }
  return detail;
}

/**
 * Whether this launch is switched off subscription credentials.
 *
 * Said either way, and said even when the answer is "there is no switch": the
 * policy is part of the fingerprint, and a launch the user replaced silently
 * loses the flag the catalog would have added. On is the default (ADR-0013),
 * so the line for it says what the launch runs on and where the switch is —
 * which also covers a replaced launch, where the switch cannot be applied.
 */
function authenticationLine(runtime: ResolvedRuntime): string {
  const recipe = runtime.subscriptionAuth?.hideArgs ?? [];
  if (recipe.length === 0) return "Subscription authentication: this launch has no switch for it.";
  // Read off the launch, not off the intent: whoever supplied the arguments —
  // the catalog or the user — the line has to agree with the command line shown
  // one row above it, or the dialog argues with itself.
  return recipe.every((argument) => runtime.launch.args.includes(argument))
    ? `Subscription authentication: off, via ${recipe.join(" ")}.`
    : "Subscription authentication: on — runs on the login the CLI already has (ADR-0013)." +
      " claude.hideSubscriptionAuth insists on an API key, for the catalog's own adapter only.";
}

/**
 * What a Suppression Plan would do, in the ways that are not visible in the
 * command line: a `session/new` payload, and an edit inside the repository.
 *
 * The policy is named even where there is no plan, because the policy is part
 * of the fingerprint: a Runtime asked to suppress and unable to is a different
 * identity from one that was never asked, and the two would otherwise read the
 * same here while hashing differently.
 */
function suppressionLines(
  runtime: ResolvedRuntime,
  plan: SuppressionPlan | undefined,
  meta: string | undefined,
): string[] {
  if (!plan) {
    return runtime.policy.suppressBuiltInSubagents
      ? ["Subagent suppression: asked for, and this runtime has no recipe for it."]
      : ["Subagent suppression: off."];
  }
  return [
    "Subagent suppression:",
    ...(meta === undefined ? [] : [`  session metadata: ${meta}`]),
    // "Would", not "does": nothing in this Client makes that edit (ADR-0008), and
    // the line beside this one reads its answer off the launch rather than off
    // the intent for the same reason. Whether this Runtime may be handed work is
    // a separate question, asked separately — saying it here would answer it for
    // the plans that have a workspace file and leave it hanging for the rest.
    ...(plan.workspaceSettings
      ? [
          `  would edit ${flat(plan.workspaceSettings.file)} in this workspace,`,
          `  writing: ${flat(stableJson(plan.workspaceSettings.merge))}`,
        ]
      : []),
  ];
}

/** Which variables come out of secret storage, and from which key. */
function secretReferenceLines(references: Record<string, string>): string[] {
  const entries = Object.entries(references);
  if (entries.length === 0) return [];
  return [
    "Filled from secret storage:",
    ...entries.map(([name, key]) => `  ${flat(name)}=<secret ${flat(key)}>`),
  ];
}

/**
 * Shows what would actually run and asks for approval.
 *
 * The identity is resolved twice on purpose: once for the dialog, and once
 * against the approval just given — which is what a Session start does, so a
 * file replaced while the dialog was open fails closed here rather than later.
 */
export async function approveIdentity(
  ports: WizardPorts,
  state: Connection,
): Promise<ResolvedRuntime> {
  const runtime = await resolveRuntime(state.spec, { executable: ports.executable });
  const approved = await ports.consent.ask(
    `Approve ${shownName(state.spec.displayName)} exactly as it will be launched?`,
    // Not clamped here: `identityDetail` fits the dialog or refuses, and a
    // clamp at this point would silently undo that.
    { modal: true, detail: identityDetail(runtime, state.spec.suppression) },
    "Approve",
  );
  if (!approved) throw new NotApproved(`${state.spec.id} was not approved`);
  state.trust = { fingerprint: runtime.fingerprint };
  return resolveRuntime(state.spec, { executable: ports.executable, trust: state.trust });
}

/** Dismissing the approval is a refusal, and the wizard's own cancellation
 *  sentinel is not exported, so the flow recognises this one. */
export class NotApproved extends Error {}
