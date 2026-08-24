# ARCHITECTURE

How Agent Conductor is put together. The reasons behind it live in `docs/adr/`; the words it uses are in `UBIQUITOUS.md`. To change the shape described here, supersede the relevant ADR first.

## Premise

We are an **ACP client**, never a harness (ADR-0001). Each CLI runs inside its own harness — its system prompt, its tools, its memory files, its compaction. We start the process, show what it sends us, and answer its requests: `session/request_permission`, `fs/*` and `terminal/*`.

Nothing is shared between two CLIs. When one agent hands work to another, it hands over a written brief and nothing else.

## System

```
┌─ VS Code window ────────────────────────────────────────────────────────┐
│  UI layer (src/vscode/**, may import core)                              │
│  ├─ Chat participant @conductor                            (stable API) │
│  └─ Sessions tree · transcript webview · Connect-a-CLI wizard           │
│                                                                         │
│  Conductor core (src/core/**, NO `vscode` imports — extraction seam)    │
│  ├─ RuntimeRegistry   catalog · detection · ACP-Registry resolution     │
│  ├─ AcpClient         spawn · handshake · connections                   │
│  ├─ ConductorSession  prompt loop · update pump · cancel                │
│  ├─ PolicyEngine      Suppression Plans per Runtime                     │
│  ├─ ConfigDiscovery   configOptions → model/effort · Read-back          │
│  ├─ Orchestrator      spawn tree · semaphore · budgets · worktrees      │
│  └─ ipc               socket server for the Shim (capability-authed)    │
│                                                                         │
│  Client services (src/vscode/**): PermissionRouter · FsProvider         │
│  (dirty buffers first) · TerminalService · FormElicitor                 │
└──────────┬──────────────────────────────────────────────────────────────┘
           │ spawns; ACP v1 = ndjson JSON-RPC over stdio
   ┌───────┴────────┬───────────────┬───────────────┐
   ▼                ▼               ▼               ▼
claude-agent-acp  codex-acp    gemini --acp   copilot --acp   … any ACP agent
   ▲                ▲               ▲               ▲
   └────────────────┴───────┬───────┴───────────────┘
                            │ opted-in + trusted + suppression-verified only
                    ┌───────┴────────┐
                    │ MCP Shim       │ dist/mcp-shim.cjs — spawned BY the harness
                    └───────┬────────┘ tools: spawn_subagent · list_runtimes · …
                            │ unix socket / named pipe (Session Capability)
                            ▼
                    Orchestrator (extension host)
```

Two facts about processes explain the rest of this document:

- **The extension starts each agent.**
- **The agent starts our Shim.** The Shim's tool calls come back to the extension, which is the only place that can open new ACP sessions and route a child's permission prompts into the same UI. It also runs in the agent's environment rather than ours — an MCP client hands a stdio server a small default set of its own — so whatever the Shim's interpreter needs travels in the `mcpServers` entry beside the Session Capability, never by inheritance. In an extension host that interpreter is an Electron binary, which behaves as Node only when told to.

## Protocol surfaces

| Surface | Side we implement | Purpose | Status |
|---|---|---|---|
| ACP | client | drive every Agent (downstream) | v1, core |
| MCP | server (Shim) | orchestrator tools injected per session | core |
| ACP | agent (Facade) | expose the Conductor to Zed/JetBrains/etc. | planned |
| AHP | client / server | VS Code Agent Host interop | deferred (ADR-0001) |

## Layering rules

`src/core/**` must not import `vscode`; `make lint` checks this. Everything the core needs from VS Code arrives through a **Client Port** — permission, filesystem, terminal, elicitation, logging, clock, starting processes, finding executables, and durable storage.

`src/vscode/**` may import the core, and supplies those ports. `src/shim/**` imports neither: it is bundled separately and runs outside the extension host. TypeScript only (ADR-0003).

The core's own API follows ACP's shape. That is what lets it run under plain Node in tests today, and lets it back an ACP-agent facade later as a Node process — a packaging change, not a rewrite.

## Data flows

