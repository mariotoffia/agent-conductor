import type * as vscode from "vscode";
import { logsAt, nodeProcessPort, type LogLevel, type LogPort, type SessionPorts } from "../core/index.js";
import type { ConductorSettings } from "./config.js";
import { FormElicitor, type FormHost } from "./elicitation.js";
import { WorkspaceFs, type OpenDocuments } from "./fsProvider.js";
import { PermissionRouter, type ConsentHost } from "./permissions.js";
import { TerminalService } from "./terminals.js";

/**
 * The Client Ports one Session is served through (ARCHITECTURE.md §Layering
 * rules).
 *
 * `vscode` is not imported here, which is the point: what a Session may read and
 * run is decided by the roots and the settings this is handed, and that wiring
 * is the kind that fails silently — a port built with the wrong roots refuses
 * nothing, and every service below it goes on passing its own tests. The surfaces
 * that really are the VS Code API live in `hostPorts.ts`.
 */

export interface SessionPortsRequest {
  settings: ConductorSettings;
  /** Absolute folders this Session may reach. */
  roots: readonly string[];
  /** What the Agent is called in a consent dialog. */
  agentLabel: string;
  log: LogPort;
  consent: ConsentHost;
  /** Open editor buffers, so a read serves what is on screen. */
  documents: OpenDocuments;
  /** Where a form is asked. */
  forms: FormHost;
}

export function sessionPorts(request: SessionPortsRequest): SessionPorts {
  const { settings, roots, log } = request;
  const consent = new PermissionRouter(
    {
      autoAllow: settings["permissions.autoAllowClientOperations"],
      autoReject: settings["permissions.autoRejectClientOperations"],
      rememberAlwaysChoices: settings["permissions.rememberAlwaysChoices"],
    },
    request.consent,
    request.agentLabel,
  );
  return {
    process: nodeProcessPort,
    permission: consent,
    fs: new WorkspaceFs({ roots: [...roots], documents: request.documents, consent }),
    terminal: new TerminalService({
      roots: [...roots],
      consent,
      maxEnvironmentChars: settings["permissions.maxEnvironmentChars"],
    }),
    elicitation: new FormElicitor(request.forms),
    log,
  };
}

/**
 * Binds the four severities to the output channel. Which of them are written is
 * decided by `logsAt`, in the core, where a test can reach it — this is only the
 * wiring. `off` drops the record; the level is re-read per record, so this is
 * the composition and never the policy.
 *
 * Both halves are calls into the window — the configured level is read, then the
 * channel is written — and a window on its way out answers either by throwing.
 * Records are made from places nothing is waiting on: an Agent process that
 * ended, a pipe that drained, a Turn's `finally`. So the guard is here, where
 * every caller routes through, rather than at each of the dozens of them: none
 * has anywhere to put the failure, and a log that ends the work that was logging
 * is worse than a record nobody kept.
 */
export function liveLogPort(channel: vscode.LogOutputChannel, level: () => string): LogPort {
  const write: Record<LogLevel, (text: string) => void> = {
    error: (text) => channel.error(text),
    info: (text) => channel.info(text),
    debug: (text) => channel.debug(text),
    trace: (text) => channel.trace(text),
  };
  return {
    log: (severity, text) => {
      try {
        const configured = level();
        if (configured !== "off" && logsAt(configured, severity)) write[severity](text);
      } catch {
        // The window this was going to is gone. There is nowhere left to say so.
      }
    },
  };
}

