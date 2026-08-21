import { basename } from "node:path";
import * as vscode from "vscode";
import {
  executablePort,
  logsAt,
  nodeProcessPort,
  resolveRuntime,
  runtimeCatalog,
  type LogLevel,
  type LogPort,
  type RuntimeSpec,
  type RuntimeTrust,
  type SessionPorts,
} from "../core/index.js";
import { readSettings, resolveSecretEnvironment, type ConductorSettings } from "./config.js";
import { DiffDocuments, DIFF_SCHEME } from "./diffDocs.js";
import { FormElicitor, type FormHost } from "./elicitation.js";
import { WorkspaceFs, type OpenDocuments } from "./fsProvider.js";
import { OPEN_DIFF_COMMAND } from "./chatSink.js";
import { ConductorParticipant, openTrustedSession, type RuntimeChoice } from "./participant.js";
import { PermissionRouter, type ConsentHost } from "./permissions.js";
import { TerminalService } from "./terminals.js";

/**
 * The composition root: the one module that holds the real `vscode` API and
 * hands it to everything else as a Client Port (ARCHITECTURE.md §Layering rules).
 *
 * Nothing here decides anything. Every rule — what may be spawned, what may be
 * read, what is asked about — lives in a module that can be tested without an
 * extension host, and arrives here already made.
 */

/**
 * The seam the extension-host tests drive the extension through.
 *
 * It exists because VS Code offers no way to invoke a chat participant
 * programmatically: a test inside the host can register one but cannot send it a
 * turn. So the test is handed the live participant instead, and runs the real
 * wiring — real settings, real trust gate, real permission routing, real
 * process — against the bundled mock Agent.
 *
 * Handed out only when VS Code itself says this window was started to run tests
 * — `ExtensionMode.Test`, which it sets from the launch arguments. An
 * environment variable would have been the easy gate and the wrong one: every
 * extension in a host shares one `process.env` and can write it, so the gate
 * would be forgeable by exactly the code it is meant to exclude.
 *
 * Nothing here grants a capability that was not already there — anything running
 * in this extension host has the user's full permissions regardless. What the
 * gate buys is that a normal window has no such object at all, so none of it can
 * be done wearing this extension's identity.
 */
export interface ConductorTestHooks {
  /** Records Runtime Trust for the identity this Runtime resolves to right now,
   *  which is what the connection wizard will do once it exists. */
  grantTrust(runtimeId: string): Promise<string>;
  /** The live participant, so a turn can be driven inside the host. */
  participant: ConductorParticipant;
  /** Diffs this window has retained, for checking the diff command. */
  diffs: DiffDocuments;
  /** Answers consent dialogs, which a test cannot click. `undefined` restores
   *  the real modal. */
  useConsent(host: ConsentHost | undefined): void;
}

export interface ConductorActivation {
  /** Final teardown, awaited by `deactivate`. */
  teardown(): Promise<void>;
  hooks?: ConductorTestHooks;
}


