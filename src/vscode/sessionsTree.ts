import { createHash } from "node:crypto";
import type * as vscode from "vscode";
import {
  ConductorSession,
  readSessions,
  resumeBlock,
  type EffectiveSelection,
  type PersistedSession,
  type ResumeBlock,
  type ResumeConditions,
  type SessionState,
  type StoragePort,
} from "../core/index.js";
import type { Assert } from "./permissions.js";
import { contextValue, describe, ICONS, iconFor, label, safeSelection, safeText, tooltip } from "./sessionRows.js";

export {
  ICONS,
  LIVE_CONTEXT,
  PAST_CONTEXT,
  RESUMABLE_CONTEXT,
  WORKTREE_MARK,
} from "./sessionRows.js";

/**
 * The Sessions tree: every Session this window has, live or only remembered,
 * with its Subagents beneath it (ARCHITECTURE.md §Layering rules).
 *
 * `vscode` is a type-only import here, as it is everywhere below the composition
 * root, so the whole surface — what a row says, which actions it offers, when a
 * row disappears — is exercised by the unit suite without an extension host.
 *
 * A live Session is drawn from the Session object itself rather than from its
 * record: records are written with nothing waiting on them, so a row fed by the
 * file would lag a Turn it is meant to be showing. A Session that is only a
 * record is drawn from the record. No Session is ever both, and the live one
 * wins, because a stale row about a running Agent is the worse of the two.
 */

// `vscode.TreeItemCollapsibleState`, pinned by the enum itself: the numbers
// cross a boundary this module only imports types through, and a wrong one
// would silently draw a Session with Subagents as a leaf.
const NONE: vscode.TreeItemCollapsibleState.None = 0;
const COLLAPSED: vscode.TreeItemCollapsibleState.Collapsed = 1;

/**
 * The part of a live `ConductorSession` a row is drawn from.
 *
 * Structural, so the tree can be driven without an Agent process — and asserted
 * against the real class below, so a Session that stops offering one of these
 * fails the build here rather than at wiring time.
 */
export interface TrackedSession {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly state: SessionState;
  readonly modelSelection: EffectiveSelection;
  readonly effortSelection: EffectiveSelection;
  /** Resolves when the Agent process is gone. */
  readonly exited: Promise<unknown>;
}

/** What the Agent last reported spending. Never inferred (ADR-0005). */
export interface SessionCost {
  amount: number;
  currency: string;
}

/** Everything about a live Session that the Session object does not know. */
export interface TrackedAbout {
  /** Absolute `cwd` this Session was created with. */
  workspace: string;
  /** Values this Session's Agent was started with, so nothing it echoes back
   *  can put one on screen (ADR-0010). A record is redacted on its way to disk;
   *  a live row has to be redacted here, for the same reason. */
  secrets?: readonly string[];
  worktree?: { path: string; branch: string };
}

/** One row. Also the element VS Code hands back to a command. */
export interface SessionNode {
  /**
   * The row's identity. Not the session id: an Agent chooses that itself and
   * nothing makes it unique across Runtimes or folders — the store keys a record
   * on all three for the same reason. Two rows sharing one identity is one row
   * silently never drawn, and a Session nothing draws is one nothing can cancel.
   */
  key: string;
  /**
   * The Agent's own session id — what `session/load` and a cancel are addressed
   * with, and the id a Subagent names its parent by.
   *
   * Never redacted: it is a handle, and a handle nothing answers to is a button
   * that quietly does nothing. What is drawn instead is `shownId`.
   */
  id: string;
  /** The session id as it may be drawn: the Agent chose it, so it passes the
   *  same redaction a record does on its way to disk (ADR-0010). */
  shownId: string;
  runtimeId: string;
  /** Absolute `cwd` the Session runs in. A handle, like `id`: it is compared
   *  against the folders this window holds, so it is never redacted. */
  workspace: string;
  /** The same folder as it may be drawn. */
  shownWorkspace: string;
  state: SessionState;
  /** Runtime Trust fingerprint the Session ran under, so whether it may be
   *  reattached to can be worked out again at the moment somebody clicks rather
   *  than read off a row drawn minutes ago (ADR-0008). */
  fingerprint: string;
  /** The Agent advertised `loadSession`. */
  loadable: boolean;
  /** When the window holding this Session last said it still had it open. */
  heldAt?: number;
  /** This window owns the Agent process right now. */
  live: boolean;
  /** How long this window has been running it. Live Sessions only. */
  runningMs?: number;
  /**
   * How long ago a Session that is only a record was last written.
   *
   * Not how long it ran: a record keeps when it was first and last written, and
   * a Session resumed the next day keeps its original `createdAt`, so the span
   * between them is a day and not the ten minutes anybody spent in it.
   */
  lastActiveMs?: number;
  model?: EffectiveSelection;
  effort?: EffectiveSelection;
  cost?: SessionCost;
  worktree?: { path: string; branch: string };
  /** Why this Session cannot be reattached to, when it cannot. Live Sessions
   *  are already attached and carry none. */
  blocked?: ResumeBlock;
  children: SessionNode[];
}

