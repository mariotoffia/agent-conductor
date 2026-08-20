# ADR-0001: ACP is the protocol we use to drive agents

- Status: accepted
- Date: 2026-08-18

## Context

There were four ways to drive a coding CLI from VS Code.

- **Each CLI's own output format** (`claude --output-format stream-json`, `codex exec --json`, and so on). That means writing and maintaining a separate parser for every CLI.
- **VS Code's Language Model and Chat APIs.** These hand the agent loop to Copilot. That is the wrong shape: these CLIs *are* agent loops.
- **Microsoft's Agent Host Protocol (AHP).** A third party cannot register a harness with it. VS Code only connects to its own `code agent host`, over SSH or a dev tunnel, with the CLI installed for you. The protocol describes itself as unstable.
- **The Agent Client Protocol (ACP).** Version 1 is stable and governed jointly by Zed and JetBrains. It has an official TypeScript SDK, a machine-readable registry of agents, and either an adapter or native support for every CLI we target. Microsoft's own AHP documentation treats ACP as the layer beneath it.

## Decision

We talk to agents over ACP v1, on stdio, and nothing else. A CLI that does not speak ACP is used through its ACP adapter.

AHP is deferred, both as something we call and as something we offer. No code may depend on an AHP shape.

Moving to ACP v2 requires a new ADR that supersedes this one.

## Consequences

One protocol core covers every runtime we support today, and every one the registry adds later.

We also take on ACP's limits. Two harnesses share no conversation, so handing work between them means writing a Brief. The transport is stdio only. Config options are the only way to set model and effort (ADR-0005).

Look at AHP again if VS Code ever allows connecting by address, or lets a third party register a harness.

## References

agentclientprotocol.com (v1 spec, registry) · microsoft.github.io/agent-host-protocol (guide/ahp-and-acp) · vscode issue #265496
