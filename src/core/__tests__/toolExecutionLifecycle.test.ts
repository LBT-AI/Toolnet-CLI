/**
 * Phase 1.5 — Tool execution lifecycle integrity.
 *
 * Primary invariant: every accepted tool call settles exactly once.
 * For each unique callId: terminalResultCount(callId) === 1.
 *
 * Two layers are covered:
 *   1. executeToolBatch — the canonical settlement point (one transcript
 *      message per unique call id; abort/throw/late-completion races).
 *   2. AgentHarness — the production path
 *      provider (stubbed fetch) → AgentHarness → ToolGateway → executor →
 *      HarnessEvent → AgentEvent → transcript, asserting exactly one terminal
 *      AgentEvent and exactly one provider-facing tool message per call.
 *
 * All races use deferred promises / explicit barriers — no sleeps.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executeToolBatch,
  validateToolInput,
  type ToolBatchOptions,
  type ToolCall,
} from "../../lib/harness/toolExecutor";
import { AgentHarness } from "../../lib/harness";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { toAgentEvents } from "../agent/agentEngine";
import { setSandboxMode } from "../../lib/permissions";
import { setModelCapabilities } from "../../lib/reasoning";
import type { HarnessEvent } from "../../lib/harness/types";

// ── helpers ──────────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain pending microtasks/IO callbacks (a barrier, not a timed sleep). */
const flush = () => new Promise<void>((r) => setImmediate(r));

const ok = (stdout = "ok") => ({ result: JSON.stringify({ stdout, stderr: "", exitCode: 0 }), allowed: true });
const codeOf = (content: string): string | undefined => {
  try {
    return JSON.parse(content)?.structuredError?.code;
  } catch {
    return undefined;
  }
};

/**
 * An AbortSignal that counts live `abort` listeners — the executor's per-call
 * active-execution registration. Returning to 0 proves cleanup.
 */
function trackedAbort() {
  const ac = new AbortController();
  const signal = ac.signal;
  let active = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  (signal as any).addEventListener = (type: string, l: any, o?: any) => {
    if (type === "abort") active++;
    add(type as any, l, o);
  };
  (signal as any).removeEventListener = (type: string, l: any, o?: any) => {
    if (type === "abort") active--;
    remove(type as any, l, o);
  };
  return { ac, signal, active: () => active };
}

function batchOpts(
  runTool: ToolBatchOptions["runTool"],
  extra: Partial<ToolBatchOptions> = {}
): ToolBatchOptions & { forced: string[]; late: string[] } {
  const forced: string[] = [];
  const late: string[] = [];
  return {
    cwd: "/",
    runTool,
    onForcedSettle: (c) => forced.push(c.id),
    onLateCompletion: (c, kind) => late.push(`${c.id}:${kind}`),
    ...extra,
    forced,
    late,
  };
}

/** Exactly-once assertion over a batch outcome: one message per unique id. */
function expectOneMessagePerId(messages: { id: string }[], ids: string[]) {
  for (const id of ids) {
    expect(messages.filter((m) => m.id === id).length).toBe(1);
  }
  expect(messages.length).toBe(ids.length);
}

// ── Layer 1: executeToolBatch settlement ─────────────────────────────────────

