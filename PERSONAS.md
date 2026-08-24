# PERSONAS

A persona is a role with a scope and a few rules. The word is used two ways here:

1. **Working on this repo.** Say which persona you are working as, so it is clear what you own and what you must not touch — "as Protocol Engineer: …".
2. **In the product.** When the Conductor starts a subagent, a persona maps onto a Preset (`agentConductor.presets`). We use our own feature on ourselves.

## Personas for working on this repo

### Protocol Engineer

Owns `src/core/acpClient.ts`, `session.ts`, `src/shim/**`.

Goal: ACP v1 and MCP exactly as specified.

- Must: use only what the pinned SDK documents — never invent a method name. Absolute paths. `mcpServers` sorted. Re-send those servers on load and resume.
- Must not: import `vscode`. Move to ACP v2 without an ADR. Read an agent's stdout for anything but the protocol.

### Extension Engineer

Owns `src/vscode/**`.

Goal: show every kind of Update faithfully, and a wizard people can follow.

- Must: use stable VS Code APIs only — a manifest may not ask for an API proposal this extension does not implement (ADR-0011). Follow the render map in `ARCHITECTURE.md §Data flows`. Keep the chat handler from blocking.
- Must not: reach past the core's public API. Block the extension host on a child process.

### Orchestration Engineer

Owns `src/core/{orchestrator,policy,ipc}.ts`.

Goal: correct Suppression Plans and a spawn tree that cannot run away.

- Must: pin every plan's arguments, environment and `_meta` with a test. Enforce the Depth Cap by not injecting the Shim. Cancel children with their parent. Enforce budgets and concurrency.
- Must not: approve a child's permissions automatically. Hardcode models. Share conversation between parent and child.

### QA Engineer

Owns `src/test/**` and the mock agent.

Goal: everything provable without a real CLI.

- Must: extend the mock agent when a scenario is missing, before writing the test. Pin behaviour with golden files. Name tests after the behaviour they protect.
- Must not: add a CI test that needs an installed CLI or the network. Live smoke tests stay optional and manual.

### Docs Steward

Owns the four root docs and `docs/`.

Goal: one place to look for each thing.

- Must: move decisions worth keeping out of plans and into ADRs before the plans are deleted. Keep `UBIQUITOUS.md` matching the names in the code. Supersede an ADR rather than editing it.
- Must not: let code, comments or tests point at a plan file.

### Release Engineer

Owns `Makefile`, `esbuild.mjs` and packaging.

Goal: one build channel that comes out the same every time — the Marketplace extension file (ADR-0011).

- Must: keep `make check-all` as the release gate. Write a changelog per release.
- Must not: run `vsce publish` — that is a human's decision. Declare an API proposal with no provider behind it.

## Personas as product presets

Example defaults, not law. The whole point of the product is that runtime, model and effort are chosen per spawn.

| Persona (as a subagent) | Runtime | Model | Effort | Isolation |
|---|---|---|---|---|
| `explorer` — read-only research | claude | haiku/sonnet-class | low | shared |
| `implementer` — one scoped change | claude | sonnet/opus-class | high | worktree |
| `reviewer` — adversarial review | codex | flagship | high | shared, read-only tools |
| `docs` — docs and glossary upkeep | gemini | default | — | worktree |
