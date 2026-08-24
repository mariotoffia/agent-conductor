import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeTrust } from "../../core/index.js";
import { runtimeTrustStore, trustKey, type TrustStorage } from "../../vscode/runtimeTrust.js";

/**
 * Trust the user granted in this window survives its own storage.
 *
 * VS Code's `globalState` is where an approval lives between windows, and it is
 * the right place for it. What it does not promise is that a value is readable
 * for as long as the window that wrote it runs: a flush that began before the
 * last write can land after it, and the newest key is the one that disappears.
 * Observed exactly so — three approvals seconds apart, the two older ones still
 * there, the newest gone from `keys()` two hundred milliseconds after it had
 * been written and read back.
 *
 * Losing that value is not a stale display. Trust is re-derived on every spawn,
 * so a Runtime the user approved a moment ago is refused as one they never took
 * through the wizard — which is advice to do the thing they just did.
 */

const TRUST: RuntimeTrust = { fingerprint: "sha256:approved" };
const OTHER: RuntimeTrust = { fingerprint: "sha256:elsewhere" };

/** A `globalState` that keeps what it is given. */
function keepingStorage(): TrustStorage & { held: Map<string, unknown> } {
  const held = new Map<string, unknown>();
  return {
    held,
    get: <T>(key: string): T | undefined => held.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      held.set(key, value);
      return Promise.resolve();
    },
  };
}

/**
 * Storage as it behaved when this was found: a flush that began before the last
 * write lands after it, so the write is accepted and then gone, while every key
 * already there is untouched. What it holds to begin with is the point — the
 * loss is of one key, not of the store, and the fallback has to be per Runtime.
 */
function losingTheNewestWrite(already: ReadonlyMap<string, RuntimeTrust>): TrustStorage {
  const held = new Map<string, unknown>(already);
  return {
    get: <T>(key: string): T | undefined => held.get(key) as T | undefined,
    // Accepted, and then lost to the stale snapshot landing on top of it.
    update: () => Promise.resolve(),
  };
}

test("an approval is readable back through the store that recorded it", async () => {
  const store = runtimeTrustStore(keepingStorage());

  await store.record("claude", TRUST);

  assert.deepEqual(store.get("claude"), TRUST);
});

test("a runtime nobody approved is untrusted, and the store never invents one", () => {
  const store = runtimeTrustStore(keepingStorage());

  assert.equal(store.get("claude"), undefined);
});

test("an approval survives storage losing the write that carried it", async () => {
  // One Runtime approved earlier and still in storage, which is what makes the
  // loss the newest key's alone rather than the whole store's.
  const earlier = new Map([[trustKey("codex"), OTHER]]);
  const store = runtimeTrustStore(losingTheNewestWrite(earlier));

  await store.record("claude", TRUST);

  // Storage has forgotten it. The window has not, and the user did approve it.
  assert.deepEqual(store.get("claude"), TRUST);
  // And the Runtime approved before it is still read from storage, unaffected.
  assert.deepEqual(store.get("codex"), OTHER);
});

test("what storage holds wins, so another window's newer approval is the one used", async () => {
  const storage = keepingStorage();
  const store = runtimeTrustStore(storage);
  await store.record("claude", TRUST);

  // A second window approves a different identity for the same Runtime; this
  // window's memory is then the older answer and must not be preferred.
  await storage.update(trustKey("claude"), OTHER);

  assert.deepEqual(store.get("claude"), OTHER);
});

test("an approval whose write failed is not remembered as one", async () => {
  // The wizard tells the user their connection could not be saved. A window
  // that went on treating the Runtime as approved would be contradicting the
  // refusal it just showed them, and starting an Agent on it (ADR-0007).
  const store = runtimeTrustStore({
    get: () => undefined,
    update: () => Promise.reject(new Error("globalState is full")),
  });

  await assert.rejects(store.record("claude", TRUST), /globalState is full/);

  assert.equal(store.get("claude"), undefined);
});

test("one runtime's approval is never read for another", async () => {
  const store = runtimeTrustStore(losingTheNewestWrite(new Map()));

  await store.record("claude", TRUST);

  assert.equal(store.get("codex"), undefined);
});