export interface SessionsTreeOptions {
  storage: StoragePort;
  /**
   * What resumability is re-derived against right now: the Runtime Trust
   * fingerprint this window holds per Runtime, and the folders it has open.
   *
   * Read from what the user approved rather than from a fresh resolution, so
   * drawing the tree never hashes an executable. It decides what is *offered*;
   * the launch itself still re-resolves and refuses a Runtime that moved or
   * changed, which is the gate that matters (ADR-0007).
   */
  conditions(): ResumeConditions;
  now(): number;
  /** `new vscode.ThemeIcon(id)`. The tree names an icon; it never builds one. */
  icon?(id: string): unknown;
  /** Settles once queued Session records have been written — `savesSettled`. */
  saved?(): Promise<void>;
}

/** A live Session, with what only the caller that opened it knows. */
interface LiveEntry {
  session: TrackedSession;
  about: TrackedAbout;
  startedAt: number;
}

export class SessionsTree {
  readonly #options: SessionsTreeOptions;
  /** Keyed by row identity, never by session id: an Agent chooses that, and two
   *  Sessions holding one key is one of them with no row and no way to cancel it. */
  readonly #live = new Map<string, LiveEntry>();
  /** Latest cost per live row. Beside the Session because ACP reports it as an
   *  Update and nothing retains it — and keyed like the rows, so it is dropped
   *  with the Session that earned it rather than inherited by the next. */
  readonly #cost = new Map<string, SessionCost>();
  readonly #listeners = new Set<(node: SessionNode | undefined) => unknown>();

  constructor(options: SessionsTreeOptions) {
    this.#options = options;
  }

  /** `vscode.TreeDataProvider.onDidChangeTreeData`. */
  readonly onDidChangeTreeData: vscode.Event<SessionNode | undefined> = (
    listener,
    thisArgs?,
    disposables?,
  ) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.#listeners.add(bound);
    const subscription = { dispose: () => this.#listeners.delete(bound) };
    disposables?.push(subscription);
    return subscription;
  };

