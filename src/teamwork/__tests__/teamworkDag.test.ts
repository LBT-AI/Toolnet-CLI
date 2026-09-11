/**
 * Phase 76B — Teamwork DAG unit + scheduler semantics.
 *
 * The scheduler is driven with a FAKE SubagentManager so ordering, conditions,
 * retries and timeouts are deterministic and independent of any model. A real
 * BackgroundJobService is used because the point of this suite is precisely the
 * interaction between the DAG scheduler and the shared job queue.
 *
 * A failure here is a CORE_RUNTIME defect in the teamwork scheduler.
 */

import { describe, test, expect } from "bun:test";
import { BackgroundJobService } from "../../core/background";
import { TeamworkEngine, detectCycle, validateTeamworkPlan } from "../../core/teamwork";
import type { SubagentResult } from "../../core/agent/agents/types";
import type { SubagentRunRequest } from "../../core/agent/agents/manager";

// ── Fake manager ─────────────────────────────────────────────────────────────

interface ManagerState {
  order: string[];
  prompts: Record<string, string>;
  calls: Record<string, number>;
}

interface FakeManagerOptions {
  /** Produce the child result for one run. `attempt` is 1-based per node. */
  handler?: (req: SubagentRunRequest, state: ManagerState) => Promise<SubagentResult> | SubagentResult;
  /** Which node a request belongs to, derived from its prompt. */
  identify?: (req: SubagentRunRequest) => string;
}

/**
 * A stand-in for SubagentManager: it never touches a provider, it just returns
 * a scripted envelope. Node identity is read from the prompt, because that is
 * what the real engine would send.
 */
function fakeManager(options: FakeManagerOptions = {}) {
  const state: ManagerState = { order: [], prompts: {}, calls: {} };
  const identify = options.identify ?? ((req: SubagentRunRequest) => firstTag(req.prompt) ?? req.prompt);
  const handler = options.handler ?? (() => completed("done"));

  const manager = {
    allocateSessionId: (_parent: string, agent?: string) => `sub:test:${agent ?? "general"}:${state.order.length + 1}`,
    async run(req: SubagentRunRequest): Promise<SubagentResult> {
      const node = identify(req);
      state.order.push(node);
      state.calls[node] = (state.calls[node] ?? 0) + 1;
      state.prompts[node] = req.prompt;
      return handler(req, state);
    },
  };

  return { manager: manager as any, state };
}

/** First `[[node]]` marker in a prompt — our test-only node identity. */
function firstTag(prompt: string): string | undefined {
  return /\[\[([^\]]+)\]\]/.exec(prompt)?.[1];
}

function completed(output: string): SubagentResult {
  return { taskId: "t", agent: "general", status: "completed", summary: output, output, toolCalls: 1, durationMs: 1 };
}

function errored(message: string): SubagentResult {
  return { taskId: "t", agent: "general", status: "error", summary: message, toolCalls: 0, durationMs: 1, error: message };
}

function cancelled(): SubagentResult {
  return { taskId: "t", agent: "general", status: "cancelled", summary: "cancelled", toolCalls: 0, durationMs: 1, error: "cancelled" };
}

function engineFor(options: FakeManagerOptions = {}, maxConcurrency = 4) {
  const { manager, state } = fakeManager(options);
  const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false, maxConcurrency });
  return { engine: new TeamworkEngine({ jobs, manager }), state, jobs };
}

function node(id: string, agent: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) {
  return { id, title: id, agent, prompt: `[[${id}]] do ${id}`, dependsOn, ...extra };
}

const runOptions = {
  parentSessionId: "team-parent",
  parentPermission: { defaultDecision: "allow", tools: {} } as any,
  parentDepth: 0,
};

// ── Validation ───────────────────────────────────────────────────────────────

