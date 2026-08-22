import { message, resolveRuntime } from "../core/index.js";
import type { RuntimeSetting } from "./config.js";
import type { QuickItem } from "./elicitation.js";
import { report, shownName } from "./wizardAsk.js";
import type { Connection, SettingsScope, WizardPorts } from "./wizardPorts.js";

/**
 * The last stage of the connection wizard: writing it down.
 *
 * Apart from the questions it asks, because what is written is where the
 * damage lives. Two rules run through all of it. What the wizard did not decide
 * is not the wizard's to remove — a Runtime's hand-written suppression plan, its
 * safe-mode flag, an earlier secret reference — so an entry is merged, never
 * replaced. And the approval recorded must be the identity a Session start will
 * derive from these settings, which is checked afterwards rather than assumed
 * (ADR-0007).
 */

/**
 * Keeps everything about a Runtime the wizard never asked about.
 *
 * Connecting a Runtime a second time — which ADR-0007 requires after any change
 * to its launch identity, so after every CLI upgrade — must not be how a user
 * loses the plan that made it eligible for orchestration, or the reference to
 * the key it authenticates with.
 */
export function mergeEntry(
  existing: RuntimeSetting | undefined,
  connected: RuntimeSetting,
): RuntimeSetting {
  if (!existing) return connected;
  const secretEnvironment = { ...existing.secretEnvironment, ...connected.secretEnvironment };
  return {
    ...existing,
    ...connected,
    ...(Object.keys(secretEnvironment).length > 0 ? { secretEnvironment } : {}),
  };
}

/** Writes the connection, then the approval. Settings without an approval refuse
 *  to launch, which is the direction a half-finished write should fail in. */
export async function saveConnection(ports: WizardPorts, state: Connection): Promise<void> {
  if (!state.trust) throw new Error("nothing was approved for this runtime");
  const name = shownName(state.spec.displayName);
  const scope = await chooseScope(ports);
  try {
    const existing = ports.settings.runtimesAt(scope);
    await ports.settings.writeRuntimes(
      { ...existing, [state.spec.id]: mergeEntry(existing[state.spec.id], state.entry) },
      scope,
    );
    // Inside the same guard: a failure to record the approval is the same kind
    // of failure as one to write the settings, and reporting it as a CLI that
    // could not connect would send the user to fix the wrong thing.
    await ports.recordTrust(state.spec.id, state.trust);
  } catch (error) {
    // Its own kind, so the flow reports it as what it is: everything up to here
    // worked, and "could not connect" would send the user back to fix a CLI
    // that is fine.
    throw new NotSaved(`${name} works, but its connection could not be saved: ${message(error)}`);
  }
  report(ports, state, `${name} connected.`);
  // Checked before the default is offered: pointing new sessions at a Runtime
  // that will not start as approved is worse than leaving the default alone.
  if (await launchesAsApproved(ports, state)) await offerDefault(ports, state, scope);
}

/**
 * Where to write it. The workspace scope is offered only where there is a
 * workspace: VS Code throws on a workspace write with no folder open, and an
 * offer that cannot be honoured would throw away a connection that worked.
 */
async function chooseScope(ports: WizardPorts): Promise<SettingsScope> {
  if (!ports.settings.workspaceOpen()) {
    ports.say("No folder is open, so this connection is saved for every workspace.");
    return "global";
  }
  const items: QuickItem[] = [
    { label: "User", description: "Available in every workspace" },
    { label: "Workspace", description: "Only in this folder" },
  ];
  const chosen = await ports.form.pick(items, {
    title: "Where to save this connection",
    placeHolder: "Settings scope",
    ignoreFocusOut: true,
  });
  if (!chosen) throw new CancelledSave();
  return items.indexOf(chosen) === 0 ? "global" : "workspace";
}

/** Cancelling the scope question is cancelling the wizard; the wizard's own
 *  sentinel is not exported, so this one stands in for it. */
export class CancelledSave extends Error {}

/** A connection that passed every stage and could not be written down. */
export class NotSaved extends Error {}

/**
 * Offers to point new sessions at what was just connected.
 *
 * Without this, connecting anything but the default leaves `defaultRuntime`
 * naming a Runtime nobody approved: the next chat turn is refused and tells the
 * user to run the wizard they have just finished.
 */
async function offerDefault(
  ports: WizardPorts,
  state: Connection,
  scope: SettingsScope,
): Promise<void> {
  const name = shownName(state.spec.displayName);
  if (ports.settings.defaultRuntime() === state.spec.id) return;
  const answer = await ports.consent.ask(
    `Start new sessions on ${name}?`,
    {
      modal: true,
      detail:
        `New chat sessions currently start on "${shownName(ports.settings.defaultRuntime())}",` +
        " which may not be connected. You can always switch with /runtime.",
    },
    `Use ${name}`,
  );
  if (!answer) {
    report(ports, state, `Pick ${name} in chat with /runtime.`);
    return;
  }
  // A failure here costs a default, not a connection: the Runtime is saved and
  // approved either way, and /runtime still reaches it.
  await ports.settings
    .writeDefaultRuntime(state.spec.id, scope)
    .catch((error: unknown) => report(ports, state, `The default runtime was not changed: ${message(error)}`));
}

/**
 * Whether the approval just recorded is the identity these settings produce.
 *
 * It can differ: a setting written at one scope loses to the same key at a
 * higher one, so a connection saved for every workspace can be overridden by a
 * folder's own entry that was already there. The Runtime then resolves to
 * something the user never approved and is refused at the first turn — correct,
 * but baffling unless it is said here, while they are still looking at the
 * wizard.
 *
 * Read back from settings rather than reasoned about: what a setting is worth
 * after a write is VS Code's answer, not ours.
 */
async function launchesAsApproved(ports: WizardPorts, state: Connection): Promise<boolean> {
  const spec = ports.runtimes().find((candidate) => candidate.id === state.spec.id);
  const effective = spec
    ? await resolveRuntime(spec, { executable: ports.executable }).then(
        (runtime) => runtime.fingerprint,
        () => undefined,
      )
    : undefined;
  if (effective === state.trust?.fingerprint) return true;
  // Deliberately vague about the cause, because several produce it: another
  // scope defining the same Runtime, an entry that no longer validates, one
  // that is disabled. Naming one of them would send the user to the wrong file.
  report(
    ports,
    state,
    `${state.spec.id} will not launch as approved: something in agentConductor.runtimes` +
      " still describes it differently — check your settings scopes for another entry.",
  );
  return false;
}
