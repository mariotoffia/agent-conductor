# ADR-0014: A CLI's own subagents are allowed, and the Shim is injected on opt-in and trust

- Status: accepted
- Date: 2026-08-24
- Supersedes: ADR-0004's requirement that each CLI's own delegation be switched off before the Shim is injected, and ADR-0008's Suppression Capability precondition for injecting it. Everything else in both stands.

## Context

ADR-0004 injected our MCP Shim only beside a CLI whose own delegation tools had been switched off, and ADR-0008 demanded proof — a Suppression Capability — before injecting. ACP has no call that reports an agent's tools, so that proof could never be gathered, and the product's headline feature was implemented, tested, and reachable by nobody.

The worry behind the rule was double delegation: a CLI spawning helpers of its own, invisible to our limits, beside the helpers it asks us for.

Looked at again, a CLI's own subagents live inside the same ACP session. The adapters are designed to route what they ask — a permission request, a file, a terminal — through that session like the parent's own, and their cost is that session's cost; that routing is the vendor's to keep working, and its known failures today fail closed, not open. What the harness decides on its own, under the permission mode the user gave the CLI, this client never sees — for the parent exactly as for its helpers. What we lose is the *count*: they are not rows in the Sessions tree and not counted against the spawn limits, because the CLI never told us it started them. What we keep is everything the Shim exists for: a way to hand work to *another* CLI, model, or effort, bounded and visible.

The product owner's decision is that both kinds of delegation are wanted: the Conductor spawns subagents across CLIs, models and efforts, and a CLI may fork its own subagents to split its task further.

## Decision

**The Shim is injected when orchestration is switched on and the Runtime's trust holds** — plus the Depth Cap, and an agent that accepts MCP servers at all. No suppression evidence is required.

**A CLI's own subagents are allowed.** `suppressBuiltInSubagents` becomes optional hardening, off by default, settable per Runtime for anyone who prefers one delegation system to two. A Suppression Plan still applies when it is on; whether it worked is still recorded as evidence and still gates nothing.

**A Runtime whose agent refuses `mcpServers` is never injected**, whatever else holds — DeepSeek Harness's ACP rejects a non-empty list, and a session that fails to open is worse than one without a Shim.

The limits stay: depth, concurrency, aggregate count, timeout, worktrees, the cancellation cascade, Fan-out Consent for a foreign provider. They bound what goes through the Shim.

## Alternatives considered

- **Keep waiting for a tool list.** Rejected: the protocol has shown no sign of adding one, and the feature would stay unreachable indefinitely.
- **Trust the recipes without proof.** Rejected: a recipe that silently stopped working would be a silent lie in the approval dialog; better to say plainly that native subagents may run.
- **Enforce limits on native subagents.** Not possible: the CLI does not report them.

## Consequences

Cross-CLI delegation works the day orchestration is switched on, on every trusted Runtime whose agent accepts MCP servers. What a parent's own subagents do is the parent's business: they act inside its session, under whatever that session asks this client and whatever the CLI's own permission mode decides without asking.

Every Runtime's launch identity is unchanged for a window with orchestration off, because the window policy already carried no suppression there. A user who turned orchestration on before this decision sees the launch approved again, since the policy in its fingerprint changed.

The evidence machinery — plans, verification, recorded tool lists — is now informational. It can be removed if nothing comes to read it; that is a cleanup, not a decision.

## References

ADR-0004 · ADR-0008 · ARCHITECTURE.md §Data flows, §Security invariants · UBIQUITOUS.md: Suppression Plan, Suppression Capability, Subagent
