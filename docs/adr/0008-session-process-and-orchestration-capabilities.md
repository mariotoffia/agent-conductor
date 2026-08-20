# ADR-0008: One process per session, and what the Shim is allowed to do

- Status: accepted
- Date: 2026-08-18
- Supersedes: the process-lifecycle and capability-scope parts of ADR-0004

## Context

One ACP connection can host several sessions. But cancelling sometimes means terminating an agent that has stopped responding.

If sessions shared a process, one session's terminate — or one session's crash — would take unrelated sessions down with it.

A token shared across the whole VS Code window has the same problem in another form: one compromised session could act as any other.

## Decision

**One process per session.** For v1, every session owns exactly one agent process.

Cancelling sends `session/cancel`, waits for the configured grace period, and may then terminate that session's process and no other. Cancelling a parent cancels the children we are tracking.

**Orchestration is off until turned on.** While it is off, we issue no Session Capability, inject no Shim, and expose no spawn RPC at all.

**Each eligible Shim gets its own Session Capability**: random, short-lived, and bound on our side to the parent session, the spawn depth, the workspace roots, an expiry, and the list of RPC methods it may call. Every call requires an active parent and current Runtime Trust.

The capability is revoked immediately, on our side, when the parent ends or is cancelled, when trust stops being valid, or when orchestration is turned off. A caller cannot supply or change its own lineage, roots, limits, or policy. Capabilities are never shared between sessions.

**Injecting the Shim needs more than trust**: it needs a current Suppression Capability for that exact launch identity.

An agent's ability to enforce a money limit is tracked separately, as a **Budget Capability**. It never replaces our own limits on depth, concurrency, spawn count, and timeouts.

**A Persisted Session is metadata only**, with a version. It holds identifiers, which runtime and workspace it belongs to, timestamps, requested and effective selections, stop state, the parent's identity, worktree details, and optionally a SecretStorage reference to a resume token.

Resume tokens are treated as credentials unless the protocol proves otherwise. Each is tied to the Runtime Trust fingerprint and the workspace, and deleted when the session is forgotten or either of those changes.

Prompts, hidden context, credentials, resume-token values, and tool payloads are never written into that record.

## Alternatives considered

- **Pool sessions by runtime or policy.** Rejected for v1: terminating a process is not isolated to one session.
- **One token per VS Code window.** Rejected: it gives every eligible session the same authority.
- **Trust the depth or roots the caller sends.** Rejected: those decide what is allowed, so they cannot come from the caller.
- **Save full transcripts.** Rejected: keeping sensitive data we do not need.

## Consequences

V1 uses more processes and pays more cold starts. In return, it is always clear which session a crash or a cancellation belongs to.

Orchestration can be tested one session at a time. Upgrading a runtime invalidates the evidence that suppression worked. A runtime that cannot enforce a money limit shows that plainly. Resume storage stays small and can be migrated.

## References

ADR-0004 · ARCHITECTURE.md §Data flows · UBIQUITOUS.md: Session Capability, Suppression Capability, Budget Capability, Persisted Session
