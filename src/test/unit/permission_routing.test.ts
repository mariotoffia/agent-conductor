import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import {
  clientOperation,
  CLIENT_OPERATIONS,
  PermissionRouter,
  type ConsentHost,
  type PermissionPolicy,
} from "../../vscode/permissions.js";

/** Records what the user was asked, and answers with a scripted choice. */
function consent(answers: (string | undefined)[]): ConsentHost & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    get asked() {
      return asked;
    },
    async ask(message, _options, ...choices) {
      asked.push(message);
      const answer = answers.shift();
      return answer && choices.includes(answer) ? answer : undefined;
    },
  };
}

const policy = (over: Partial<PermissionPolicy> = {}): PermissionPolicy => ({
  autoAllow: [],
  autoReject: [],
  rememberAlwaysChoices: true,
  ...over,
});

test("every client-owned method has an operation key, and nothing else does", () => {
  assert.equal(clientOperation(acp.methods.client.fs.readTextFile), "fs.read");
  assert.equal(clientOperation(acp.methods.client.fs.writeTextFile), "fs.write");
  assert.equal(clientOperation(acp.methods.client.terminal.create), "terminal.spawn");
  assert.equal(clientOperation(acp.methods.client.terminal.waitForExit), "terminal.wait");
  assert.equal(clientOperation(acp.methods.client.terminal.kill), "terminal.kill");
  assert.equal(clientOperation(acp.methods.client.terminal.release), "terminal.release");

  // An Agent's own tool call is not a Client Operation: nothing the Client
  // performs, so no key an automatic policy could be written against.
  assert.equal(clientOperation(acp.methods.client.session.requestPermission), undefined);
  assert.equal(clientOperation("fs/read_text_file_v2"), undefined);
});

test("an auto-allowed operation runs without asking", async () => {
  const host = consent([]);
  const router = new PermissionRouter(policy({ autoAllow: ["fs.read"] }), host);

  assert.equal(await router.authorize("fs.read", "/work/repo/a.ts"), true);
  assert.deepEqual(host.asked, []);
});

test("an auto-rejected operation is refused without asking, even when also allowed", async () => {
  const host = consent([]);
  // config resolves this contradiction before it gets here; the router must not
  // depend on that having happened.
  const router = new PermissionRouter(
    policy({ autoAllow: ["terminal.spawn"], autoReject: ["terminal.spawn"] }),
    host,
  );

  assert.equal(await router.authorize("terminal.spawn", "rm -rf /"), false);
  assert.deepEqual(host.asked, []);
});

test("an operation under no policy asks, and a dismissed dialog is a refusal", async () => {
  const host = consent([undefined]);
  const router = new PermissionRouter(policy(), host);

  assert.equal(await router.authorize("fs.write", "/work/repo/a.ts"), false);
  assert.equal(host.asked.length, 1);
});

test("an always answer holds for the rest of the session, once", async () => {
  const host = consent(["Always allow"]);
  const router = new PermissionRouter(policy(), host);

  assert.equal(await router.authorize("fs.write", "/work/repo/a.ts"), true);
  assert.equal(await router.authorize("fs.write", "/work/repo/b.ts"), true);
  assert.equal(host.asked.length, 1, "the remembered answer must not ask again");
});

test("an always rejection is remembered too", async () => {
  const host = consent(["Always reject"]);
  const router = new PermissionRouter(policy(), host);

  assert.equal(await router.authorize("terminal.spawn", "npm test"), false);
  assert.equal(await router.authorize("terminal.spawn", "npm test"), false);
  assert.equal(host.asked.length, 1);
});

test("with remembering off, every turn asks again", async () => {
  const host = consent(["Always allow", "Allow"]);
  const router = new PermissionRouter(policy({ rememberAlwaysChoices: false }), host);

  assert.equal(await router.authorize("fs.write", "/work/repo/a.ts"), true);
  assert.equal(await router.authorize("fs.write", "/work/repo/a.ts"), true);
  assert.equal(host.asked.length, 2);
});

// ---------------------------------------------------------------------------
// An Agent's own tool call. ToolKind is the Agent's classification of itself.
// ---------------------------------------------------------------------------

const toolCall = (over: Partial<acp.ToolCallUpdate> = {}): acp.RequestPermissionRequest => ({
  sessionId: "s1",
  toolCall: { toolCallId: "t1", title: "Read package.json", kind: "read", ...over },
  options: [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
});

test("an auto-allowed client operation never auto-allows an agent tool of the same kind", async () => {
  const host = consent([undefined]);
  // fs.read is auto-allowed for the Client's own reads. A tool call the Agent
  // labels `read` is not that operation, and the label is the Agent's to choose.
  const router = new PermissionRouter(policy({ autoAllow: ["fs.read"] }), host);

  const answer = await router.requestPermission(toolCall());

  assert.deepEqual(answer, { outcome: { outcome: "cancelled" } });
  assert.equal(host.asked.length, 1, "an agent tool call is always asked about");
});

test("the chosen option comes back by its id", async () => {
  const router = new PermissionRouter(policy(), consent(["Allow"]));

  assert.deepEqual(await router.requestPermission(toolCall()), {
    outcome: { outcome: "selected", optionId: "yes" },
  });
});

test("a tool kind cannot change the decision, only the description", async () => {
  const asked: string[] = [];
  const host: ConsentHost = {
    async ask(_message, options) {
      asked.push(options.detail);
      return undefined;
    },
  };
  const router = new PermissionRouter(policy({ autoAllow: [...CLIENT_OPERATIONS] }), host);

  await router.requestPermission(toolCall({ kind: "read" }));
  await router.requestPermission(toolCall({ kind: "execute" }));

  assert.equal(asked.length, 2, "both were asked about");
  assert.match(asked[0], /read/);
  assert.match(asked[1], /execute/);
});

test("an agent that offers no options gets a cancelled outcome rather than consent", async () => {
  const host = consent(["Allow"]);
  const router = new PermissionRouter(policy(), host);

  const answer = await router.requestPermission({ ...toolCall(), options: [] });

  assert.deepEqual(answer, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(host.asked, []);
});

test("options with the same name still map back to their own ids", async () => {
  const host = consent(["Allow (2)"]);
  const router = new PermissionRouter(policy(), host);

  const answer = await router.requestPermission({
    ...toolCall(),
    options: [
      { optionId: "first", name: "Allow", kind: "allow_once" },
      { optionId: "second", name: "Allow", kind: "allow_always" },
    ],
  });

  assert.deepEqual(answer, { outcome: { outcome: "selected", optionId: "second" } });
});

test("a follow-up to an authorized operation is policy-only: silence is not a question", () => {
  const host = consent([]);
  const router = new PermissionRouter(policy({ autoReject: ["terminal.kill"] }), host);

  // Consent for a command is given when it starts. Asking again to wait for it,
  // or to clean it up, is the noise that teaches people to click through.
  assert.equal(router.permits("terminal.wait"), true);
  assert.equal(router.permits("terminal.release"), true);
  assert.equal(router.permits("terminal.kill"), false, "an explicit rejection still holds");
  assert.deepEqual(host.asked, []);
});
