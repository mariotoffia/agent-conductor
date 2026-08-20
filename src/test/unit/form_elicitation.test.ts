import assert from "node:assert/strict";
import { test } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { FormElicitor, type FormHost } from "../../vscode/elicitation.js";

/** Answers each prompt in turn; `undefined` is the user dismissing the input. */
function form(answers: (string | string[] | undefined)[]): FormHost & { readonly prompts: string[] } {
  const prompts: string[] = [];
  const next = (): string | string[] | undefined => answers.shift();
  return {
    get prompts() {
      return prompts;
    },
    async input(options) {
      prompts.push(options.prompt);
      const answer = next();
      if (typeof answer !== "string") return undefined;
      const complaint = options.validateInput?.(answer);
      assert.equal(complaint, undefined, `the form should not have offered: ${complaint}`);
      return answer;
    },
    async pick(items, options) {
      prompts.push(options.placeHolder);
      const answer = next();
      return items.find((item) => item.label === answer);
    },
    async pickMany(items, options) {
      prompts.push(options.placeHolder);
      const answer = next();
      return Array.isArray(answer) ? items.filter((item) => answer.includes(item.label)) : undefined;
    },
  };
}

const ask = (
  properties: Record<string, acp.ElicitationPropertySchema>,
  required?: string[],
): acp.CreateElicitationRequest => ({
  mode: "form",
  sessionId: "s1",
  message: "The agent has a question",
  requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
});

test("a filled-in form comes back as accepted content", async () => {
  const host = form(["release/2.0", "staging", "Yes", "3"]);
  const elicitor = new FormElicitor(host);

  const answer = await elicitor.createElicitation(
    ask({
      branch: { type: "string", title: "Branch" },
      environment: { type: "string", title: "Environment", enum: ["staging", "production"] },
      force: { type: "boolean", title: "Force" },
      retries: { type: "integer", title: "Retries" },
    }),
  );

  assert.deepEqual(answer, {
    action: "accept",
    content: { branch: "release/2.0", environment: "staging", force: true, retries: 3 },
  });
});

test("dismissing any input cancels the whole elicitation", async () => {
  const host = form(["release/2.0", undefined]);
  const elicitor = new FormElicitor(host);

  const answer = await elicitor.createElicitation(
    ask({
      branch: { type: "string", title: "Branch" },
      environment: { type: "string", title: "Environment", enum: ["staging", "production"] },
    }),
  );

  assert.deepEqual(answer, { action: "cancel" });
});

test("an elicitation this client never advertised is declined, not guessed at", async () => {
  const host = form([]);
  const elicitor = new FormElicitor(host);

  const answer = await elicitor.createElicitation({
    mode: "url",
    sessionId: "s1",
    elicitationId: "e1",
    message: "Sign in",
    url: "https://example.invalid/login",
  });

  assert.deepEqual(answer, { action: "decline" });
  assert.deepEqual(host.prompts, [], "nothing was put in front of the user");
});

test("a required field with no input for it declines rather than inventing a value", async () => {
  const host = form([]);
  const elicitor = new FormElicitor(host);

  const answer = await elicitor.createElicitation(
    ask({ mystery: { type: "geo-coordinate" } as unknown as acp.ElicitationPropertySchema }, ["mystery"]),
  );

  assert.deepEqual(answer, { action: "decline" });
});

test("an optional field with no input for it is simply left out", async () => {
  const host = form(["release/2.0"]);
  const elicitor = new FormElicitor(host);

  const answer = await elicitor.createElicitation(
    ask({
      branch: { type: "string", title: "Branch" },
      mystery: { type: "geo-coordinate" } as unknown as acp.ElicitationPropertySchema,
    }),
  );

  assert.deepEqual(answer, { action: "accept", content: { branch: "release/2.0" } });
});

test("a multi-select answers with the values behind the labels the user read", async () => {
  const host = form([["Unit tests", "Linting"]]);
  const elicitor = new FormElicitor(host);

  const answer = await elicitor.createElicitation(
    ask({
      checks: {
        type: "array",
        title: "Checks",
        items: {
          anyOf: [
            { const: "test", title: "Unit tests" },
            { const: "lint", title: "Linting" },
            { const: "types", title: "Type checking" },
          ],
        },
      } as unknown as acp.ElicitationPropertySchema,
    }),
  );

  assert.deepEqual(answer, { action: "accept", content: { checks: ["test", "lint"] } });
});

