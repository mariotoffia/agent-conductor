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
);