describe("Phase 76B — DAG validation", () => {
  const agents = [
    { id: "general", mode: "all" },
    { id: "explore", mode: "subagent" },
    { id: "plan", mode: "primary" },
  ];

  test("accepts a well-formed plan", () => {
    const issues = validateTeamworkPlan(
      { id: "p", nodes: [node("a", "explore"), node("b", "explore", ["a"])] } as any,
      { agents }
    );
    expect(issues).toEqual([]);
  });

  test("rejects a missing / empty plan", () => {
    expect(validateTeamworkPlan(undefined as any, { agents }).length).toBe(1);
    expect(validateTeamworkPlan({ id: "p", nodes: [] } as any, { agents }).length).toBe(1);
  });

  test("rejects duplicate node ids", () => {
    const issues = validateTeamworkPlan(
      { id: "p", nodes: [node("a", "explore"), node("a", "explore")] } as any,
      { agents }
    );
    expect(issues.some((i) => /Duplicate node id/.test(i.message))).toBe(true);
  });

  test("rejects unknown dependencies and self-dependencies", () => {
    const unknown = validateTeamworkPlan(
      { id: "p", nodes: [node("a", "explore", ["ghost"])] } as any,
      { agents }
    );
    expect(unknown.some((i) => /unknown node "ghost"/.test(i.message))).toBe(true);

    const self = validateTeamworkPlan(
      { id: "p", nodes: [node("a", "explore", ["a"])] } as any,
      { agents }
    );
    expect(self.some((i) => /cannot depend on itself/.test(i.message))).toBe(true);
  });

  test("rejects a dependency cycle before anything executes", () => {
    const plan = {
      id: "p",
      nodes: [node("a", "explore", ["b"]), node("b", "explore", ["a"])],
    } as any;
    const issues = validateTeamworkPlan(plan, { agents });
    expect(issues.some((i) => /cycle detected/.test(i.message))).toBe(true);
    expect(detectCycle(plan.nodes).sort()).toEqual(["a", "b"]);
  });

  test("detectCycle returns [] for an acyclic graph", () => {
    expect(detectCycle([node("a", "explore"), node("b", "explore", ["a"])] as any)).toEqual([]);
  });

  test("rejects unknown agents and agents that cannot be subagents", () => {
    const unknown = validateTeamworkPlan({ id: "p", nodes: [node("a", "ghost")] } as any, { agents });
    expect(unknown.some((i) => /unknown agent/.test(i.message))).toBe(true);

    const primary = validateTeamworkPlan({ id: "p", nodes: [node("a", "plan")] } as any, { agents });
    expect(primary.some((i) => /cannot run as a subagent/.test(i.message))).toBe(true);
  });

  test("rejects empty prompts, bad conditions and unbounded retries/timeouts", () => {
    const issues = validateTeamworkPlan(
      {
        id: "p",
        nodes: [
          { id: "a", agent: "explore", prompt: "  ", dependsOn: [] },
          node("b", "explore", [], { condition: "whenever" }),
          node("c", "explore", [], { retry: { maxAttempts: 99 } }),
          node("d", "explore", [], { timeoutMs: -5 }),
        ],
      } as any,
      { agents }
    );
    const text = issues.map((i) => i.message).join("\n");
    expect(text).toMatch(/non-empty prompt/);
    expect(text).toMatch(/invalid condition/);
    expect(text).toMatch(/retry.maxAttempts exceeds/);
    expect(text).toMatch(/timeoutMs must be a positive number/);
  });
});

// ── Scheduling semantics ─────────────────────────────────────────────────────

