import {
  message,
  openProbeSession,
  pickEffortChoices,
  EFFORT_LEVELS,
  pickModelChoices,
  redactSecrets,
  SMOKE_PROMPT,
  type ChoiceSource,
  type EffortLevel,
  type Probe,
  type ResolvedRuntime,
} from "../core/index.js";
import { readBackLine } from "./chatSink.js";
import { asQuickItem } from "./elicitation.js";
import { clampForDisplay, MAX_DETAIL_CHARS, MAX_LABEL_CHARS } from "./permissions.js";
import { ask, Cancelled, pickIndex, report, safeText, shownName } from "./wizardAsk.js";
import { mergeEntry } from "./wizardSettings.js";
import type { Connection, WizardPorts } from "./wizardPorts.js";

/**
 * Everything the wizard does with a running Agent: opening a Probe Session,
 * handing authentication back to the CLI that owns it, reading Config Options,
 * agreeing the policy, and one short Turn to prove it all works.
 *
 * Apart from choosing *what* to connect, because these are the steps where an
 * untrusted Agent is on the other end — its text is redacted before it is said,
 * its refusals are survivable, and what it reports is never taken as what the
 * user asked for (ADR-0005, ADR-0007, ADR-0010).
 */

/** Probe attempts before the wizard stops asking. A person who has just signed
 *  in needs another go; a loop that never ends is not a wizard. */
const PROBE_ATTEMPTS = 3;

export async function startProbe(
  ports: WizardPorts,
  state: Connection,
  runtime: ResolvedRuntime,
  /** Recomposes and re-approves the identity. Called when a handoff changed
   *  what the launch is: a credential reference is part of the identity, so
   *  adding one means the approval already given no longer describes it. */
  reapprove: (state: Connection) => Promise<ResolvedRuntime>,
): Promise<Probe> {
  let approved = runtime;
  let last: unknown;
  const name = shownName(state.spec.displayName);
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    try {
      // Inside the attempt, so a reference with nothing behind it fails the way
      // everything else does — into the handoff below, which is where a
      // credential can be stored. Settings sync carries these references
      // between machines and secret storage does not, so a run that could not
      // read one has to lead somewhere (ADR-0010).
      Object.assign(
        state.secretEnvironment,
        // What settings say, with anything this run repaired on top.
        await ports.secrets.resolve(
          state.spec.id,
          mergeEntry(ports.settings.runtimeEntry(state.spec.id), state.entry).secretEnvironment ?? {},
        ),
      );
      // Under progress: nobody can help while an Agent starts, and it may take
      // the whole Setup Deadline to fail.
      return await ports.progress(`Starting ${name}…`, () =>
        openProbeSession({
          runtime: approved,
          secretEnvironment: state.secretEnvironment,
          ports: ports.session ?? {},
          ...(ports.deadlineMs === undefined ? {} : { deadlineMs: ports.deadlineMs }),
        }));
    } catch (error) {
      last = error;
      if (attempt === PROBE_ATTEMPTS) break;
      const references = Object.keys(state.entry.secretEnvironment ?? {}).length;
      await offerAuthHandoff(ports, state, error);
      // A stored credential changes what would be launched, so what was
      // approved no longer describes it (ADR-0007).
      if (Object.keys(state.entry.secretEnvironment ?? {}).length !== references) {
        approved = await reapprove(state);
      }
    }
  }
  report(
    ports,
    state,
    `${shownName(state.spec.displayName)} did not open a session: ${message(last)}`,
  );
  throw new Cancelled();
}

/**
 * What to do about a Runtime that would not start.
 *
 * ACP gives no dependable way to tell "not signed in" from any other startup
 * failure — `authMethods` is advertised whether or not one is needed, and a
 * `session/new` refusal carries the CLI's own text. So the failure is shown as
 * it arrived and the ways forward offered beside it. Signing in happens in the
 * CLI that owns the credential; the only thing held here is a pasted key
 * (ADR-0010).
 */
