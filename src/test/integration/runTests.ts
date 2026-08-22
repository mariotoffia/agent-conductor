import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

/**
 * Launches VS Code with this extension loaded and runs the suite inside it.
 *
 * Everything the tests need from outside the host is handed over here: a real
 * node binary and the bundled mock Agent, because the extension host is Electron
 * and cannot launch a `.ts` file or itself act as node.
 *
 * Anything that goes wrong — VS Code that will not download, a harness that will
 * not start, a failing or empty suite — exits nonzero. A gate that cannot fail
 * reports success forever.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..", "..", "..");

/**
 * `VSCODE_*` and `ELECTRON_*` are how a running VS Code tells its own child
 * processes what they are. Inherited by the VS Code we start here, they make it
 * behave as that other window's extension host — it runs as plain node and tries
 * to execute the workspace path as a script. So they are dropped: a value of
 * `undefined` is a variable the child is not given.
 *
 * This only matters when the tests are launched from inside VS Code, which is
 * exactly where someone working on this extension launches them.
 */
function withoutHostEnvironment(): Record<string, string | undefined> {
  const cleared: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("VSCODE_") || name.startsWith("ELECTRON_")) cleared[name] = undefined;
  }
  // The other half of the same symptom: VS Code's JS auto-attach sets this
  // beside `VSCODE_INSPECTOR_OPTIONS`, and it points at a bootloader belonging
  // to the window we were launched from.
  cleared.NODE_OPTIONS = undefined;
  return cleared;
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "conductor-host-"));
  // Removed however the run ends: this harness makes one per invocation, and
  // the unit suite's fixtures were leaking the same way until they were fixed.
  try {
    await runInside(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runInside(workspace: string): Promise<void> {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, "dist", "test", "suite", "index.cjs"),
    launchArgs: [
      workspace,
      // Only this extension, and a workspace already trusted — the refusal that
      // untrusted workspaces produce has its own test under `make test`.
      "--disable-extensions",
      "--disable-workspace-trust",
      "--disable-gpu",
      "--no-sandbox",
    ],
    extensionTestsEnv: {
      ...withoutHostEnvironment(),
      // No flag turns the test hooks on: VS Code reports `ExtensionMode.Test`
      // because of `extensionTestsPath` above, and that is what the extension
      // reads — an environment variable would be forgeable from inside the host.
      AGENT_CONDUCTOR_TEST_NODE: process.execPath,
      AGENT_CONDUCTOR_TEST_AGENT: resolve(root, "dist", "mock-agent.cjs"),
    },
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