**Prompt.** Chat input → participant → `ConductorSession`. Two gates come first and in this order: the window's trust, then the runtime's, re-derived from a fresh resolution rather than read from a record. The session owns one agent process, created with `session/new`: the workspace as `cwd`, `mcpServers` sorted by name (including the Shim only when orchestration is on, the runtime is trusted, suppression is verified, and depth allows), and the Suppression Plan in `_meta`. Then `session/prompt`, the update pump, the render map, and a stop reason. The render map is `src/vscode/render.ts`: one Update in, a list of surface-neutral items out, with a compile-time proof that every variant of ACP's update union is covered — an Update this client's protocol version never documented becomes an item too, because one nobody drew is indistinguishable from an agent that sent nothing (ADR-0011).

A session runs one turn at a time, so a second submission is refused rather than allowed to disturb the one in flight. The turn is marked as under way before anything is awaited, because the window that matters opens at the first wait: starting the agent is the slowest part of a turn, and a second submission that raced through it would open a second session — whose process nobody then owns. The turn owns where its updates are drawn, which is what stops a later turn from taking them, or an earlier turn from losing its own. Between turns there is nowhere to draw, so an agent that keeps talking after a turn ends is logged rather than dropped.

A launch command is looked up before anything runs: the file the name lands on after symlinks, and a digest of what that file contains. Both describe the file as it was read, not as it will be spawned — that window is inherent to approving a program in advance, which is why resolution happens per session start rather than once.

A diff the agent reports is shown as two virtual documents, never against the file on disk. What is on disk is what is there now; the agent reported what it wrote. Both sides are bounded, and everything a session recorded is dropped when it closes.

VS Code offers no way to send a chat participant a turn, so the extension-host tests are handed the live participant instead, through an object the extension only builds when VS Code reports the window was started to run tests. That answer comes from the launch arguments rather than from the environment, so nothing else in the host can forge it, and a normal window has no such object at all.

**Resume.** A Session that ends leaves a record behind: its ids, its runtime and workspace, when it ran, what was asked for beside what the agent reported running, how it stopped, and the launch identity it ran under. Metadata and nothing else — there is no field for a prompt, hidden context, a tool payload or a credential, so the file cannot carry one, and everything the agent worded passes the same redaction as a log on its way there. It is bounded in both directions, how long one value may be and how many sessions are kept, because the agent chooses its own session id and a window can open a session per turn. And it is versioned: a file written by a build that means something else by these fields is not read at all, since every one of them decides whether an agent may be started.

Whether a saved session may be reattached to is worked out afresh rather than stored. The runtime has to still resolve to the fingerprint that conversation ran under, the folder has to be open, and the agent has to have advertised `loadSession`. ACP v1 has no resume token: `session/load` and `session/resume` both take the session id and nothing secret, so the id is the handle. This client sends `session/load` and only that, so an agent that offers only `sessionCapabilities.resume` leaves a record that is history and nothing else. Loading is an explicit action: opening a folder starts an agent only where `sessions.resumeOnStartup` says so, and then for one session, the most recent that still clears all three.

Saving never holds a turn up. Two windows share one storage directory, so a save is a read and a replace and the later one wins; within a window they are queued, because two sessions saving at once would otherwise write each other away.

**Sessions tree.** One row per session, live or only remembered, with subagents beneath the session that spawned them. A live session is drawn from the session object itself and a remembered one from its record, and never both — records are written with nothing waiting on them, so a row fed by the file would lag the turn it is meant to be showing. A row says the runtime, the state, the read-back with its two markers, the cost or that it is unknown, and how long it has been running or how long ago it last was. Which of those a record can supply is why the two say different things about time: a record keeps when it was first and last written, and a session resumed the next day keeps its original stamp, so the span between them is not the time anybody spent in it.

Lineage and worktrees are the Orchestrator's to record, and it does: a subagent's record names the parent's own session id, and a worktree row is offered for a session that was given a checkout of its own. A session nobody spawned is still a root and still offers no worktree, which is every session the user starts.

A row is keyed the way the store keys a record — runtime, folder and session id together — because an agent chooses its own session id and nothing makes it unique across either. Keyed on the id alone, one of two sessions would silently have no row, and a session nothing draws is a session nothing can cancel. The lineage is walked rather than followed one step, so a cycle written into the file leaves rows rather than emptying the view.

