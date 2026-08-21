# ARCHITECTURE

How Agent Conductor is put together. The reasons behind it live in `docs/adr/` (ADR-0001…0010); the words it uses are in `UBIQUITOUS.md`. To change the shape described here, supersede the relevant ADR first.

## Premise

We are an **ACP client**, never a harness (ADR-0001). Each CLI runs inside its own harness — its system prompt, its tools, its memory files, its compaction. We start the process, show what it sends us, and answer its requests: `session/request_permission`, `fs/*` and `terminal/*`.

Nothing is shared between two CLIs. When one agent hands work to another, it hands over a written brief and nothing else.

## System

```
┌─ VS Code window ────────────────────────────────────────────────────────┐
│  UI layer (src/vscode/**, may import core)                              │
│  ├─ Chat participant @conductor        (stable API — Marketplace build) │
│  ├─ Sessions tree · transcript webview · Connect-a-CLI wizard           │
│  └─ chatSessions provider              (proposed API — VSIX build only) │
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
- **The agent starts our Shim.** The Shim's tool calls come back to the extension, which is the only place that can open new ACP sessions and route a child's permission prompts into the same UI.

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

**Prompt.** Chat input → participant → `ConductorSession`. Two gates come first and in this order: the window's trust, then the runtime's, re-derived from a fresh resolution rather than read from a record. The session owns one agent process, created with `session/new`: the workspace as `cwd`, `mcpServers` sorted by name (including the Shim only when orchestration is on, the runtime is trusted, suppression is verified, and depth allows), and the Suppression Plan in `_meta`. Then `session/prompt`, the update pump, the render map, and a stop reason.

A session runs one turn at a time, so a second submission is refused rather than allowed to disturb the one in flight. The turn is marked as under way before anything is awaited, because the window that matters opens at the first wait: starting the agent is the slowest part of a turn, and a second submission that raced through it would open a second session — whose process nobody then owns. The turn owns where its updates are drawn, which is what stops a later turn from taking them, or an earlier turn from losing its own. Between turns there is nowhere to draw, so an agent that keeps talking after a turn ends is logged rather than dropped.

A launch command is looked up before anything runs: the file the name lands on after symlinks, and a digest of what that file contains. Both describe the file as it was read, not as it will be spawned — that window is inherent to approving a program in advance, which is why resolution happens per session start rather than once.

A diff the agent reports is shown as two virtual documents, never against the file on disk. What is on disk is what is there now; the agent reported what it wrote. Both sides are bounded, and everything a session recorded is dropped when it closes.

VS Code offers no way to send a chat participant a turn, so the extension-host tests are handed the live participant instead, through an object the extension only builds when VS Code reports the window was started to run tests. That answer comes from the launch arguments rather than from the environment, so nothing else in the host can forge it, and a normal window has no such object at all.

**Spawn.** The model calls `spawn_subagent{runtime?, model?, effort?, brief, …}`. The Shim passes it over the socket to the Orchestrator, which checks the Session Capability, the Runtime Trust fingerprint, provider consent, depth, the semaphore, local limits, and the optional Budget Capability. It fills in Preset defaults, optionally runs `git worktree add`, and opens a child `session/new` on the target runtime — with suppression on, and **no Shim below the Depth Cap**, which is what stops the recursion. The child's updates render nested under the parent's tool call, and its final message becomes the tool result.

**Permission.** Any session → `session/request_permission` → policy (automatic allow or reject by Client Operation, plus remembered "always" answers; `ToolKind` is for display only) → otherwise a dialog → `selected` or `cancelled`. A cancelled turn must answer `cancelled`. This is consent and an audit trail. It is not a sandbox.

A Client Operation only exists where the client is the one acting, so it is derived from the ACP method the client is serving. An agent's own tool call has none, so it is always asked about — and the "always" option we hand back is remembered by the harness that offered it, not by us.

Consent for a command is given once, when it starts. Waiting for it, killing it and releasing it are follow-ups: they check policy but do not ask again, because a client that asks four questions per command teaches people to stop reading them.

The allow and reject lists are validated one entry at a time. Falling back to the default for a malformed reject list would mean falling back to no policy at all.

**Client services.** Reading a file serves the open editor buffer ahead of what is on disk — that is the point of the capability. Writing to an open file goes through the editor, so it joins the user's undo history instead of appearing underneath it. Every path is resolved, symlinks and all, before it is used; a path outside the session's roots is refused rather than offered for approval.

Commands are started with a command and arguments, never a shell string, and in their own process group so that stopping one stops what it started. That group is only ever signalled while we have never seen it end, since the system may hand a finished group's id to somebody else. Output is kept in a ring buffer whose size we choose, not the agent, and is cut on a character boundary.

A finished process does not mean finished output, so the pipes get a short, bounded moment to deliver the rest.

Questions from the agent are answered through a form, so an agent does not have to disable its own question feature. Dismissing any input cancels the whole form, and a question we cannot present is declined rather than answered badly. A regular expression the agent attaches to a field is shown but never run: matching it means running the agent's pattern on the editor's UI thread on every keystroke, and one that backtracks badly freezes the window.

Everything the agent supplies to a dialog is bounded and printed on one line, each part with its own budget, so nothing it sends can push out or imitate what we wrote. A command's environment is shown in full or the command is refused — showing the first few variables and counting the rest would let the agent choose which one you do not read.

**Failure.** A session owns one agent process for its whole life.

Every wait on that process is bounded:

- A **Setup Deadline** bounds each request made outside a turn: the handshake, creating the session, and setting a config option.
- A **Stall Limit** bounds silence inside a turn. A stalled turn is cancelled politely first, then terminated like any other cancel. Time we owe the agent an answer never counts as silence.

A turn fails when the process or the connection dies. The failure carries the exit status when we know it, and the agent's recent stderr either way. An agent that merely refuses one turn keeps its session usable.

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
- Capabilities are per session, revocable, and checked against the active parent, the roots, the allowed methods, the expiry, and current trust.
- Worktrees coordinate changes; they do not restrict what an agent can reach. A child does not get the parent repository in `additionalDirectories` by default.
- Secrets and resume tokens live in SecretStorage. Settings and saved sessions hold only references. An agent is started with resolved secrets in its environment, so its own diagnostics are redacted before they reach a log, a failure message or a transcript — and redacted after the buffer is joined, since a value split across two reads is whole again the moment they are concatenated.
- Claude sessions disable subscription authentication by default (ADR-0010).
- Depth, concurrency, spawn count and stall limits apply to every subagent. Money limits depend on what the runtime supports.
