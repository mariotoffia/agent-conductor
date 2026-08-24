# ADR-0013: Claude sessions use the CLI's own login by default

- Status: accepted
- Date: 2026-08-24
- Supersedes: the Claude authentication default of ADR-0010. Its secret-reference rules stand.

## Context

ADR-0010 made Claude sessions hide subscription authentication by default, so that the adapter would insist on an API key. It rested on one page: Anthropic's legal and compliance page, which says a third-party developer may not offer Claude.ai login in its own application or route requests through Free, Pro or Max credentials on behalf of its users.

Two things were checked on 2026-08-24 that the decision had not seen.

Anthropic's own support article on using the Claude Agent SDK with a Claude plan names "third-party apps that authenticate with your Claude subscription through the Agent SDK" as a use a plan pays for: it announced a separate monthly Agent SDK credit for exactly that usage, then paused the change, and says such usage today "still draw[s] from your subscription's usage limits". The vendor thereby treats this usage as a thing subscribers do, not a thing forbidden. The Claude ACP adapter is built on the Agent SDK, so this is the sentence that describes it.

Zed, whose adapter this is, does nothing special: the adapter advertises the Claude Code CLI's own login as an ACP authentication method — `--hide-claude-auth` exists to remove it — and Zed does not pass the flag. Its users run Claude Code over ACP on their own plans, openly (zed-industries/zed issue #51648 is a Max subscriber doing so).

The shape the legal page forbids — a product that offers a Claude.ai sign-in of its own, or holds credentials for its users — is not this one. Here the sign-in completes in Claude Code's own flow (`claude /login`), on the user's own machine, and this extension never sees the credential in either configuration.

## Decision

Claude sessions launch on whatever login the Claude Code CLI already has. `--hide-claude-auth` is not sent unless `agentConductor.claude.hideSubscriptionAuth` is set to `true`.

The switch stays. It is for organisations that want an API key enforced, and it remains part of the launch identity: turning it on or off changes the fingerprint, so the launch is approved again either way.

Everything else in ADR-0010 stands: settings hold only the name of a secret, the wizard stores a pasted key in SecretStorage, and nothing collects, proxies, infers or logs a credential.

## Alternatives considered

- **Keep hiding by default.** Rejected: it enforces a reading of one page that the vendor's own article contradicts, and it costs every user an API key for a login they already have.
- **Remove the switch.** Rejected: an organisation may still want API-key billing enforced, and the adapter ships the switch for exactly that.

## Consequences

A user signed in to Claude Code connects Claude with no further setup. What their plan covers, and how it is billed, is between them and Anthropic — the paused Agent SDK credit may return.

The default changed, so every previously approved Claude launch has a new fingerprint and is approved again at its next use. That is the trust model working, not a defect.

Vendor policy is still re-checked before each release and recorded with its date in `docs/CHANGELOG.md`. Should Anthropic withdraw the article's sentence, this decision is the one to supersede.

## References

https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (verified 2026-08-24) · https://code.claude.com/docs/en/legal-and-compliance (verified 2026-08-24) · https://zed.dev/blog/anthropic-subscription-changes · ADR-0010 · ARCHITECTURE.md §Security invariants
