# Install an agent CLI

Agent Conductor drives a coding CLI you already have. Install at least one:

- **Claude Code**, **Codex**, **Gemini CLI** or **Copilot CLI**
- **DeepSeek Harness** (a developer preview) — once, after installing `dsh`, give it a profile that carries DeepSeek's own ACP plugin:

  ```bash
  dsh plugin --profile acp add @deepseek-ai/dsh-acp@0.1.1-rc.2
  printf -- "- insert:\n    - id: acp\n      name: '@deepseek-ai/dsh-acp'\n" > ~/.dsh/profiles/acp/cordis.patch.yml
  ```

  The second line writes that profile's patch file, replacing any patch the profile already had. Agent Conductor then launches `dsh --profile acp`. Your model and credentials are dsh's own settings (`dsh web`, *Models*).
- or any other agent that speaks the Agent Client Protocol

Agent Conductor never downloads one for you. It only runs programs already on your machine.
