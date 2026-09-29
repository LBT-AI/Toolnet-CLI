/**
 * Unified Tool Batch Executor — the single P1 pipeline core.
 *
 * This is the ONLY place where raw tool_calls are turned into executions.
 * Every execution path (TUI, AgentRuntime, SubAgent, Teamwork, AgentHarness
 * headless) MUST route its assistant tool_calls through here so that:
 *
 *   1. ToolPlanner dedup — identical (name+args) calls within a turn execute once.
 *   2. Parallel-safe classification — independent read-only calls run concurrently.
 *   3. Cache — executeTool applies the shared ToolCache (read-only hits skip disk).
 *   4. Compression — executeTool applies ToolOutputCompressor to large results.
 *   5. ContextEngine — callers still call prepareMessagesForApi per turn; this
 *      executor complements it by keeping context small (no duplicate blobs).
 *   6. Permission approval is preserved — approval-required tools are forced to
 *      the sequential path so batching can never silently skip a confirmation.
 *
 * The actual permission decision and the real tool side-effect live in `runTool`,
 * which each path supplies (TUI shows an interactive modal, runtimes fail closed).
 */

import { classifyToolCalls, type ToolCall } from "./toolPlanner";
import { canonicalizeJson } from "../security/auditLogger";
import type { StructuredToolError } from "../../core/contracts";

export type { ToolCall } from "./toolPlanner";

/** Model-facing JSON envelope for a terminal failure the executor synthesizes itself. */
export function toolErrorEnvelope(error: StructuredToolError, exitCode = 1): string {
  return JSON.stringify({ stdout: "", stderr: error.message, exitCode, structuredError: error });
}

/**
 * Typed terminal error for an aborted signal. The run-level timeout aborts
 * with a `TimeoutError` DOMException (AbortSignal.timeout) — that is TIMEOUT;
 * every other abort (user cancel, loop teardown) is CANCELLED.
 */
export function abortError(signal: AbortSignal | undefined): StructuredToolError {
  const reason = signal?.reason as { name?: unknown } | undefined;
  if (reason && reason.name === "TimeoutError") {
    return { code: "TIMEOUT", message: "Tool execution timed out.", retryable: true };
  }
  return { code: "CANCELLED", message: "Cancelled", retryable: false };
}

function internalError(err: unknown): StructuredToolError {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    code: "INTERNAL_ERROR",
    message: `Internal tool execution error: ${msg}`,
    retryable: false,
  };
}

/**
 * Common legacy spellings a tool implementation accepts in place of the
 * canonical schema key (see the registry executors: `command || cmd`,
 * `old_string || oldString`, ...). A required key satisfied by one of these is
 * not missing.
 */
const REQUIRED_KEY_ALIASES: Record<string, string[]> = {
  command: ["cmd", "CommandLine"],
  old_string: ["oldString"],
  new_string: ["newString"],
  url: ["link"],
  patch: ["diff"],
  task: ["prompt"],
};

/**
 * Pre-execution input check against a tool's JSON schema. Deliberately
 * shallow: arguments must be an object, required keys must be present, and a
 * key declared as string/object/array must carry that JSON type. Numbers and
 * booleans stay lenient — implementations already coerce them.
 *
 * Returns an INVALID_INPUT error, or null when the input may be dispatched.
 */
export function validateToolInput(
  name: string,
  args: unknown,
  schema: Record<string, unknown> | undefined
): StructuredToolError | null {
  const invalid = (message: string): StructuredToolError => ({
    code: "INVALID_INPUT",
    message: `Invalid arguments for tool '${name}': ${message}`,
    retryable: true,
    suggestedAction: "Fix the arguments to match the tool schema and call it again.",
  });

  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalid("arguments must be a JSON object.");
  }
  if (!schema) return null;

  const input = args as Record<string, unknown>;
  const present = (key: string): boolean =>
    [key, ...(REQUIRED_KEY_ALIASES[key] ?? [])].some((k) => input[k] !== undefined && input[k] !== null);

  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const missing = required.filter((k): k is string => typeof k === "string" && !present(k));
  if (missing.length > 0) {
    return invalid(`missing required ${missing.length === 1 ? "field" : "fields"} ${missing.map((k) => `'${k}'`).join(", ")}.`);
  }

  const properties = (schema.properties ?? {}) as Record<string, { type?: unknown }>;
  for (const [key, prop] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined || value === null || typeof prop?.type !== "string") continue;
    const ok =
      prop.type === "string" ? typeof value === "string"
      : prop.type === "array" ? Array.isArray(value)
      : prop.type === "object" ? typeof value === "object" && !Array.isArray(value)
      : true;
    if (!ok) return invalid(`field '${key}' must be of type ${prop.type}.`);
  }
  return null;
}

