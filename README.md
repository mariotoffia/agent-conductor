# Agent Conductor

Run coding CLIs — Claude Code, Codex, Gemini CLI, Copilot CLI, or any [ACP](https://agentclientprotocol.com) agent — inside VS Code.

You choose the CLI, the model, and the reasoning effort for each session, and what you asked for is always shown beside what the agent reports it is actually running. Written entirely in TypeScript.

It is also built to let one agent hand work to agents on other CLIs, within limits you set — but that is switched off for every CLI today, not only by default: before an agent may delegate, we must verify its own subagent feature is really off, ACP has no way to prove that yet, and unprovable means not allowed. `docs/CHANGELOG.md` records what was verified and when.

## Getting started

```bash
git clone https://github.com/mariotoffia/agent-conductor && cd agent-conductor
make install    # checks node, npm and git, lists the agent CLIs you have, installs dependencies
make check      # build, lint and unit tests — no agent CLI needed
```

Node must be one of the versions in `engines.node` — 20.19+, 22.13+ or 24 and later. `make install`
refuses an older one rather than building a dependency tree that cannot run.

Open the folder in VS Code and press **F5** to launch the extension. In the new window, run *Agent Conductor: Connect a CLI…*, or type **@conductor** in Chat. The **Sessions** view in the activity bar lists what this window is running and what it remembers, and is where a session is cancelled or picked up again.

## Security defaults

An agent CLI is a program that runs with your permissions. It is not a sandboxed plugin. So:

- **You approve each CLI before it runs.** The approval covers the exact program and the exact arguments. Change either and you are asked again.
- **Starting a session never downloads anything.** Only programs already on your machine are run. Installing one is a separate step, and it names an exact version.
- **Handing work to other CLIs is off, and today it stays off.** The switch exists, but no CLI can yet be granted the verification it requires (see above), so no delegation server is injected into any session.
- **Opening a folder starts nothing.** Sessions are remembered as metadata — never a prompt, never anything the agent read — and picking one up again is something you do. Turn on `agentConductor.sessions.resumeOnStartup` and one session is opened for you, the most recent that still clears every condition. Sessions are remembered per machine, and a session another window has open is not offered to this one — so two windows on one folder cannot end up running two agents on one conversation.
- **Git worktrees keep changes apart, not agents.** They stop two agents editing the same files. They do not limit what an agent can read or run.
- **Claude sessions need an API key.** Signing in with a claude.ai subscription is disabled by default — the adapter is launched with `--hide-claude-auth`, and that is part of what you approve. Keys live in VS Code's secret storage; your settings hold only the name of the key, never its value.
- **Permission prompts say what the extension is about to do** — read this file, run this command — rather than repeating the agent's own description of it.

## Everyday commands

`make help` lists them all.

| Command | What it does |
|---|---|
| `make install` | checks prerequisites, then installs dependencies |
| `make build` / `make watch` | builds `dist/extension.cjs` and `dist/mcp-shim.cjs` |
| `make lint` / `make test` | the two checks that say your work is done; full logs land in `reports/` |
| `make check` / `make check-all` | both of the above, plus a build (`check-all` also runs the VS Code tests) |
| `make package` | builds the Marketplace extension file |
| `make release` | the full check plus the extension file |
| `make adr NAME=…` / `make plan NAME=…` | starts a new decision record / plan |

## Documentation

- `AGENTS.md` — how to work in this repo. Start here.
- `ARCHITECTURE.md` — how the pieces fit together.
- `UBIQUITOUS.md` — what each term means.
- `PERSONAS.md` — who owns which part.
- `docs/adr/` — why each decision was made.
- `docs/CHANGELOG.md` — what each release does, and what was verified for it, dated.
- `docs/plans/` — working plans, deleted once done.

## License

Apache-2.0
