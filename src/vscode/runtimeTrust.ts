import type { RuntimeTrust } from "../core/index.js";

/**
 * Where Runtime Trust is kept.
 *
 * Written by the connection wizard, which is the only thing that may: a Runtime
 * nobody took through it resolves untrusted, and no Agent is started for it
 * (ADR-0007). One reader and one writer, so this is the whole of it.
 */

/** The part of VS Code's `Memento` this needs, so the store can be driven
 *  without one. `PromiseLike` rather than VS Code's `Thenable`, which is the
 *  same shape under a name only the extension host declares. */
export interface TrustStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface RuntimeTrustStore {
  /** Records what the user approved for one Runtime. */
  record(runtimeId: string, trust: RuntimeTrust): Promise<void>;
  /** What they approved, or nothing because they never did. */
  get(runtimeId: string): RuntimeTrust | undefined;
}

export function runtimeTrustStore(storage: TrustStorage): RuntimeTrustStore {
  /**
   * What this window granted, kept beside what storage holds.
   *
   * `globalState` is where an approval belongs — it is what another window and
   * the next one read. What it does not promise is that a value stays readable
   * for as long as the window that wrote it runs: a flush that began before the
   * last write lands after it, and the key that disappears is the newest one.
   * Observed as three approvals written seconds apart, the two older ones still
   * present and the newest gone from `keys()` two hundred milliseconds after it
   * had been written and read back.
   *
   * Trust is re-derived from storage on every spawn, so losing it is not a
   * stale display: the Runtime the user approved a moment ago is refused as one
   * they never took through the wizard, which is advice to do what they just
   * did. The precedence below is the decision, not a detail (ADR-0012).
   */
  const granted = new Map<string, RuntimeTrust>();
  return {
    async record(runtimeId, trust) {
      // Storage first, and only then remembered. A write that failed is one the
      // wizard tells the user did not save, and a window that went on treating
      // the Runtime as approved would contradict the refusal it just showed
      // them — and start an Agent on it (ADR-0007).
      await storage.update(trustKey(runtimeId), trust);
      granted.set(runtimeId, trust);
    },
    get(runtimeId) {
      // Storage first, so a Runtime re-approved in another window is read as
      // that window left it. This one's memory answers only where storage has
      // nothing — it can keep an approval the user made, never invent one.
      return storage.get<RuntimeTrust>(trustKey(runtimeId)) ?? granted.get(runtimeId);
    },
  };
}

/** Where one Runtime's approval is kept. Exported so a test can stand in for
 *  another window writing directly, rather than spelling the format again. */
export const trustKey = (runtimeId: string): string => `runtimeTrust.${runtimeId}`;
