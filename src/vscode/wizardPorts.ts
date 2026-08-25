import type { RuntimeSetting } from "./config.js";
import type { FormHost } from "./elicitation.js";
import type { ConsentHost } from "./permissions.js";
import type { ExecutablePort, RuntimeSpec, RuntimeTrust, SessionPorts } from "../core/index.js";

/**
 * What the connection wizard needs from VS Code, and what one run of it decides.
 *
 * Apart from the flow so that both halves of the wizard — the questions and the
 * settings written at the end — can name the same ports without importing each
 * other. `vscode` appears nowhere: every window, terminal, secret and setting is
 * a port, which is what lets the wizard be driven against a real Agent process
 * under plain Node.
 */

export type SettingsScope = "global" | "workspace";

/** SecretStorage, as the wizard needs it: settings keep the name of a secret,
 *  never its value (ADR-0010). */
export interface WizardSecretsPort {
  /**
   * Values behind a set of `secretEnvironment` references. Throws when one is
   * missing, which is the same fail-closed answer a Session start gets.
   *
   * The references are passed in rather than read from settings: the wizard may
   * have just repaired one, and settings are not written until the end, so
   * reading them there would go on resolving the reference that is missing.
   */
  resolve(runtimeId: string, references: Record<string, string>): Promise<Record<string, string>>;
  store(key: string, value: string): Promise<void>;
}

/** Where `agentConductor.*` is written. */
export interface WizardSettingsPort {
  /** `agentConductor.runtimes` exactly as written at one scope. Never validated
   *  on the way out: an entry the schema rejects is still the user's, and this
   *  is not the place to delete it. */
  runtimesAt(scope: SettingsScope): Record<string, RuntimeSetting>;
  /** The effective entry for one Runtime — what the catalog composed it from.
   *  The wizard's pending entry is built on top of this, so the identity it
   *  approves is the one these settings already describe (ADR-0007). */
  runtimeEntry(runtimeId: string): RuntimeSetting | undefined;
  /** Every Runtime id the settings describe, including ones they disable. The
   *  catalog drops those, so this is the only way the wizard can offer to turn
   *  one back on rather than leaving settings as the only route. */
  configuredIds(): string[];
  writeRuntimes(entries: Record<string, RuntimeSetting>, scope: SettingsScope): Promise<void>;
  defaultRuntime(): string;
  writeDefaultRuntime(runtimeId: string, scope: SettingsScope): Promise<void>;
  /** Whether a folder is open. Without one there is nowhere to put workspace
   *  settings, and VS Code refuses the write rather than ignoring it. */
  workspaceOpen(): boolean;
}

export interface WizardPorts {
  /** Quick picks and input boxes; `vscode.window`. */
  form: FormHost;
  /** Modal approvals — the same surface permission routing asks through. */
  consent: ConsentHost;
  /** Reports outcomes; `vscode.window.showInformationMessage`. */
  say(message: string): void;
  /** Runs a step the user cannot help with, saying so while it runs. A probe
   *  may take a Setup Deadline to fail, and a window that says nothing for that
   *  long looks hung; `vscode.window.withProgress`. */
  progress<T>(title: string, run: () => Promise<T>): Promise<T>;
  /**
   * Every Runtime the settings describe, with `override` applied on top.
   *
   * The override matters: it is what makes the identity approved here the same
   * identity a Session start composes later. A wizard that built its own spec
   * would approve a fingerprint the catalog never produces — and the Runtime
   * would be untrusted the first time it was used (ADR-0007).
   */
  runtimes(override?: { id: string; entry: RuntimeSetting }): RuntimeSpec[];
  executable: ExecutablePort;
  settings: WizardSettingsPort;
  secrets: WizardSecretsPort;
  recordTrust(runtimeId: string, trust: RuntimeTrust): Promise<void>;
  /** Runs a command in a terminal the user can watch: a CLI's own login, or
   *  installing an Adapter. Never a string that came from settings or an Agent. */
  runInTerminal(name: string, command: string): void;
  /** Where Adapters this Client installs live — its own directory under global
   *  storage, not the machine's npm prefix. */
  adapterHome(): string;
  /** `agentConductor.orchestration.enabled`. */
  orchestrationEnabled(): boolean;
  /** `vscode.workspace.isTrusted`. Probing starts an Agent, so the window's own
   *  trust gates it exactly as it gates a Session (ADR-0007). */
  workspaceTrusted(): boolean;
  /** Ports the Probe Session runs on; it is given no filesystem or terminal. */
  session?: Pick<SessionPorts, "process" | "log" | "clock">;
  /** Overrides the Setup Deadline every probe stage is bounded by. */
  deadlineMs?: number;
}

/** Everything one run of the wizard has decided so far — the single state it
 *  carries from stage to stage, so a later stage can never be reached with an
 *  earlier one's answer missing. */
export interface Connection {
  spec: RuntimeSpec;
  /** What will be merged into `agentConductor.runtimes`, if anything ever is. */
  entry: RuntimeSetting;
  /** Values behind the entry's references, held only for this run's Probe
   *  Session. They are never written to settings and never logged. */
  secretEnvironment: Record<string, string>;
  trust?: RuntimeTrust;
}
