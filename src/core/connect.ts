import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { message } from "./failures.js";
import { resolveRuntime, trustedLaunch, type ResolveRuntimeOptions } from "./runtimeRegistry.js";
import { ConductorSession } from "./session.js";
import { DEFAULT_CANCEL_GRACE_MS } from "./sessionSpec.js";
import type { ResolvedRuntime, RuntimeSpec, SessionPorts } from "./types.js";

/**
 * The core half of connecting a Runtime: finding out whether it can launch at
 * all, and whether it answers.
 *
 * Both halves are here because both exist for the connection wizard and neither
 * belongs in the UI layer — this way the whole of "does this CLI work" can be
 * driven against a real Agent process under plain Node.
 *
 * The Probe Session is the throwaway Session the wizard opens to find
 * out whether a Runtime is authenticated, what Config Options it exposes, and
 * whether one short Turn really streams back (`UBIQUITOUS.md`: Probe Session,
 * Smoke Test).
 *
 * Three things make it a probe rather than an ordinary Session:
 *
 * - It runs in a temporary directory of its own, so an Agent that writes where
 *   it was started does not write into the user's repository. That is a smaller
 *   blast radius, not a sandbox — an Agent runs with the user's privileges and
 *   can address any path (ADR-0007).
 * - It is given no filesystem, terminal, or elicitation port, so none of those
 *   capabilities is advertised at all: the Agent is never told this Client will
 *   read, write, or run anything on its behalf. A permission request it asks
 *   anyway is refused rather than left open.
 * - Every wait is bounded by the probe's own short deadline instead of a
 *   Session's, so a Runtime that goes silent fails the wizard step in seconds
 *   rather than after a full session-setup wait.
 */

/** One catalog entry measured against the machine: launchable, or why not. */
export interface RuntimeDetection {
  spec: RuntimeSpec;
  /** Absent when this Runtime cannot launch as configured. */
  runtime?: ResolvedRuntime;
  /** What is wrong with it, in the words `resolveRuntime` refused it with. */
  problem?: string;
}

/**
 * Resolves every Runtime the user could pick, keeping the refusals.
 *
 * The wizard needs both halves: a Runtime that cannot launch is still worth
 * listing, because "not found — install it" is an answer, and one missing from
 * the list silently is not.
 */
export async function detectRuntimes(
  specs: RuntimeSpec[],
  options: ResolveRuntimeOptions,
): Promise<RuntimeDetection[]> {
  return Promise.all(
    specs.map(async (spec) => {
      try {
        return { spec, runtime: await resolveRuntime(spec, options) };
      } catch (error) {
        return { spec, problem: message(error) };
      }
    }),
  );
}

/**
 * Setup Deadline and Stall Limit for a probe stage.
 *
 * Deliberately far below `DEFAULT_SETUP_TIMEOUT_MS`: somebody is sitting in
 * front of the wizard watching it, and a Runtime that has not answered a
 * handshake by now is one they need to hear about rather than wait for.
 */
export const PROBE_DEADLINE_MS = 20_000;

/** The Smoke Test prompt. Short, and its answer is checkable without a model. */
export const SMOKE_PROMPT = "Reply with exactly: OK";

/**
 * How much of a Smoke Test answer is kept.
 *
 * The step asks for one word, so anything past this is already a failure, and
 * an Agent that answers with a whole file must not become the extension host's
 * memory — every Update restarts the Stall Limit, so a stream that never stops
 * is never silent enough to be cut off (UBIQUITOUS: Smoke Test).
 */
export const MAX_SMOKE_REPLY_CHARS = 4_096;

export interface ProbeRequest {
  /** An approved identity; anything else is refused before a process exists. */
  runtime: ResolvedRuntime;
  /** Values already resolved from SecretStorage. Never logged (ADR-0010). */
  secretEnvironment?: Record<string, string>;
  /** Host ports the probe process runs on; the rest are withheld on purpose. */
  ports?: Pick<SessionPorts, "process" | "log" | "clock">;
  /** Overrides `PROBE_DEADLINE_MS` for every wait this probe makes. */
  deadlineMs?: number;
}

export interface SmokeResult {
  /** The Agent answered the Smoke Test and nothing else. */
  ok: boolean;
  /** What it actually said, so the wizard can show it either way. */
  reply: string;
  stopReason: string;
}

export interface Probe {
  session: ConductorSession;
  /** The temporary directory the Agent was started in. Removed by `close`. */
  directory: string;
  /** One short Turn that proves streaming — and, with Read-back, the selection. */
  smoke(): Promise<SmokeResult>;
  /** Ends the Session and removes the directory. Idempotent through disposal. */
  close(): Promise<void>;
}

/**
 * The probe's answer to any permission request.
 *
 * A refusal the Agent offered is preferred to `cancelled`: cancelled says the
 * question went unanswered, and an Agent that reads it as "ask again later" is
 * entitled to. Where nothing refusable is offered there is no honest way to say
 * no, so the request is cancelled instead of being answered with an allow the
 * user never gave (ADR-0007).
 */
