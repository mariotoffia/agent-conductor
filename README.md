# Agent Conductor

Drive agentic coding CLIs — Claude Code, Codex, Gemini CLI, Copilot CLI, any [ACP](https://agentclientprotocol.com) agent — inside VS Code. Pick cli × model × effort per session; let the main agent spawn cross-CLI subagents under your policy, budget, and permissions. TypeScript only.

## Bootstrap

```bash
git clone https://github.com/mariotoffia/agent-conductor && cd agent-conductor
make install    # verifies node>=20/npm/git, reports installed agent CLIs, npm ci
make check      # build + lint + unit tests (no live CLIs needed)
```

Open the folder in VS Code and press **F5** (Run Extension). In the dev host: run *Agent Conductor: Connect a CLI…* or mention **@conductor** in Chat.

## Security defaults

Agent executables are trusted code, not sandboxed plugins. Connecting a Runtime records approval for its resolved launch fingerprint, and a changed launch — a different executable, arguments, or suppression policy — requires renewed trust. Starting a session never downloads anything: agents and adapters are launched from executables already installed on the machine, and installing one is a separate step that names an exact version. Cross-runtime orchestration is off until explicitly enabled, and worktrees coordinate changes without restricting Agent filesystem access.

Claude launches disable claude.ai subscription authentication by default. Configure API-key or supported cloud-provider credentials through VS Code SecretStorage; settings contain references, never secret values. Permission policy classifies Client filesystem and terminal operations independently of Agent-supplied `ToolKind`.

Everyday targets (`make help` for all):

| Target | Does |
|---|---|
| `make install` | prerequisite doctor + dependency install |
| `make build` / `make watch` | esbuild → `dist/extension.cjs` + `dist/mcp-shim.cjs` |
| `make lint` / `make test` | the done-criteria (AGENTS.md); logs under `reports/` |
| `make check` / `make check-all` | aggregate gates (`check-all` adds extension-host tests) |
| `make package` / `make package-rich` | Marketplace VSIX / sideload VSIX with proposed APIs |
| `make release` | clean-tree gate + `check-all` + both VSIX artifacts |
| `make adr NAME=…` / `make plan NAME=…` | scaffold a decision record / plan |

## Documentation

`AGENTS.md` (agent rules — start here) · `ARCHITECTURE.md` · `UBIQUITOUS.md` (glossary) · `PERSONAS.md` · `docs/adr/` (decisions) · `docs/plans/` (temporary working plans).

## License

Apache-2.0
