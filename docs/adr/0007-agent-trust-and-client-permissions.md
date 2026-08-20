# ADR-0007: Approving a runtime, and what permission prompts actually are

- Status: accepted
- Date: 2026-08-18

## Context

An agent is a program that runs with the user's own permissions.

ACP permission requests are optional, and `ToolKind` — the agent's label for what a tool does — is chosen by the agent itself.

So permission routing can get the user's consent for work *we* do on the agent's behalf. It cannot restrict the agent's own tools, and it cannot make an untrusted program safe.

## Decision

A runtime is untrusted until the user approves it in the connection flow. That approval is its **Runtime Trust**. Being in our catalog grants nothing.

Runtime Trust is a fingerprint of the program or adapter that will actually run, together with the launch specification. Every start checks the fingerprint again, and a mismatch stops the launch. Both workspace trust and Runtime Trust are required before any agent process starts. A user-defined runtime gets no orchestration until it is explicitly trusted.

Permission routing is consent and an audit trail. It is not a sandbox.

For its own filesystem and terminal work, the client works out a **Client Operation** from the method being served and its arguments. Automatic allow and reject rules are keyed by that. The UI may show `ToolKind`, but never uses it to decide anything — the agent chooses that value.

Runtime and provider labels are there to inform the user. Authorization uses the verified Runtime Trust fingerprint. Safe-mode flags reduce what a repository can influence; they do not replace Runtime Trust.

## Alternatives considered

- **Trust catalog entries automatically.** Rejected: resolving a launch can pick a different or replaced program.
- **Authorize by `ToolKind`.** Rejected: the agent controls that classification.
- **Treat a workspace or a safe-mode flag as a sandbox.** Rejected: the process still has the user's own access to the machine.
- **Add an OS sandbox in v1.** Deferred: enforcing one across platforms is a separate product on its own.

## Consequences

Connecting a runtime includes an explicit decision about trust, tied to the launch it resolved to. If that identity changes, the user is asked again.

The UI must describe permission prompts accurately, as consent. Security documentation must not claim that ACP confines the agent process.

## References

ARCHITECTURE.md §Security invariants · UBIQUITOUS.md: Runtime Trust, ToolKind
