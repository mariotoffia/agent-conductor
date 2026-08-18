# ADR-0001: ACP is the downstream agent protocol

- Status: accepted
- Date: 2026-08-18

## Context

Candidate integration paths for driving coding CLIs from VS Code: per-CLI headless stream formats (`claude --output-format stream-json`, `codex exec --json`, …), VS Code's Language Model / Chat APIs, Microsoft's Agent Host Protocol (AHP), or the Agent Client Protocol (ACP). Per-CLI formats mean N bespoke parsers. The LM provider API hands the loop to Copilot — wrong shape for CLIs that *are* harnesses. AHP has no third-party harness registration and VS Code only connects to its own `code agent host` (SSH/dev-tunnel, auto-installed CLI); the protocol is explicitly unstable. ACP v1 is stable, jointly governed (Zed + JetBrains), has an official TS SDK, a machine-readable agent registry, and adapters/native support across every target CLI. Microsoft's own AHP doctrine treats ACP as the downstream layer.

## Decision

All agent communication is ACP v1 over stdio. Non-ACP CLIs enter only through their ACP adapters. AHP surfaces (client or server) are deferred; nothing in the codebase may depend on AHP shapes. ACP v2 adoption requires a superseding ADR.

## Consequences

One protocol core covers every runtime, current and future (registry-resolved). We inherit ACP limits: no shared context across harnesses (delegation is Brief-level), stdio-only transport, config options as the only model/effort channel (ADR-0005). Revisit AHP when VS Code allows attach-by-address or harness registration.

## References

agentclientprotocol.com (v1 spec, registry) · microsoft.github.io/agent-host-protocol (guide/ahp-and-acp) · vscode issue #265496
