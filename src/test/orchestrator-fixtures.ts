import type * as acp from "@agentclientprotocol/sdk";
import type {
  ChildLaunch,
  ChildSession,
  OrchestrationCall,
  OrchestrationLimits,
  OrchestratorPorts,
  SessionCapability,
  SubagentRuntime,
} from "../core/index.js";

/**
 * A host for the Orchestrator that starts no process.
 *
 * What the Orchestrator decides — depth, counts, defaults, which Runtime, what
 * a child is told — is settled before anything is spawned, so a fixture that
 * spawns nothing can observe all of it. A real Agent appears in the Shim
 * integration test, once, where the whole chain is what is under test.
 */

export const PARENT_KEY = "parent-key";

export function grant(over: Partial<SessionCapability> = {}): SessionCapability {
  return {
    sessionId: PARENT_KEY,
    depth: 0,
    roots: ["/workspace"],
    expiresAtMs: 2 ** 42,
    methods: ["list_runtimes", "spawn_subagent", "check_subagent", "subagent_result", "cancel_subagent"],
    ...over,
  };
}

export function limits(over: Partial<OrchestrationLimits> = {}): OrchestrationLimits {
  return {
    maxSpawnDepth: 1,
    maxConcurrentSubagents: 2,
    maxSubagentsPerSession: 4,
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 600_000,
    budgetUsdPerSubagent: 2,
    isolation: "shared",
    ...over,
  };
}

export function runtime(over: Partial<SubagentRuntime> = {}): SubagentRuntime {
  return {
    id: "claude",
    displayName: "Claude Code",
    available: true,
    budget: false,
    fanOut: false,
    ...over,
  };
}

/** A child Session that answers as it is told and remembers what it was asked. */
export interface FakeChild extends ChildSession {
  readonly launch: ChildLaunch;
  readonly prompts: Array<string | acp.ContentBlock[]>;
  cancelled: boolean;
  disposed: boolean;
  /** Lets the turn this child is running finish with this stop reason. */
  finish(stopReason?: string): void;
  /** Reports one Update, as an Agent would. */
  say(update: Record<string, unknown>): void;
}

export interface FakeHost {
  ports: OrchestratorPorts;
  /** Children in the order they were opened. */
  readonly children: FakeChild[];
  /** Resolves once at least `count` children have been opened. */
  opened(count: number): Promise<void>;
  /** Turns that had started and not finished, at their busiest. */
  peakConcurrent: () => number;
  /** Refuses the next `openChild` with this message. */
  failNextOpen(message: string): void;
  /** Holds every `openChild` open until `letOpen` is called, so a test can act
   *  inside the window between a spawn being allowed and its child existing. */
  holdOpen(): void;
  letOpen(): void;
  /** Resolves once a child is waiting inside `openChild`. */
  opening(): Promise<void>;
}

export function fakeHost(over: Partial<OrchestratorPorts> = {}): FakeHost {
  const children: FakeChild[] = [];
  let running = 0;
  let peak = 0;
  let refusal: string | undefined;
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  let held: Promise<void> | undefined;
  let letGo: (() => void) | undefined;
  const inside: Array<() => void> = [];

  const openChild = async (launch: ChildLaunch): Promise<ChildSession> => {
    if (refusal !== undefined) {
      const said = refusal;
      refusal = undefined;
      throw new Error(said);
    }
    if (held) {
      for (const watcher of inside.splice(0)) watcher();
      await held;
    }
    let settle: ((response: acp.PromptResponse) => void) | undefined;
    // Latched, because a test learns a child exists the moment it is opened —
    // which is one turn of the event loop before its Turn has begun. A `finish`
    // that arrived then would otherwise be dropped, and the test would hang on
    // a Turn nothing ever ends.
    let ended: string | undefined;
    const child: FakeChild = {
      launch,
      prompts: [],
      cancelled: false,
      disposed: false,
      sessionId: `${launch.sessionKey}-acp`,
      runtimeId: launch.runtimeId,
      modelSelection: { requested: launch.requestedModel, verification: "unavailable" },
      effortSelection: { requested: launch.requestedEffort, verification: "unavailable" },
      prompt(prompt) {
        this.prompts.push(prompt);
        running += 1;
        peak = Math.max(peak, running);
        return new Promise<acp.PromptResponse>((resolve) => {
          settle = (response) => {
            running -= 1;
            settle = undefined;
            resolve(response);
          };
          if (ended !== undefined) settle({ stopReason: ended } as acp.PromptResponse);
        });
      },
      finish(stopReason = "end_turn") {
        ended = stopReason;
        settle?.({ stopReason } as acp.PromptResponse);
      },
      say(update) {
        launch.observe({
          sessionId: `${launch.sessionKey}-acp`,
          update,
        } as unknown as acp.SessionNotification);
      },
      async cancel() {
        this.cancelled = true;
        // Not settled here. A real `session/cancel` is a notification: it
        // returns once written, and the Turn ends afterwards — when the Agent
        // stops, or when the grace period takes its process down. A fake that
        // ended the Turn inside `cancel` would make every caller look as if it
        // had waited for something it never waited for.
        setImmediate(() => {
          ended = "cancelled";
          settle?.({ stopReason: "cancelled" } as acp.PromptResponse);
        });
      },
      async dispose() {
        this.disposed = true;
      },
    };
    children.push(child);
    // Woken a macrotask later, not now. A child exists the moment it is opened,
    // but its Turn has not begun until the Orchestrator's own continuation has
    // run — so a test told "opened" synchronously would read a child that has
    // been asked nothing yet, and pass or fail on the scheduler.
    setImmediate(() => {
      for (const watcher of [...waiting]) {
        if (children.length >= watcher.count) {
          waiting.splice(waiting.indexOf(watcher), 1);
          watcher.resolve();
        }
      }
    });
    return child;
  };

  let next = 0;
  return {
    children,
    peakConcurrent: () => peak,
    failNextOpen: (message) => {
      refusal = message;
    },
    holdOpen() {
      held = new Promise<void>((resolve) => {
        letGo = resolve;
      });
    },
    letOpen() {
      letGo?.();
      held = undefined;
      letGo = undefined;
    },
    opening: () => new Promise<void>((resolve) => inside.push(resolve)),
    opened: (count) =>
      new Promise<void>((resolve) => {
        waiting.push({ count, resolve });
        if (children.length >= count) setImmediate(() => {
          const at = waiting.findIndex((watcher) => watcher.resolve === resolve);
          if (at >= 0) waiting.splice(at, 1);
          resolve();
        });
      }),
    ports: {
      limits: () => limits(),
      runtimes: async () => [runtime()],
      openChild,
      newKey: () => `child-${(next += 1)}`,
      ...over,
    },
  };
}

/** One call, as the socket would deliver it. */
export function call<M extends OrchestrationCall["method"]>(
  method: M,
  params: Extract<OrchestrationCall, { method: M }>["params"],
  capability: SessionCapability = grant(),
): OrchestrationCall {
  return { method, params, grant: capability } as OrchestrationCall;
}
