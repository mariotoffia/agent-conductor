# Let agents call other agents

This is off until you turn it on.

Once on, the agent you are talking to can hand a self-contained task to an agent on another CLI. Before that is allowed, we check that the CLI's own subagent feature is switched off, and that you have approved the target CLI and its provider.

Every subagent is bounded by your own settings, whatever the CLI on the other end supports: how deep the tree may go, how many run at once, how many one session may start in all, and how long a subagent's turn may run. A money limit is passed on only to a CLI that says it can hold one — your limits apply either way.

Cancelling a session cancels every subagent below it. A worktree is never deleted for you: **Remove Worktree** on the row is the only thing that removes one, and it appears once that subagent has finished — while it is still running, that directory is its working copy, including when the window running it is another one of yours. A checkout with uncommitted changes is refused the first time and removed only if you ask again having read what is in it. The branch always stays, so anything committed there survives.

**Git worktrees keep changes apart, not agents.** They stop two agents editing the same files. They do not limit what an agent can read or run — an agent has the same access to your machine that you do.
