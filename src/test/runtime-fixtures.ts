import assert from "node:assert/strict";
import {
  builtinRuntimes,
  REGISTRY_CACHE_KEY,
  type ExecutablePort,
  type RuntimeSpec,
  type SessionPolicy,
  type StoragePort,
} from "../core/index.js";

/** Fixtures shared by the Runtime catalog, resolution, and trust tests. */
/** Frozen: every built-in spec holds this object by reference, so one test
 *  mutating it would quietly reconfigure the rest of the file. */
export const policy: SessionPolicy = Object.freeze({ suppressBuiltInSubagents: true });

/** PATH lookup fake: only the names it was given resolve, to canonical paths. */
export function executables(paths: Record<string, string>): ExecutablePort {
  return {
    async resolve(command: string) {
      const path = paths[command];
      return path ? { path } : undefined;
    },
  };
}

/** Every built-in Runtime's executable, installed where PATH would find it. */
export const installed = executables({
  "claude-agent-acp": "/opt/bin/claude-agent-acp",
  "codex-acp": "/opt/bin/codex-acp",
  gemini: "/opt/bin/gemini",
  copilot: "/opt/bin/copilot",
});

/** A built-in Runtime with the fields under test replaced. */
export function spec(overrides: Partial<RuntimeSpec> = {}): RuntimeSpec {
  const [claude] = builtinRuntimes(policy);
  return { ...claude, ...overrides };
}

/** Shape published at cdn.agentclientprotocol.com/registry/v1/latest/registry.json. */
export const registryText = JSON.stringify({
  version: "1.0.0",
  agents: [
    {
      id: "claude-acp",
      name: "Claude Agent",
      version: "0.71.0",
      description: "ACP adapter for Claude Code",
      distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.71.0" } },
    },
    {
      id: "amp-acp",
      name: "Amp",
      version: "0.9.0",
      distribution: { binary: { "darwin-aarch64": { archive: "https://x/y.tar.gz", cmd: "./amp-acp", sha256: "ab" } } },
    },
  ],
  extensions: [],
});

/** In-memory StoragePort that records every write it was asked to make. */
export function storage(initial?: string): StoragePort & { readonly writes: string[] } {
  let value = initial;
  const writes: string[] = [];
  return {
    get writes() { return writes; },
    async read(key: string) { return key === REGISTRY_CACHE_KEY ? value : undefined; },
    async writeAtomic(key: string, next: string) {
      assert.equal(key, REGISTRY_CACHE_KEY);
      writes.push(next);
      value = next;
    },
  };
}