test("a number field refuses what is not a number, before the agent ever sees it", async () => {
  let validate: ((value: string) => string | undefined) | undefined;
  const host: FormHost = {
    async input(options) {
      validate = options.validateInput;
      return "3";
    },
    async pick() {
      return undefined;
    },
    async pickMany() {
      return undefined;
    },
  };

  await new FormElicitor(host).createElicitation(
    ask({ retries: { type: "integer", title: "Retries", minimum: 1, maximum: 5 } }),
  );

  assert.match(validate?.("abc") ?? "", /number/);
  assert.match(validate?.("2.5") ?? "", /whole number/);
  assert.match(validate?.("9") ?? "", /at most 5/);
  assert.equal(validate?.("3"), undefined);
});

test("a pattern the agent sends is never compiled straight into the input box", async () => {
  let validate: ((value: string) => string | undefined) | undefined;
  const host: FormHost = {
    async input(options) {
      validate = options.validateInput;
      return "anything";
    },
    async pick() {
      return undefined;
    },
    async pickMany() {
      return undefined;
    },
  };

  // A pattern JavaScript cannot compile — an agent using another regex dialect
  // must not throw out of a keystroke handler in the editor.
  const answer = await new FormElicitor(host).createElicitation(
    ask({ branch: { type: "string", title: "Branch", pattern: "(?P<name>x" } }),
  );

  assert.deepEqual(answer, { action: "accept", content: { branch: "anything" } });
  assert.equal(validate?.("whatever"), undefined, "an uncompilable pattern constrains nothing");
});

test("an agent cannot put an unbounded string in front of the user", async () => {
  const seen: string[] = [];
  const host: FormHost = {
    async input(options) {
      seen.push(options.title, options.prompt);
      return "x";
    },
    async pick() {
      return undefined;
    },
    async pickMany() {
      return undefined;
    },
  };

  await new FormElicitor(host).createElicitation({
    mode: "form",
    sessionId: "s1",
    message: "M".repeat(500_000),
    requestedSchema: {
      type: "object",
      properties: { branch: { type: "string", title: "T".repeat(500_000) } },
    },
  });

  for (const text of seen) assert.ok(text.length < 5_000, `unbounded string reached the user: ${text.length}`);
});

test("a required field the schema never described is not an accept", async () => {
  const host = form(["release/2.0"]);

  const answer = await new FormElicitor(host).createElicitation(
    ask({ branch: { type: "string", title: "Branch" } }, ["branch", "environment"]),
  );

  assert.deepEqual(answer, { action: "decline" });
});

test("an agent's pattern is shown to the user, never run by the client", async () => {
  let validate: ((value: string) => string | undefined) | undefined;
  let shown = "";
  const host: FormHost = {
    async input(options) {
      validate = options.validateInput;
      shown = options.prompt;
      return "anything";
    },
    async pick() {
      return undefined;
    },
    async pickMany() {
      return undefined;
    },
  };

  await new FormElicitor(host).createElicitation(
    // Compilable, and catastrophic: running it on a rejecting input takes tens
    // of seconds — on the UI thread, per keystroke.
    ask({ branch: { type: "string", title: "Branch", pattern: "^(a+)+$" } }),
  );

  assert.equal(validate?.("a".repeat(30) + "!"), undefined, "the client ran the agent's regex");
  assert.match(shown, /\^\(a\+\)\+\$/, "the user cannot meet a rule they are not shown");
});

test("a required name that is only inherited is not a field the schema described", async () => {
  const host = form(["release/2.0"]);

  const answer = await new FormElicitor(host).createElicitation(
    ask({ branch: { type: "string", title: "Branch" } }, ["branch", "toString"]),
  );

  assert.deepEqual(answer, { action: "decline" });
});

test("a choice list too long to put in front of someone is not answered at random", async () => {
  const host = form([]);

  const answer = await new FormElicitor(host).createElicitation(
    ask(
      { region: { type: "string", title: "Region", enum: Array.from({ length: 5_000 }, (_u, i) => `r${i}`) } },
      ["region"],
    ),
  );

  // Same rule as everywhere else here: a question this client cannot put to a
  // person is declined, never turned into a free-text box that accepts anything.
  assert.deepEqual(answer, { action: "decline" });
  assert.deepEqual(host.prompts, []);
});

test("an answer that is not a number never reaches the agent as one", async () => {
  // A host that ignores its own validation: the content must still be usable.
  const host: FormHost = {
    async input() {
      return "not a number";
    },
    async pick() {
      return undefined;
    },
    async pickMany() {
      return undefined;
    },
  };

  const answer = await new FormElicitor(host).createElicitation(
    ask({ retries: { type: "integer", title: "Retries" } }),
  );

  assert.deepEqual(answer, { action: "cancel" });
});
