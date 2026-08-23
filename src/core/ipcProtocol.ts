/**
 * What the two ends of the orchestration socket agree on.
 *
 * The frame, the methods, and the shape of every argument — separate from the
 * server that enforces them (`ipc.ts`) because they are the contract, and the
 * contract is worth reading without the machinery around it. The Shim keeps its
 * own copy of the parts it needs: it is bundled separately and imports nothing
 * from here, so agreement between the two is something the tests prove rather
 * than something the type system assumes.
 */
import { isAbsolute } from "node:path";
import { z } from "zod";
import { EFFORT_LEVELS } from "./types.js";

/** What the Shim may ask for. Anything else is refused by name. */
export const ORCHESTRATION_METHODS = [
  "list_runtimes",
  "spawn_subagent",
  "check_subagent",
  "subagent_result",
  "cancel_subagent",
] as const;

export type OrchestrationMethod = (typeof ORCHESTRATION_METHODS)[number];

/**
 * Longest frame accepted in either direction.
 *
 * Applied to the bytes as they arrive rather than to a parsed value, because a
 * peer that never sends a newline is otherwise a memory leak with no upper
 * bound — and this socket's peer is a process an Agent started.
 */
export const MAX_FRAME_BYTES = 1_000_000;

/** The handshake line is a secret and a newline; anything longer is not one. */
export const MAX_SECRET_LINE_BYTES = 256;

/** Bound on what a failing handler may say back to an Agent. */
export const MAX_ERROR_CHARS = 500;

const handle = z.object({ handle: z.string().min(1).max(200) }).strict();

/**
 * One schema per method, every one `strict`.
 *
 * `runtime` is a plain string rather than an enum of the four built-ins: the
 * catalog is what says which Runtimes exist, a user-defined one is a first-class
 * member of it, and a list frozen here would refuse the Runtime somebody added
 * (ADR-0005 for the same reason applied to models).
 */
export const PARAMS = {
  list_runtimes: z.object({}).strict(),
  spawn_subagent: z
    .object({
      runtime: z.string().min(1).max(100).optional(),
      model: z.string().min(1).max(200).optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
      brief: z.string().min(1).max(100_000),
      // ACP requires every path absolute, and this is where a Brief's paths
      // arrive from an Agent. Which roots they must fall inside is the
      // Orchestrator's to say; being a path at all is decided here.
      files: z
        .array(z.string().min(1).max(4_096).refine(isAbsolute, "file paths must be absolute"))
        .max(200)
        .optional(),
      isolation: z.enum(["shared", "worktree"]).optional(),
      mode: z.enum(["sync", "background"]).optional(),
      budget_usd: z.number().positive().finite().optional(),
      timeout_ms: z.number().int().positive().max(24 * 60 * 60 * 1_000).optional(),
    })
    .strict(),
  check_subagent: handle,
  subagent_result: handle,
  cancel_subagent: handle,
} satisfies Record<OrchestrationMethod, z.ZodTypeAny>;

export type OrchestrationParams = { [M in OrchestrationMethod]: z.infer<(typeof PARAMS)[M]> };

/**
 * Short-lived authority for one Shim, bound to one active parent Session.
 *
 * Everything here is decided by the issuer. None of it is reflected from a
 * request, and none of it can be changed by one: a Shim that wants to act at a
 * different depth, in a different workspace or for a different Session would
 * need a different capability, which only this side can mint.
 */
export interface SessionCapability {
  /** The Session whose Agent started this Shim. */
  sessionId: string;
  /** That Session's own parent, when it is itself a Subagent. */
  parentSessionId?: string;
  /** How deep the parent already sits in the spawn tree. */
  depth: number;
  /** Absolute roots the parent Session runs against. */
  roots: readonly string[];
  /** Epoch milliseconds after which nothing is accepted. */
  expiresAtMs: number;
  /** The methods this capability may call, and no others. */
  methods: readonly OrchestrationMethod[];
}

/** A validated call, carrying the grant it was made under rather than a claim. */
export type OrchestrationCall = {
  [M in OrchestrationMethod]: { method: M; params: OrchestrationParams[M]; grant: SessionCapability };
}[OrchestrationMethod];

/** What the Orchestrator supplies. Whatever it returns is JSON for the Agent. */
export type OrchestrationHandler = (call: OrchestrationCall) => Promise<unknown>;

export type Failure =
  | "unauthorized"
  | "unknown_method"
  | "invalid_params"
  | "invalid_frame"
  | "too_large"
  | "failed";

/** A request frame, once it is known to be answerable. */
export interface RequestFrame {
  id: string | number;
  method: unknown;
  params: unknown;
}

/**
 * Reads one line as a request, or refuses it.
 *
 * A frame with no id is refused rather than answered with a null one: the Shim
 * matches answers by id, so a nameless failure is a request that never returns
 * — the caller waits for the length of the Agent's turn to learn nothing.
 */
export function readFrame(line: string): RequestFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { id, method, params } = parsed as Record<string, unknown>;
  if (typeof id !== "number" && typeof id !== "string") return undefined;
  // Bounded because every answer quotes it back, and a refusal's own budget is
  // small: an id longer than that turns a request inside the frame limit into
  // an answer beyond it, which the peer refuses wholesale — taking every call
  // in flight on that connection with it.
  if (typeof id === "string" && id.length > MAX_ERROR_CHARS) return undefined;
  return { id, method, params };
}
