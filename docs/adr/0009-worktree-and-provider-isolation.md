# ADR-0009: Worktrees keep changes apart, not agents

- Status: accepted
- Date: 2026-08-18

## Context

A Git worktree separates branches and working files. It does not stop an agent process reading any path the operating system allows.

Passing the parent repository through ACP's `additionalDirectories` cannot make it read-only either.

Handing work to another runtime can also move repository data across a provider boundary, even when the Brief contains nothing but file paths.

## Decision

**Isolation is a way to keep changes from colliding. It is never a security boundary.**

Allocating a worktree uses unique session identities and branch names, runs Git changes one at a time, records what it intends to do before doing it, and reconciles anything left over when the extension next starts. Cleanup is explicit: a worktree with uncommitted changes is never deleted automatically.

**A child does not get the parent repository** in `additionalDirectories` by default. Extra directories are sent only when the agent says it supports them and the session the user authorized actually needs them.

**Delegating across providers is off by default.** Before the first time, the user is told what data would leave, and approves the target runtime's trust fingerprint. Provider labels inform the user; they are not what we authorize against. An unknown, custom, or changed launch fingerprint has to be approved again.

A Brief stays self-contained and made of paths. But our documentation does not claim that this stops an agent, or a provider, from reading repository data.

## Alternatives considered

- **Describe worktrees as read-only or secure.** Rejected: neither Git nor ACP enforces anything of the kind.
- **Give every child the parent repository.** Rejected: it defeats the separation and widens exposure.
- **Infer provider consent from the fact that a runtime is connected.** Rejected: running an agent directly and delegating to it across providers move data differently.
- **Delete worktrees automatically when a session ends.** Rejected: with crashes and uncommitted work, that deletes real work.

## Consequences

Worktree mode makes merges and parallel changes easier without overstating what it protects.

The Orchestrator needs a journal, a lock around Git, reconciliation on startup, and a way for the user to clean up.

Cross-provider delegation costs a one-time consent step. We record which runtime and provider a session used, and store no credentials and no hidden prompt content.

## References

ADR-0004 · ARCHITECTURE.md §Data flows and §Security invariants · UBIQUITOUS.md: Isolation, Brief
