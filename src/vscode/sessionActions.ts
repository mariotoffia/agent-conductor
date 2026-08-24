import { isAbsolute } from "node:path";
import {
  message,
  readSessions,
  resumeBlock,
  startupResume,
  type ReleaseOutcome,
  type ResumeConditions,
  type StoragePort,
} from "../core/index.js";
import type { ConductorParticipant } from "./participant.js";
import { MAX_DETAIL_CHARS, clampForDisplay } from "./permissions.js";
import { plainText } from "./sealing.js";
import type { SessionNode } from "./sessionsTree.js";

/**
 * What a row in the Sessions tree can be asked to do.
 *
 * Apart from the composition root because each of these decides something. A
 * Session is only ever reattached to through the participant that owns every
 * other one, and only into a folder this window actually holds — a saved record
 * is what somebody clicked, not evidence that clicking it is still safe.
 */

/** Built-in commands this module drives. Neither is ours. */
const GIT_OPEN_REPOSITORY = "git.openRepository";
const SHOW_SOURCE_CONTROL = "workbench.view.scm";

/** The window surfaces one action needs. */
export interface SessionActionHost {
  /** `vscode.commands.executeCommand`. */
  execute(command: string, ...args: unknown[]): Promise<unknown>;
  /** `vscode.window.showInformationMessage`. */
  inform(text: string): void;
  /** `vscode.window.showErrorMessage`. */
  fail(text: string): void;
  /** A modal question with one destructive answer; `false` is every other way
   *  out of it, including dismissing it. */
  confirm(text: string, proceed: string): Promise<boolean>;
}

export interface SessionActionOptions {
  participant: Pick<ConductorParticipant, "cancel" | "resume" | "dispose">;
  host: SessionActionHost;
  /** Absolute folders open in this window, read per action rather than cached. */
  workspaces(): readonly string[];
  /** Where Persisted Sessions live. */
  storage: StoragePort;
  /** What resumability is re-derived against right now (ADR-0008). */
  conditions(): ResumeConditions;
  /** `agentConductor.sessions.resumeOnStartup`, read when it is acted on. */
  resumeOnStartup(): boolean;
  /** Gives a worktree back. Absent in a window that has no orchestration. */
  releaseWorktree?(path: string, options?: { force?: boolean }): Promise<ReleaseOutcome>;
}

export interface SessionActions {
  cancel(node?: SessionNode): Promise<void>;
  resume(node?: SessionNode): Promise<void>;
  openWorktreeDiff(node?: SessionNode): Promise<void>;
  removeWorktree(node?: SessionNode): Promise<void>;
  resumeOnStartup(): Promise<void>;
  /** Ends the live Session so the next prompt opens a new one. */
  newSession(): Promise<void>;
  /** Every Turn this window is running. The way out of one that will not stop,
   *  so it names no Session and must not therefore mean none. */
  cancelAll(): Promise<void>;
}

/**
 * The commands the Sessions view offers, as a table rather than as a list of
 * registrations.
 *
 * The composition root registers whatever is in here, so which command runs
 * which action is something a test can read — a registration bound to the wrong
 * function, or to nothing, is otherwise a button that silently does nothing and
 * a manifest that still looks right.
 */
export function sessionCommands(actions: SessionActions): Record<string, (node?: SessionNode) => Promise<void>> {
  return {
    "agentConductor.newSession": () => actions.newSession(),
    "agentConductor.cancelAll": () => actions.cancelAll(),
    "agentConductor.cancelSession": (node) => actions.cancel(node),
    "agentConductor.resumeSession": (node) => actions.resume(node),
    "agentConductor.openWorktreeDiff": (node) => actions.openWorktreeDiff(node),
    "agentConductor.removeWorktree": (node) => actions.removeWorktree(node),
  };
}

const BLOCKED = "That session cannot be resumed. Its row says why.";

