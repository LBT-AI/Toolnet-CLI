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

export type { ToolCall } from "./toolPlanner";

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
  /** Emit each tool result message as it is produced (id, name, content). */
  onMessage?: (msg: { id: string; name: string; content: string }) => void;
}

export interface ToolBatchOutcome {
  messages: { id: string; name: string; content: string }[];
  executedCount: number;
  deduplicatedCount: number;
  parallelBatches: number;
  parallelCalls: number;
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
  const needsApproval = opts.needsApproval ?? (() => false);
  const maxRepeat = opts.maxRepeat ?? 0;

  // Preserve original call order; collect the first occurrence per signature.
  // Duplicate calls reuse the executed result instead of running again.
  const order: { id: string; name: string; sig: string }[] = [];
  const firstBySig = new Map<string, ToolCall>();
  for (const c of calls) {
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

    const res = await opts.runTool(call.name, call.args, call.id);
    contentBySig.set(sig, res.result);
    executedCount++;
    return res.result;
  };

  // Step 3: run parallel batches concurrently.
  for (const batch of parallel) {
    await Promise.all(batch.map((c) => runOne(c)));
  }
  // Step 4: run sequential calls one by one.
  for (const call of sequential) {
    await runOne(call);
  }

  const messages = order.map((o) => ({
    id: o.id,
    name: o.name,
    content: contentBySig.get(o.sig) ?? "",
  }));

  const deduplicatedCount = calls.length - unique.length;
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
  };
}