describe("Phase 1.5 — executor exactly-once settlement", () => {
  test("A. normal success: executor invoked once, one result, callId preserved, active cleared", async () => {
    const t = trackedAbort();
    let executions = 0;
    const opts = batchOpts(async () => {
      executions++;
      return ok("hello");
    }, { signal: t.signal });
    const out = await executeToolBatch([{ id: "success-1", name: "get_cwd", args: {} }], opts);

    expect(executions).toBe(1);
    expect(out.executedCount).toBe(1);
    expectOneMessagePerId(out.messages, ["success-1"]);
    expect(JSON.parse(out.messages[0].content).exitCode).toBe(0);
    expect(codeOf(out.messages[0].content)).toBeUndefined();
    expect(opts.forced).toEqual([]);
    expect(t.active()).toBe(0);
  });

  test("B. normal tool failure (EXECUTION_FAILED) settles once and does not throw", async () => {
    const t = trackedAbort();
    const failure = JSON.stringify({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      structuredError: { code: "EXECUTION_FAILED", message: "boom", retryable: false },
    });
    const opts = batchOpts(async () => ({ result: failure, allowed: true }), { signal: t.signal });
    const out = await executeToolBatch([{ id: "fail-1", name: "shell", args: { command: "false" } }], opts);

    expectOneMessagePerId(out.messages, ["fail-1"]);
    expect(codeOf(out.messages[0].content)).toBe("EXECUTION_FAILED");
    expect(opts.forced).toEqual([]);
    expect(t.active()).toBe(0);
  });

  test("C. implementation throws → one INTERNAL_ERROR result, no escape, siblings still answered", async () => {
    const t = trackedAbort();
    const opts = batchOpts(async (_n, args) => {
      if (args.path === "boom") throw new Error("Simulated unexpected exception");
      return ok(String(args.path));
    }, { signal: t.signal });

    const out = await executeToolBatch(
      [
        { id: "a", name: "read_file", args: { path: "A" } },
        { id: "throw-1", name: "read_file", args: { path: "boom" } },
        { id: "c", name: "read_file", args: { path: "C" } },
      ],
      opts
    );

    expectOneMessagePerId(out.messages, ["a", "throw-1", "c"]);
    const thrown = out.messages.find((m) => m.id === "throw-1")!;
    expect(codeOf(thrown.content)).toBe("INTERNAL_ERROR");
    expect(thrown.content).toContain("Simulated unexpected exception");
    expect(codeOf(out.messages.find((m) => m.id === "a")!.content)).toBeUndefined();
    expect(codeOf(out.messages.find((m) => m.id === "c")!.content)).toBeUndefined();
    expect(opts.forced).toEqual(["throw-1"]);
    expect(t.active()).toBe(0);
  });

  test("C'. a synchronous throw from runTool is also settled as INTERNAL_ERROR", async () => {
    const opts = batchOpts((() => {
      throw new Error("sync throw");
    }) as any);
    const out = await executeToolBatch([{ id: "sync-1", name: "get_cwd", args: {} }], opts);
    expectOneMessagePerId(out.messages, ["sync-1"]);
    expect(codeOf(out.messages[0].content)).toBe("INTERNAL_ERROR");
  });

  test("H. cancellation before start: implementation never runs, one CANCELLED result", async () => {
    const t = trackedAbort();
    t.ac.abort();
    let executions = 0;
    const opts = batchOpts(async () => {
      executions++;
      return ok();
    }, { signal: t.signal });
    const out = await executeToolBatch([{ id: "pre-1", name: "get_cwd", args: {} }], opts);

    expect(executions).toBe(0);
    expect(out.executedCount).toBe(0);
    expectOneMessagePerId(out.messages, ["pre-1"]);
    expect(codeOf(out.messages[0].content)).toBe("CANCELLED");
    expect(t.active()).toBe(0);
  });

  test("I. cancel while running, then late success → stays CANCELLED, late success ignored", async () => {
    const t = trackedAbort();
    const gate = deferred<ReturnType<typeof ok>>();
    const started = deferred<void>();
    const opts = batchOpts(async () => {
      started.resolve();
      return gate.promise;
    }, { signal: t.signal });

    const batch = executeToolBatch([{ id: "run-1", name: "get_cwd", args: {} }], opts);
    await started.promise;
    t.ac.abort();
    const out = await batch; // settles on abort, before the tool finishes

    expectOneMessagePerId(out.messages, ["run-1"]);
    expect(codeOf(out.messages[0].content)).toBe("CANCELLED");
    expect(opts.forced).toEqual(["run-1"]);
    expect(t.active()).toBe(0);

    // The underlying operation resolves successfully AFTER cancellation.
    gate.resolve(ok("late"));
    await flush();
    expect(opts.late).toEqual(["run-1:resolved"]);
    expect(out.messages.length).toBe(1);
    expect(codeOf(out.messages[0].content)).toBe("CANCELLED");
  });

  test("J. cancel vs failure race (same tick): exactly one outcome wins", async () => {
    const t = trackedAbort();
    const gate = deferred<ReturnType<typeof ok>>();
    const opts = batchOpts(() => gate.promise, { signal: t.signal });
    const batch = executeToolBatch([{ id: "race-1", name: "get_cwd", args: {} }], opts);

    t.ac.abort();
    gate.reject(new Error("rejected at the same time"));
    const out = await batch;
    await flush();

    expectOneMessagePerId(out.messages, ["race-1"]);
    expect(codeOf(out.messages[0].content)).toBe("CANCELLED");
    expect(opts.forced).toEqual(["race-1"]);
    expect(opts.late).toEqual(["race-1:rejected"]);
    expect(t.active()).toBe(0);
  });

  test("J'. failure settles first, abort afterwards → INTERNAL_ERROR only, no CANCELLED", async () => {
    const t = trackedAbort();
    const gate = deferred<ReturnType<typeof ok>>();
    const opts = batchOpts(() => gate.promise, { signal: t.signal });
    const batch = executeToolBatch([{ id: "race-2", name: "get_cwd", args: {} }], opts);

    gate.reject(new Error("failed first"));
    await flush();
    t.ac.abort();
    const out = await batch;

    expectOneMessagePerId(out.messages, ["race-2"]);
    expect(codeOf(out.messages[0].content)).toBe("INTERNAL_ERROR");
    expect(opts.forced).toEqual(["race-2"]);
    expect(opts.late).toEqual([]);
    expect(t.active()).toBe(0);
  });

  test("K. timeout fires, then underlying operation resolves → one TIMEOUT, late success ignored", async () => {
    // The harness run budget is AbortSignal.timeout(...), which aborts with a
    // TimeoutError DOMException. Reproduce that reason deterministically.
    const t = trackedAbort();
    const gate = deferred<ReturnType<typeof ok>>();
    const opts = batchOpts(() => gate.promise, { signal: t.signal });
    const batch = executeToolBatch([{ id: "timeout-1", name: "get_cwd", args: {} }], opts);

    t.ac.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const out = await batch;
    gate.resolve(ok("late"));
    await flush();

    expectOneMessagePerId(out.messages, ["timeout-1"]);
    expect(codeOf(out.messages[0].content)).toBe("TIMEOUT");
    expect(opts.late).toEqual(["timeout-1:resolved"]);
    expect(t.active()).toBe(0);
  });

  test("L. duplicate completion: settle(success) then abort/settle again → one terminal result", async () => {
    const t = trackedAbort();
    const opts = batchOpts(async () => ok("first"), { signal: t.signal });
    const out = await executeToolBatch([{ id: "dup-settle-1", name: "get_cwd", args: {} }], opts);
    // A second terminal contender after settlement (abort) must not produce anything.
    t.ac.abort();
    await flush();

    expectOneMessagePerId(out.messages, ["dup-settle-1"]);
    expect(JSON.parse(out.messages[0].content).stdout).toBe("first");
    expect(opts.forced).toEqual([]);
    expect(t.active()).toBe(0);
  });

  test("M. duplicate provider callId in one batch: executed once, answered once, reported", async () => {
    let executions = 0;
    const seen: string[] = [];
    const opts = batchOpts(async (_n, args) => {
      executions++;
      return ok(String(args.command));
    }, { onDuplicateCallId: (c) => seen.push(c.id) });

    const out = await executeToolBatch(
      [
        { id: "same-id", name: "shell", args: { command: "echo first" } },
        { id: "same-id", name: "shell", args: { command: "echo second" } },
      ],
      opts
    );

    expect(executions).toBe(1);
    expectOneMessagePerId(out.messages, ["same-id"]);
    expect(JSON.parse(out.messages[0].content).stdout).toBe("echo first");
    expect(out.duplicateCallIds).toEqual(["same-id"]);
    expect(seen).toEqual(["same-id"]);
  });

  test("M'. callId scope is the batch: the same id in a different run/turn is not a collision", async () => {
    let executions = 0;
    const run = () =>
      executeToolBatch([{ id: "call_0", name: "get_cwd", args: {} }], batchOpts(async () => {
        executions++;
        return ok();
      }));
    const first = await run();
    const second = await run();
    expect(executions).toBe(2);
    expect(first.duplicateCallIds).toEqual([]);
    expect(second.duplicateCallIds).toEqual([]);
  });

  test("identical signature under distinct ids: executes once, every id answered (existing dedup)", async () => {
    let executions = 0;
    const out = await executeToolBatch(
      [
        { id: "call-1", name: "shell", args: { command: "echo ok" } },
        { id: "call-2", name: "shell", args: { command: "echo ok" } },
      ],
      batchOpts(async () => {
        executions++;
        return ok();
      })
    );
    expect(executions).toBe(1);
    expectOneMessagePerId(out.messages, ["call-1", "call-2"]);
  });

  test("P. three parallel tools completing B, C, A: each once, exact callId mapping", async () => {
    const t = trackedAbort();
    const gates: Record<string, Deferred<ReturnType<typeof ok>>> = { A: deferred(), B: deferred(), C: deferred() };
    const execs: Record<string, number> = { A: 0, B: 0, C: 0 };
    const opts = batchOpts((_n, args) => {
      execs[args.path]++;
      return gates[args.path].promise;
    }, { signal: t.signal });

    const batch = executeToolBatch(
      [
        { id: "call-A", name: "read_file", args: { path: "A" } },
        { id: "call-B", name: "read_file", args: { path: "B" } },
        { id: "call-C", name: "read_file", args: { path: "C" } },
      ],
      opts
    );
    // All three are in flight concurrently — no serialization.
    expect(execs).toEqual({ A: 1, B: 1, C: 1 });
    expect(t.active()).toBe(3);

    gates.B.resolve(ok("B"));
    await flush();
    gates.C.resolve(ok("C"));
    await flush();
    gates.A.resolve(ok("A"));
    const out = await batch;

    expect(execs).toEqual({ A: 1, B: 1, C: 1 });
    expectOneMessagePerId(out.messages, ["call-A", "call-B", "call-C"]);
    for (const k of ["A", "B", "C"]) {
      expect(JSON.parse(out.messages.find((m) => m.id === `call-${k}`)!.content).stdout).toBe(k);
    }
    expect(out.parallelCalls).toBe(3);
    expect(t.active()).toBe(0);
  });

  test("Q. mixed parallel A success / B failure / C success: three independent results", async () => {
    const t = trackedAbort();
    const opts = batchOpts(async (_n, args) => {
      if (args.path === "B") {
        return {
          result: JSON.stringify({ stdout: "", stderr: "nope", exitCode: 1, structuredError: { code: "EXECUTION_FAILED", message: "nope", retryable: false } }),
          allowed: true,
        };
      }
      return ok(String(args.path));
    }, { signal: t.signal });
    const out = await executeToolBatch(
      [
        { id: "A", name: "read_file", args: { path: "A" } },
        { id: "B", name: "read_file", args: { path: "B" } },
        { id: "C", name: "read_file", args: { path: "C" } },
      ],
      opts
    );
    expectOneMessagePerId(out.messages, ["A", "B", "C"]);
    expect(codeOf(out.messages.find((m) => m.id === "B")!.content)).toBe("EXECUTION_FAILED");
    expect(JSON.parse(out.messages.find((m) => m.id === "A")!.content).stdout).toBe("A");
    expect(JSON.parse(out.messages.find((m) => m.id === "C")!.content).stdout).toBe("C");
    expect(t.active()).toBe(0);
  });

  test("cancellation is run-wide: aborting while A/B/C run settles each exactly once as CANCELLED", async () => {
    // There is no per-call cancel API; the only cancel is the run's signal.
    const t = trackedAbort();
    const gates = [deferred<ReturnType<typeof ok>>(), deferred<ReturnType<typeof ok>>(), deferred<ReturnType<typeof ok>>()];
    let i = 0;
    const opts = batchOpts(() => gates[i++].promise, { signal: t.signal });
    const batch = executeToolBatch(
      ["A", "B", "C"].map((p) => ({ id: `run-${p}`, name: "read_file", args: { path: p } })),
      opts
    );
    t.ac.abort();
    const out = await batch;
    for (const g of gates) g.resolve(ok("late"));
    await flush();

    expectOneMessagePerId(out.messages, ["run-A", "run-B", "run-C"]);
    for (const m of out.messages) expect(codeOf(m.content)).toBe("CANCELLED");
    expect(opts.forced.sort()).toEqual(["run-A", "run-B", "run-C"]);
    expect(opts.late.length).toBe(3);
    expect(t.active()).toBe(0);
  });

  test("classifier (needsApproval) throw does not orphan the batch: call still settles once", async () => {
    let executions = 0;
    const out = await executeToolBatch(
      [{ id: "cls-1", name: "read_file", args: { path: 123 } }],
      batchOpts(async () => {
        executions++;
        return ok();
      }, {
        needsApproval: () => {
          throw new TypeError("targetPath.trim is not a function");
        },
      })
    );
    expect(executions).toBe(1);
    expectOneMessagePerId(out.messages, ["cls-1"]);
    expect(out.parallelCalls).toBe(0); // failed closed onto the sequential path
  });

  test("run-wide abort mid-batch: unstarted sequential calls never execute", async () => {
    const ac = new AbortController();
    let executions = 0;
    const out = await executeToolBatch(
      [
        { id: "call-1", name: "shell", args: { command: "echo A" } },
        { id: "call-2", name: "shell", args: { command: "echo B" } },
      ],
      batchOpts(async () => {
        executions++;
        ac.abort();
        return ok();
      }, { signal: ac.signal })
    );
    expect(executions).toBe(1);
    expectOneMessagePerId(out.messages, ["call-1", "call-2"]);
    expect(codeOf(out.messages[1].content)).toBe("CANCELLED");
  });
});