  /**
   * Follows one live Session until its process is gone.
   *
   * Removal is tied to the process ending rather than to whoever owned it, so a
   * Session that died on its own leaves the live list just as predictably as one
   * that was disposed. The record that replaces the row is written by the same
   * event, with nothing waiting on it — hence the second refresh once the saves
   * have settled, so the row that takes its place says how it ended rather than
   * how it began. That ordering is the caller's: whatever writes the record must
   * have queued its write before this is called.
   */
  track(session: TrackedSession, about: TrackedAbout): void {
    // Built from the same values a record holds, redaction included: a record is
    // redacted on its way to disk, so a live row keyed on the raw text would not
    // match its own record and the same conversation would be drawn twice — once
    // live, and once as a row offering to open a second process on it.
    const secrets = about.secrets ?? [];
    const key = rowKey(
      safeText(session.runtimeId, secrets),
      safeText(about.workspace, secrets),
      safeText(session.sessionId, secrets),
    );
    this.#live.set(key, { session, about, startedAt: this.#options.now() });
    // Whatever the Session this replaces spent is not this one's: an Agent may
    // reuse an id, and the handler that would have cleared it has not run yet.
    this.#cost.delete(key);
    this.refresh();
    void session.exited.then(async () => {
      // Only its own: an Agent may reuse a session id, and a late handler that
      // deleted by key alone would take the Session that replaced it — leaving a
      // running Agent with no row, and so nothing to cancel it with.
      if (this.#live.get(key)?.session !== session) return;
      this.#live.delete(key);
      this.#cost.delete(key);
      this.refresh();
      await this.#options.saved?.().catch(() => undefined);
      this.refresh();
    });
  }

  /**
   * One Update, for the two things a row shows that only an Update carries.
   *
   * An Agent may name any Session it likes in a notification, including one this
   * window does not hold — the Session layer forwards those rather than adopting
   * them, and so does this. Anything else is a map an Agent can grow without
   * bound, and a cost figure drawn against a Session whose Agent never sent it.
   */
  observe(sessionId: string, update: { sessionUpdate?: unknown; cost?: unknown }): void {
    if (update.sessionUpdate !== "usage_update") return;
    const cost = update.cost;
    if (!isCost(cost)) return;
    const key = this.#keyOf(sessionId);
    if (key === undefined) return;
    const held = this.#cost.get(key);
    // Only when it moved: a Turn reports usage repeatedly, and redrawing the
    // tree for an unchanged number is work the extension host does for nothing.
    if (held && held.amount === cost.amount && held.currency === cost.currency) return;
    this.#cost.set(key, cost);
    this.refresh();
  }

  /**
   * Redraws every row. Cheap: the rows themselves are rebuilt lazily, and only
   * while the view is on screen.
   *
   * A listener that throws is logged over rather than allowed out: this runs on
   * the path an Agent's Update takes, and a view that has been torn down must
   * not be able to swallow the Update behind it.
   */
  refresh(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(undefined);
      } catch {
        // A drawing surface is not allowed to fail an Update.
      }
    }
  }

  /** `vscode.TreeDataProvider.getChildren`. */
  async getChildren(node?: SessionNode): Promise<SessionNode[]> {
    if (node) return node.children;
    return this.#roots();
  }

  /** `vscode.TreeDataProvider.getTreeItem`. */
  getTreeItem(node: SessionNode): vscode.TreeItem {
    const icon = this.#options.icon?.(ICONS[iconFor(node.state)]);
    return {
      // Derived, never the row key itself: VS Code keeps which rows are open and
      // selected under this id, in storage that outlives the window, and the key
      // holds a session id the Agent chose (ADR-0010).
      id: viewId(node.key),
      label: label(node.runtimeId),
      description: describe(node),
      tooltip: tooltip(node),
      contextValue: contextValue(node),
      collapsibleState: node.children.length > 0 ? COLLAPSED : NONE,
      ...(icon === undefined ? {} : { iconPath: icon as vscode.TreeItem["iconPath"] }),
    };
  }

  #keyOf(sessionId: string): string | undefined {
    for (const [key, entry] of this.#live) if (entry.session.sessionId === sessionId) return key;
    return undefined;
  }

  async #roots(): Promise<SessionNode[]> {
    const conditions = this.#options.conditions();
    const now = this.#options.now();
    // Read before the live Sessions are looked at, not after: a Session's record
    // is queued the moment it opens, so a list taken first and merged after the
    // wait can hold the record of a Session that became live during it — drawn
    // as ended, and offering to reattach to a conversation already running.
    const stored = await readSessions(this.#options.storage);
    const nodes = new Map<string, SessionNode>();
    for (const [key, entry] of this.#live) nodes.set(key, this.#liveNode(key, entry, now));
    // Lineage is kept beside the nodes, never on them: a node is handed to a
    // command exactly as it is, so it carries what a command needs and no more.
    const parents = new Map<string, string>();
    for (const saved of stored) {
      const key = rowKey(saved.runtimeId, saved.workspace, saved.sessionId);
      if (saved.parentSessionId) parents.set(key, saved.parentSessionId);
      // Records for Sessions this window is running are dropped rather than
      // merged: the record is a snapshot of a Session that has not finished, and
      // two rows for one conversation is the reading nobody wants.
      if (nodes.has(key)) continue;
      nodes.set(key, savedNode(key, saved, conditions, now));
    }
    // A Subagent names its parent by session id and may run on another Runtime
    // in another folder, so the parent is found by id. Records arrive newest
    // first, so where an Agent has reused an id, the most recent one is the
    // parent — which is the only reading that is ever right by itself.
    const byId = new Map<string, SessionNode>();
    for (const node of nodes.values()) if (!byId.has(node.id)) byId.set(node.id, node);
    const roots: SessionNode[] = [];
    for (const node of nodes.values()) {
      const parent = parentOf(node, byId, parents);
      // A Subagent whose parent this window does not hold is drawn at the top
      // rather than hidden: the parent may have been evicted from the store, and
      // a Session nothing shows is a Session nothing can cancel.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  #liveNode(key: string, entry: LiveEntry, now: number): SessionNode {
    const { session, about } = entry;
    const cost = this.#cost.get(key);
    const secrets = about.secrets ?? [];
    return {
      key,
      id: session.sessionId,
      shownId: safeText(session.sessionId, secrets),
      runtimeId: session.runtimeId,
      workspace: about.workspace,
      shownWorkspace: safeText(about.workspace, secrets),
      state: session.state,
      // A live Session is already attached, so neither of these is ever read for
      // one — an action returns on `live` before it looks. They are the refusing
      // values rather than plausible ones, so that a reader which did look would
      // be told no (ADR-0007).
      fingerprint: "",
      loadable: false,
      live: true,
      // Clamped where the subtraction happens, as the record's age is: the
      // clock this reads is not monotonic, and a correction backwards under a
      // running session would draw it as one that ran for minus two minutes.
      runningMs: Math.max(0, now - entry.startedAt),
      model: safeSelection(session.modelSelection, secrets),
      effort: safeSelection(session.effortSelection, secrets),
      // Every field of it: an Agent chooses the currency it words a figure in
      // just as freely as it chooses what it says it is running.
      ...(cost ? { cost: { amount: cost.amount, currency: safeText(cost.currency, secrets) } } : {}),
      ...(about.worktree
        ? {
            worktree: {
              path: safeText(about.worktree.path, secrets),
              branch: safeText(about.worktree.branch, secrets),
            },
          }
        : {}),
      children: [],
    };
  }
}

/**
 * The Session this one hangs under, or nothing.
 *
 * Walked to the top rather than resolved in one step, because the chain is read
 * from a file two windows write: a record naming itself, or a pair naming each
 * other, would otherwise leave every node in the cycle a child of another and
 * the whole tree empty — the one outcome a Session view must never produce.
 */
function parentOf(
  node: SessionNode,
  byId: Map<string, SessionNode>,
  parents: Map<string, string>,
): SessionNode | undefined {
  const parent = byId.get(parents.get(node.key) ?? "");
  // Seeded with this node, so a Session naming itself is caught by the same walk
  // rather than by a second rule beside it.
  const seen = new Set([node.key]);
  for (let above: SessionNode | undefined = parent; above; ) {
    if (seen.has(above.key)) return undefined;
    seen.add(above.key);
    above = byId.get(parents.get(above.key) ?? "");
  }
  return parent;
}

/**
 * A Persisted Session's own identity, as the store defines it.
 *
 * Each part is written with its length in front, so the key is unique whatever
 * the parts contain. A separator alone would not be: an Agent chooses its own
 * session id and nothing checks its characters, so it may hold the separator.
 */
function rowKey(runtimeId: string, workspace: string, sessionId: string): string {
  return [runtimeId, workspace, sessionId].map((part) => `${part.length}:${part}`).join("");
}

/** The same identity, as something that may be written down by somebody else. */
function viewId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function savedNode(
  key: string,
  saved: PersistedSession,
  conditions: ResumeConditions,
  now: number,
): SessionNode {
  const blocked = resumeBlock(saved, conditions);
  return {
    key,
    id: saved.sessionId,
    // A record was redacted on its way to disk, so what it holds is already
    // what may be drawn.
    shownId: saved.sessionId,
    runtimeId: saved.runtimeId,
    workspace: saved.workspace,
    // A record was redacted on its way to disk, so what it holds may be drawn.
    shownWorkspace: saved.workspace,
    state: saved.state,
    fingerprint: saved.fingerprint,
    loadable: saved.loadable,
    // Carried onto the row so that whether somebody else still has it is worked
    // out again when the user clicks, not only when the row was drawn.
    ...(saved.heldAt === undefined ? {} : { heldAt: saved.heldAt }),
    live: false,
    lastActiveMs: Math.max(0, now - saved.updatedAt),
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.effort ? { effort: saved.effort } : {}),
    ...(saved.worktree ? { worktree: saved.worktree } : {}),
    ...(blocked ? { blocked } : {}),
    children: [],
  };
}

function isCost(value: unknown): value is SessionCost {
  if (typeof value !== "object" || value === null) return false;
  const cost = value as Record<string, unknown>;
  // Finite, not merely a number: `Infinity` reaches a row as a figure the Agent
  // never reported, and this Client is the one that failed to check it.
  return Number.isFinite(cost.amount) && typeof cost.currency === "string";
}

/** The tree still is the VS Code API it stands for; see `config.ts`. */
export type SessionsTreePortsMatchVsCodeApi = [
  Assert<SessionsTree extends vscode.TreeDataProvider<SessionNode> ? true : false>,
  // And the live half of a row still is the Session it is drawn from, so a
  // Session that stops offering one of these fails the build here rather than
  // at the one line that wires them together.
  Assert<ConductorSession extends TrackedSession ? true : false>,
  // The gate's own self-test: a member VS Code does not implement is rejected.
  Assert<SessionsTree extends { sparkle(): void } ? false : true>,
];