Cost is the one thing on a row that arrives only as an update, and it is kept beside the session rather than in it. An update naming a session this window does not hold is drawn and never adopted — the same rule the session layer applies — because a map keyed on what an agent says would be a map an agent can grow, and a figure drawn against a session whose own agent never sent it.

What a row offers is decided by what can actually be done with it, and everything it claimed is checked again when somebody clicks: the folder has to still be open, the runtime still approved. Resuming goes through the same participant that owns every other session and the same gate that starts every other agent, because a session opened beside it would be a second owner of a process teardown cannot reach — which is also why it ends the session that was live. What that costs is why the runtime's approval is checked on this side too, before anything is ended: the gate would otherwise refuse a launch only after the conversation somebody was in had been spent on it. Cancelling names the session the row is about, never whichever one happens to be live. Only the extension writes the store, and it is shared by every window on the machine — so a record has to say whether a session is in use. It does, as a stamp rather than a flag: the window running a session re-writes the moment it last still had it, and the window that ends one writes it away. A session stamped within the last half-minute is somebody's, and is not offered back. The stamp rather than the flag is the whole design, because the two questions have one answer — a window that is still there keeps saying so, and a window that was killed simply stops. A flag set once would be a flag a crash leaves set, and the conversation it named unreachable for good; coming back to a conversation a crash interrupted is what resuming is for.


**Spawn.** The model calls `spawn_subagent{runtime?, model?, effort?, brief, …}`. The Shim passes it over the socket to the Orchestrator, which answers only for a parent this window is still running — a capability outlives nothing — and then measures the call against the Depth Cap, the aggregate spawn count for that parent, the semaphore, the timeout, and the roots the capability was granted. A brief naming a file outside those roots is refused before anything starts. What the brief leaves out comes from the Preset; a runtime the brief names has to resolve, be trusted, and — when it is not the parent's own — have Fan-out Consent. A money limit is forwarded only to a runtime with the Budget Capability, and is clamped to the user's own figure either way, because our depth, concurrency, count and timeout apply whatever the runtime supports. No runtime reports that capability today: ACP has no call that sets a money limit on a child, so what this client offers a subagent is what it can actually ask for, never what a runtime says it could do — telling a parent a limit is being held when nothing was sent is the failure this is shaped to avoid.

The count is read and reserved with nothing awaited in between: two calls that arrived in one read are two handlers in one turn of the loop, and a limit read before an await and written after is not a limit.

Both of those are re-read after every wait. A spawn queues behind the semaphore for as long as the subagents ahead of it take, and its parent can end in that time; a child registered after the cancellation that would have reached it is an agent process nobody owns. The same holds across starting the agent, which is the slowest thing here and therefore the widest window.

The child then opens a `session/new` of its own through the same trust gate every other session goes through — with suppression on, in its own worktree or its parent's folder, and **no Shim below the Depth Cap**, which is what stops the recursion. `sync` waits for the turn; `background` answers with a handle at once, and that handle is also the key the child's own Shim would act under. A handle is only ever answerable to the session that made it. The result carries the child's session id, its stop reason, its final message bounded, its read-back, and what it cost — or that the cost is unknown, which is a real answer and never a zero. A turn that outlives its timeout is cancelled and says so. Ending a session cancels everything below it, to the bottom of the tree, and withdraws the capability with it: a subagent whose parent is gone is an agent process nobody owns.

The child's own updates draw its row in the Sessions tree, beneath the session that spawned it. They are not yet nested under the parent's tool call in the transcript.

**The orchestration socket.** The Shim reaches the Orchestrator over a local socket: on POSIX a unix socket inside a directory of our own created `0700`, because Linux honours the socket file's own mode and macOS honours the directory's — on Windows a named pipe, which carries no filesystem mode at all. One JSON object per line in each direction, bounded as the bytes arrive rather than once a frame is whole, because the peer is a process an Agent started. The first line a Shim sends is its Session Capability and nothing else, and that secret travels in the Shim's environment rather than its arguments, since `ps` and `/proc` make an argument readable by anyone on the machine.

