import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, platform: "node", format: "cjs", sourcemap: true, logLevel: "info" };

const builds = [
  // Extension host bundle — `vscode` is provided by the host.
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", external: ["vscode"], target: "node20" },
  // MCP shim — spawned by agent harnesses OUTSIDE the extension host; fully self-contained.
  { ...common, entryPoints: ["src/shim/mcp-shim.ts"], outfile: "dist/mcp-shim.cjs", target: "node18" },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
