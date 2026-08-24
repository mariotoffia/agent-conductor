import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import {
  injectShim,
  ORCHESTRATION_METHODS,
  SHIM_SERVER_NAME,
  type OrchestrationServer,
  type SessionCapability,
  type ShimInjectionRequest,
} from "../../core/index.js";
import { ipcServer } from "../ipc-fixtures.js";

/**
 * What every eligible Session would ask for. Each test spoils exactly one of
 * these, because the decision has to fail on any one of them alone.
 */
function eligible(
  issuer: ShimInjectionRequest["issuer"],
  over: Partial<ShimInjectionRequest> = {},
): ShimInjectionRequest {
  return {
    enabled: true,
    depth: 0,
    maxSpawnDepth: 1,
    trusted: true,
    suppressionVerified: true,
    sessionKey: "parent-key",
    roots: ["/workspace"],
    issuer,
    command: "/opt/node",
    launch: { args: ["/ext/dist/mcp-shim.cjs"] },
    now: () => 1_000,
    ...over,
  };
}

/** A real orchestration server, so a grant that could not be enforced is refused
 *  by the thing that would have to enforce it rather than by a stub. */
async function issuer(t: TestContext): Promise<{
  server: OrchestrationServer;
  granted: SessionCapability[];
}> {
  const granted: SessionCapability[] = [];
  // Frozen at zero so an expiry is judged against the clock the tests set, not
  // the wall clock the process happens to be running under.
  const server = await ipcServer(t, { handler: async () => null, now: () => 0 });
  return {
    server: {
      ...server,
      issue(grant) {
        granted.push(grant);
        return server.issue(grant);
      },
    },
    granted,
  };
}

const stdio = (server: acp.McpServer): Record<string, unknown> => server as Record<string, unknown>;

test("orchestration that is switched off injects no Shim and mints no capability", async (t) => {
  const { server, granted } = await issuer(t);

  const injection = injectShim(eligible(server, { enabled: false }));

  assert.deepEqual(injection.servers, []);
  assert.deepEqual(granted, [], "a capability nothing may use is authority spent for nothing");
  assert.match(injection.refused ?? "", /orchestration/i);
});

test("a Runtime with no verified Suppression Capability gets no Shim", async (t) => {
  const { server, granted } = await issuer(t);

  const injection = injectShim(eligible(server, { suppressionVerified: false }));

  assert.deepEqual(injection.servers, []);
  assert.deepEqual(granted, []);
  assert.match(injection.refused ?? "", /suppress/i);
});

test("a Runtime whose trust does not hold gets no Shim", async (t) => {
  const { server, granted } = await issuer(t);

  const injection = injectShim(eligible(server, { trusted: false }));

  assert.deepEqual(injection.servers, []);
  assert.deepEqual(granted, []);
  assert.match(injection.refused ?? "", /trust/i);
});

test("the Depth Cap stops the recursion by not injecting the Shim at all", async (t) => {
  const { server, granted } = await issuer(t);

  const atCap = injectShim(eligible(server, { depth: 1, maxSpawnDepth: 1 }));
  const below = injectShim(eligible(server, { depth: 0, maxSpawnDepth: 1 }));

  assert.deepEqual(atCap.servers, [], "a Session at the cap must not be able to spawn");
  assert.match(atCap.refused ?? "", /depth/i);
  assert.equal(below.servers.length, 1);
  assert.equal(granted.length, 1, "only the Session below the cap is granted anything");
  below.revoke();
});

test("a Depth Cap of zero switches delegation off entirely", async (t) => {
  const { server, granted } = await issuer(t);

  const injection = injectShim(eligible(server, { depth: 0, maxSpawnDepth: 0 }));

  assert.deepEqual(injection.servers, []);
  assert.deepEqual(granted, []);
});

