import { adapterRemoveCommand, message, type AdapterPackage } from "../core/index.js";
import type { QuickItem } from "./elicitation.js";
import { shownName } from "./wizardAsk.js";
import type { SettingsScope, WizardPorts } from "./wizardPorts.js";

/**
 * Disconnecting a CLI: the reverse of the connection wizard.
 *
 * Connecting writes three things — a settings entry, a Runtime Trust approval,
 * and, for a Runtime with one, an installed Adapter. Leaving any of them behind
 * is what makes a CLI look connected when it is not, so all three are offered
 * here rather than left to a settings file and an `npm` invocation the user has
 * to work out for themselves.
 *
 * The approval goes first, and that ordering is the decision. A half-finished
 * removal has to land on the side that refuses to start an Agent: an entry with
 * no approval is refused at the next turn, and says so, while an approval with
 * no entry would be an identity nobody can see recorded as approved (ADR-0007).
 */

/** What disconnecting needs, which is the wizard's ports minus everything that
 *  exists to start an Agent — nothing here launches one. */
export type DisconnectPorts = Pick<
  WizardPorts,
  "form" | "consent" | "say" | "settings" | "runtimes" | "runInTerminal" | "adapterHome"
> & {
  /** Drops what the user approved for one Runtime, so nothing starts on it
   *  until they take it through the wizard again. */
  forgetTrust(runtimeId: string): Promise<void>;
};

export async function disconnectCli(ports: DisconnectPorts): Promise<void> {
  const scopes: SettingsScope[] = ports.settings.workspaceOpen()
    ? ["global", "workspace"]
    : ["global"];
  const configured = ports.settings.configuredIds();
  if (configured.length === 0) {
    ports.say("No CLI is connected — nothing to disconnect.");
    return;
  }

  const chosen = await choose(ports, configured);
  if (!chosen) return;
  // Read before anything is removed. The catalog is composed from the settings,
  // so the entry this is about stops being in it the moment the entry is gone —
  // and the Adapter to offer back would be read as "there isn't one".
  const spec = ports.runtimes().find((candidate) => candidate.id === chosen);
  const name = shownName(spec?.displayName ?? chosen);
  const adapter = spec?.adapter;

  const confirmed = await ports.consent.ask(
    `Disconnect ${name}?`,
    {
      modal: true,
      detail:
        "Its entry in agentConductor.runtimes and the approval recorded for it are removed." +
        " Sessions already running are not stopped, and the CLI itself is left installed.",
    },
    "Disconnect",
  );
  if (!confirmed) return;

  try {
    await ports.forgetTrust(chosen);
  } catch (error) {
    // Reported, not thrown: an approval that could not be dropped leaves the
    // Runtime startable, and the settings entry below is what stops that.
    ports.say(`The approval for ${name} was not removed: ${message(error)}`);
  }

  for (const scope of scopes) {
    const entries = ports.settings.runtimesAt(scope);
    if (!Object.prototype.hasOwnProperty.call(entries, chosen)) continue;
    const rest = Object.fromEntries(Object.entries(entries).filter(([id]) => id !== chosen));
    try {
      await ports.settings.writeRuntimes(rest, scope);
    } catch (error) {
      // Both scopes are attempted whatever one of them does: a folder whose
      // settings cannot be written must not keep the entry in the other scope.
      ports.say(`${name} was not removed from ${scope} settings: ${message(error)}`);
    }
  }

  if (adapter) await offerAdapterRemoval(ports, adapter, name);
  ports.say(`${name} disconnected.`);
  if (ports.settings.defaultRuntime() === chosen) {
    // Not cleared: nothing here knows which of the others should take its place,
    // and a default silently pointed somewhere else is worse than one that says
    // it is wrong at the next turn.
    ports.say(`New sessions still start on ${name}. Pick another with /runtime.`);
  }
}

/** Which connected CLI to disconnect. Drawn from the settings rather than the
 *  catalog: an entry the settings disable is still connected, and is exactly
 *  the kind nobody can find to remove. */
async function choose(ports: DisconnectPorts, configured: string[]): Promise<string | undefined> {
  const specs = ports.runtimes();
  const items: QuickItem[] = configured.map((id) => {
    const spec = specs.find((candidate) => candidate.id === id);
    return {
      label: shownName(spec?.displayName ?? id),
      description: spec?.adapter ? `${id} — adapter ${spec.adapter.package}` : id,
    };
  });
  const picked = await ports.form.pick(items, {
    title: "Disconnect a CLI",
    placeHolder: "Connected CLIs",
    ignoreFocusOut: true,
  });
  const index = picked ? items.indexOf(picked) : -1;
  return index === -1 ? undefined : configured[index];
}

/**
 * Offers to remove the Adapter this Client installed, and only that.
 *
 * Only an Adapter the catalog names is offered: the CLI itself was the user's
 * to install and stays theirs, and a Runtime whose launch they configured by
 * hand has nothing here that this Client put on the machine.
 */
async function offerAdapterRemoval(
  ports: DisconnectPorts,
  adapter: AdapterPackage,
  name: string,
): Promise<void> {
  let command: string;
  try {
    command = adapterRemoveCommand(adapter, ports.adapterHome());
  } catch (error) {
    // A path or package name this Client will not put in a terminal. The
    // disconnection itself has already happened and stands.
    ports.say(`The adapter for ${name} must be removed by hand: ${message(error)}`);
    return;
  }
  const answer = await ports.consent.ask(
    `Remove the adapter ${adapter.package}?`,
    {
      modal: true,
      detail:
        `It was installed by this extension, into its own directory, and nothing else uses it.` +
        " Leaving it costs disk space and nothing else.",
    },
    "Remove",
  );
  if (!answer) return;
  // In a terminal the user watches, exactly as the install was. Nothing here
  // waits for it: the settings and the approval are already gone, and a package
  // manager that takes its time is not a disconnection that failed.
  ports.runInTerminal("Agent Conductor uninstall", command);
}