What the capability authorises is settled on this side alone — the Session it acts for, that Session's parent, its depth, its roots, when it lapses, and which methods it may call. A request that so much as names one of those is refused rather than having it quietly ignored, because a field that is ignored today is a field somebody merges tomorrow. An active parent and current Runtime Trust are not re-checked here but *withdrawn*: the capability is retired the moment either stops holding, and every connection holding it goes with it. A capability that merely lapsed is retired the first time it is used after its expiry — nothing sweeps for them, because revocation is the path that matters and an expiry nobody reaches authorises nothing. A Shim gets a few connections and a bounded number of calls in flight on each; past that we stop reading and the backlog waits in the socket, where the operating system already knows how to push back. Otherwise how much of the extension host's memory to use would be a decision belonging to a process the Agent controls.

**Worktrees.** A worktree is allocated by writing down the intention first and running `git worktree add` second, because a host killed between the two must leave a record of what it was doing rather than a directory nothing remembers making. Every git mutation goes through one queue: two `worktree add` runs against one repository race over the same index and administrative files. The branch and the directory are derived from the session's own key, and a name already taken is stepped past rather than reused — checking out a branch somebody's work is on is how that work is lost. The directory is written down the way *git* will report it, with every symlink resolved: git records a worktree's realpath rather than the path it was handed, and everything afterwards compares the two as strings. A root reached through a symlink — `/tmp` is one on macOS, and is the obvious thing to type into the setting — would otherwise produce a journal that never matches what git lists, so the first reconciliation would call a live checkout abandoned and drop the only record that could ever reach it again. At activation the journal is settled against what git actually has: an allocation git does not know about is dropped, one it does know about is left exactly as it is, and a repository git could not be asked about at all — moved, unmounted, or with no `git` on `PATH` — keeps everything it has, because "we could not tell" and "there is nothing there" must not have the same consequence. Nothing is pruned: git *lists* a worktree whose directory is missing rather than forgetting it, so every entry dropped here is one git already has no record of, and the only thing `prune` could still reach is a registration that is not ours to remove.

The journal is read afresh by everything that writes it back, and a read that fails is a failure rather than an empty list — a transient one answered as "no allocations" would trade every real entry for the next one written, and the entry is the only thing that makes a checkout reachable. Listing is the exception, because it changes nothing. A journal this build cannot *understand* is the other case and is treated the other way: it will not start making sense, so refusing for ever would disable worktrees in every window with no way back from inside the product. It is kept whole under a name of its own — it still says where checkouts are — and the window carries on with none.

Nothing is ever removed automatically. Removing one is a row action, offered only once the session that was using it has ended anywhere — not merely in this window. Sessions are remembered per machine and every window's worktrees live under one root, so a row here can name a checkout another window's agent is working in; that row says so and the action refuses it, because this window has no way to cancel another window's session.

A checkout with uncommitted changes is refused once, with the reason, and removed only if the user asks again having read it. A refusal that force could not fix, and one where git could not be asked whether there was work there at all, are reported rather than offered a second question: there is nothing to say the user would be giving up. The one refusal that resolves itself is a checkout whose directory somebody deleted by hand — git reports that worktree as prunable, so there is provably no work to lose and it is cleared without a second question. The branch always stays: what was committed lives only there. A worktree allocated for a subagent that was then refused is given back at once, since no row will ever name it.

**Connect.** The wizard is the only thing that records Runtime Trust, so nothing else can start an agent. The window's own trust gates it first, because probing starts an agent like anything else. Then it resolves every runtime, asks which one, offers to install a missing adapter at the exact version the catalog names — otherwise the reason shown against a runtime is advice the wizard cannot act on — and asks what to launch when a command is still missing.

What it approves has to be what a session start will derive, so the runtime is rebuilt through the catalog with the pending settings entry applied, never composed by the wizard itself. Two places deciding what an overridden launch means for a plan or a policy would eventually disagree, and the disagreement would show up as a runtime that is untrusted the first time it is used. The approval prompt shows everything the fingerprint covers — the command and its arguments quoted as a command line, every environment variable with its value, which variables come from secret storage and from which key, the policy, and a suppression plan's session payload, the file it would edit and what it would write there — because approving what you cannot see is what it exists to prevent, and a repository can supply most of those through its own workspace settings. Nothing in it is trimmed: the whole description fits the dialog or there is no dialog, since a budget spent on one part would otherwise be taken out of another. What a person must read to decide sits above the part whose size somebody else chooses.

