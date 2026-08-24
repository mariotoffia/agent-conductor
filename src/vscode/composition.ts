import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import {
  executablePort,
  message,
  describeRefresh,
  readCachedRegistry,
  refreshRegistry,
  resolveRuntime,
  runtimeCatalog,
  savesSettled,
  type ChildLaunch,
  type ConductorSession,
  type RegistrySnapshot,
  type ResumeConditions,
  type RuntimeSpec,
  type RuntimeTrust,
} from "../core/index.js";
import {
  fileStorage,
  readSettings,
  resolveSecretEnvironment,
  type ConductorSettings,
  type RuntimeSetting,
} from "./config.js";
import { liveLogPort, sessionPorts } from "./clientPorts.js";
import { formHost, modalConsentHost, openDocuments } from "./hostPorts.js";
import { DiffDocuments, DIFF_SCHEME } from "./diffDocs.js";
import { OPEN_DIFF_COMMAND } from "./chatSink.js";
import { ConductorParticipant, type RuntimeChoice } from "./participant.js";
import type { SavedSession } from "./participantPorts.js";
import { defaultWorktreeRoot, orchestration } from "./orchestration.js";
import { fileRoots } from "./spawnGate.js";
import type { ConsentHost } from "./permissions.js";
import { launchSession } from "./sessionLaunch.js";
import { sessionActions, sessionCommands } from "./sessionActions.js";
import { SessionsTree, type SessionNode } from "./sessionsTree.js";
import { connectCli } from "./wizard.js";
import { wizardHost, wizardTerminals } from "./wizardHost.js";

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
  /** Records Runtime Trust for the identity this Runtime resolves to right now
   *  — the connection wizard's last step, without its questions. */
  grantTrust(runtimeId: string): Promise<string>;
  /** The live participant, so a turn can be driven inside the host. */
  participant: ConductorParticipant;
  /** Diffs this window has retained, for checking the diff command. */
  diffs: DiffDocuments;
  /** The live Sessions tree, so its rows and actions can be driven in the host. */
  sessions: SessionsTree;
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

  const storage = fileStorage(context.globalStorageUri.fsPath);
  // Made afresh per activation, and never written anywhere but beside a hold: a
  // window that was killed comes back as a different one, so the Sessions it was
  // running stop being its own and become somebody's that has gone quiet.
  const windowId = randomUUID();
  // Validated Registry snapshot, read in the background: it supplies exact
  // Adapter versions and nothing else, the built-in catalog launches every
  // Runtime without it, and activation must not wait on a file to hand the
  // window a chat participant.
  let registry: RegistrySnapshot | undefined;
  void readCachedRegistry(storage, Date.now()).then((snapshot) => {
    registry = snapshot;
  });

  /** Every Runtime the settings describe, optionally with one entry the wizard
   *  has not saved yet applied on top — composed here, once, so the identity the
   *  wizard approves is the one a Session start resolves (ADR-0007). */
  const runtimes = (override?: { id: string; entry: RuntimeSetting }): RuntimeSpec[] => {
    const current = settings();
    return catalog(current, current["registry.autoResolve"] ? registry : undefined, override);
  };

  const recordTrust = async (runtimeId: string, trust: RuntimeTrust): Promise<void> => {
    await context.globalState.update(trustKey(runtimeId), trust);
    // Approving a Runtime changes which saved Sessions may be reattached to, in
    // both directions: the ones that ran under the identity just approved, and
    // the ones that ran under the one it replaced.
    sessions.refresh();
  };

  // Replaced only through the test hooks below; the real modal otherwise.
  let consent: ConsentHost | undefined;
  const askConsent = (): ConsentHost => consent ?? modalConsentHost();

  const diffs = new DiffDocuments();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
  );

  /** What resumability is re-derived against right now (ADR-0008). */
  const conditions = (): ResumeConditions => ({
    fingerprints: new Map(
      runtimes().flatMap((spec) => {
        const fingerprint = trustFor(context, spec)?.fingerprint;
        return fingerprint === undefined ? [] : [[spec.id, fingerprint] as const];
      }),
    ),
    workspaces: workspaceRoots(),
    now: Date.now(),
    window: windowId,
  });
  const sessions = new SessionsTree({
    storage,
    conditions,
    now: () => Date.now(),
    icon: (id) => new vscode.ThemeIcon(id),
    saved: () => savesSettled(storage),
  });
  context.subscriptions.push(
    vscode.window.createTreeView("agentConductor.sessions", { treeDataProvider: sessions }),
    // What a row may be asked to do is re-derived from these every time it is
    // drawn, so a row drawn before one of them changed is a row offering an
    // action that will be refused — and saying nothing about why, because its
    // reason was worked out under the old answer.
    vscode.workspace.onDidChangeWorkspaceFolders(() => sessions.refresh()),
    vscode.workspace.onDidChangeConfiguration((change) => {
      if (change.affectsConfiguration("agentConductor")) sessions.refresh();
    }),
  );

  /**
   * Orchestration: the socket, the spawn tree and the worktrees (ADR-0008).
   *
   * Built for every window, and inert in almost all of them: no socket is
   * created and no capability is minted until a Session turns out to be eligible
   * for the Shim, which needs orchestration switched on *and* a Suppression
   * Capability no Runtime holds today. The wiring exists so that granting one is
   * the only remaining step, rather than a second implementation.
   */
  const conductor = orchestration({
    settings,
    runtimes: () => runtimes(),
    trustFor: (spec) => trustFor(context, spec),
    executable: executablePort(),
    workspace: () => workspaceRoots()[0],
    openChild: (child: ChildLaunch) => startSession(child.runtimeId, () => undefined, undefined, child),
    storage,
    log,
    // The extension host's own Node, and the Shim as the build wrote it: both
    // absolute, because ACP requires it and because a bare name would be
    // resolved from wherever the Agent happens to be running.
    command: process.execPath,
    shim: { args: [vscode.Uri.joinPath(context.extensionUri, "dist", "mcp-shim.cjs").fsPath] },
    worktreeRoot: defaultWorktreeRoot(context.globalStorageUri.fsPath),
  });
  context.subscriptions.push({ dispose: () => void conductor.dispose() });

  /** The one call that starts a Session in this window, direct or Subagent. */
  const startSession = (
    runtimeId: string,
    onUpdate: (notification: acp.SessionNotification) => void,
    load?: SavedSession,
    child?: ChildLaunch,
  ): Promise<ConductorSession> =>
    launchSession({
      runtimeId,
      ...(load ? { load } : {}),
      onUpdate,
      runtimes: () => runtimes(),
      settings,
      roots: workspaceRoots,
      workspaceTrusted: () => vscode.workspace.isTrusted,
      trustFor: (spec) => trustFor(context, spec),
      secretsFor: (spec, references) =>
        resolveSecretEnvironment(context.secrets, spec.id, references),
      executable: executablePort(),
      ports: (current, roots, agentLabel) =>
        sessionPorts({
          settings: current,
          roots,
          agentLabel,
          log,
          consent: askConsent(),
          documents: openDocuments(),
          forms: formHost(),
        }),
      storage,
      log,
      sessions,
      window: windowId,
      orchestration: conductor,
      ...(child
        ? {
            child: {
              sessionKey: child.sessionKey,
              parentSessionKey: child.parentSessionKey,
              parentSessionId: child.parentSessionId,
              depth: child.depth,
              cwd: child.cwd,
              ...(child.requestedModel ? { requestedModel: child.requestedModel } : {}),
              ...(child.requestedEffort ? { requestedEffort: child.requestedEffort } : {}),
              ...(child.worktree ? { worktree: child.worktree } : {}),
              // A Subagent has no chat stream of its own, so the Orchestrator is
              // where its Updates go: its parent's result is made of them.
              observe: child.observe,
            },
          }
        : {}),
    });

  const participant = new ConductorParticipant({
    diffs,
    log,
    defaultRuntimeId: () => settings().defaultRuntime,
    showThinking: () => settings()["ui.showThinking"],
    slashCommands: () => settings()["ui.slashCommandAllowlist"],
    pick: (items, options) => vscode.window.showQuickPick(items, options),
    runtimes: async () => runtimes().map(asChoice),
    modelCatalog: (runtimeId) =>
      runtimes().find((spec) => spec.id === runtimeId)?.modelCatalog ?? [],
    runtimeQuirks: (runtimeId) => runtimes().find((spec) => spec.id === runtimeId)?.quirks,
    onChanged: () => sessions.refresh(),
    open: (runtimeId, onUpdate, load) => startSession(runtimeId, onUpdate, load),
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

  // Built here rather than per wizard run: it registers a disposable on the
  // context and holds the one login terminal, both of which are the window's.
  const runInTerminal = wizardTerminals(context);
  const actions = sessionActions({
    participant,
    workspaces: workspaceRoots,
    storage,
    conditions,
    resumeOnStartup: () => settings()["sessions.resumeOnStartup"],
    host: {
      execute: (command, ...args) => Promise.resolve(vscode.commands.executeCommand(command, ...args)),
      // The window's own voice, so ending a session is visible where the user
      // asked for it rather than only in a log nobody has open.
      inform: (text) => void vscode.window.showInformationMessage(text),
      fail: (text) => void vscode.window.showErrorMessage(text),
      // Modal, because the one thing it is asked about destroys work. Anything
      // but the destructive answer — including dismissing it — is `false`.
      confirm: async (text, proceed) =>
        (await vscode.window.showWarningMessage(text, { modal: true }, proceed)) === proceed,
    },
    releaseWorktree: (path, release) => conductor.releaseWorktree(path, release),
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_DIFF_COMMAND, (id: unknown) => openDiff(diffs, id)),
    ...Object.entries(sessionCommands(actions)).map(([id, run]) =>
      vscode.commands.registerCommand(id, (node?: SessionNode) => run(node))),
    // The Connect-a-CLI wizard is the only thing that records Runtime Trust:
    // until a Runtime has been through it, no identity is approved and every
    // spawn is refused, which is the direction that fails closed (ADR-0007).
    vscode.commands.registerCommand("agentConductor.connectCli", () =>
      connectCli(
        wizardHost(context, {
          form: formHost(),
          consent: askConsent(),
          channel,
          runtimes,
          runInTerminal,
          recordTrust,
          settings,
          log,
        }),
      )),
    vscode.commands.registerCommand("agentConductor.refreshRegistry", async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Refreshing the ACP agent registry…" },
        () => refreshRegistry(storage, settings()["registry.url"], Date.now()),
      );
      // A failed refresh keeps whatever was cached: the built-in catalog works
      // offline, so the only thing that must not happen is silence about it.
      if (result.snapshot) registry = result.snapshot;
      const said = describeRefresh(result);
      channel.info(said);
      void vscode.window.showInformationMessage(said);
    }),
  );

  // Never awaited: activation must not wait on a file, still less on a process.
  void actions.resumeOnStartup().catch((error: unknown) => {
    log.log("error", `no session was resumed on startup: ${message(error)}`);
  });
  // Nor on git. What a window that was killed left behind is settled here and
  // nowhere else: a worktree allocation written down but never made, or one whose
  // directory has since gone (ADR-0009).
  void conductor.reconcile().catch((error: unknown) => {
    log.log("error", `the worktree journal was not reconciled: ${message(error)}`);
  });

  channel.info("Agent Conductor activated.");
  return {
    teardown: async () => {
      await participant.stop();
      // Before the saves settle: ending a Subagent is what makes its record say
      // it ended, and that write has to be one of the ones waited for below.
      await conductor.dispose();
      // Session records are written with nothing waiting on them, so that a Turn
      // never queues behind a file. This is the one moment that has to: a window
      // closing would otherwise take the record of how the Session ended with it.
      await savesSettled(storage);
    },
    ...(context.extensionMode === vscode.ExtensionMode.Test
      ? {
          hooks: {
            participant,
            diffs,
            sessions,
            useConsent: (host) => {
              consent = host;
            },
            grantTrust: async (runtimeId) => {
              const spec = runtimes().find((entry) => entry.id === runtimeId);
              if (!spec) throw new Error(`runtime ${runtimeId} is not configured`);
              const runtime = await resolveRuntime(spec, { executable: executablePort() });
              // The fingerprint, never a flag: trust is re-derived from the
              // resolved identity on every spawn (ADR-0007). Written through the
              // same call the wizard uses, so there is one writer of trust.
              await recordTrust(runtimeId, { fingerprint: runtime.fingerprint });
              return runtime.fingerprint;
            },
          },
        }
      : {}),
  };
}

