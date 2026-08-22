import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  isSmokeReply,
  MAX_SMOKE_REPLY_CHARS,
  openProbeSession,
  PROBE_DEADLINE_MS,
  refuseProbePermission,
  resolveRuntime,
  type ResolvedRuntime,
} from "../../core/index.js";
import { recordingProcessPort, type SentLine } from "../acp-harness.js";
import { executable, mockRuntime } from "../participant-fixtures.js";
import type { SpawnRequest } from "../../core/index.js";

/**
 * The Probe Session: the throwaway Session the connection wizard opens to check
 * authentication, read Config Options, and run the Smoke Test.
 *
 * It runs against the real mock Agent process, because what is being protected
 * is what actually reaches the wire — which capabilities were advertised, which
 * directory the Agent was started in, and how long a silent one is waited for.
 */

const probeTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 20_000 }, fn);

/** The mock Agent as a Runtime whose identity the wizard has just approved. */
async function approved(mode?: string, trusted = true): Promise<ResolvedRuntime> {
  const spec = mockRuntime(mode);
  const untrusted = await resolveRuntime(spec, { executable });
  if (!trusted) return untrusted;
  return resolveRuntime(spec, { executable, trust: { fingerprint: untrusted.fingerprint } });
}

function recording() {
  const spawns: SpawnRequest[] = [];
  const sent: SentLine[] = [];
  return { spawns, sent, ports: { process: recordingProcessPort(spawns, sent) } };
}

probeTest("the smoke test reports the agent's own reply", async () => {
  const ports = recording();
  const probe = await openProbeSession({ runtime: await approved(), ports: ports.ports });
  try {
    const smoke = await probe.smoke();

    assert.equal(smoke.ok, true, `smoke reply was ${JSON.stringify(smoke.reply)}`);
    assert.match(smoke.reply, /OK/);
    assert.equal(smoke.stopReason, "end_turn");
  } finally {
    await probe.close();
  }
});

probeTest("an agent that answers something else fails the smoke test", async () => {
  const ports = recording();
  const probe = await openProbeSession({ runtime: await approved("chatty"), ports: ports.ports });
  try {
    const smoke = await probe.smoke();

    assert.equal(smoke.ok, false, "any reply but OK must fail the step");
    assert.match(smoke.reply, /Mock response/);
  } finally {
    await probe.close();
  }
});

probeTest("a probe runs in a temporary directory and removes it afterwards", async () => {
  const ports = recording();
  const probe = await openProbeSession({ runtime: await approved(), ports: ports.ports });

  assert.equal(existsSync(probe.directory), true, "the probe directory must exist while probing");
  assert.ok(probe.directory.startsWith(tmpdir()), `${probe.directory} is not a temporary directory`);
  assert.notEqual(probe.directory, process.cwd());
  assert.equal(ports.spawns[0]?.cwd, probe.directory, "the agent must be started in it");
  assert.equal(ports.sent.find((line) => line.method === "session/new")?.params?.cwd, probe.directory);

  await probe.close();

  assert.equal(existsSync(probe.directory), false, "the probe directory must not outlive the probe");
});

probeTest("a probe advertises no filesystem or terminal capability", async () => {
  const ports = recording();
  const probe = await openProbeSession({ runtime: await approved(), ports: ports.ports });
  await probe.close();

  const capabilities = ports.sent.find((line) => line.method === "initialize")?.params
    ?.clientCapabilities as
    | { fs?: Record<string, boolean>; terminal?: boolean; elicitation?: unknown }
    | undefined;
  assert.deepEqual(capabilities?.fs, { readTextFile: false, writeTextFile: false });
  assert.equal(capabilities?.terminal, false);
  // Withheld too: an Agent that could ask a question could ask for a secret.
  assert.equal(capabilities?.elicitation, undefined);
});

test("an answer spread over many lines is not the one word that was asked for", () => {
  // `\W` matches a newline, so a reply of three hundred blank lines and an "ok"
  // trims to something the pattern accepts — and the wizard reports it on the
  // Agent's own first line, pushing the Read-back out of the notification.
  assert.equal(isSmokeReply(`${"-\n".repeat(300)}ok`), false);
  assert.equal(isSmokeReply("OK\nand another thing"), false);
  assert.equal(isSmokeReply("  OK.  "), true, "punctuation and space around it still answer");
});

