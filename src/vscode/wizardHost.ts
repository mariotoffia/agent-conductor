import * as vscode from "vscode";
import {
  adapterHome,
  adapterSearchPath,
  executablePort,
  nodeProcessPort,
  type LogPort,
  type RuntimeSpec,
  type RuntimeTrust,
} from "../core/index.js";
import { resolveSecretEnvironment, type ConductorSettings, type RuntimeSetting } from "./config.js";
import type { ConsentHost } from "./permissions.js";
import type { FormHost } from "./elicitation.js";
import type { SettingsScope, WizardPorts } from "./wizardPorts.js";

/**
 * How this extension host serves the connection wizard's ports.
 *
 * Apart from the composition root because it is the one place a wizard's
 * decisions become VS Code state — settings at a chosen scope, secrets, a
 * terminal — and because nothing here decides anything: every rule the wizard
 * follows lives in a module that can be tested without an extension host.
 */

export interface WizardHostServices {
  form: FormHost;
  consent: ConsentHost;
  /** Where the whole of what the wizard says is kept. Everything it says is one
   *  line by the time it arrives — see `report` — but a notification is
   *  transient and the window shortens it, and the Read-back is the part worth
   *  being able to go back and read (ADR-0005). */
  channel: vscode.LogOutputChannel;
  runtimes(override?: { id: string; entry: RuntimeSetting }): RuntimeSpec[];
  /** Opens a terminal for a login handed back to the CLI that owns it. Built
   *  once per activation — see `wizardTerminals`. */
  runInTerminal(name: string, command: string): void;
  recordTrust(runtimeId: string, trust: RuntimeTrust): Promise<void>;
  settings(): ConductorSettings;
  log: LogPort;
}

export function wizardHost(
  context: vscode.ExtensionContext,
  services: WizardHostServices,
): WizardPorts {
  const configuration = (): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration("agentConductor");
  return {
    form: services.form,
    consent: services.consent,
    say: (text) => {
      services.channel.info(text);
      void vscode.window.showInformationMessage(text.split("\n")[0] ?? text);
    },
    // `withProgress` answers with a Thenable; the port promises a Promise.
    progress: async (title, run) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        () => run(),
      ),
    runtimes: services.runtimes,
    // The Adapters this Client installed are searched before the machine's own
    // `PATH`, so the version the wizard just installed is the one it detects.
    executable: executablePort({ path: adapterSearchPath(context.globalStorageUri.fsPath) }),
    adapterHome: () => adapterHome(context.globalStorageUri.fsPath),
    settings: {
      runtimesAt: (scope) => savedRuntimes(scope),
      runtimeEntry: (runtimeId) => services.settings().runtimes[runtimeId],
      configuredIds: () => Object.keys(services.settings().runtimes),
      writeRuntimes: async (entries, scope) => {
        await configuration().update("runtimes", entries, settingsTarget(scope));
      },
      defaultRuntime: () => services.settings().defaultRuntime,
      writeDefaultRuntime: async (runtimeId, scope) => {
        await configuration().update("defaultRuntime", runtimeId, settingsTarget(scope));
      },
      // A workspace setting needs a workspace: VS Code refuses that write rather
      // than ignoring it, and the wizard must not offer what it cannot honour.
      workspaceOpen: () => (vscode.workspace.workspaceFolders ?? []).length > 0,
    },
    secrets: {
      // The same resolution a Session start does, so the probe runs with the
      // credentials the Runtime will really carry (ADR-0010).
      resolve: (runtimeId, references) =>
        resolveSecretEnvironment(context.secrets, runtimeId, references),
      store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
    },
    recordTrust: services.recordTrust,
    runInTerminal: services.runInTerminal,
    orchestrationEnabled: () => services.settings()["orchestration.enabled"],
    workspaceTrusted: () => vscode.workspace.isTrusted,
    session: { process: nodeProcessPort, log: services.log },
  };
}

/** `agentConductor.runtimes` exactly as written at one scope, so connecting a
 *  Runtime adds to what is there. Never validated on the way out: an entry the
 *  schema rejects is still the user's, and this is not where it gets deleted. */
function savedRuntimes(scope: SettingsScope): Record<string, RuntimeSetting> {
  const inspected = vscode.workspace
    .getConfiguration("agentConductor")
    .inspect<Record<string, RuntimeSetting>>("runtimes");
  const value = scope === "global" ? inspected?.globalValue : inspected?.workspaceValue;
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `agentConductor.runtimes is not an object in ${scope} settings — fix it before connecting`,
    );
  }
  return value;
}

function settingsTarget(scope: SettingsScope): vscode.ConfigurationTarget {
  return scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
}

/**
 * Runs a CLI's own login command, or an Adapter install, where the user can
 * watch it.
 *
 * Every string that reaches here comes from the built-in catalog — a login
 * command settings cannot set, or an install command built from a validated
 * package name and an exact version — because this is the one place in the
 * extension where text reaches a shell. Signing in stays the CLI's business; we
 * never collect or proxy a credential (ADR-0010).
 *
 * One terminal at a time: a window that kept one per attempt would hold them
 * all until the extension was unloaded.
 */
/**
 * One terminal at a time, and one registration.
 *
 * Called once per activation — not per module, since a second `activate` in one
 * extension host (a reload, or the test host) has its own context and must get
 * its own disposal; and not per wizard run, since the subscription list lives as
 * long as the window and each run would leave the run before it holding a shell
 * nothing disposes.
 */
export function wizardTerminals(context: vscode.ExtensionContext): (name: string, command: string) => void {
  let open: vscode.Terminal | undefined;
  context.subscriptions.push({ dispose: () => open?.dispose() });
  return (name, command) => {
    open?.dispose();
    open = vscode.window.createTerminal({ name });
    open.show();
    open.sendText(command, true);
  };
}
