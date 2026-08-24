# Connect a CLI

The wizard finds the CLI, shows you the exact command it will run, and asks you to approve it.

That approval covers the exact program, its arguments and its environment. If any of them changes later, you are asked again — so read the command before you accept it. If the CLI needs an adapter you do not have, the wizard offers to install it at one exact version, as its own step.

Then it opens a throwaway session in a temporary directory, offers the models and reasoning levels the agent itself reports, and asks the agent one short question. Nothing is written to your settings until it answers, so a CLI that will not start, or will not reply, is never saved — though a key you pasted stays in secret storage, and an adapter you asked it to install stays installed.

You choose whether the connection is saved for every workspace or only this one. Whatever you had already configured for that CLI in that same place is kept, and settings a repository supplied for this workspace stay there rather than following you into other ones. If another settings file still describes the CLI differently, the wizard tells you the connection will not launch as approved.

Signing in happens in the CLI's own login command — `claude /login`, `codex login`, and so on — which the wizard offers to open in a terminal, and waits for. Claude then runs on your plan. If you would rather it used an API key, the wizard stores one in VS Code's secret storage and your settings hold only its name; an organisation can enforce that with `agentConductor.claude.hideSubscriptionAuth`, which launches Claude with `--hide-claude-auth` and is covered by the approval you give. Agent Conductor never collects or proxies a credential.
