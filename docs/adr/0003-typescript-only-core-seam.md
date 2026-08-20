# ADR-0003: TypeScript only, with the core kept free of `vscode`

- Status: accepted
- Date: 2026-08-18

## Context

The VS Code extension host runs TypeScript or JavaScript, and the official ACP SDK is TypeScript.

We considered splitting the work across two languages — a separate daemon written in something else. We rejected it. That split adds inter-process communication, a binary to build and ship per platform, a second toolchain, and a second copy of the protocol code. The user gets nothing from any of it. Simplicity is a stated goal of this project.

## Decision

The project is **TypeScript only**: the extension, the conductor core, and the MCP shim.

`src/core/**` must not import `vscode`. It offers an internal API shaped like ACP.

That line exists for two reasons. It lets the core run under plain Node in unit tests. And it keeps one option open without committing to it: lifting the core into its own Node process behind an ACP-agent facade.

## Consequences

One language and one toolchain, so `make check` covers everything.

The line is checked by a machine, not by reviewers — see `reports/core-imports.log`.

Supporting other editors, if we ever want to, becomes a packaging change: a Node daemon reusing `src/core`. Not a rewrite.

## References

ARCHITECTURE.md §Layering rules · @agentclientprotocol/sdk
