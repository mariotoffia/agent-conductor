# Find a session again

The **Sessions** view in the activity bar lists every session this window has — the one running now, and the ones it remembers.

A row says which CLI it runs, what state it is in, what the agent reports it is actually running beside what was asked for, what it has cost if the CLI reports one, and how long it has been going. A session that has ended says how long ago it last ran.

The row running now can be cancelled from the view. One that has ended can be resumed, when it still can be — and resuming ends the session you are in, because one session is one agent process for its whole life: its CLI has to be one you have approved, its folder has to be open in this window, and the agent has to support reattaching. When it cannot be, the row says which of those is missing rather than offering a button that fails.

Nothing is remembered but metadata. There is no field for a prompt, for anything the agent read, or for a credential — so resuming reattaches to the conversation on the agent's side, and this extension never had a copy of it.

Opening a folder does not start an agent. If you want the most recent session opened for you, turn on `agentConductor.sessions.resumeOnStartup`; it starts one session at most, and only one that still clears every condition above.

Sessions are remembered per machine rather than per window, so a session another window has open is not offered here — its row says that instead. If that window is killed, the session becomes available again about half a minute later, which is how a crashed window's work is picked up rather than lost.