Then it opens a probe session: a temporary directory of its own, no filesystem or terminal port — so neither capability is advertised at all and a permission request is refused rather than left open — and every wait bounded by a short deadline instead of a session's, because somebody is watching it. It carries the credentials a real session would, resolved from secret storage, so what is proved is the configuration that will actually run. What it learns there fills the model and effort pickers from the agent's own config options, and one short prompt has to come back as the word it asked for. The read-back is reported on one line, because a notification shows one line and a mismatch nobody sees is a mismatch nobody acted on.

The entry is composed once, before the approval, on top of what settings already say about that runtime — otherwise the fingerprint approved is for a launch the saved settings never produce, and the runtime is refused at its first turn.

Only then is anything written, and only what this run decided — merged into what the chosen scope already holds. The effective settings are what the identity was composed against, but they are not what gets written: an entry a repository supplied for this workspace must not be copied into the profile that applies to every other one. Settings without an approval refuse to launch, which is the direction a half-finished write should fail in. Merged, not replaced — reconnecting is routine, since every change of identity requires it, and it must not be how a runtime loses the suppression plan or secret reference somebody wrote by hand. The workspace scope is offered only where a folder is open, since VS Code refuses that write otherwise and a connection that passed every stage would be thrown away by it. Afterwards the wizard reads the settings back and checks that the identity it approved is the one they now produce: a scope that loses to another would otherwise leave a connection that can never launch and no way to tell why. A wizard that was cancelled or failed writes no settings and records no approval. It is not a transaction, though: a key already pasted stays in secret storage, and an adapter it was asked to install stays installed.

A CLI that will not start is shown its own error, with its own login command offered beside it, and the wizard waits for the person to say the login finished rather than retrying while they are still typing. A key stored at that point changes what would be launched, so the identity is composed and approved again before the next attempt — an approval that predates the credential describes a launch the saved settings would never produce. ACP has no dependable way to tell "not signed in" from any other startup failure — `authMethods` is advertised whether or not one is needed — so the failure is reported rather than classified. Signing in stays the CLI's business; the only credential we hold is a key the user pastes, and it goes to SecretStorage.

A session applies the model and effort it was opened with, where the agent exposes a config option for them, reports something else, and lists the value being asked for. That last condition is what keeps a setting that has merely gone stale — the ordinary result of a CLI dropping a model id — from being refused, since a refused set leaves the session with no config options at all and would cost both pickers rather than one. A new session only: a reattached one carries a conversation produced under some configuration, and changing what that conversation runs under halfway through is not a default anyone chose.

The wizard records no suppression evidence at all — neither a tool list, because ACP v1 has no call that returns one, nor the consent a plan that edits a workspace file needs. Verification requires both, so collecting one alone would prove nothing while writing into somebody's repository for it. Orchestration therefore stays unavailable until something can supply a tool list, which is the fail-closed direction (ADR-0008).

Refreshing the runtime registry validates before it replaces: a document that fails, or a network that is not there, leaves the cached copy exactly as it was and says so, naming the date it was cached. An extension quietly serving a month-old document looks identical to one that just refreshed. The response is bounded as it is read, not after.

**Permission.** Any session → `session/request_permission` → policy (automatic allow or reject by Client Operation, plus remembered "always" answers; `ToolKind` is for display only) → otherwise a dialog → `selected` or `cancelled`. A cancelled turn must answer `cancelled`. This is consent and an audit trail. It is not a sandbox.

A Client Operation only exists where the client is the one acting, so it is derived from the ACP method the client is serving. An agent's own tool call has none, so it is always asked about — and the "always" option we hand back is remembered by the harness that offered it, not by us.

Consent for a command is given once, when it starts. Waiting for it, killing it and releasing it are follow-ups: they check policy but do not ask again, because a client that asks four questions per command teaches people to stop reading them.

The allow and reject lists are validated one entry at a time. Falling back to the default for a malformed reject list would mean falling back to no policy at all.

**Client services.** Reading a file serves the open editor buffer ahead of what is on disk — that is the point of the capability. Writing to an open file goes through the editor, so it joins the user's undo history instead of appearing underneath it. Every path is resolved, symlinks and all, before it is used; a path outside the session's roots is refused rather than offered for approval.

