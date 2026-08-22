import {
  resolveRuntime,
  runtimeCatalog,
  type AgentProcess,
  type RuntimeSpec,
  type RuntimeTrust,
  type SpawnRequest,
} from "../core/index.js";
import type { RuntimeSetting } from "../vscode/config.js";
import type { SettingsScope, WizardPorts } from "../vscode/wizardPorts.js";
import { launchMockAgent, recordingProcessPort, type SentLine } from "./acp-harness.js";
import { executable } from "./participant-fixtures.js";

/**
 * A connection wizard wired to scripted answers instead of a VS Code window.
 *
 * The Runtimes it offers are built by the real `runtimeCatalog` from the same
 * settings the wizard writes back — as the composition root does. A fixture
 * whose catalog was unrelated to its settings could not see the defect that
 * matters most here: an approval recorded for an identity the saved settings
 * will never produce (ADR-0007).
 *
 * Questions are answered by title so a test reads as the conversation it is;
 * anything unscripted takes the first offer, which is what a user clicking
 * through the defaults does.
 */

/** The Runtime under test: a built-in whose launch is replaced by the mock
 *  Agent, so the catalog's own override rules are what compose it. */
export const MOCK_ID = "claude";

/** The settings entry that points a Runtime at the mock Agent. */
export function mockEntry(mode?: string): RuntimeSetting {
  const launch = launchMockAgent(mode);
  return { command: launch.command, args: launch.args };
}

export interface Script {
  /** Quick pick answer by title: a label substring, an index, or `undefined`. */
  pick?: Record<string, string | number | undefined>;
  /** Input box answer by title; `undefined` cancels. */
  input?: Record<string, string | undefined>;
  /** Modal answer: the choice to click, or `undefined` to dismiss. */
  consent?: (message: string, choices: string[]) => string | undefined;
  /** Mock-agent mode the Runtime under test launches with. */
  mode?: string;
  /** `agentConductor.runtimes` as user settings hold it. */
  saved?: Record<string, RuntimeSetting>;
  /** `agentConductor.runtimes` as this workspace holds it — a repository's own
   *  `.vscode/settings.json`, which outranks the user's. */
  workspaceSaved?: Record<string, RuntimeSetting>;
  /** What SecretStorage already holds, keyed by reference. */
  secrets?: Record<string, string>;
  orchestration?: boolean;
  workspaceTrusted?: boolean;
  workspaceOpen?: boolean;
  defaultRuntime?: string;
  /** Fails every settings write, as VS Code does for a workspace scope with no
   *  folder open. */
  writeFails?: string;
  /** An entry that keeps winning whatever is written, as a higher-priority
   *  settings scope does. */
  overriddenBy?: RuntimeSetting;
}

export interface WizardHarness {
  ports: WizardPorts;
  offered: { title: string; labels: string[]; descriptions: string[] }[];
  asked: string[];
  said: string[];
  /** Titles of the steps the wizard ran under progress. */
  progress: string[];
  /** Every input box offered, with what it was prefilled with. */
  typed: { title: string; value: string }[];
  writes: { entries: Record<string, RuntimeSetting>; scope: SettingsScope }[];
  trusted: { runtimeId: string; trust: RuntimeTrust }[];
  secrets: Record<string, string>;
  terminals: { name: string; command: string }[];
  defaults: { id: string; scope: SettingsScope }[];
  spawns: SpawnRequest[];
  sent: SentLine[];
  /** Every agent process the wizard started, so a test can wait for its end. */
  agents: AgentProcess[];
  /** `agentConductor.runtimes` as it stands now. */
  saved(): Record<string, RuntimeSetting>;
  /** The identity a Session start would derive from the settings as they stand
   *  — the one the recorded approval has to match. */
  effectiveFingerprint(id?: string): Promise<string | undefined>;
}

