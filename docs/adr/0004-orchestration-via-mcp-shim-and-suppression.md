# ADR-0004: Subagents go through an MCP server we inject, and each CLI's own version is switched off

- Status: accepted
- Date: 2026-08-18

## Context

Every CLI we target can already hand work to subagents: Claude has an `Agent` tool, Codex `spawn_agent`, Gemini `invoke_agent`, Copilot `task`.

If we leave those on, the decision to spawn happens inside one vendor's harness. It never passes our policy, our budgets, or our UI.

ACP lets the client add MCP servers to a session, and all four major CLIs honour that. ACP v2 and the proxy-chains RFD both endorse client-provided MCP as the way to extend an agent.

## Decision

Each runtime gets a **Suppression Plan** that switches off its built-in delegation:

| Runtime | How |
|---|---|
| claude | `_meta`: `disallowedTools` plus `agents:{}` |
| codex | `CODEX_CONFIG` turns agents and the related features off — applies to the whole process |
| gemini | merge into the workspace settings file, after asking the user |
| copilot | `--excluded-tools` at startup |

The conductor then injects a bundled MCP server over stdio — the Shim. It offers `spawn_subagent` (runtime, model and effort all optional), `list_runtimes`, and tools for background work. The Shim passes calls back to the extension over a local socket, authenticated by a token.

The Depth Cap works by **not injecting the Shim** below it. Injection is what stops the recursion.

Subagents share no conversation with their parent. A Brief carries file paths, never file contents.

## Consequences

Every act of delegation becomes visible, budgeted, cancellable, and able to cross from one CLI to another.

The costs: each spawn pays a cold start; a runtime whose config applies to the whole process needs one process per policy; and the suppression recipes are vendor-specific and have to be pinned by tests. Flags rot — Claude's tool was renamed from `Task` to `Agent`, and the old name silently did nothing.

## References

ARCHITECTURE.md §Data flows · agentclientprotocol.com/rfds/proxy-chains · per-CLI verification record: docs/CHANGELOG.md