/** Every Runtime the settings describe, at its pinned Adapter version. */
function catalog(
  settings: ConductorSettings,
  registry?: RegistrySnapshot,
  override?: { id: string; entry: RuntimeSetting },
): RuntimeSpec[] {
  return runtimeCatalog({
    // Suppression is only ever needed to make Shim injection safe, so the window
    // policy follows the orchestration switch (ADR-0004).
    policy: {
      suppressBuiltInSubagents: settings["orchestration.enabled"],
      hideSubscriptionAuth: settings["claude.hideSubscriptionAuth"],
    },
    overrides: override ? { ...settings.runtimes, [override.id]: override.entry } : settings.runtimes,
    ...(registry ? { registry } : {}),
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
 * Written by the connection wizard, which is the only thing that may: a Runtime
 * nobody took through it resolves untrusted, and no Agent is started for it.
 */
function trustFor(context: vscode.ExtensionContext, spec: RuntimeSpec): RuntimeTrust | undefined {
  return context.globalState.get<RuntimeTrust>(trustKey(spec.id));
}

const trustKey = (runtimeId: string): string => `runtimeTrust.${runtimeId}`;

/**
 * The same folders, without the demand that there be any.
 *
 * The Sessions tree is drawn in a window with no folder open, and every saved
 * Session in it is then correctly one that cannot be resumed. Only starting a
 * Session needs a `cwd`, so only that refuses.
 */
function workspaceRoots(): string[] {
  return fileRoots(vscode.workspace.workspaceFolders ?? []);
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
