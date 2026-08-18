# ADR-0003: TypeScript only; conductor core isolated behind a vscode-free seam

- Status: accepted
- Date: 2026-08-18

## Context

The extension host mandates TS/JS and the official ACP SDK is TypeScript. A polyglot split (a separate daemon in another language) was considered and rejected: it adds IPC, per-platform binary distribution, a second toolchain, and duplicated protocol code — for no user benefit. Simplicity is a stated project value.

## Decision

The project is **TypeScript only** — extension, conductor core, and MCP shim. `src/core/**` must not import `vscode` and exposes an ACP-shaped internal API. The seam exists for testability (core runs under plain Node in unit tests) and keeps one future option open without committing to it: lifting the core into a standalone Node process behind the ACP-agent facade.

## Consequences

One language, one toolchain; `make check` covers everything. The seam is machine-checked (`reports/core-imports.log`). Multi-editor reach, if ever wanted, is a packaging change (Node daemon reusing `src/core`), not a rewrite.

## References

ARCHITECTURE.md §Layering rules · @agentclientprotocol/sdk
