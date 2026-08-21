# Agent Conductor — rules for working in this repo

This is the canonical file. `.claude/CLAUDE.md` is a symlink to it. If the two ever differ, keep the user's edits and say so.

Agent Conductor is a **VS Code extension, written in TypeScript**. It runs coding CLIs — Claude Code, Codex, Gemini CLI, Copilot CLI, any ACP agent — over the **Agent Client Protocol (ACP v1)**. The user picks the CLI, model and effort for each session. One agent can hand work to agents on other CLIs through a small server we inject, while each CLI's own way of doing that is switched off.

This file tells you where to look. It does not repeat the rules that live elsewhere.

**TypeScript only** — the extension, the core, and the injected server are all TypeScript. No other languages (ADR-0003). Prefer deleting code to abstracting it.

## How to write

Be brief in chat, status updates, findings and handoffs. Be complete when the work is destructive, security-related, about authentication or terms of service, or when the request is unclear.

## MUST: which doc to read

| If you are | Read |
|---|---|
| naming a type, setting, tool, event or concept | `UBIQUITOUS.md` — the glossary decides |
| changing layers, components or protocol boundaries | `ARCHITECTURE.md` |
| working as, or starting, a persona | `PERSONAS.md` |
| wondering why something was decided, or changing it | `docs/adr/` — to change a decision, write a new ADR that supersedes the old one (`make adr`) |
| looking for current status | `docs/plans/0001-mvp-implementation-plan.md` |
| looking for how-to detail: the manifest, settings, the wizard, code sketches | `docs/plans/0002-implementation-guide.md` (**temporary** — see the rule about plan files below) |
| adding or changing an agent runtime | `ARCHITECTURE.md §Runtime catalog`, then "Adding a runtime" below |

Docs are Markdown. The root holds exactly four: `AGENTS.md`, `UBIQUITOUS.md`, `ARCHITECTURE.md`, `PERSONAS.md`. Everything else goes in `docs/`. Do not add a root-level doc unless asked.

## Hard rules

Written so you can grep for them. `make lint` enforces the first two.

- **`src/core/**` must never import `vscode`.** That is the line that keeps the core runnable outside VS Code (ADR-0003). `make lint` checks it and writes `reports/core-imports.log`.
- **TypeScript `strict` is on.** No `any` unless a comment on the same line says why.
- **ACP discipline.** Protocol v1 only. Every path absolute. Sort `mcpServers` by name, because agents treat the list as part of a session's identity. On `session/load` and resume, always send `mcpServers` and `additionalDirectories` again.
- **Never hardcode model or effort lists.** Ask the agent (`configOptions`), fall back to the catalog, and always read back what the agent says it is actually running (ADR-0005).
- **Never bypass permission routing.** Automatic decisions are keyed by what *the client* is about to do — worked out from the method and its arguments — never by the `ToolKind` the agent reports. A cancelled turn answers `{"outcome":"cancelled"}`.
- **Secrets live in VS Code `SecretStorage`.** Settings hold only the name of a secret. Values are resolved when the process starts, and are never logged or written to settings.
- **Check claims about other CLIs and protocols before relying on them.** They go stale within weeks. The unverified ones are listed in `docs/plans/0002-implementation-guide.md`, Appendix A.

## MUST: never point at a planning document

Do not put review or task identifiers — `P3`, `HIGH-2`, `finding F1`, "see the implementation guide" — in comments, test names, file names or docs. Files under `docs/plans/` get deleted, and the reference outlives them, leaving a reader pointed at nothing.

Point only at things that last:

| Point at | Like this |
|---|---|
| an ADR | `see ADR-0004 — suppression is per-runtime, injection is the recursion guard` |
| a root doc and section | `ARCHITECTURE.md §Data flows`, `UBIQUITOUS.md` |
| a glossary term | say `Runtime`, `Brief`, `Shim`, `Read-back` — the word, not a ticket |

If a plan contains a decision worth keeping, move it into an ADR or a root doc **before** the plan is deleted, then point there.

Name a test file after the behaviour it protects: `suppression_argv_test.ts`, not `p3_orchestrator_test.ts`.

## How you know you are done

Two commands.

```bash
make lint   # every static check; one log per checker in reports/
make test   # unit tests against a mock agent — no real CLIs
```

`make test` fails a test file that does not exit after its tests finish — one that left a process, socket, or timer running. Without that check the file prints `ok` for every test and the run hangs. `src/test/unit/leak_guard.test.ts` tests the check itself: a leak must fail, a clean file must not.

`make lint` starts by proving its own checks can still fail. It plants a `vscode` import and expects it to be caught, and it makes a command fail inside a piped recipe to be sure the `tee` does not hide it. A check that cannot fail reports success forever, so a `gate self-test` failure is a broken build, not a broken test.

Both must pass on your branch. Failures that were there before you started are still yours to fix or revert before you call the work done.

Wider versions of the same checks:

```bash
make check       # build + lint + test
make check-all   # the above + the VS Code extension tests against a mock agent
```

`make test-integration` downloads VS Code once, into `.vscode-test/`, and runs the extension inside it against the bundled mock Agent. It fails three ways, not one: a test that fails, a suite that registered nothing, and a suite that registered tests and ran fewer — every one skipped, a test with no body, or a `.only` left behind after debugging. The last is the one that will actually happen, and a passing count hides it best.

Launched from inside VS Code it drops the `VSCODE_*`, `ELECTRON_*` and `NODE_OPTIONS` variables it inherited, which would otherwise make the VS Code it starts behave as the outer window's extension host.

The extension exposes the participant to those tests through an object it only builds under `ExtensionMode.Test` — VS Code sets that from the launch arguments, so unlike an environment variable it cannot be forged by anything else in the host. There is no other way in: VS Code has no API for sending a chat participant a turn.

Keep output small: full logs go to `reports/`. For a passing run, report the command, the status, the count and the time. Only read the failing parts.

Never run `vsce publish`. Building the extension file is `make package` / `make package-rich`; publishing it is a human decision.

`.vscodeignore` is an allow-list, and it has to be: `vsce` keeps a file when any negation matches it, whatever else the file says and whatever the order, so `!dist/**` followed by exclusions ships everything under `dist/` regardless. It reports nothing when it is wrong — after changing what the build writes, check what would actually ship with `npx @vscode/vsce ls`.

## Adding a runtime

1. Add its `RuntimeSpec` to the catalog (`src/core/runtimeRegistry.ts`): how to launch it, how to detect it, how to log in, and its quirks.
2. Write its `SuppressionPlan` (`src/core/policy.ts`) with a test beside it that pins the exact arguments, environment and `_meta`.
3. Add wizard hints. The authentication check uses ACP's `authMethods` — do not special-case a CLI unless the protocol offers nothing.
4. New terms go in `UBIQUITOUS.md`. New trade-offs get an ADR.
5. `make check` passes.
