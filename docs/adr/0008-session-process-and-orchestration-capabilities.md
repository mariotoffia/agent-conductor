# ADR-0008: Session process and orchestration capabilities

- Status: accepted
- Date: 2026-08-18
- Supersedes: process-lifecycle and capability-scope portions of ADR-0004

## Context

ACP connections can host multiple Sessions, but cancellation may require terminating an unresponsive Agent process. Process sharing would let one Session's fallback cancellation or crash affect unrelated Sessions. A window-wide Shim token would also let one compromised Session impersonate another.

## Decision

For v1, every Session owns exactly one Agent process. Cancellation sends `session/cancel`, waits for the configured grace period, then may terminate only that Session's process. Parent cancellation cascades through tracked child Sessions.

Orchestration is explicit opt-in. While disabled, the extension issues no Session Capability, injects no Shim, and exposes no spawn RPC. Each eligible Shim receives a random, short-lived **Session Capability**. The extension binds it server-side to the parent Session, spawn depth, workspace roots, expiry, and allowed RPC methods. Every RPC requires an active parent and current Runtime Trust. Parent termination or cancellation, trust invalidation, or orchestration disablement immediately revokes the capability server-side. Callers cannot supply or change lineage, roots, limits, or policy. Capabilities are not shared between Sessions.

Shim injection additionally requires a current **Suppression Capability** for the exact Runtime launch identity. Agent-side monetary limits are represented separately as a **Budget Capability**; they never replace local depth, concurrency, spawn-count, and timeout limits.

A **Persisted Session** is a versioned metadata record containing identifiers, Runtime and workspace identity, timestamps, requested/effective selections, stop state, parent identity, worktree metadata, and an optional SecretStorage reference to an Agent resume token. Resume tokens are treated as credentials unless the protocol proves otherwise, bound to the Runtime Trust fingerprint and workspace, and deleted when the Session is forgotten or either binding changes. Prompts, hidden context, credentials, resume-token values, and tool payloads are not persisted in the metadata record.

## Alternatives considered

- Pool Sessions by Runtime or policy tuple: rejected for v1 because process termination is not Session-isolated.
- Use one token per VS Code window: rejected because it grants every eligible Session the same authority.
- Trust caller-provided depth or roots: rejected because those are authorization inputs.
- Persist full transcripts: rejected as unnecessary sensitive-data retention.

## Consequences

V1 uses more processes and cold starts, but crash and cancellation ownership is deterministic. Orchestration authorization can be tested per Session, Runtime upgrades invalidate suppression evidence, unsupported monetary budgets remain visibly unavailable, and resume storage is bounded and migratable.

## References

ADR-0004 · ARCHITECTURE.md §Data flows · UBIQUITOUS.md: Session Capability, Suppression Capability, Budget Capability, Persisted Session