/**
 * Produces a stable tool-call signature that is insensitive to the JSON object
 * key order in the arguments. Two calls with semantically identical args
 * ({a:1,b:2} vs {b:2,a:1}) share the same signature, so dedup and loop
 * detection are correct regardless of how the provider serialized the object.
 */
export function signatureForToolCall(name: string, args: any): string {
  return `${name}:${canonicalizeJson(args ?? {})}`;
}

export { canonicalizeJson };

export interface BatchRunResult {
  result: string;
  allowed: boolean;
  reason?: string;
}

export interface ToolBatchOptions {
  cwd: string;
  workspaceRoot?: string;
  sandboxMode?: string;
  /** Predicate: does this call require interactive approval? Controls parallel/sequential split. */
  needsApproval?: (name: string, args: any) => boolean;
  /** Execute one tool after permission handling. Must return standardized JSON result string. */
  runTool: (name: string, args: any, id: string) => Promise<BatchRunResult>;
  /** Abort the whole batch if the same signature repeats more than this many times (per turn). 0 = off. */
  maxRepeat?: number;
  /** Abort signal — when aborted, remaining (not-yet-started) calls are skipped with a Cancelled result. */
  signal?: AbortSignal;
  /** Emit each tool result message as it is produced (id, name, content). */
  onMessage?: (msg: { id: string; name: string; content: string }) => void;
  /**
   * A STARTED call was settled by the executor itself — the abort signal won
   * the race (CANCELLED / TIMEOUT) or `runTool` threw (INTERNAL_ERROR). The
   * `runTool` body will never deliver this call's terminal outcome, so the
   * caller closes any per-call activity it opened here.
   */
  onForcedSettle?: (call: ToolCall, content: string, error: StructuredToolError) => void;
  /**
   * Diagnostic only: a completion arrived for a call that had already settled
   * (late success/failure after cancel or timeout). It is ignored for
   * correctness — the settled outcome stands.
   */
  onLateCompletion?: (call: ToolCall, kind: "resolved" | "rejected") => void;
  /** Diagnostic only: a second tool_call reused an id already seen in this batch; it is not executed. */
  onDuplicateCallId?: (call: ToolCall) => void;
}

export interface ToolBatchOutcome {
  messages: { id: string; name: string; content: string }[];
  executedCount: number;
  deduplicatedCount: number;
  parallelBatches: number;
  parallelCalls: number;
  /** Tool call ids that appeared more than once; only the first occurrence ran and was answered. */
  duplicateCallIds: string[];
}

/**
 * Dispatch a set of tool_calls produced by a single assistant turn.
 *
 * Returns one message per original tool_call id (duplicate calls reuse the
 * executed result so the model always receives a response for every call).
 */
