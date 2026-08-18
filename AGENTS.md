# Agent Conductor Agent Rules

Canonical file. `.claude/CLAUDE.md` is a symlink to this. If the two ever disagree, preserve user edits and report it.

Agent Conductor is a **TypeScript VS Code extension** that drives agentic coding CLIs (Claude Code, Codex, Gemini CLI, Copilot CLI — any ACP agent) over the **Agent Client Protocol (ACP v1)**. The user picks cli × model × effort per session; a conductor layer spawns cross-CLI subagents through an injected MCP server while each CLI's built-in delegation is suppressed. This file is navigation, not a rule restatement.

**TypeScript only** — extension, conductor core, and MCP shim are all TypeScript; no other implementation languages (ADR-0003). Keep it simple and clean: prefer deleting code to abstracting it.

## Communication

Terse for chat, status, findings, and handoffs. Full clarity for destructive, security, auth/ToS, or ambiguous work.

## MUST: Where to look — task → doc

| Doing this | Read |
|---|---|
| Naming a type, setting, tool, event, or concept | `UBIQUITOUS.md` (authoritative glossary) |
| Changing layering, components, or protocol boundaries | `ARCHITECTURE.md` |
| Working as, or spawning, a persona | `PERSONAS.md` |
| Understanding why a choice was made (or changing it) | `docs/adr/` — changing an ADR'd decision requires a superseding ADR (`make adr`) |
| Current milestones and status | `docs/plans/0001-mvp-implementation-plan.md` |
| Implementation how-to: manifest, settings schema, wizard, code skeletons | `docs/plans/0002-implementation-guide.md` (**temporary** — see plan-file rule below) |
| Adding or changing an agent runtime | `ARCHITECTURE.md §Runtime catalog` + "Adding a runtime" below |

Markdown is the default doc format. Root-level canon is exactly: `AGENTS.md`, `UBIQUITOUS.md`, `ARCHITECTURE.md`, `PERSONAS.md`. Everything else goes under `docs/` — do not add root-level docs unless instructed.

## Hard rules (grep-able conventions; `make lint` enforces the first two)

- `src/core/**` MUST NOT import `vscode` — it is the extraction seam (ADR-0003). Checked by `make lint` (`reports/core-imports.log`).
- TypeScript `strict` is on; no `any` without an inline reason comment.
- ACP discipline: protocol v1 only; every path absolute; `mcpServers` arrays sorted by name (session fingerprinting); on `session/load`/`resume`, always re-send `mcpServers` and `additionalDirectories`.
- Model and effort lists are **never hardcoded** — discovery via `configOptions`, catalog fallback, and mandatory effective-value read-back (ADR-0005).
- Permission routing is never bypassed; automatic policy uses Client Operations derived from method + normalized arguments, never Agent-supplied `ToolKind`; a cancelled turn answers `{"outcome":"cancelled"}`.
- Secrets live in VS Code `SecretStorage`; settings hold opaque references, resolved values are injected as env at spawn, and values are never logged or written to settings JSON.
- External claims about CLIs and protocols go stale weekly — verify against primary sources before relying; the current unverified list is `docs/plans/0002-implementation-guide.md` Appendix A.

## MUST: Never reference a planning document

Comments, test names, file names and docs MUST NOT carry review or task identifiers — `P3`, `HIGH-2`, `finding F1`, "see the implementation guide". Files under `docs/plans/` get deleted; the reference outlives them and points a reader at nothing.

Reference only what is durable:

| Reference | Example |
|---|---|
| An ADR | `see ADR-0004 — suppression is per-runtime, injection is the recursion guard` |
| A canonical root doc + section | `ARCHITECTURE.md §Data flows`, `UBIQUITOUS.md` |
| A `UBIQUITOUS.md` term | say `Runtime`, `Brief`, `Shim`, `Read-back` — the glossary word, not a ticket |

If a plan's decision is worth keeping, promote it to an ADR or a canonical doc **before** the plan is deleted, then point at that.

Name test files after the behaviour they pin (`suppression_argv_test.ts`, not `p3_orchestrator_test.ts`).

## How to know you're done

Two commands. That's it.

```bash
make lint   # every static check; one log per checker under reports/
make test   # unit tests (mock ACP agent, no live CLIs)
```

Both green on your branch. Failures that pre-date your work are still your problem on the branch — fix or revert before declaring done.

Convenience wrappers (same gates, different scopes):

```bash
make check       # build + lint + test
make check-all   # build + lint + test + test-integration (VS Code host + mock agent)
```

Keep output context-efficient: full logs to `reports/`, report command/status/count/duration for passing runs, read failure sections only.

Never run `vsce publish` — packaging is `make package` / `make package-rich`; publishing is a human action.

## Adding a runtime

1. Add the `RuntimeSpec` to the catalog (`src/core/runtimeRegistry.ts`): launch, detection, login command, quirks.
2. Write its `SuppressionPlan` (`src/core/policy.ts`) and a golden argv/env/`_meta` test beside it.
3. Wire wizard hints (auth probe uses ACP `authMethods` — no per-CLI hacks unless the protocol offers nothing).
4. New terms → `UBIQUITOUS.md`; new trade-off → ADR.
5. `make check` green.
