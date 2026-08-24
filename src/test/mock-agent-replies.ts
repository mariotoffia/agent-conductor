import type * as acp from "@agentclientprotocol/sdk";

/**
 * Mock Agent scenarios whose whole behaviour is one spoken reply — in one
 * chunk, or in several, since how a CLI splits its stream is a behaviour too.
 *
 * Kept apart from the rest of the prompt handler because this is where a
 * scenario gets added: each is what the Agent says and nothing else, and
 * what they have in common is that it is chosen to be hostile to whatever
 * reads it — a credential echoed back, padding built out of the characters
 * that sealing rewrites, a banner fused onto the answer the way Copilot
 * fuses one, an answer long enough to fill a report.
 */

/** One spoken chunk, as the prompt handler speaks one. */
export type Speak = (text: string) => Promise<void>;

/** What the Agent was started with, which several of these echo. */
const secret = (): string => process.env.MOCK_SECRET ?? "";

const REPLIES: Record<string, () => string | string[]> = {
  // The shape a real Copilot answers in: an informational banner, then the
  // answer as a chunk of its own, fused with no line ending between them.
  "banner-then-ok": () => ["Info: Disabled tools: read_agent, task", "OK"],
  // The answer cut mid-word by chunking, which any stream may do.
  "split-ok": () => ["O", "K"],
  // The banner and the answer inside one chunk, separated only by a newline.
  "banner-line-ok": () => "Info: model ready\nOK",
  // Acceptable, at length, in the credential it was started with — which
  // redaction replaces with something longer than the value it removes.
  "echo-secret": () => `${secret().repeat(400)}ok`,
  // Acceptable too, in padding built from characters that are neither letters
  // nor numbers and that overlap the rules that seal it.
  "chained-ok": () => `${"_@_.@_.".repeat(400)}ok`,
  // Acceptable, and long enough to fill the report it is quoted into.
  "padded-ok": () => `${".".repeat(2_100)}ok`,
  // Acceptable, and ending in an override that draws the rest of the report —
  // the Read-back, and the mismatch in it — backwards.
  "bidi-ok": () => "OK\u202e",
  // Its credential with the whitespace inside it written differently, as a CLI
  // that re-wraps what it prints does.
  "respace-secret": () => `configured with ${secret().replace(/ /g, "\n  ")}`,
  // Its own environment, as a CLI that echoes its configuration does.
  "speak-secret": () => `configured with ${secret()}. retrying`,
};

/**
 * Answers the prompt if this mode is one of these, and says so; `undefined`
 * leaves the turn to the handler that called this.
 */
export async function spokenReply(
  mode: string,
  speak: Speak,
): Promise<acp.PromptResponse | undefined> {
  const reply = REPLIES[mode];
  if (!reply) return undefined;
  const said = reply();
  for (const chunk of Array.isArray(said) ? said : [said]) await speak(chunk);
  return { stopReason: "end_turn" };
}