export function wizardHarness(script: Script = {}): WizardHarness {
  const offered: { title: string; labels: string[]; descriptions: string[] }[] = [];
  const asked: string[] = [];
  const said: string[] = [];
  const progress: string[] = [];
  const typed: { title: string; value: string }[] = [];
  const writes: { entries: Record<string, RuntimeSetting>; scope: SettingsScope }[] = [];
  const trusted: { runtimeId: string; trust: RuntimeTrust }[] = [];
  const secrets: Record<string, string> = { ...script.secrets };
  const terminals: { name: string; command: string }[] = [];
  const defaults: { id: string; scope: SettingsScope }[] = [];
  const spawns: SpawnRequest[] = [];
  const sent: SentLine[] = [];
  const agents: AgentProcess[] = [];
  const byScope: Record<SettingsScope, Record<string, RuntimeSetting>> = {
    global: script.saved ?? (script.workspaceSaved ? {} : { [MOCK_ID]: mockEntry(script.mode) }),
    workspace: script.workspaceSaved ?? {},
  };
  /** What the catalog is composed from. A simplification: VS Code merges object
   *  settings across scopes property by property, while this lets one scope's
   *  entry win whole. Enough for what these tests protect — which scope a write
   *  lands in — and not a model of VS Code's resolution. */
  const effective = (): Record<string, RuntimeSetting> => ({ ...byScope.global, ...byScope.workspace });
  let defaultRuntime = script.defaultRuntime ?? MOCK_ID;

  /** The catalog under the current settings, narrowed to the Runtimes a test
   *  configured — the wizard lists whatever it is handed. */
  const specs = (override?: { id: string; entry: RuntimeSetting }): RuntimeSpec[] => {
    // A scope that outranks the one being written wins over what is saved — but
    // not over the entry the wizard is still holding, exactly as the real
    // catalog composes it.
    const base = { ...effective(), ...(script.overriddenBy ? { [MOCK_ID]: script.overriddenBy } : {}) };
    const overrides = override ? { ...base, [override.id]: override.entry } : base;
    const wanted = new Set(Object.keys(overrides));
    return runtimeCatalog({
      policy: { suppressBuiltInSubagents: script.orchestration ?? false },
      overrides,
    }).filter((spec) => wanted.has(spec.id));
  };

  const ports: WizardPorts = {
    form: {
      async pick(items, options) {
        offered.push({
          title: options.title,
          labels: items.map((item) => item.label),
          descriptions: items.map((item) => item.description ?? ""),
        });
        const answer = options.title in (script.pick ?? {}) ? script.pick?.[options.title] : 0;
        if (answer === undefined) return undefined;
        return typeof answer === "number"
          ? items[answer]
          : items.find((item) => item.label.includes(answer));
      },
      async input(options) {
        typed.push({ title: options.title, value: options.value ?? "" });
        return options.title in (script.input ?? {}) ? script.input?.[options.title] : options.value;
      },
      async pickMany() {
        throw new Error("the wizard should not need a multi-select");
      },
    },
    consent: {
      async ask(message, options, ...choices) {
        // Both halves: a modal shows the detail under the message, and most of
        // what the user is approving is in the detail.
        asked.push(`${message}\n${options.detail ?? ""}`);
        return script.consent ? script.consent(message, choices) : choices[0];
      },
    },
    say: (message) => said.push(message),
    progress: async (title, run) => {
      progress.push(title);
      return run();
    },
    runtimes: specs,
    executable,
    settings: {
      runtimesAt: (scope) => byScope[scope],
      runtimeEntry: (runtimeId) => effective()[runtimeId],
      configuredIds: () => Object.keys(effective()),
      async writeRuntimes(entries, scope) {
        if (script.writeFails) throw new Error(script.writeFails);
        writes.push({ entries, scope });
        byScope[scope] = entries;
      },
      defaultRuntime: () => defaultRuntime,
      async writeDefaultRuntime(id, scope) {
        defaults.push({ id, scope });
        defaultRuntime = id;
      },
      workspaceOpen: () => script.workspaceOpen ?? true,
    },
    secrets: {
      async resolve(_runtimeId, references) {
        const resolved: Record<string, string> = {};
        for (const [name, reference] of Object.entries(references)) {
          const value = secrets[reference];
          if (value === undefined) throw new Error(`no stored secret for ${name}`);
          resolved[name] = value;
        }
        return resolved;
      },
      async store(key, value) {
        secrets[key] = value;
      },
    },
    async recordTrust(runtimeId, trust) {
      trusted.push({ runtimeId, trust });
    },
    runInTerminal: (name, command) => terminals.push({ name, command }),
    orchestrationEnabled: () => script.orchestration ?? false,
    workspaceTrusted: () => script.workspaceTrusted ?? true,
    session: { process: recordingProcessPort(spawns, sent, agents) },
    // Short enough that a Runtime which never answers fails the test rather
    // than the suite; the wizard's own default is for a person watching it.
    deadlineMs: 5_000,
  };

  return {
    ports,
    offered,
    asked,
    said,
    progress,
    typed,
    writes,
    trusted,
    secrets,
    terminals,
    defaults,
    spawns,
    sent,
    agents,
    saved: () => effective(),
    async effectiveFingerprint(id = MOCK_ID) {
      const spec = specs().find((candidate) => candidate.id === id);
      if (!spec) return undefined;
      return resolveRuntime(spec, { executable }).then(
        (runtime) => runtime.fingerprint,
        () => undefined,
      );
    },
  };
}
