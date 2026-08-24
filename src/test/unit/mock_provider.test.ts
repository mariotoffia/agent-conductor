import assert from "node:assert/strict";
import test from "node:test";
import { MOCK_COMPLETION, MOCK_MODEL, startMockProvider } from "../mock-provider.js";

/**
 * The model endpoint a live run points DeepSeek Harness at, so that run proves
 * this Client can drive a CLI rather than whether somebody's server was up.
 */

test("it answers a completion, and says it was asked", async () => {
  const provider = await startMockProvider();
  try {
    const response = await fetch(`${provider.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hi" }] }),
    });
    const completion = (await response.json()) as {
      choices: { message: { content: string }; finish_reason: string }[];
    };

    assert.equal(response.status, 200);
    assert.equal(completion.choices[0]?.message.content, MOCK_COMPLETION);
    assert.equal(completion.choices[0]?.finish_reason, "stop");
    // A Turn that never reached the model fails differently from one the model
    // answered badly, so the count is worth having.
    assert.equal(provider.completions, 1);
  } finally {
    await provider.close();
  }
});

test("it lists the one model it serves", async () => {
  const provider = await startMockProvider();
  try {
    const listed = (await (await fetch(`${provider.url}/models`)).json()) as { data: { id: string }[] };

    assert.deepEqual(listed.data.map((model) => model.id), [MOCK_MODEL]);
    assert.equal(provider.completions, 0, "listing models is not completing anything");
  } finally {
    await provider.close();
  }
});

test("a stream is answered as events, ending with the sentinel", async () => {
  // The CLI this exists for streams. A whole JSON body handed to a client
  // waiting for events is a turn that hangs or dies on the parse.
  const provider = await startMockProvider();
  try {
    const response = await fetch(`${provider.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MOCK_MODEL, stream: true, messages: [] }),
    });
    const stream = await response.text();

    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(stream, new RegExp(`"content":"${MOCK_COMPLETION}"`));
    assert.match(stream, /"finish_reason":"stop"/);
    assert.match(stream, /data: \[DONE\]/);
    assert.equal(provider.completions, 1, "a streamed answer is a completion too");
  } finally {
    await provider.close();
  }
});

test("its answer is what the caller asked it to say", async () => {
  const provider = await startMockProvider("something else");
  try {
    const completion = (await (
      await fetch(`${provider.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MOCK_MODEL, messages: [] }),
      })
    ).json()) as { choices: { message: { content: string } }[] };

    assert.equal(completion.choices[0]?.message.content, "something else");
  } finally {
    await provider.close();
  }
});