describe("Phase 76B — DAG scheduling", () => {
  test("runs a dependency before its dependent and forwards its output", async () => {
    const { engine, state } = engineFor({
      handler: (req) => completed(`${firstTag(req.prompt)} result`),
    });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("a", "explore"), node("b", "explore", ["a"])] } as any,
    });

    expect(result.status).toBe("completed");
    expect(state.order).toEqual(["a", "b"]);
    // The dependent node received the dependency's declared output, not its run.
    expect(state.prompts.b).toContain("<dependency_outputs>");
    expect(state.prompts.b).toContain("a result");
    expect(result.nodes.b.status).toBe("completed");
  });

  test("runs independent nodes in parallel, bounded by the shared job queue", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const { engine } = engineFor({
      handler: async (req) => {
        if (req.signal?.aborted) throw new Error("aborted");
        started++;
        // Only resolves once BOTH nodes are running: a sequential scheduler
        // would deadlock here and fail the test's timeout.
        if (started >= 2) release();
        await gate;
        return completed(`${firstTag(req.prompt)} ok`);
      },
    });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("a", "explore"), node("b", "explore")] } as any,
    });

    expect(started).toBe(2);
    expect(result.status).toBe("completed");
  });

  test("a failed dependency fails the plan and skips dependents", async () => {
    const { engine, state } = engineFor({
      handler: (req) => (firstTag(req.prompt) === "a" ? errored("boom") : completed("ok")),
    });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("a", "explore"), node("b", "explore", ["a"])] } as any,
    });

    // The child failed inside its envelope while the job itself completed — the
    // node must still be reported as an error, never as success.
    expect(result.nodes.a.status).toBe("error");
    expect(result.nodes.a.error).toBe("boom");
    expect(result.nodes.b.status).toBe("skipped");
    expect(result.status).toBe("error");
    expect(state.order).toEqual(["a"]);
  });

  test("condition=always runs after a failure; condition=on_failure only reacts to failures", async () => {
    const { engine, state } = engineFor({
      handler: (req) => (firstTag(req.prompt) === "a" ? errored("boom") : completed("ok")),
    });

    const result = await engine.run({
      ...runOptions,
      plan: {
        id: "p",
        nodes: [
          node("a", "explore"),
          node("recover", "coder", ["a"], { condition: "on_failure" }),
          node("after", "explore", ["a"], { condition: "always" }),
          node("skip", "explore", ["a"]),
        ],
      } as any,
    });

    expect(state.order).toContain("recover");
    expect(state.order).toContain("after");
    expect(state.order).not.toContain("skip");
    expect(result.nodes.skip.status).toBe("skipped");
    // A recovery node declares its dependency's failure handled, so the plan
    // itself is not failed.
    expect(result.status).toBe("completed");
  });

  test("an on_failure node that has no failure to react to is skipped", async () => {
    const { engine, state } = engineFor({ handler: () => completed("ok") });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("a", "explore"), node("r", "coder", ["a"], { condition: "on_failure" })] } as any,
    });

    expect(state.order).toEqual(["a"]);
    expect(result.nodes.r.status).toBe("skipped");
  });

  test("retries a retryable failure and reports the attempt count", async () => {
    let firstFailed = false;
    const { engine, state } = engineFor({
      handler: () => {
        if (firstFailed) return completed("recovered");
        firstFailed = true;
        return errored("transient");
      },
    });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("a", "explore", [], { retry: { maxAttempts: 3 } })] } as any,
    });

    expect(state.calls.a).toBe(2);
    expect(result.nodes.a.status).toBe("completed");
    expect(result.nodes.a.attempts).toBe(2);
    expect(result.status).toBe("completed");
  });

  test("does not retry beyond maxAttempts", async () => {
    const { engine, state } = engineFor({ handler: () => errored("always broken") });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("a", "explore", [], { retry: { maxAttempts: 2 } })] } as any,
    });

    expect(state.calls.a).toBe(2);
    expect(result.nodes.a.status).toBe("error");
  });

  test("a node timeout aborts the node instead of hanging the plan", async () => {
    const { engine } = engineFor({
      handler: async (req) => {
        // Honour the abort so no promise leaks, but never finish on our own.
        await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return cancelled();
      },
    });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("slow", "explore", [], { timeoutMs: 40 })] } as any,
    });

    expect(result.nodes.slow.status).toBe("error");
    expect(result.nodes.slow.errorKind).toBe("timeout");
    expect(result.status).toBe("error");
  });

  test("cancelling the plan cancels live nodes and marks the plan cancelled", async () => {
    const controller = new AbortController();

    const { engine } = engineFor({
      handler: async (req) => {
        await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return cancelled();
      },
    });

    const promise = engine.run({
      ...runOptions,
      signal: controller.signal,
      plan: { id: "p", nodes: [node("a", "explore")] } as any,
    });

    // Let the node actually start before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(result.nodes.a.status).toBe("cancelled");
  });

  test("rejects an invalid plan without executing a single node", async () => {
    const { engine, state } = engineFor({ handler: () => completed("ok") });

    const result = await engine.run({
      ...runOptions,
      plan: { id: "p", nodes: [node("a", "explore", ["ghost"])] } as any,
    });

    expect(result.status).toBe("error");
    expect(state.order).toEqual([]);
    expect(result.error).toMatch(/Plan rejected/);
    expect(result.issues?.length).toBeGreaterThan(0);
  });
});
