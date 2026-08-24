# Install an agent CLI

Agent Conductor drives a coding CLI you already have. Install at least one:

- **Claude Code** or **Codex** — the wizard installs their ACP adapter for you, at one exact version, as its own step.
- **Gemini CLI** — `brew install gemini-cli`, or `npm install -g @google/gemini-cli`
- **Copilot CLI** — `brew install --cask copilot-cli`, or `npm install -g @github/copilot`
- **DeepSeek Harness** (a developer preview) — once, after installing `dsh`, give it a profile that carries DeepSeek's own ACP plugin:

  ```bash
  dsh plugin --profile acp add @deepseek-ai/dsh-acp@0.1.1-rc.2
  printf -- "- insert:\n    - id: acp\n      name: '@deepseek-ai/dsh-acp'\n      config: {provider: PROVIDER, model: MODEL}\n" > ~/.dsh/profiles/acp/cordis.patch.yml
  ```

  Put your own provider route and model id in place of `PROVIDER` and `MODEL` — `dsh web` → *Models* names them. dsh's ACP plugin does not read dsh's default model, and without both every turn fails. The second line replaces any patch that profile already had. Agent Conductor then launches `dsh --profile acp`; credentials stay dsh's own.
- or any other agent that speaks the Agent Client Protocol

Agent Conductor never downloads one for you. It only runs programs already on your machine.