describe("Phase 1.5 — input preflight contract", () => {
  const schema = toolRegistry.get("read_file")!.parameters as Record<string, unknown>;

  test("valid input passes", () => {
    expect(validateToolInput("read_file", { path: "a.ts", offset: 1 }, schema)).toBeNull();
  });
  test("missing required field → INVALID_INPUT", () => {
    expect(validateToolInput("read_file", {}, schema)?.code).toBe("INVALID_INPUT");
  });
  test("wrong JSON type for a string field → INVALID_INPUT", () => {
    expect(validateToolInput("read_file", { path: 123 }, schema)?.code).toBe("INVALID_INPUT");
  });
  test("non-object arguments → INVALID_INPUT", () => {
    expect(validateToolInput("read_file", "path=a" as any, schema)?.code).toBe("INVALID_INPUT");
  });
  test("legacy spellings accepted by the implementation still satisfy required keys", () => {
    const shell = toolRegistry.get("shell")!.parameters as Record<string, unknown>;
    expect(validateToolInput("shell", { cmd: "ls" }, shell)).toBeNull();
  });
});

// ── Layer 2: production path through AgentHarness ────────────────────────────

interface MockResponse {
  content?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

const originalFetch = globalThis.fetch;
let tmpDir: string;

function stubModel(responses: MockResponse[], route?: (url: string) => Response | undefined) {
  let turn = 0;
  const requests: any[] = [];
  globalThis.fetch = (async (url: string, options?: { body?: string; signal?: AbortSignal }) => {
    if (options?.signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }
    const routed = route?.(String(url));
    if (routed) return routed;
    try {
      requests.push(JSON.parse(options?.body ?? "{}"));
    } catch {}
    const response = responses[turn] ?? { content: "Done.", tool_calls: [] };
    turn++;
    const body = JSON.stringify({
      id: `chatcmpl-${turn}`,
      object: "chat.completion",
      created: Date.now(),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.content ?? "",
            ...(response.tool_calls?.length ? { tool_calls: response.tool_calls } : {}),
          },
          finish_reason: response.tool_calls?.length ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      type: "default",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(body),
      text: async () => body,
      clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
    } as never;
  }) as never;
  return requests;
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

/**
 * Observe the canonical AgentEvent stream (the same mapping the TUI consumes)
 * and track open tool activity: `tool-call` opens it, `tool-result` /
 * `tool-error` settles it.
 */
function observe(harness: AgentHarness) {
  const terminal = new Map<string, string[]>();
  const open = new Set<string>();
  harness.on((ev: HarnessEvent) => {
    for (const e of toAgentEvents(ev)) {
      if (e.type === "tool-call") open.add(e.callId);
      if (e.type === "tool-result" || e.type === "tool-error") {
        open.delete(e.callId);
        terminal.set(e.callId, [...(terminal.get(e.callId) ?? []), e.type]);
      }
    }
  });
  return { terminal, open };
}

const toolMessages = (messages: any[], id: string) =>
  messages.filter((m) => m.role === "tool" && m.tool_call_id === id);

function newHarness() {
  return new AgentHarness({
    workspaceRoot: tmpDir,
    currentCwd: tmpDir,
    model: "test-model",
    harness: "default",
  } as any);
}

describe("Phase 1.5 — production path (provider → AgentHarness → ToolGateway → executor → AgentEvent → transcript)", () => {
  beforeEach(() => {
    setSandboxMode("full-access");
    setModelCapabilities([
      {
        id: "test-model",
        capabilities: { tools: true, nativeToolCalls: true, reasoning: false, vision: false, streaming: false },
      },
    ]);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase15-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    toolRegistry.unregisterOwner("test:phase15");
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("success: one input tool call → exactly one terminal event and one provider-facing tool result", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "alpha-content");
    const requests = stubModel([{ tool_calls: [call("prod-1", "read_file", { path: "a.txt" })] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);

    const res = await harness.run("read it", { maxTurns: 4 });

    expect(res.success).toBe(true);
    expect(obs.terminal.get("prod-1")).toEqual(["tool-result"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "prod-1");
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain("alpha-content");
    // The follow-up provider request carries exactly one tool result for the call.
    const followUp = requests[1];
    const providerToolMsgs = (followUp?.messages ?? []).filter((m: any) => m.role === "tool" && m.tool_call_id === "prod-1");
    expect(providerToolMsgs.length).toBe(1);
  });

  test("P (production). parallel read-only calls: each settles once with exact mapping", async () => {
    for (const k of ["A", "B", "C"]) fs.writeFileSync(path.join(tmpDir, `${k}.txt`), `content-${k}`);
    stubModel([
      {
        tool_calls: [
          call("par-A", "read_file", { path: "A.txt" }),
          call("par-B", "read_file", { path: "B.txt" }),
          call("par-C", "read_file", { path: "C.txt" }),
        ],
      },
      { content: "Done." },
    ]);
    const harness = newHarness();
    const obs = observe(harness);
    const res = await harness.run("read three", { maxTurns: 4 });

    for (const k of ["A", "B", "C"]) {
      expect(obs.terminal.get(`par-${k}`)).toEqual(["tool-result"]);
      const msgs = toolMessages(res.messages, `par-${k}`);
      expect(msgs.length).toBe(1);
      expect(msgs[0].content).toContain(`content-${k}`);
    }
    expect(obs.open.size).toBe(0);
  });

  test("N. unknown tool → one TOOL_UNAVAILABLE result, no crash, no orphan activity", async () => {
    stubModel([{ tool_calls: [call("unk-1", "tool_that_does_not_exist", {})] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    const res = await harness.run("go", { maxTurns: 4 });

    expect(obs.terminal.get("unk-1")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "unk-1");
    expect(msgs.length).toBe(1);
    expect(codeOf(msgs[0].content)).toBe("TOOL_UNAVAILABLE");
  });

  test("O. malformed input → one INVALID_INPUT result, implementation never reached", async () => {
    // `path: 123` used to throw inside the security preflight and crash the run.
    stubModel([{ tool_calls: [call("bad-1", "read_file", { path: 123 })] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    let dispatched = 0;
    const realDispatch = harness.dispatchTool.bind(harness);
    (harness as any).dispatchTool = (...a: any[]) => {
      dispatched++;
      return (realDispatch as any)(...a);
    };
    const res = await harness.run("go", { maxTurns: 4 });

    expect(dispatched).toBe(0);
    expect(obs.terminal.get("bad-1")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "bad-1");
    expect(msgs.length).toBe(1);
    expect(codeOf(msgs[0].content)).toBe("INVALID_INPUT");
  });

  test("F. security hard deny (real gateway) → executor never called, one SECURITY_DENIED", async () => {
    setSandboxMode("workspace");
    let executions = 0;
    toolRegistry.register(
      {
        name: "phase15_mutating_probe",
        description: "test-only mutating external tool",
        parameters: { type: "object", properties: {} },
        risk: "write",
        async execute() {
          executions++;
          return JSON.stringify({ stdout: "should never run", exitCode: 0 });
        },
      },
      "test:phase15"
    );
    stubModel([{ tool_calls: [call("sec-1", "phase15_mutating_probe", {})] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    const res = await harness.run("go", { maxTurns: 4 });

    expect(executions).toBe(0);
    expect(obs.terminal.get("sec-1")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "sec-1");
    expect(msgs.length).toBe(1);
    expect(codeOf(msgs[0].content)).toBe("SECURITY_DENIED");
    expect(msgs[0].content).not.toContain("should never run");
  });

  /** Stub the gateway boundary with an approval gate + execution counter. */
  function gatedDispatch(harness: AgentHarness) {
    const state = { executions: 0, dispatches: 0 };
    (harness as any).dispatchTool = async (_name: string, _args: any, opts: { userApproved?: boolean }) => {
      state.dispatches++;
      if (!opts.userApproved) {
        return {
          result: JSON.stringify({
            stdout: "",
            stderr: "Approval Required",
            exitCode: 1,
            approvalRequired: true,
            structuredError: { code: "PERMISSION_REQUIRED", message: "Approval Required", retryable: false },
          }),
          allowed: false,
          needsApproval: true,
          reason: "needs approval",
        };
      }
      state.executions++;
      return { result: JSON.stringify({ stdout: "approved-run", stderr: "", exitCode: 0 }), allowed: true };
    };
    return state;
  }

  test("D. permission approve → executes exactly once, settles exactly once", async () => {
    stubModel([{ tool_calls: [call("perm-ok", "shell", { command: "echo hi" })] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    const state = gatedDispatch(harness);
    let asked = 0;
    const res = await harness.run("go", {
      maxTurns: 4,
      requestApproval: async () => {
        asked++;
        // Before approval the tool has not executed.
        expect(state.executions).toBe(0);
        return true;
      },
    });

    expect(asked).toBe(1);
    expect(state.executions).toBe(1);
    expect(obs.terminal.get("perm-ok")).toEqual(["tool-result"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "perm-ok");
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain("approved-run");
  });

  test("E. permission deny → never executes, one PERMISSION_DENIED terminal result", async () => {
    stubModel([{ tool_calls: [call("perm-no", "shell", { command: "echo hi" })] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    const state = gatedDispatch(harness);
    const res = await harness.run("go", { maxTurns: 4, requestApproval: async () => false });

    expect(state.executions).toBe(0);
    expect(obs.terminal.get("perm-no")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "perm-no");
    expect(msgs.length).toBe(1);
    expect(codeOf(msgs[0].content)).toBe("PERMISSION_DENIED");
  });

  test("permission required with no approval front-end → one PERMISSION_REQUIRED, activity closed", async () => {
    stubModel([{ tool_calls: [call("perm-none", "shell", { command: "echo hi" })] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    const state = gatedDispatch(harness);
    const res = await harness.run("go", { maxTurns: 4 });

    expect(state.executions).toBe(0);
    expect(obs.terminal.get("perm-none")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "perm-none");
    expect(msgs.length).toBe(1);
    expect(codeOf(msgs[0].content)).toBe("PERMISSION_REQUIRED");
  });

  test("C (production). dispatch throws → one INTERNAL_ERROR result, run survives", async () => {
    stubModel([{ tool_calls: [call("throw-p", "shell", { command: "echo hi" })] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    (harness as any).dispatchTool = async () => {
      throw new Error("gateway exploded");
    };
    const res = await harness.run("go", { maxTurns: 4 });

    expect(obs.terminal.get("throw-p")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "throw-p");
    expect(msgs.length).toBe(1);
    expect(codeOf(msgs[0].content)).toBe("INTERNAL_ERROR");
  });

  test("I/L (production). cancel while running, late success → one terminal tool-error, no tool-result", async () => {
    stubModel([{ tool_calls: [call("cancel-p", "shell", { command: "sleep-ish" })] }, { content: "Done." }]);
    const harness = newHarness();
    const obs = observe(harness);
    const ac = new AbortController();
    const gate = deferred<{ result: string; allowed: boolean }>();
    let executions = 0;
    (harness as any).dispatchTool = async () => {
      executions++;
      ac.abort(); // cancel arrives while the tool is running
      return gate.promise;
    };

    const res = await harness.run("go", { maxTurns: 4, signal: ac.signal });
    // Underlying operation completes successfully after cancellation.
    gate.resolve({ result: JSON.stringify({ stdout: "late success", exitCode: 0 }), allowed: true });
    await flush();

    expect(executions).toBe(1);
    expect(obs.terminal.get("cancel-p")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages ?? [], "cancel-p");
    expect(msgs.length).toBeLessThanOrEqual(1);
    for (const m of msgs) {
      expect(codeOf(m.content)).toBe("CANCELLED");
      expect(m.content).not.toContain("late success");
    }
  });

  test("M (production). duplicate callId in one assistant turn: executed once, answered once", async () => {
    stubModel([
      {
        tool_calls: [
          call("dup-p", "shell", { command: "echo first" }),
          call("dup-p", "shell", { command: "echo second" }),
        ],
      },
      { content: "Done." },
    ]);
    const harness = newHarness();
    const obs = observe(harness);
    const ran: string[] = [];
    (harness as any).dispatchTool = async (_n: string, args: any) => {
      ran.push(args.command);
      return { result: JSON.stringify({ stdout: args.command, exitCode: 0 }), allowed: true };
    };
    const res = await harness.run("go", { maxTurns: 4 });

    expect(ran).toEqual(["echo first"]);
    expect(obs.terminal.get("dup-p")).toEqual(["tool-result"]);
    expect(toolMessages(res.messages, "dup-p").length).toBe(1);
  });

  test("web_fetch internal retries (503 → 200) produce ONE terminal tool result", async () => {
    let attempts = 0;
    stubModel(
      [{ tool_calls: [call("wf-1", "web_fetch", { url: "https://example.com/page" })] }, { content: "Done." }],
      (url) => {
        if (!url.includes("example.com")) return undefined;
        attempts++;
        return attempts === 1
          ? new Response("Service Unavailable", { status: 503 })
          : new Response("<html><body>fetched-body</body></html>", { status: 200 });
      }
    );
    const harness = newHarness();
    const obs = observe(harness);
    const res = await harness.run("fetch it", { maxTurns: 4 });

    expect(attempts).toBe(2);
    expect(obs.terminal.get("wf-1")).toEqual(["tool-result"]);
    expect(obs.open.size).toBe(0);
    const msgs = toolMessages(res.messages, "wf-1");
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain("fetched-body");
  });

  test("R. active tool activity returns to baseline across success/failure/deny/unavailable/throw", async () => {
    fs.writeFileSync(path.join(tmpDir, "ok.txt"), "fine");
    stubModel([
      {
        tool_calls: [
          call("r-ok", "read_file", { path: "ok.txt" }),
          call("r-fail", "read_file", { path: "missing.txt" }),
          call("r-unk", "no_such_tool", {}),
          call("r-bad", "read_file", {}),
        ],
      },
      { content: "Done." },
    ]);
    const harness = newHarness();
    const obs = observe(harness);
    const res = await harness.run("go", { maxTurns: 4 });

    for (const id of ["r-ok", "r-fail", "r-unk", "r-bad"]) {
      expect(obs.terminal.get(id)?.length).toBe(1);
      expect(toolMessages(res.messages, id).length).toBe(1);
    }
    expect(obs.terminal.get("r-ok")).toEqual(["tool-result"]);
    expect(obs.terminal.get("r-fail")).toEqual(["tool-error"]);
    expect(obs.open.size).toBe(0);
  });
});
