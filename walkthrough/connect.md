# Connect a CLI

The wizard finds the CLI, shows you the exact command it will run, and asks you to approve it.

That approval covers the exact program, its arguments and its environment. If any of them changes later, you are asked again — so read the command before you accept it. If the CLI needs an adapter you do not have, the wizard offers to install it at one exact version, as its own step.

Then it opens a throwaway session in a temporary directory, offers the models and reasoning levels the agent itself reports, and asks the agent one short question. Nothing is written to your settings until it answers, so a CLI that will not start, or will not reply, is never saved — though a key you pasted stays in secret storage, and an adapter you asked it to install stays installed.

You choose whether the connection is saved for every workspace or only this one. Whatever you had already configured for that CLI in that same place is kept, and settings a repository supplied for this workspace stay there rather than following you into other ones. If another settings file still describes the CLI differently, the wizard tells you the connection will not launch as approved.

**Claude needs an API key.** Signing in with a claude.ai subscription is disabled by default: Claude is launched with `--hide-claude-auth`, which the approval you give covers. Your key is stored in VS Code's secret storage; your settings hold only the name of the key, never the key itself.

Signing in otherwise happens in the CLI's own login command, which the wizard offers to open in a terminal, and waits for. Agent Conductor never collects or proxies a credential.
