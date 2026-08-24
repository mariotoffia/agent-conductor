import {
  adapterInstallCommand,
  detectRuntimes,
  message,
  type RuntimeDetection,
  type RuntimeSpec,
} from "../core/index.js";
import type { RuntimeSetting } from "./config.js";
import type { QuickItem } from "./elicitation.js";
import { WAYS_CHARS, clampForDisplay, MAX_DETAIL_CHARS, MAX_LABEL_CHARS } from "./permissions.js";
import { ask, Cancelled, pickIndex, report, shownName } from "./wizardAsk.js";
import { plainText } from "./sealing.js";
import type { Connection, WizardPorts } from "./wizardPorts.js";
import {
  acknowledgeFanOut,
  choosePicker,
  runAndWait,
  smokeTest,
  startProbe,
} from "./wizardProbe.js";
import { approveIdentity, NotApproved } from "./wizardTrust.js";
import { CancelledSave, mergeEntry, NotSaved, saveConnection } from "./wizardSettings.js";

/**
 * The Connect-a-CLI wizard: detect, configure, approve the launch identity, hand
 * authentication back to the CLI that owns it, read Config Options, agree the
 * policy, prove one Turn works, and only then write anything down.
 *
 * Two rules shape the flow. Nothing is persisted until a Probe Session has
 * actually answered — an approval recorded for a Runtime that never started is
 * an identity nobody proved (ADR-0007). And every step is cancellable:
 * dismissing any question ends the run having written nothing.
 */

const ADD_CUSTOM = "Add a custom ACP agent…";