test("an eligible Session gets one stdio Shim whose secret travels in its environment", async (t) => {
  const { server, granted } = await issuer(t);

  const injection = injectShim(eligible(server));
  t.after(() => injection.revoke());

  assert.equal(injection.servers.length, 1);
  const shim = stdio(injection.servers[0] as acp.McpServer);
  assert.equal(shim.name, SHIM_SERVER_NAME);
  assert.equal(shim.command, "/opt/node");
  const args = shim.args as string[];
  assert.deepEqual(args.slice(0, 2), ["/ext/dist/mcp-shim.cjs", "--socket"]);
  assert.equal(args[2], server.address);

  const environment = shim.env as Array<{ name: string; value: string }>;
  const secret = environment.find((entry) => entry.name === "AGENT_CONDUCTOR_SESSION_SECRET");
  assert.ok(secret && secret.value.length > 0, "the Shim is given its capability");
  assert.equal(
    args.some((argument) => argument.includes(secret.value)),
    false,
    "argv is world-readable: a secret in it authenticates anyone on the machine",
  );
  assert.equal(granted.length, 1);
});

test("what the interpreter needs travels in the entry, and cannot displace the capability", async (t) => {
  // The Shim is started by the *Agent*, from this entry, with an environment the
  // Agent composes — not ours. So anything the command depends on has to be in
  // the entry: a VS Code extension host's own interpreter is an Electron binary
  // and behaves as Node only when told to, and nothing it inherits says so.
  const { server } = await issuer(t);

  const injection = injectShim(
    eligible(server, {
      launch: {
        args: ["/ext/dist/mcp-shim.cjs"],
        env: { ELECTRON_RUN_AS_NODE: "1", AGENT_CONDUCTOR_SESSION_SECRET: "forged" },
      },
    }),
  );
  t.after(() => injection.revoke());

  const environment = stdio(injection.servers[0] as acp.McpServer).env as Array<{
    name: string;
    value: string;
  }>;
  assert.deepEqual(
    environment.find((entry) => entry.name === "ELECTRON_RUN_AS_NODE"),
    { name: "ELECTRON_RUN_AS_NODE", value: "1" },
  );
  // Exactly one, and not the one the caller asked for. Which of two entries
  // sharing a name reaches the process is the *Agent's* decision — ACP describes
  // a list, not a map — so an ordering rule here would be a rule enforced in
  // somebody else's code. There is nothing to choose between instead.
  const secrets = environment.filter((entry) => entry.name === "AGENT_CONDUCTOR_SESSION_SECRET");
  assert.equal(secrets.length, 1, "the capability variable appears more than once");
  assert.notEqual(secrets[0]?.value, "forged");
});

test("the grant is what the issuer decided, and nothing a caller could widen", async (t) => {
  const { server, granted } = await issuer(t);

  const injection = injectShim(
    eligible(server, {
      depth: 0,
      sessionKey: "parent-key",
      parentSessionKey: "grandparent-key",
      roots: ["/workspace", "/other"],
      now: () => 1_000,
      lifetimeMs: 60_000,
    }),
  );
  t.after(() => injection.revoke());

  const grant = granted[0];
  assert.ok(grant);
  assert.equal(grant.sessionId, "parent-key");
  assert.equal(grant.parentSessionId, "grandparent-key");
  assert.equal(grant.depth, 0);
  assert.deepEqual([...grant.roots], ["/workspace", "/other"]);
  assert.equal(grant.expiresAtMs, 61_000);
  assert.deepEqual([...grant.methods], [...ORCHESTRATION_METHODS]);
});

test("revoking the injection withdraws the capability it minted", async (t) => {
  const { server } = await issuer(t);
  const revoked: string[] = [];
  const watched: ShimInjectionRequest["issuer"] = {
    address: server.address,
    issue: (grant) => {
      const issued = server.issue(grant);
      return { secret: issued.secret, revoke: () => {
        revoked.push(grant.sessionId);
        issued.revoke();
      } };
    },
  };

  injectShim(eligible(watched)).revoke();

  assert.deepEqual(revoked, ["parent-key"]);
});