test("a probe refuses a permission request rather than leaving it open", () => {
  const refused = refuseProbePermission({
    sessionId: "probe",
    toolCall: { toolCallId: "t", title: "Write a file", kind: "edit", status: "pending" },
    options: [
      { kind: "allow_once", name: "Allow", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ],
  });

  assert.deepEqual(refused.outcome, { outcome: "selected", optionId: "reject" });
});

test("a probe cancels a permission request that offers no refusal", () => {
  const refused = refuseProbePermission({
    sessionId: "probe",
    toolCall: { toolCallId: "t", title: "Write a file", kind: "edit", status: "pending" },
    options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
  });

  assert.deepEqual(refused.outcome, { outcome: "cancelled" });
});

probeTest("a silent runtime fails the probe on the probe deadline", async () => {
  const ports = recording();
  assert.ok(PROBE_DEADLINE_MS < DEFAULT_SETUP_TIMEOUT_MS, "a probe stage waits less than a session");

  const started = Date.now();
  await assert.rejects(
    openProbeSession({
      runtime: await approved("silent-session-new"),
      ports: ports.ports,
      deadlineMs: 3_000,
    }),
    // Whichever setup request it was waiting on, it was waiting on the probe's
    // deadline rather than a session's.
    /within 3000ms/,
  );

  assert.ok(
    Date.now() - started < DEFAULT_SETUP_TIMEOUT_MS / 2,
    "the wizard step must not wait out a session's setup deadline",
  );
});

probeTest("a probe that never opens leaves no directory behind", async () => {
  const ports = recording();
  // A temporary directory of this test's own: `os.tmpdir()` is read per call
  // from the environment, and the shared one has probes from other test files
  // appearing and vanishing in it while this runs.
  const root = await mkdtemp(join(tmpdir(), "probe-cleanup-"));
  // Restored key by key: replacing `process.env` wholesale does not reliably
  // put back what `os.tmpdir()` reads, and every later test in this file would
  // then make its directories inside one this test has removed.
  const names = ["TMPDIR", "TMP", "TEMP"] as const;
  const restore = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = root;
  try {
    await assert.rejects(
      openProbeSession({
        runtime: await approved("crash-on-session-new"),
        ports: ports.ports,
        deadlineMs: 2_000,
      }),
    );

    // Named, not counted: the agent process runs under a loader that keeps its
    // own cache here too, and that is not the probe's to remove.
    const left = (await readdir(root)).filter((entry) => entry.startsWith("agent-conductor-probe-"));
    assert.deepEqual(left, [], "a failed probe must clean up after itself");
  } finally {
    for (const [name, value] of restore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

probeTest("an agent that will not stop talking does not become the host's memory", async () => {
  const ports = recording();
  const probe = await openProbeSession({ runtime: await approved("flood"), ports: ports.ports });
  try {
    const smoke = await probe.smoke();

    // UBIQUITOUS (Smoke Test): the Agent must answer it and nothing else. What
    // is kept is bounded, so a CLI that answers with a whole file is a failed
    // step rather than an extension host holding the file.
    assert.equal(smoke.ok, false, "answering with more than was asked is a failed step");
    assert.ok(smoke.reply.length <= MAX_SMOKE_REPLY_CHARS, `kept ${smoke.reply.length} characters`);
    // The cap is what makes that true: without it the reply grows with whatever
    // the Agent sends, and the step would still be reported as a failure by the
    // wording alone.
    assert.ok(smoke.reply.length > 0, "the start of the answer is still reported");
  } finally {
    await probe.close();
  }
});

probeTest("an answer that is right and then keeps going is still not an answer", async () => {
  const ports = recording();
  const probe = await openProbeSession({ runtime: await approved("overflow-after-ok"), ports: ports.ports });
  try {
    const smoke = await probe.smoke();

    // What was kept trims to exactly "OK", so only having noticed that more
    // followed makes this the failure it is (UBIQUITOUS: Smoke Test).
    assert.equal(smoke.reply, "OK");
    assert.equal(smoke.ok, false, "the agent answered it and then some");
  } finally {
    await probe.close();
  }
});

probeTest("a runtime whose identity is not approved is never probed", async () => {
  const ports = recording();

  await assert.rejects(
    openProbeSession({ runtime: await approved(undefined, false), ports: ports.ports }),
    /not trusted/,
  );

  assert.equal(ports.spawns.length, 0, "an unapproved identity must not start a process");
});

test("a reply padded with words in another script is not an answer either", () => {
  // `\\W` is the ASCII complement, so every letter outside it counted as padding
  // and a paragraph answered a one-word question. The Smoke Test asks for `OK`
  // and nothing else, in any script (UBIQUITOUS.md: Smoke Test).
  assert.equal(isSmokeReply("Привет всё хорошо ok"), false);
  assert.equal(isSmokeReply("好的 ok"), false);
  assert.equal(isSmokeReply("OK!"), true, "punctuation around it is still an answer");
  assert.equal(isSmokeReply(" ok "), true);
});

probeTest("a probe refuses the agent's own permission request rather than asking", async () => {
  // The wizard is not a place to approve an Agent's tool call: the probe runs in
  // a temporary directory with nothing to write to, and the person in front of
  // it is answering questions about connecting, not about edits. Tested through
  // a live probe, because `refuseProbePermission` being correct says nothing
  // about whether the probe is wired to it.
  const ports = recording();
  const probe = await openProbeSession({ runtime: await approved("stray-permission"), ports: ports.ports });
  try {
    await probe.smoke();

    // `stray-permission` ends its turn without waiting for its own answer, so the
    // request arrives after `smoke()` resolves — waited for, not assumed, since a
    // fixed delay is a guess about how loaded the machine is.
    const outcomes = (): Record<string, unknown>[] =>
      ports.sent
        .map((line) => line.result?.outcome)
        .filter((outcome): outcome is Record<string, unknown> => outcome !== undefined);
    for (let left = 200; left > 0 && outcomes().length === 0; left -= 1) {
      await new Promise((wake) => setTimeout(wake, 25));
    }
    const answers = outcomes();
    assert.ok(answers.length > 0, "the agent never asked for permission");
    assert.deepEqual(
      answers,
      answers.map(() => ({ outcome: "cancelled" })),
      `a probe answered with something other than a refusal: ${JSON.stringify(answers)}`,
    );
  } finally {
    await probe.close();
  }
});
