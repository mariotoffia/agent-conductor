# Let agents call other agents

**Not yet available — for any CLI.** Before an agent may hand work to another,
Agent Conductor must verify that the CLI's own subagent feature is really
switched off; the protocol these CLIs speak has no way to prove that yet, and
unprovable means not allowed. So the setting exists, the machinery is built and
tested, and no session is given the delegation tools today — whatever you turn
on. `docs/CHANGELOG.md` in the repository records exactly what was verified,
and this page describes what the feature does the day a CLI can pass that
check.

Once available: the agent you are talking to can hand a self-contained task to
an agent on another CLI. Only a written brief crosses over — task text and file
paths, never your conversation. The agent on the other end still reads files
and runs commands itself, though, so work handed to a CLI on another provider
sends whatever that agent then reads to that provider. That is why each target
CLI, and its provider, needs your explicit approval first.

Every subagent is bounded by your own settings, whatever the CLI on the other
end supports: how deep the tree may go, how many run at once, how many one
session may start in all, and how long a subagent's turn may run. A money limit
is passed on only to a CLI that says it can hold one — your limits apply either
way.

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