async function offerAuthHandoff(ports: WizardPorts, state: Connection, error: unknown): Promise<void> {
  const login = state.spec.loginCommand;
  const loginChoice = login ? `Log in with "${clampForDisplay(login, MAX_LABEL_CHARS)}"` : undefined;
  // This dialog's own sentences come first and whole. It is the one that offers
  // to take a credential, and the failure printed beside it is as long as the
  // Agent cares to make it — put second, it would push these off the end of a
  // bounded modal and leave the Agent answering for where a pasted key goes.
  const ours =
    "If it needs signing in, do that in the CLI itself and continue." +
    " Agent Conductor never collects or proxies a credential — a key you paste is stored" +
    " in VS Code's secret storage, and settings keep only its name.\n\nIt said: ";
  const choice = await ports.consent.ask(
    `${shownName(state.spec.displayName)} could not open a session.`,
    {
      modal: true,
      detail:
        ours +
        safeText(message(error), Object.values(state.secretEnvironment), MAX_DETAIL_CHARS - ours.length),
    },
    ...[loginChoice, "Store an API key…", "Try again"].filter((option): option is string => Boolean(option)),
  );
  if (!choice) throw new Cancelled();
  if (login && choice === loginChoice) {
    await runAndWait(ports, "Agent Conductor login", login);
    return;
  }
  if (choice.startsWith("Store")) await storeApiKey(ports, state);
}

/** Runs a command in a terminal and waits for the user to say it finished:
 *  opening it is our part, and only the person typing knows when it is done. */
export async function runAndWait(ports: WizardPorts, name: string, command: string): Promise<void> {
  ports.runInTerminal(name, command);
  const done = await ports.consent.ask(
    `Running "${clampForDisplay(command, MAX_LABEL_CHARS)}" in a terminal.`,
    { modal: true, detail: "Continue once it has finished." },
    "Continue",
  );
  if (!done) throw new Cancelled();
}

/** Stores one credential and references it from the entry; the value stays in
 *  memory for this run's Probe Session and is never written down. */
async function storeApiKey(ports: WizardPorts, state: Connection): Promise<void> {
  const name = await ask(ports, {
    title: "Environment variable",
    prompt: "Variable the agent reads its key from, e.g. ANTHROPIC_API_KEY",
    value: "",
    validateInput: (value) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Not an environment variable name",
  });
  const value = await ask(ports, {
    title: "API key",
    prompt: "Stored in VS Code secret storage; settings will hold only its name",
    value: "",
    password: true,
    validateInput: (typed) => (typed.trim() ? undefined : "A value is required"),
  });
  const key = `agentConductor.${state.spec.id}.${name}`;
  await ports.secrets.store(key, value);
  state.secretEnvironment[name] = value;
  state.entry.secretEnvironment = { ...state.entry.secretEnvironment, [name]: key };
}

// ---------------------------------------------------------------------------
// Config Options, policy, Smoke Test
// ---------------------------------------------------------------------------

/**
 * Offers one picker and applies it to the Probe Session.
 *
 * Config Options are re-read each time rather than captured once: setting one
 * returns the whole refreshed array, and a Runtime that narrows its effort
 * levels once a model is chosen must be offered what it says now. What is saved
 * is the request; what the Agent runs is Read-back's answer (ADR-0005).
 */
export async function choosePicker(
  ports: WizardPorts,
  state: Connection,
  probe: Probe,
  slot: "model" | "effort",
): Promise<void> {
  const config = probe.session.config;
  const catalog = state.spec.modelCatalog ?? [];
  const source: ChoiceSource =
    slot === "model"
      ? pickModelChoices(config, catalog)
      : pickEffortChoices(config, catalog.find((hint) => hint.id === config.model?.currentValue));
  if (source.choices.length === 0) {
    report(
      ports,
      state,
      `${shownName(state.spec.displayName)} exposes no ${slot} to choose;` +
        " it keeps its own default.",
    );
    return;
  }
  const at = await pickIndex(ports, source.choices.map(asQuickItem), {
    title: slot === "model" ? "Model" : "Reasoning effort",
    placeHolder: source.source === "agent" ? "Reported by the agent" : "From the runtime catalog",
  });
  const choice = source.choices[at];
  if (!choice) throw new Cancelled();
  const selector = slot === "model" ? config.model : config.effort;
  // A Runtime whose configuration is fixed when its process starts has nothing
  // to set; the value is still recorded, and takes effect the next time it runs.
  // A Runtime that offers the option and then refuses it is not a Runtime that
  // cannot be connected: it keeps its own default, and Read-back says so.
  if (selector) {
    try {
      await probe.session.setConfigOption(selector.id, choice.value);
    } catch (error) {
      report(ports, state, `${shownName(state.spec.displayName)} refused that ${slot}: ${message(error)}`);
    }
  }
  if (!storable(ports, state, choice.value)) return;
  if (slot === "model") {
    state.entry.defaultModel = choice.value;
    return;
  }
  if (isEffortLevel(choice.value)) {
    state.entry.defaultEffort = choice.value;
    return;
  }
  report(
    ports,
    state,
    `"${clampForDisplay(choice.value, MAX_LABEL_CHARS)}" is not a reasoning level this client` +
      " can store as a default; it applies to this probe only.",
  );
}

