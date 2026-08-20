# Let agents call other agents

This is off until you turn it on.

Once on, the agent you are talking to can hand a self-contained task to an agent on another CLI. Before that is allowed, we check that the CLI's own subagent feature is switched off, and that you have approved the target CLI and its provider.

**Git worktrees keep changes apart, not agents.** They stop two agents editing the same files. They do not limit what an agent can read or run — an agent has the same access to your machine that you do.
