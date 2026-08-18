# ADR-0004: Cross-CLI subagents via an injected MCP shim; built-in delegation suppressed

- Status: accepted
- Date: 2026-08-18

## Context

Every target CLI ships its own delegation (Claude `Agent` tool, Codex `spawn_agent`, Gemini `invoke_agent`, Copilot `task`). Left on, spawn decisions happen inside single-vendor harnesses and escape our policy, budgets, and UI. ACP lets the client inject MCP servers per session; all four majors honor it. ACP v2 and the proxy-chains RFD both bless client-provided MCP as the extension mechanism.

## Decision

Per runtime, a Suppression Plan disables built-in delegation (claude: `_meta` disallowedTools/agents:{}; codex: `CODEX_CONFIG` agents+features off — process-scoped; gemini: workspace settings merge, consent-gated; copilot: startup `--excluded-tools`). The conductor injects a bundled stdio MCP shim exposing `spawn_subagent` (runtime/model/effort all optional), `list_runtimes`, and background lifecycle tools; the shim tunnels to the extension over a token-authed local socket. The Depth Cap works by **not injecting the shim** below it — injection is the recursion guard. Subagents share no conversation context: Briefs carry paths, never contents.

## Consequences

All delegation is observable, budgeted, cancellable, and cross-CLI. Costs: per-spawn cold-start token overhead; process-scoped runtimes need one process per policy; suppression recipes are per-vendor and must be golden-tested (flags rot — e.g. Claude's tool renamed `Task`→`Agent`).

## References

ARCHITECTURE.md §Data flows · agentclientprotocol.com/rfds/proxy-chains · per-CLI evidence: docs/plans/0002 Appendix A
