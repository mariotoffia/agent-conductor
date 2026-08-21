import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, platform: "node", format: "cjs", sourcemap: true, logLevel: "info" };

const builds = [
  // Extension host bundle — `vscode` is provided by the host.
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", external: ["vscode"], target: "node20" },
  // MCP shim — spawned by agent harnesses OUTSIDE the extension host; fully self-contained.
  { ...common, entryPoints: ["src/shim/mcp-shim.ts"], outfile: "dist/mcp-shim.cjs", target: "node18" },
  // Mock ACP agent — the extension-host tests launch this as a real Runtime, so
  // it has to be a plain node program with no loader behind it.
  { ...common, entryPoints: ["src/test/mock-agent.ts"], outfile: "dist/mock-agent.cjs", target: "node20" },
  // Extension-host test suite — loaded by VS Code, so `vscode` and the test
  // runner both come from the host rather than from this bundle.
  {
    ...common,
    entryPoints: ["src/test/integration/suite/index.ts"],
    outfile: "dist/test/suite/index.cjs",
    external: ["vscode", "mocha"],
    target: "node20",
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