export async function connectCli(ports: WizardPorts): Promise<void> {
  // Held outside the try so the catch can redact against it: what ends a run
  // carries the Agent's own words as often as what it says while running, and
  // all of it reaches a log file (ADR-0010).
  let state: Connection | undefined;
  try {
    if (!ports.workspaceTrusted()) {
      throw new Error(
        "this workspace is not trusted, and connecting a CLI starts it — trust the workspace first",
      );
    }
    state = await chooseRuntime(ports);
    const runtime = await approveIdentity(ports, state);
    const probe = await startProbe(ports, state, runtime, async (changed) => {
      // Composed through the catalog again, then approved again: the same two
      // steps the first identity went through.
      const respecced = respec(ports, changed.spec.id, changed.entry);
      changed.spec = respecced.spec;
      return approveIdentity(ports, changed);
    });
    try {
      await choosePicker(ports, state, probe, "model");
      await choosePicker(ports, state, probe, "effort");
      await acknowledgeFanOut(ports, state);
      await smokeTest(ports, state, probe);
    } finally {
      // Closed before anything is saved: the probe's Agent process has served
      // its purpose, and the next thing that starts one should be the user. A
      // failure to clean up is not a reason to throw away a connection that
      // worked, so it is reported rather than raised.
      await probe.close().catch((error: unknown) => {
        report(ports, state, `The probe session did not shut down cleanly: ${message(error)}`);
      });
    }
    await saveConnection(ports, state);
  } catch (error) {
    if (error instanceof Cancelled || error instanceof CancelledSave || error instanceof NotApproved) {
      ports.say("Connection cancelled — nothing was saved.");
      return;
    }
    // A CLI that worked and could not be written down is not a CLI that failed.
    report(ports, state, error instanceof NotSaved ? message(error) : `Could not connect: ${message(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Detect, install, configure
// ---------------------------------------------------------------------------

async function chooseRuntime(ports: WizardPorts): Promise<Connection> {
  const listed = ports.runtimes();
  const known = new Set(listed.map((spec) => spec.id));
  // Runtimes the settings disable are absent from the catalog, so connecting
  // one would otherwise mean hand-editing settings to find it again.
  const disabled = ports.settings
    .configuredIds()
    .filter((id) => !known.has(id))
    .flatMap((id) => enabledAgain(ports, id));
  const detected = await detectRuntimes([...listed, ...disabled.map((entry) => entry.spec)], {
    executable: ports.executable,
  });
  const off = new Set(disabled.map((entry) => entry.spec.id));
  const items: QuickItem[] = detected.map((entry) => ({
    label: `${entry.runtime ? "✓" : "✗"} ${clampForDisplay(entry.spec.displayName, MAX_LABEL_CHARS)}`,
    // A Runtime that cannot launch is listed with the reason rather than hidden:
    // "not found — install it" is an answer, and a silent absence is not.
    description: clampForDisplay(
      off.has(entry.spec.id)
        ? "disabled in settings — connecting turns it back on"
        : entry.runtime?.launch.command ?? entry.problem ?? "",
      MAX_DETAIL_CHARS,
    ),
  }));
  items.push({ label: ADD_CUSTOM, description: "Any ACP agent already installed on this machine" });

  const at = await pickIndex(ports, items, {
    title: "Connect a CLI",
    placeHolder: "Pick the agent CLI to connect",
  });
  if (at === items.length - 1) return customRuntime(ports);

  const chosen = detected[at];
  if (!chosen) throw new Cancelled();
  // Turning it back on is this run's decision, so it is what gets written.
  const decided = disabled.find((entry) => entry.spec.id === chosen.spec.id)?.decided ?? {};
  // A Runtime that already resolves needs no configuring. Anything else settings
  // say about it is preserved when this is saved, and is already part of the
  // identity about to be approved.
  if (chosen.runtime) return { spec: chosen.spec, entry: decided, secretEnvironment: {} };
  return notReady(ports, chosen);
}

/**
 * What the catalog knows about making this Runtime runnable, as dialog text.
 *
 * Catalog constants, so nothing here is a repository's to write. Installing is
 * shown only where this Client has no Adapter to offer instead, and setting up
 * only where being installed is not enough (ADR-0007: a CLI is the user's to
 * install, and we say how rather than doing it).
 */
export function ourWays(spec: Pick<RuntimeSpec, "install" | "setup">): string {
  const block = (heading: string, lines?: string[]): string =>
    lines && lines.length > 0 ? `${heading}\n${lines.join("\n")}\n\n` : "";
  return (
    block("Install it with one of:", spec.install) +
    block("Once installed, it also needs:", spec.setup)
  );
}

/** A disabled Runtime as it would be with the switch flipped, so the wizard can
 *  offer it and approve the identity it would actually launch under. */
function enabledAgain(
  ports: WizardPorts,
  id: string,
): { spec: RuntimeSpec; decided: RuntimeSetting }[] {
  const decided: RuntimeSetting = { enabled: true };
  const entry = mergeEntry(ports.settings.runtimeEntry(id), decided);
  const spec = ports.runtimes({ id, entry }).find((candidate) => candidate.id === id);
  return spec ? [{ spec, decided }] : [];
}

/** What to do about a Runtime that cannot launch. An Adapter is offered at the
 *  exact version the catalog names — otherwise this is a dead end, since the
 *  reason shown is "install it from the connection wizard". A deliberate,
 *  visible step, never something a Session does (ADR-0007). */
async function notReady(ports: WizardPorts, chosen: RuntimeDetection): Promise<Connection> {
  const { adapter } = chosen.spec;
  const install = adapter ? `Install ${adapter.package}@${adapter.version}` : undefined;
  const enter = "Enter a launch command…";
  // Ours first, the reason second: the reason is as long as whatever refused
  // it, and what a person needs in order to act must not be what falls off the
  // end of a bounded modal. Bounded all the same, and to a share of the budget
  // rather than the whole of it — text of ours long enough to spend the budget
  // would drop the reason entirely and say nothing about having done so.
  const ways = clampForDisplay(ourWays(chosen.spec), WAYS_CHARS);
  const choice = await ports.consent.ask(
    `${shownName(chosen.spec.displayName)} cannot be launched yet.`,
    // Flattened: runtime settings are window-scoped, so the command quoted back
    // here can be a repository's — and a line of its own in a dialog about
    // whether to trust a launch is what an approval is made of (ADR-0007).
    {
      modal: true,
      detail: ways + clampForDisplay(plainText(chosen.problem ?? ""), MAX_DETAIL_CHARS - ways.length),
    },
    ...[install, enter].filter((option): option is string => Boolean(option)),
  );
  if (!choice) throw new Cancelled();
  if (adapter && choice === install) {
    const command = adapterInstallCommand(adapter);
    await runAndWait(ports, "Agent Conductor install", `${command.command} ${command.args.join(" ")}`);
    // Re-detected rather than assumed: an install that failed leaves exactly the
    // Runtime that could not launch a moment ago.
    return chooseRuntime(ports);
  }
  // Prefilled from what settings say, not from the launch the catalog composed:
  // our own policy arguments are in the second, and offering them back would
  // both hand them to the user as theirs and make accepting the prefill count
  // as a replaced launch — which costs this Runtime its Suppression Plan.
  // What settings already say, or else the Runtime's own arguments before any
  // policy was applied — never the policy-augmented launch. Offering ours back
  // would hand this Client's flags to the user as theirs, and accepting them
  // would count as replacing the launch, costing the Runtime its Suppression
  // Plan; offering nothing would drop the flags that make it speak ACP at all.
  return configure(ports, chosen.spec.id, {
    command: chosen.spec.launch.command,
    args: ports.settings.runtimeEntry(chosen.spec.id)?.args ?? chosen.spec.baseArgs ?? [],
  });
}

/** A Runtime the catalog has never heard of; after the id it is configured like
 *  any other. */
async function customRuntime(ports: WizardPorts): Promise<Connection> {
  const taken = new Set(ports.runtimes().map((spec) => spec.id));
  const id = await ask(ports, {
    title: "Custom ACP agent",
    prompt: "An id for this agent — lowercase, used in settings and in /runtime",
    value: "",
    validateInput: (value) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) return "Use lowercase letters, digits and dashes";
      // Settings as well as the catalog: a Runtime somebody disabled is absent
      // from the picker and still very much configured.
      const configured = taken.has(value) || ports.settings.runtimeEntry(value) !== undefined;
      return configured ? `"${value}" is already configured` : undefined;
    },
  });
  return configure(ports, id, { command: "", args: [] });
}

/**
 * Asks what to launch, then rebuilds the Runtime through the catalog with that
 * answer applied — never by editing a spec here. The catalog decides what an
 * overridden launch means for a Runtime's Suppression Plan and policy, and two
 * places deciding that would eventually disagree about the fingerprint.
 */
async function configure(
  ports: WizardPorts,
  id: string,
  prefill: { command: string; args: string[] },
): Promise<Connection> {
  const command = await ask(ports, {
    title: "Launch command",
    prompt: "Program that speaks ACP — an absolute path, or a name on PATH",
    value: prefill.command,
    validateInput: (value) => (value.trim() ? undefined : "A launch command is required"),
  });
  const args = await askArguments(ports, prefill.args);
  return respec(ports, id, { command: command.trim(), args });
}

/** The catalog's own Runtime for a decision not saved yet: composed from the
 *  effective settings with the decision on top, so what is approved is what a
 *  Session start derives (ADR-0007). What is *kept* is the decision alone — the
 *  effective entry can hold values a repository supplied at workspace scope,
 *  and writing those into the scope the user picks would promote a repository's
 *  configuration into their profile. */
function respec(ports: WizardPorts, id: string, decided: RuntimeSetting): Connection {
  const entry = mergeEntry(ports.settings.runtimeEntry(id), decided);
  const spec = ports.runtimes({ id, entry }).find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`runtime ${id} is not in the catalog`);
  return { spec, entry: decided, secretEnvironment: {} };
}

/** Arguments as JSON: splitting a typed line on spaces is a guess. */
async function askArguments(ports: WizardPorts, current: string[]): Promise<string[]> {
  const typed = await ask(ports, {
    title: "Launch arguments",
    prompt: 'A JSON list, e.g. ["--acp"]',
    value: JSON.stringify(current),
    validateInput: (value) => (parseArguments(value) ? undefined : "Expected a JSON list of strings"),
  });
  return parseArguments(typed) ?? [];
}

function parseArguments(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return undefined;
    return parsed as string[];
  } catch {
    return undefined;
  }
}