export function sessionActions(options: SessionActionOptions): SessionActions {
  const { host, participant } = options;
  return {
    /** Cancels the Turn on the Session this row names, and only that one. */
    async cancel(node) {
      if (!node) return;
      await participant.cancel(node.id);
    },

    async cancelAll() {
      await participant.cancel();
    },

    async newSession() {
      await participant.dispose();
      host.inform("Session ended; the next prompt starts a new one.");
    },

    /**
     * Reattaches to the Session this row names (`session/load`), ending the
     * live one first — one Agent process per Session, for its whole life.
     *
     * Everything the row said is checked again here rather than trusted: a tree
     * is drawn from a file and then sat on, and by the time somebody clicks, the
     * folder may have been closed and the Runtime's approval may have lapsed.
     * The spawn gate re-derives Runtime Trust for itself, but it does so *after*
     * the live Session has been ended to make room — so a Runtime this window
     * can no longer start is caught here, before a conversation somebody is in
     * is spent on a reattach that was never going to happen (ADR-0007).
     */
    async resume(node) {
      if (!node || node.live) return;
      // The same rule the row was drawn by, applied again to what holds now.
      // `node.blocked` is not consulted: it was worked out when the row was
      // drawn and is stale by exactly as long as the user has been looking at
      // it, so believing it could only ever be believing something older. The
      // node carries what the rule reads, so this is the same answer, now.
      const blocked = resumeBlock(node, options.conditions());
      if (blocked || !options.workspaces().includes(node.workspace)) {
        host.inform(BLOCKED);
        return;
      }
      try {
        await participant.resume({
          sessionId: node.id,
          runtimeId: node.runtimeId,
          workspace: node.workspace,
        });
      } catch (error) {
        host.fail(`That session could not be resumed. ${said(error)}`);
      }
    },

    /**
     * The one Session, if any, that opening a folder may start an Agent for.
     *
     * Off unless the setting says otherwise, because activating an extension is
     * not a request to run anything — and then one at most, the most recent that
     * still clears every condition, re-derived here rather than read off a
     * record (ADR-0008).
     */
    async resumeOnStartup() {
      const resuming = startupResume(
        await readSessions(options.storage),
        options.conditions(),
        options.resumeOnStartup(),
      );
      if (!resuming) return;
      await participant.resume({
        sessionId: resuming.sessionId,
        runtimeId: resuming.runtimeId,
        workspace: resuming.workspace,
      });
    },

    /**
     * Shows what a Subagent changed in its own worktree.
     *
     * Through VS Code's own Git extension rather than a diff of our making: a
     * worktree is an ordinary checkout, and its changes are exactly what Source
     * Control already draws. A window without that extension is told so, because
     * a command that silently does nothing reads as a broken worktree.
     */
    async openWorktreeDiff(node) {
      const worktree = node?.worktree;
      if (!worktree) return;
      // The path reaches VS Code's Git extension, which runs `git` inside
      // whatever directory it names. Where a worktree may live is decided by
      // whatever creates one; that this is a path at all is decided here.
      if (!isAbsolute(worktree.path)) {
        host.fail("That session's worktree is not an absolute path, so it was not opened.");
        return;
      }
      try {
        await host.execute(GIT_OPEN_REPOSITORY, worktree.path);
        await host.execute(SHOW_SOURCE_CONTROL);
      } catch (error) {
        host.fail(
          "That worktree could not be opened in Source Control." +
            ` ${said(error)}`,
        );
      }
    },

    /**
     * Gives a worktree back, and only when somebody asked for it.
     *
     * A checkout with uncommitted changes is refused once and removed only if
     * the user says so again, having been told what is in it. Nothing in this
     * Client removes a worktree on its own — a Session that crashed is exactly
     * when unmerged work is most likely to be sitting there (ADR-0009).
     */
    async removeWorktree(node) {
      const worktree = node?.worktree;
      if (!worktree) return;
      // A running Session is working *in* that directory. Removing it deletes
      // the working directory of a process that is mid-turn, and everything it
      // does after that is lost — so the row offers it only once the Session has
      // ended. The manifest says the same, and this says it again because a
      // command is invocable without a row (ADR-0009).
      //
      // "Running" means anywhere, not here: Sessions are remembered per machine
      // and every window's worktrees live under one root, so a window that is
      // not running this Session can still see its row and reach its checkout.
      // Refusing is the only answer available for that one — this window cannot
      // cancel another window's Session, so there is no "cancel it first" to
      // offer.
      if (node?.live || node?.blocked === "held-elsewhere") {
        host.fail(
          node?.live
            ? "That session is still running in this worktree. Cancel it first, then remove the worktree."
            : "Another window still has that session open, and its agent is working in this worktree.",
        );
        return;
      }
      const release = options.releaseWorktree;
      if (!release) {
        host.fail("This window has no orchestration, so it owns no worktrees to remove.");
        return;
      }
      if (!isAbsolute(worktree.path)) {
        host.fail("That session's worktree is not an absolute path, so it was not removed.");
        return;
      }
      const shown = clampForDisplay(plainText(worktree.path), MAX_DETAIL_CHARS);
      if (!(await host.confirm(`Remove the worktree at ${shown}?`, "Remove"))) return;
      const first = await release(worktree.path);
      if (first.removed) {
        host.inform(`Removed the worktree at ${shown}. Its branch was left alone.`);
        return;
      }
      const why = clampForDisplay(plainText(first.reason ?? "it could not be removed"), MAX_DETAIL_CHARS);
      // Only uncommitted changes are a refusal that asking again could
      // reasonably overturn, and only because the user can be told exactly what
      // they are giving up. A checkout nobody could inspect is not that: nothing
      // established there was work there, so "remove it anyway, losing those
      // changes" would be a sentence about changes nobody has seen. The others
      // force would not fix at all.
      if (first.cause !== "dirty") {
        host.fail(`${why} The worktree at ${shown} was kept.`);
        return;
      }
      if (!(await host.confirm(`${why} Remove it anyway, losing those changes?`, "Remove anyway"))) {
        host.inform(`The worktree at ${shown} was kept.`);
        return;
      }
      const forced = await release(worktree.path, { force: true });
      if (forced.removed) host.inform(`Removed the worktree at ${shown}.`);
      else host.fail(clampForDisplay(plainText(forced.reason ?? "it could not be removed"), MAX_DETAIL_CHARS));
    },
  };
}

/** A failure as a notification may draw it: bounded, flattened, and stripped of
 *  what would make an Agent's words look like this Client's (ADR-0007). */
function said(error: unknown): string {
  return clampForDisplay(plainText(message(error)).trim(), MAX_DETAIL_CHARS);
}