export function activateConductor(context: vscode.ExtensionContext): ConductorActivation {
  const channel = vscode.window.createOutputChannel("Agent Conductor", { log: true });
  context.subscriptions.push(channel);
  // Settings are read per use, not cached: a change takes effect on the next
  // turn without an extension reload. Problems are reported when they appear
  // rather than on every read, which is many times a turn.
  let reported = "";
  const settings = (): ConductorSettings => {
    const read = readSettings(vscode.workspace.getConfiguration("agentConductor"));
    const problems = read.problems.join("\n");
    if (problems !== reported) {
      reported = problems;
      for (const problem of read.problems) channel.warn(problem);
    }
    return read.settings;
  };

  // Live, like every other setting here: a level changed while the window is
  // open takes effect on the next record rather than on the next reload.
  const log = liveLogPort(channel, () => settings()["logging.level"]);

  // Replaced only through the test hooks below; the real modal otherwise.
  let consent: ConsentHost | undefined;
  const askConsent = (): ConsentHost => consent ?? modalConsentHost();

  const diffs = new DiffDocuments();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
  );

  const participant = new ConductorParticipant({
    diffs,
    log,
    defaultRuntimeId: () => settings().defaultRuntime,
    showThinking: () => settings()["ui.showThinking"],
    pick: (items, options) => vscode.window.showQuickPick(items, options),
    runtimes: async () => catalog(settings()).map(asChoice),
    modelCatalog: (runtimeId) =>
      catalog(settings()).find((spec) => spec.id === runtimeId)?.modelCatalog ?? [],
    open: async (runtimeId, onUpdate) => {
      const current = settings();
      const spec = catalog(current).find((entry) => entry.id === runtimeId);
      if (!spec) {
        throw new Error(
          `runtime ${runtimeId} is not configured — run "Agent Conductor: Connect a CLI…"`,
        );
      }
      const roots = sessionRoots();
      const trust = trustFor(context, spec);
      const entry = current.runtimes[spec.id];
      return openTrustedSession({
        spec,
        executable: executablePort(),
        // Workspace trust is the window's own answer, read at spawn time rather
        // than cached: a workspace can be trusted after the extension started.
        workspaceTrusted: vscode.workspace.isTrusted,
        ...(trust ? { trust } : {}),
        cwd: roots[0],
        additionalDirectories: roots.slice(1),
        secretEnvironment: await resolveSecretEnvironment(
          context.secrets,
          spec.id,
          entry?.secretEnvironment,
        ),
        ...(entry?.defaultModel ? { requestedModel: entry.defaultModel } : {}),
        ...(entry?.defaultEffort ? { requestedEffort: entry.defaultEffort } : {}),
        onUpdate,
        ports: sessionPorts(current, roots, spec.displayName, log, askConsent()),
      });
    },
  });
  // `stop`, not `dispose`: this teardown is the final one, and a turn waiting
  // on a dead Session must not resume behind it.
  context.subscriptions.push({ dispose: () => void participant.stop() });

  const chat = vscode.chat.createChatParticipant(
    "agentConductor.chat",
    (request, _chatContext, stream, token) => participant.handle(request, stream, token),
  );
  chat.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  context.subscriptions.push(chat);

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_DIFF_COMMAND, (id: unknown) => openDiff(diffs, id)),
    vscode.commands.registerCommand("agentConductor.newSession", async () => {
      await participant.dispose();
      channel.info("session ended; the next prompt starts a new one");
    }),
    vscode.commands.registerCommand("agentConductor.cancelAll", () => participant.cancel()),
    vscode.commands.registerCommand("agentConductor.connectCli", () => {
      // The Connect-a-CLI wizard — detect, configure, Probe Session, policy,
      // Smoke Test, save — is what records Runtime Trust. Until it lands, no
      // identity is approved and every spawn is refused, which is the direction
      // that fails closed (ADR-0007).
      void vscode.window.showInformationMessage(
        "The connection wizard is not available yet, so no runtime is approved to launch.",
      );
    }),
    vscode.commands.registerCommand("agentConductor.refreshRegistry", () =>
      channel.info("registry refresh: not implemented")),
  );

  channel.info("Agent Conductor activated.");
  return {
    teardown: () => participant.stop(),
    ...(context.extensionMode === vscode.ExtensionMode.Test
      ? {
          hooks: {
            participant,
            diffs,
            useConsent: (host) => {
              consent = host;
            },
            grantTrust: async (runtimeId) => {
              const spec = catalog(settings()).find((entry) => entry.id === runtimeId);
              if (!spec) throw new Error(`runtime ${runtimeId} is not configured`);
              const runtime = await resolveRuntime(spec, { executable: executablePort() });
              // The fingerprint, never a flag: trust is re-derived from the
              // resolved identity on every spawn (ADR-0007).
              await context.globalState.update(trustKey(runtimeId), {
                fingerprint: runtime.fingerprint,
              } satisfies RuntimeTrust);
              return runtime.fingerprint;
            },
          },
        }
      : {}),
  };
}

/** Every Runtime the settings describe, at its pinned Adapter version. */
function catalog(settings: ConductorSettings): RuntimeSpec[] {
  return runtimeCatalog({
    // Suppression is only ever needed to make Shim injection safe, so the window
    // policy follows the orchestration switch (ADR-0004).
    policy: { suppressBuiltInSubagents: settings["orchestration.enabled"] },
    overrides: settings.runtimes,
    pins: settings["registry.pin"],
  });
}

function asChoice(spec: RuntimeSpec): RuntimeChoice {
  return {
    id: spec.id,
    label: spec.displayName,
    ...(spec.unavailable ? { description: spec.unavailable } : {}),
  };
}