/**
 * The one-time acknowledgement before this Runtime may be handed work by an
 * agent on another provider.
 *
 * Recorded against the launch fingerprint, so it lapses exactly when trust does
 * (ADR-0009). Declining changes nothing about the connection — a direct Session
 * is configured independently of what may be delegated. Asked only where
 * orchestration is on: turning it on later changes every Runtime's policy, and
 * with it the fingerprint, so the wizard runs again and the question returns.
 */
export async function acknowledgeFanOut(ports: WizardPorts, state: Connection): Promise<void> {
  if (!ports.orchestrationEnabled() || !state.trust) return;
  const name = shownName(state.spec.displayName);
  const allow = "Allow subagents";
  const decline = "Direct sessions only";
  const answer = await ports.consent.ask(
    `Allow subagents on ${name}, including work handed to it from another provider?`,
    {
      modal: true,
      detail:
        "If this CLI is signed in with a personal subscription rather than an API" +
        " key, running it as a subagent may breach that plan's terms — we cannot" +
        " tell which credential it uses, so this is your call (ADR-0010)." +
        "\n\nA brief written by an agent on one provider would be sent to this one." +
        " Briefs carry file paths rather than file contents, but the agent reads the" +
        " repository itself, so treat this as data crossing a provider boundary." +
        "\n\nDirect sessions on this runtime work either way.",
    },
    allow,
    decline,
  );
  // Dismissal is not an answer: everywhere else in the wizard closing a dialog
  // ends the run, and this is the one question where reading it as a decision
  // would decide something on nobody's behalf.
  if (answer === undefined) throw new Cancelled();
  if (answer === allow) {
    state.trust = { ...state.trust, fanOut: true };
    return;
  }
  report(ports, state, `${name} is connected for direct sessions only; subagent fan-out stays off.`);
}

/**
 * One short Turn, and the Read-back beside it — reported on one line, because a
 * notification shows one line and a mismatch nobody sees is a mismatch nobody
 * acted on (ADR-0005). Anything but the answer the prompt asked for ends the
 * run: a Runtime that cannot do this cannot chat.
 */
export async function smokeTest(ports: WizardPorts, state: Connection, probe: Probe): Promise<void> {
  const result = await ports.progress(
    `Asking ${shownName(state.spec.displayName)} one question…`,
    () => probe.smoke(),
  );
  // Every part of this is the Agent's own text — the reply, and the effective
  // values inside the Read-back — and all of it reaches a log file, from a
  // process started with resolved secrets in its environment (ADR-0010).
  const readBack = [
    readBackLine("model", probe.session.modelSelection).trim(),
    readBackLine("effort", probe.session.effortSelection).trim(),
  ].join(" · ");
  const said = `${shownName(state.spec.displayName)} answered: `;
  // The reply gets what the Read-back leaves, not the other way round: a reply
  // can pass the Smoke Test and still be long enough to fill a bounded report,
  // and a mismatch nobody sees is a mismatch nobody acted on (ADR-0005).
  //
  // Each half is made safe before either is measured, because redaction does not
  // only shrink text — `[redacted]` is longer than the eight-character value it
  // replaces, and the Agent has the credential in its own environment to echo
  // back as often as it likes.
  const secrets = Object.values(state.secretEnvironment);
  const shown = safeText(readBack, secrets, MAX_DETAIL_CHARS);
  const room = MAX_DETAIL_CHARS - shown.length - said.length - " · ".length;
  report(ports, state, [said + safeText(result.reply || "(nothing)", secrets, room), shown].join(" · "));
  if (!result.ok) {
    // Never the Agent's text: this one is thrown, and the catch that prints it
    // has no secrets to redact against.
    throw new Error(`the smoke test failed: "${SMOKE_PROMPT}" was not answered with OK`);
  }
}

/** Whether a value the Agent supplied may be written to settings: not one
 *  carrying a credential, nor one of unbounded length. The Agent is untrusted,
 *  runs with resolved secrets, and settings sync and get committed (ADR-0010). */
function storable(ports: WizardPorts, state: Connection, value: string): boolean {
  const secrets = Object.values(state.secretEnvironment);
  if (value.length > MAX_LABEL_CHARS * 2 || redactSecrets(value, secrets) !== value) {
    report(
      ports,
      state,
      `${shownName(state.spec.displayName)} reported a value this client` +
        " will not save as a default;" +
        " it applies to this probe only.",
    );
    return false;
  }
  return true;
}

function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}
