# ADR-0009: Worktree and provider isolation

- Status: accepted
- Date: 2026-08-18

## Context

A Git worktree separates branches and working files, but an Agent process can still access any path allowed by the operating system. Passing the parent repository through ACP `additionalDirectories` cannot make it read-only. Delegating to another Runtime can also move repository data across provider boundaries even when the Brief contains only paths.

## Decision

**Isolation** is a change-coordination mode, never a security boundary. Worktree allocation uses unique Session identities and branches, serializes Git mutations, records intent before creation, and reconciles abandoned allocations on activation. Cleanup is explicit; dirty worktrees are never deleted automatically.

The parent repository is omitted from child `additionalDirectories` by default. Additional directories are sent only when the Agent advertises support and the user-authorized Session requires them.

Cross-provider orchestration is disabled by default. Before first use, the user receives a data-egress notice and approves target Runtime Trust fingerprints. Provider labels are disclosures, not authorization identities. Unknown, custom, or changed launch fingerprints require renewed consent. A Brief remains self-contained and path-oriented, but documentation does not claim that this prevents an Agent or provider from reading repository data.

## Alternatives considered

- Describe worktrees as read-only or secure isolation: rejected because Git and ACP provide no such enforcement.
- Grant every child the parent repository: rejected because it defeats the intended separation and expands exposure.
- Infer provider consent from Runtime connection: rejected because direct execution and cross-provider delegation have different data flows.
- Delete worktrees automatically at Session end: rejected because crashes and uncommitted work can make cleanup destructive.

## Consequences

Worktree mode improves merge and change coordination without overstating security. The Orchestrator needs a journal, Git lock, reconciliation, and explicit cleanup UI. Cross-provider delegation adds a one-time consent step and records the target Runtime/provider in Session metadata without storing credentials or hidden prompt content.

## References

ADR-0004 · ARCHITECTURE.md §Data flows and §Security invariants · UBIQUITOUS.md: Isolation, Brief
