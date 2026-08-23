import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "*.mjs"] },
  ...tseslint.configs.recommended,
  {
    // The core stays vscode-free — it must run under plain Node (tests, future
    // standalone conductor). See ARCHITECTURE.md §Layering rules.
    files: ["src/core/**/*.ts", "src/shim/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "vscode", message: "src/core and src/shim must stay vscode-free." }] },
      ],
    },
  },
  {
    // The Shim is bundled separately and runs in a process an agent's harness
    // started, so it reaches neither the host nor the core — which is why it
    // keeps its own copy of the wire contract, held to the core's by tests.
    // See ARCHITECTURE.md §Layering rules.
    files: ["src/shim/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "vscode", message: "src/core and src/shim must stay vscode-free." }],
          patterns: [{ group: ["**/core", "**/core/**"], message: "src/shim must not import the core." }],
        },
      ],
    },
  },
);