export function refuseProbePermission(
  request: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  const refusal = request.options.find(
    (option) => option.kind === "reject_once" || option.kind === "reject_always",
  );
  return refusal
    ? { outcome: { outcome: "selected", optionId: refusal.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/**
 * Opens a Probe Session on an approved Runtime.
 *
 * The trust gate comes first, before a directory or a process exists: probing is
 * starting an Agent, and an identity nobody approved must not be started for any
 * reason (ADR-0007).
 */
export async function openProbeSession(request: ProbeRequest): Promise<Probe> {
  const { runtime } = request;
  const launch = trustedLaunch(runtime);
  const deadline = request.deadlineMs ?? PROBE_DEADLINE_MS;
  const directory = await mkdtemp(join(tmpdir(), "agent-conductor-probe-"));
  const remove = (): Promise<void> => rm(directory, { recursive: true, force: true });

  let reply = "";
  /** What was said, chunk by chunk: the stream's own segmentation is one of the
   *  two ways an answer can stand apart from a banner (UBIQUITOUS: Smoke Test). */
  const chunks: string[] = [];
  /** The Agent said more than the step asked for, whatever the start of it says. */
  let overflowed = false;
  try {
    const session = await ConductorSession.open(
      {
        runtimeId: runtime.id,
        launch,
        cwd: directory,
        // The policy channel the fingerprint covers, exactly as a Session gets
        // it: a probe that suppressed differently would prove nothing about the
        // Runtime the user is approving (ADR-0004).
        ...(runtime.sessionMeta ? { sessionMeta: runtime.sessionMeta } : {}),
        ...(request.secretEnvironment ? { secretEnvironment: request.secretEnvironment } : {}),
        setupTimeoutMs: deadline,
        stallTimeoutMs: deadline,
        // Never longer than a Session's: this is the wait before a process is
        // terminated, and "bounded by a short deadline" must not lengthen it.
        cancelGraceMs: Math.min(deadline, DEFAULT_CANCEL_GRACE_MS),
        onUpdate: (notification) => {
          const said = spokenText(notification.update);
          if (said === "") return;
          // Sliced on the way in, so the chunk size an Agent chose decides
          // nothing about how much is held.
          overflowed ||= reply.length + said.length > MAX_SMOKE_REPLY_CHARS;
          reply = (reply + said).slice(0, MAX_SMOKE_REPLY_CHARS);
          // Kept only until the bound: past it the verdict is already failed,
          // and a flood must not become a list either.
          if (!overflowed) chunks.push(said);
        },
      },
      {
        ...request.ports,
        permission: { requestPermission: async (ask) => refuseProbePermission(ask) },
      },
    );
    return {
      session,
      directory,
      async smoke(): Promise<SmokeResult> {
        reply = "";
        chunks.length = 0;
        overflowed = false;
        const response = await session.prompt(SMOKE_PROMPT);
        return {
          ok: !overflowed && smokeVerdict(reply, chunks),
          reply: reply.trim(),
          stopReason: response.stopReason,
        };
      },
      async close(): Promise<void> {
        try {
          await session.dispose();
        } finally {
          await remove();
        }
      },
    };
  } catch (error) {
    await remove();
    throw error;
  }
}

/**
 * The Smoke Test verdict: did the answer arrive as a segment of its own?
 *
 * A segment is a line of the reply, or a suffix of it that starts where one of
 * the Agent's own chunks did — real CLIs print a banner beside their answer,
 * and Copilot fuses the two with no line ending at all, so the stream's own
 * segmentation has to count or a healthy CLI is refused. Each candidate is
 * still held to `isSmokeReply` whole: words fused onto the answer inside one
 * segment are a reply that did not follow the instruction. What an ugly-but-
 * accepted reply can do to the report is the display's problem, and is handled
 * there by bounds, sealing, and the Read-back's budget priority.
 */
export function smokeVerdict(reply: string, chunks: readonly string[]): boolean {
  if (reply.split(/\r\n|[\r\n]/).some((line) => isSmokeReply(line))) return true;
  let suffix = "";
  for (let at = chunks.length - 1; at >= 0; at -= 1) {
    suffix = (chunks[at] ?? "") + suffix;
    if (isSmokeReply(suffix)) return true;
  }
  return false;
}

/** Whether one segment is the Smoke Test's answer and nothing else. Punctuation
 *  is allowed around it — an Agent that says `OK.` answered the question — but a
 *  sentence containing the word did not, and neither did anything spanning a
 *  line ending: segmentation is `smokeVerdict`'s job, not this rule's. */
export function isSmokeReply(reply: string): boolean {
  const said = reply.trim();
  if (/[\r\n]/.test(said)) return false;
  // Anything that is not a letter or a number may sit around it — a full stop, a
  // quotation mark. A word may not, in any script: `\W` is the ASCII complement,
  // so under it a paragraph of Cyrillic and an "ok" was an answer.
  return /^[^\p{L}\p{N}]*ok[^\p{L}\p{N}]*$/iu.test(said);
}

/** What the Agent said out loud. Thoughts are not an answer to anything. */
function spokenText(update: acp.SessionUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  return update.content.type === "text" ? update.content.text : "";
}
