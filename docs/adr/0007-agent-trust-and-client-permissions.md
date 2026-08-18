# ADR-0007: Agent trust and client permissions

- Status: accepted
- Date: 2026-08-18

## Context

An Agent is an executable with the user's OS privileges. ACP permission requests are optional, and `ToolKind` is Agent-supplied metadata. Permission routing can obtain consent for operations implemented by the Client, but it cannot constrain native Agent tools or turn an untrusted executable into a safe one.

## Decision

A Runtime is untrusted until the user approves its resolved executable or adapter identity through the connection flow. This approval is its **Runtime Trust**; catalog membership alone grants no trust. Runtime Trust fingerprints the canonical executable or adapter artifact and effective launch specification. Every spawn re-verifies the fingerprint and fails closed on mismatch. Workspace trust and Runtime Trust are both required before any Agent process starts. Custom Runtimes receive no orchestration capability until explicitly trusted.

ACP permission routing is a consent and audit mechanism, not a sandbox. The Client derives a **Client Operation** from the requested method and normalized arguments for its own filesystem and terminal handlers. Automatic policy keys use Client Operations. The UI may display `ToolKind`, but never uses that Agent-supplied value as a security or authorization input. Runtime and provider labels are disclosures; authorization uses the verified Runtime Trust fingerprint. Safe-mode flags reduce exposure to repository configuration but do not replace Runtime Trust.

## Alternatives considered

- Trust built-in catalog entries automatically: rejected because launch resolution can select a different or replaced executable.
- Authorize by `ToolKind`: rejected because the Agent controls the classification.
- Treat workspaces or safe-mode flags as an Agent sandbox: rejected because the process retains the user's OS access.
- Add an OS sandbox in v1: deferred because cross-platform enforcement is a separate product boundary.

## Consequences

Connecting a Runtime includes an explicit trust decision tied to its resolved launch identity. Changed identities require renewed trust. The UI must accurately describe permission prompts as consent, and security documentation must not claim that ACP confines the Agent process.

## References

ARCHITECTURE.md §Security invariants · UBIQUITOUS.md: Runtime Trust, ToolKind