export async function executeToolBatch(
  calls: ToolCall[],
  opts: ToolBatchOptions
): Promise<ToolBatchOutcome> {
  // Classification runs before any call starts, so a throw here would reject
  // the whole batch and orphan every call. Fail closed: a call that cannot be
  // classified goes down the sequential (approval-safe) path. Its own run then
  // settles it.
  const classify = opts.needsApproval ?? (() => false);
  const needsApproval = (name: string, args: any): boolean => {
    try {
      return classify(name, args);
    } catch {
      return true;
    }
  };
  const maxRepeat = opts.maxRepeat ?? 0;

  // Preserve original call order; collect the first occurrence per signature.
  // Duplicate calls reuse the executed result instead of running again.
  // A reused call ID is different from a duplicate signature. The id is the
  // result's identity, so a second call carrying an id already seen is never
  // executed and never answered twice. The first occurrence keeps its result.
  // The scope is this batch (one assistant turn); nothing is process-global.
  const order: { id: string; name: string; sig: string }[] = [];
  const firstBySig = new Map<string, ToolCall>();
  const seenIds = new Set<string>();
  const duplicateCallIds: string[] = [];
  for (const c of calls) {
    if (c.id) {
      if (seenIds.has(c.id)) {
        duplicateCallIds.push(c.id);
        opts.onDuplicateCallId?.(c);
        continue;
      }
      seenIds.add(c.id);
    }
    const sig = signatureForToolCall(c.name, c.args);
    if (!firstBySig.has(sig)) firstBySig.set(sig, c);
    order.push({ id: c.id, name: c.name, sig });
  }
  const unique = [...firstBySig.values()];

  // Step 1+2: classify unique calls into parallel-safe batches and sequential.
  const { parallel, sequential } = classifyToolCalls(unique, needsApproval);

  const contentBySig = new Map<string, string>();
  const repeatCounts = new Map<string, number>();
  let executedCount = 0;

  const runOne = async (call: ToolCall): Promise<string> => {
    const sig = signatureForToolCall(call.name, call.args);
    const n = (repeatCounts.get(sig) ?? 0) + 1;
    repeatCounts.set(sig, n);

    if (maxRepeat > 0 && n > maxRepeat) {
      return JSON.stringify({
        stdout: "",
        stderr: `Infinite loop detected: tool '${call.name}' was called ${n} times with identical arguments. Aborting.`,
        exitCode: 1,
      });
    }

    // Guard: cancelled mid-batch — skip unstarted calls immediately.
    if (opts.signal?.aborted) {
      return toolErrorEnvelope(abortError(opts.signal), 130);
    }

    executedCount++;
    return settleOnce(call);
  };

  /**
   * Exactly-once settlement for one started call. Three contenders race to
   * settle it: runTool resolving, runTool rejecting, and the abort signal.
   * The first one wins. A later contender is reported through
   * `onLateCompletion` and is otherwise ignored, so a late success can never
   * replace CANCELLED/TIMEOUT and a throw can never escape without a result.
   */
  const settleOnce = (call: ToolCall): Promise<string> =>
    new Promise<string>((resolve) => {
      const signal = opts.signal;
      let settled = false;
      const settle = (content: string, forced?: StructuredToolError): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (forced) opts.onForcedSettle?.(call, content, forced);
        resolve(content);
        return true;
      };
      const onAbort = (): void => {
        const error = abortError(signal);
        settle(toolErrorEnvelope(error, 130), error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let pending: Promise<BatchRunResult>;
      try {
        pending = Promise.resolve(opts.runTool(call.name, call.args, call.id));
      } catch (err) {
        pending = Promise.reject(err);
      }
      pending.then(
        (res) => {
          if (!settle(res.result)) opts.onLateCompletion?.(call, "resolved");
        },
        (err) => {
          const error = internalError(err);
          if (!settle(toolErrorEnvelope(error), error)) opts.onLateCompletion?.(call, "rejected");
        }
      );
    });

  /** Record a result (or the Cancelled marker) per signature — every original
   * tool_call id must still receive a message for the model contract. */
  const record = (call: ToolCall, value: string): void => {
    contentBySig.set(signatureForToolCall(call.name, call.args), value);
  };

  // Step 3: run parallel batches concurrently.
  for (const batch of parallel) {
    await Promise.all(batch.map(async (c) => record(c, await runOne(c))));
  }
  // Step 4: run sequential calls one by one.
  for (const call of sequential) {
    record(call, await runOne(call));
  }

  const messages = order.map((o) => ({
    id: o.id,
    name: o.name,
    content: contentBySig.get(o.sig) ?? "",
  }));

  const deduplicatedCount = calls.length - duplicateCallIds.length - unique.length;
  const parallelCalls = parallel.reduce((acc, b) => acc + b.length, 0);

  if (opts.onMessage) {
    for (const m of messages) opts.onMessage(m);
  }

  return {
    messages,
    executedCount,
    deduplicatedCount,
    parallelBatches: parallel.length,
    parallelCalls,
    duplicateCallIds,
  };
}
