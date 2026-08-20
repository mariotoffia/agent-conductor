# ADR-0010: Claude needs an API key, and settings hold only the name of a secret

- Status: accepted
- Date: 2026-08-18
- Supersedes: ADR-0006

## Context

Agent Conductor is a third-party product that launches coding agents.

Anthropic's policy for Claude Code says a third-party product must use API-key authentication, and must not route through Free, Pro, or Max credentials. Other vendors' policies can change on their own schedule.

Putting environment values straight into VS Code settings would expose credentials through settings sync, through files in the workspace, and through logs.

## Decision

Claude sessions we launch have subscription authentication disabled by default. They need an API key, or cloud-provider credentials the adapter accepts.

Sessions on other runtimes may keep using the login the CLI already has, but only where that vendor's current policy allows it.

Delegating across providers, or fanning out in parallel, stays off until the user turns on orchestration, accepts the notice about data leaving, and meets whatever authentication that provider requires for this release.

The extension never collects, proxies, infers, or logs a credential.

A runtime's settings map an environment variable name to the *name* of a VS Code SecretStorage entry, through `secretEnvironment`. They never contain a secret value. The connection flow writes secrets through SecretStorage, and the launch code looks them up only while building the child process's environment. Non-secret policy environment from our catalog stays internal launch configuration.

Vendor policy is checked against the vendor's own documentation before each release. If we cannot tell which kind of credential is in use without looking at the secret itself, we ask the user instead of guessing from logs or agent output.

## Alternatives considered

- **Inherit every CLI login by default.** Rejected: a vendor's policy may forbid third-party use.
- **Store environment values in user or workspace settings.** Rejected: settings are not a secret store.
- **Proxy credentials through the extension.** Rejected: it widens what has to be trusted, and what has to be complied with.
- **Work out the credential type from output.** Rejected: unreliable, and it risks disclosure.

## Consequences

Setting up Claude requires an API key or supported cloud credentials. That trades convenience for a default that complies.

Runtime settings hold only references. A missing secret stops the launch rather than starting an agent that fails obscurely. Release work now includes checking vendor policy, with the date it was checked.

ADR-0006 stays as a record and is no longer the active decision on authentication.

## References

https://code.claude.com/docs/en/legal-and-compliance (verified 2026-08-18) · ARCHITECTURE.md §Security invariants · UBIQUITOUS.md: Runtime Trust
