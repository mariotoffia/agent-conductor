# ADR-0010: Authentication and secret references

- Status: accepted
- Date: 2026-08-18
- Supersedes: ADR-0006

## Context

Agent Conductor is a third-party product that launches coding Agents. Anthropic's current Claude Code policy says third-party products must use API-key authentication and must not route through Free, Pro, or Max credentials. Other Runtime policies can also change independently. Plaintext environment values in VS Code settings would expose credentials through settings sync, workspace files, and logs.

## Decision

Claude Sessions launched by Agent Conductor default to subscription-auth-disabled mode and require API-key or supported cloud-provider credentials accepted by the adapter. Direct Sessions on other Runtimes may inherit existing CLI authentication only when current provider policy permits it. Cross-provider or parallel fan-out remains disabled until the user explicitly enables orchestration, accepts the provider/data-egress notice, and satisfies any provider-specific authentication requirement verified for the release.

The extension never collects, proxies, infers, or logs credentials. Runtime settings map environment variable names to opaque VS Code SecretStorage key references through `secretEnvironment`; they never contain secret values. The connection flow writes secrets through SecretStorage, and launch code resolves references only when constructing the child environment. Catalog-owned non-secret policy environment remains internal launch configuration.

Provider policy is verified from primary sources before release. If a credential type cannot be determined without inspecting secret material, the product asks the user rather than inferring it from logs or Agent output.

## Alternatives considered

- Inherit all CLI logins by default: rejected because provider policy can prohibit third-party use.
- Store environment values in user or workspace settings: rejected because settings are not a secret store.
- Proxy provider credentials through the extension: rejected because it expands the trusted computing base and compliance burden.
- Detect credential type from output: rejected because it is unreliable and risks disclosure.

## Consequences

Claude setup requires an API key or supported cloud-provider credentials, trading convenience for a compliant default. Runtime configuration stores only references, missing secrets fail closed at launch, and release work includes dated policy verification. ADR-0006 remains historical and is no longer the active authentication decision.

## References

https://code.claude.com/docs/en/legal-and-compliance (verified 2026-08-18) · ARCHITECTURE.md §Security invariants · UBIQUITOUS.md: Runtime Trust
