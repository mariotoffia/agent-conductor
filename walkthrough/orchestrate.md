# Let agents call other agents

This is off until you turn it on.

Once on, the agent you are talking to can hand a self-contained task to an
agent on another CLI — or the same CLI with a different model or effort. Only
a written brief crosses over — task text and file paths, never your
conversation. The agent on the other end still reads files and runs commands
itself, though, so work handed to a CLI on another provider sends whatever
that agent then reads to that provider. That is why each target CLI, and its
provider, needs your explicit approval first.

Every subagent is bounded by your own settings, whatever the CLI on the other
end supports: how deep the tree may go, how many run at once, how many one
session may start in all, and how long a subagent's turn may run. A money limit
is passed on only to a CLI that says it can hold one — your limits apply either
way.

A CLI may also fork helpers of its own, inside its session, to split a task
further. Those are the CLI's business: they run inside its session under the CLI's own
permission mode — the CLI is built to ask you for them as it asks for itself,
though that is the CLI's promise, not ours — and their cost is its cost, but
they are not rows in the Sessions view and your limits do not count them. A CLI's settings entry can ask it to switch
them off (`suppressBuiltInSubagents`), so that every delegation goes through
Agent Conductor.

Cancelling a session cancels every subagent below it. A worktree is never
deleted for you: **Remove Worktree** on the row is the only thing that removes
one, and it appears once that subagent has finished — while it is still
running, that directory is its working copy, including when the window running
it is another one of yours. A checkout with uncommitted changes is refused the
first time and removed only if you ask again having read what is in it. The
branch always stays, so anything committed there survives.

**Git worktrees keep changes apart, not agents.** They stop two agents editing
the same files. They do not limit what an agent can read or run — an agent has
the same access to your machine that you do.