/**
 * Runtime Trust the user granted, keyed by Runtime id.
 *
 * Nothing writes these yet: recording one is the connection wizard's job, and it
 * is the only thing that may. Until then this answers `undefined`, every
 * resolution comes back untrusted, and no Agent is started.
 */
function trustFor(context: vscode.ExtensionContext, spec: RuntimeSpec): RuntimeTrust | undefined {
  return context.globalState.get<RuntimeTrust>(trustKey(spec.id));
}

const trustKey = (runtimeId: string): string => `runtimeTrust.${runtimeId}`;

/**
 * Absolute Session roots. The first folder is the session `cwd`; the rest are
 * sent as `additionalDirectories`, and only when the Agent supports them.
 */
function sessionRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = folders.filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
  if (roots.length === 0) {
    throw new Error("open a folder before starting a session — ACP requires an absolute cwd");
  }
  return roots;
}

/** The Client Ports one Session is served through. */
function sessionPorts(
  settings: ConductorSettings,
  roots: string[],
  agentLabel: string,
  log: LogPort,
  askConsent: ConsentHost,
): SessionPorts {
  const consent = new PermissionRouter(
    {
      autoAllow: settings["permissions.autoAllowClientOperations"],
      autoReject: settings["permissions.autoRejectClientOperations"],
      rememberAlwaysChoices: settings["permissions.rememberAlwaysChoices"],
    },
    askConsent,
    agentLabel,
  );
  return {
    process: nodeProcessPort,
    permission: consent,
    fs: new WorkspaceFs({ roots, documents: openDocuments(), consent }),
    terminal: new TerminalService({
      roots,
      consent,
      maxEnvironmentChars: settings["permissions.maxEnvironmentChars"],
    }),
    elicitation: new FormElicitor(formHost()),
    log,
  };
}

const modalConsentHost = (): ConsentHost => ({
  ask: (message, options, ...choices) => vscode.window.showWarningMessage(message, options, ...choices),
});

const formHost = (): FormHost => ({
  input: (options) => vscode.window.showInputBox(options),
  pick: (items, options) => vscode.window.showQuickPick(items, options),
  pickMany: (items, options) => vscode.window.showQuickPick(items, options),
});

/** Open editor buffers, so a read serves what is on screen rather than the last save. */
function openDocuments(): OpenDocuments {
  const find = (path: string): vscode.TextDocument | undefined =>
    vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === "file" && document.uri.fsPath === path,
    );
  return {
    text: (path) => find(path)?.getText(),
    async replace(path, content) {
      const document = find(path);
      if (!document) return false;
      const edit = new vscode.WorkspaceEdit();
      // Through the editor, so the change joins the user's undo history.
      edit.replace(document.uri, wholeDocument(document), content);
      return vscode.workspace.applyEdit(edit);
    },
  };
}

function wholeDocument(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

/**
 * Binds the four severities to the output channel. Which of them are written is
 * decided by `logsAt`, in the core, where a test can reach it — this is only the
 * wiring. `off` drops the record; the level is re-read per record, so this is
 * the composition and never the policy.
 */
function liveLogPort(channel: vscode.LogOutputChannel, level: () => string): LogPort {
  const write: Record<LogLevel, (text: string) => void> = {
    error: (text) => channel.error(text),
    info: (text) => channel.info(text),
    debug: (text) => channel.debug(text),
    trace: (text) => channel.trace(text),
  };
  return {
    log: (severity, text) => {
      const configured = level();
      if (configured !== "off" && logsAt(configured, severity)) write[severity](text);
    },
  };
}

/**
 * Opens one recorded diff. Both sides are virtual documents: the right-hand side
 * is what the Agent reported writing, which is not the same thing as what the
 * file says now.
 */
async function openDiff(diffs: DiffDocuments, id: unknown): Promise<void> {
  if (typeof id !== "string") return;
  const entry = diffs.entry(id);
  if (!entry) {
    void vscode.window.showInformationMessage("That diff is no longer available.");
    return;
  }
  const side = (which: string): vscode.Uri =>
    vscode.Uri.from({ scheme: DIFF_SCHEME, path: displayPath(entry.path), query: `${id}:${which}` });
  await vscode.commands.executeCommand(
    "vscode.diff",
    side("old"),
    side("new"),
    `${basename(entry.path)} (agent diff)`,
  );
}

/** A URI path is slash-separated and rooted; this one is only ever a label. */
function displayPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return slashed.startsWith("/") ? slashed : `/${slashed}`;
}