Commands are started with a command and arguments, never a shell string, and in their own process group so that stopping one stops what it started. That group is only ever signalled while we have never seen it end, since the system may hand a finished group's id to somebody else. Output is kept in a ring buffer whose size we choose, not the agent, and is cut on a character boundary.

A finished process does not mean finished output, so the pipes get a short, bounded moment to deliver the rest.

Questions from the agent are answered through a form, so an agent does not have to disable its own question feature. Dismissing any input cancels the whole form, and a question we cannot present is declined rather than answered badly. A regular expression the agent attaches to a field is shown but never run: matching it means running the agent's pattern on the editor's UI thread on every keystroke, and one that backtracks badly freezes the window.

Everything the agent supplies to a dialog is bounded and printed on one line, each part with its own budget, so nothing it sends can push out or imitate what we wrote. A command's environment is shown in full or the command is refused — showing the first few variables and counting the rest would let the agent choose which one you do not read.

**Failure.** A session owns one agent process for its whole life, and the commands that process started: ending a session ends them, because they were spawned in their own process group for exactly that. That ending is started but never waited for — a host service that hung would otherwise hold up the escalation that guarantees the agent itself dies.

Every wait on that process is bounded:

- A **Setup Deadline** bounds each request made outside a turn: the handshake, creating the session, and setting a config option.
- A **Stall Limit** bounds silence inside a turn. A stalled turn is cancelled politely first, then terminated like any other cancel. Time we owe the agent an answer never counts as silence.

A turn fails when the process or the connection dies. The failure carries the exit status when we know it, and the agent's recent stderr either way. Everything an agent worded — a protocol error as much as its stderr — is redacted before it reaches a message, a log or the transcript, and drawn on one line stripped of the markers that would make it look like something this client wrote. An agent that merely refuses one turn keeps its session usable.

ACP transports skip lines they cannot parse instead of closing, so a corrupted stream shows up as a request that never gets answered rather than as a transport error.

A refused handshake reports both why it was refused and how the process ended. A runtime that shuts down politely exits exactly like one that crashed, so the cause cannot be worked out afterwards.

We advertise only the capabilities a Client Port can actually serve, and answer `cancelled` when there is no way to ask for permission.

The SDK checks the shape of notifications we receive, but not the answers to requests we send. So anything an agent returns is checked on arrival rather than trusted because of its declared type — the session id it gives us most of all, since everything we do afterwards is addressed with it (ADR-0007).

**Cancel.** `session/cancel` → revoke that session's capability → wait for `stopReason:"cancelled"` under a grace timer → terminate only that session's process if the timer runs out. Cancelling a parent cancels its children.

## Runtime catalog

Built-in runtimes:

| Runtime | How it speaks ACP | Notable |
|---|---|---|
| `claude` | adapter | policy per session, via `_meta` |
| `codex` | adapter | `CODEX_CONFIG` applies to the whole process |
| `gemini` | native `--acp` | suppression writes a workspace settings file, and asks first |
| `copilot` | native `--acp --stdio` | model, effort and tools are fixed when the process starts |
| `dsh` | native `--profile acp` (preview) | DeepSeek's own ACP plugin, booted by dsh's launcher from a profile the user creates; automation-only, so no Config Options and no `mcpServers` — never the Shim, and no suppression recipe either |
| custom | user-defined | any ACP agent |

Every session owns one agent process.

**A launch command must already exist on the machine.** It is resolved to a canonical absolute path before anything starts. Relative paths, missing commands and package runners (`npx`, `uvx`, `pipx`, …) are refused.

General-purpose runtimes (`node`, `bun`, `deno`) are not refused, because that would refuse every locally installed agent that ships as a script. They can reach the network too, which is why the guarantee does not rest on that list: the whole command line is fingerprinted, so such a launch is one the user approved by reading it.

Adapters are therefore installed once, at an exact version, as a deliberate step in the wizard. The cost is that step plus manual upgrades. The reason is ADR-0007: what a package runner downloads is decided when it runs, so no fingerprint approved in advance can describe it.

**The ACP Registry supplies those exact versions and nothing else.** It is validated, size-limited, cached atomically, pinnable and safe offline. It may move a version forward but never backward, because serving an older artifact is how a rolled-back feed downgrades a machine. A pin overrides it in either direction, and a malformed pin disables only its own runtime. An entry that renamed its package is ignored, because that is a different artifact.

**Runtime Trust covers three things together:** the resolved artifact, the effective launch specification, and that runtime's suppression policy. Turning suppression off is a different identity, so the Suppression and Budget Capabilities recorded against a fingerprint lapse with it. The fingerprint covers the artifact's contents only when the host can supply a digest, and resolution says which of the two the user is approving.

**The Suppression Plan is part of that identity, not a consequence of it.** A user-supplied plan carries arguments, environment, `_meta`, and a workspace settings patch that no policy flag describes, so editing one asks for approval again.

A supplied plan is only accepted where the catalog has no recipe: a custom agent, or a built-in whose launch genuinely differs from the catalog's — compared by what would actually run, not by which settings keys are present.

Verification measures a plan against the tools it names *plus* every delegation tool the catalog knows about. A plan checked only against its own names would certify itself: name a tool nobody has, and an agent with delegation fully working would pass.

Three things fail closed: a tool list we cannot read, an empty one, and a plan that sets no argument, variable, metadata or setting.

That list must be the tools an agent *has*. ACP v1 has no call that returns one, and watching `tool_call` updates is not a substitute — those show which tools were used, so a delegation tool that simply went uninvoked would look like one that is gone.

The workspace settings file is written once, whole, and only after the user agrees. It is merged into whatever the file already said. Reverting removes only what the plan added: a section the user has since filled in, or a value whose type they changed, stays theirs.

## Model & effort

Resolution order: the agent's `configOptions` (categories `model` and `thought_level`) → the catalog or command-line fallback → **always read back**, because agents clamp values without saying so.

Setting a config option returns the whole refreshed array. Agents may also push `config_option_update` unprompted. Either way, render from the latest array (ADR-0005).

The fallback is used only when the agent says nothing, and only to fill a picker — never to report an effective value. A value becomes *effective* only when the agent itself reports it. A runtime that reports nothing leaves the selection *unavailable*; it does not get to confirm its own command line.

A session is busy for the whole of a set, so no turn can start under a configuration that is still changing, and two sets cannot race each other's answer.

## Security invariants

- Workspace trust and Runtime Trust gate every start. Safe mode reduces what a repository can influence, but it is not a sandbox.
- Starting a session never installs or downloads anything. Installing is a separate wizard step that names an exact version.
- Orchestration is off by default: no Session Capability is issued, no Shim is injected, and no spawn RPC exists while it is off.
- Capabilities are per session, revocable, and checked against the active parent, the roots, the allowed methods, the expiry, and current trust. The secret reaches the Shim through its environment and never its arguments, the socket lives where only its owner can reach it, and both directions of it are length-bounded.
- Worktrees coordinate changes; they do not restrict what an agent can reach. A child does not get the parent repository in `additionalDirectories` by default.
- Secrets and resume tokens live in SecretStorage. Settings and saved sessions hold only references. Which variables those references fill is part of the launch identity and is shown at the approval, because a workspace can add one — and a credential never displaces the catalog's own policy environment, which is where a suppression plan lives. An agent is started with resolved secrets in its environment, so its own diagnostics are redacted before they reach a log, a failure message or a transcript — and redacted after the buffer is joined, since a value split across two reads is whole again the moment they are concatenated.
- Claude sessions run on the login the CLI already has (ADR-0013). `agentConductor.claude.hideSubscriptionAuth` launches the adapter with `--hide-claude-auth` for an organisation that wants an API key enforced; the flag is part of the launch identity, so turning it on or off asks for approval again. The wizard stores an API key when one is given. It cannot tell which credential a CLI is already signed in with, and says so rather than guessing.
- Depth, concurrency, aggregate spawn count, timeout and stall limits apply to every subagent, and are enforced whatever the runtime supports. Money limits are forwarded only to a runtime that says it can hold one.
- A worktree is journalled before it is created, reconciled at activation, and never deleted automatically — least of all a dirty one.
