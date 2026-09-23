/**
 * Deterministic context-intelligence eval.
 *
 * These cases drive the SAME production API a turn uses — the context manager,
 * the token estimator, the model-limit resolver, the bounded compactor and the
 * cache — over fixture transcripts. Nothing is stubbed and nothing is sent: no
 * provider call, no network, no billing. The point is to pin the behaviours that
 * are easy to regress silently:
 *
 *   - output capacity is reserved before input is admitted;
 *   - protected state (a DENY, an unresolved failure, the current task) survives;
 *   - pruning reduces the request without deleting it;
 *   - a compaction that cannot make measurable progress terminates;
 *   - a cached file is never served after it changed.
 */

import { ContextCache } from "../context/cache";
import { runBoundedCompaction, type CompactionRunInput } from "../context/compaction";
import { resolveModelLimits, FALLBACK_CONTEXT_WINDOW } from "../context/limits";
import { contextManager } from "../context/manager";
import { planContext } from "../context/planner";
import { estimateMessages, type EstimatableMessage } from "../context/estimator";
import { pruneOldToolResults } from "../../lib/context/toolPruner";
import type { ContextMessage } from "../../lib/context/types";

export interface ContextEvalResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
  beforeTokens?: number;
  afterTokens?: number;
}

export interface ContextEvalReport {
  results: ContextEvalResult[];
  passed: number;
  failed: number;
}

const BIG = "x".repeat(4000);

/** Deterministic prune step built on the real tool-output pruner. */
function pruneStep(messages: EstimatableMessage[]): { messages: EstimatableMessage[]; prunedCount: number } {
  const result = pruneOldToolResults(messages as unknown as ContextMessage[], {
    maxToolResultChars: 600,
    keepRecentToolsCount: 2,
  });
  return { messages: result.messages as unknown as EstimatableMessage[], prunedCount: result.prunedCount };
}

function toolResult(content: string, name = "bash"): EstimatableMessage {
  return { role: "tool", name, content };
}

function largeTranscript(): EstimatableMessage[] {
  const messages: EstimatableMessage[] = [{ role: "system", content: "You are a coding agent." }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "user", content: `step ${i}` });
    messages.push(toolResult(JSON.stringify({ ok: true, output: `${BIG}${i}` })));
  }
  messages.push({ role: "user", content: "Now fix the failing test and make it pass." });
  return messages;
}

interface ContextEvalCase {
  id: string;
  name: string;
  run: () => ContextEvalResult | Promise<ContextEvalResult>;
}

function pass(id: string, name: string, detail: string, extra: Partial<ContextEvalResult> = {}): ContextEvalResult {
  return { id, name, passed: true, detail, ...extra };
}

function fail(id: string, name: string, detail: string, extra: Partial<ContextEvalResult> = {}): ContextEvalResult {
  return { id, name, passed: false, detail, ...extra };
}

const CASES: ContextEvalCase[] = [
  {
    id: "output-capacity-reserved",
    name: "output capacity is reserved so input cannot consume the whole window",
    run() {
      const limits = resolveModelLimits("gpt-4o");
      const messages = [{ role: "user", content: BIG }];
      const budget = contextManager.budget({ messages, model: "gpt-4o" });
      if (budget.reservedOutput <= 0) return fail(this.id, this.name, "no output capacity was reserved");
      if (budget.usableInput >= limits.contextWindow) {
        return fail(this.id, this.name, "usable input consumed the entire window");
      }
      return pass(
        this.id,
        this.name,
        `window ${limits.contextWindow}, reserved output ${budget.reservedOutput}, usable input ${budget.usableInput}`,
      );
    },
  },
  {
    id: "unknown-window-is-conservative",
    name: "an unknown model falls back to a narrow, marked window instead of guessing high",
    run() {
      const limits = resolveModelLimits("totally-unknown-model-xyz");
      if (limits.source !== "fallback") return fail(this.id, this.name, `source was ${limits.source}`);
      if (limits.contextWindow > FALLBACK_CONTEXT_WINDOW) {
        return fail(this.id, this.name, `unknown window ${limits.contextWindow} exceeded the conservative bound`);
      }
      return pass(this.id, this.name, `unknown model treated as ${limits.contextWindow} tokens (fallback)`);
    },
  },
  {
    id: "large-transcript-compacts",
    name: "a transcript over threshold compacts and shrinks",
    async run() {
      const messages = largeTranscript();
      const force = { messages, model: "gpt-4o", force: true, prune: pruneStep } satisfies CompactionRunInput;
      const outcome = await runBoundedCompaction(force);
      if (!outcome.compacted) return fail(this.id, this.name, `did not compact: ${outcome.reason}`);
      if (outcome.afterTokens >= outcome.beforeTokens) {
        return fail(this.id, this.name, "compaction did not reduce the estimate");
      }
      return pass(this.id, this.name, outcome.reason, {
        beforeTokens: outcome.beforeTokens,
        afterTokens: outcome.afterTokens,
      });
    },
  },
  {
    id: "repeated-file-reads-deduplicated",
    name: "an identical older tool result is marked redundant rather than counted twice",
    run() {
      const payload = JSON.stringify({ path: "src/app.ts", content: BIG });
      const messages: EstimatableMessage[] = [
        { role: "user", content: "read the file" },
        toolResult(payload),
        { role: "user", content: "work for a while" },
        // Enough newer results that the duplicate read falls outside the
        // recent-tool window, which is what makes it prunable rather than
        // protected-by-recency.
        toolResult(JSON.stringify({ ok: true, output: "one" })),
        toolResult(JSON.stringify({ ok: true, output: "two" })),
        toolResult(JSON.stringify({ ok: true, output: "three" })),
        { role: "user", content: "read it again" },
        toolResult(payload),
      ];
      const budget = contextManager.budget({ messages, model: "gpt-4o" });
      const plan = planContext({ messages, budget });
      const redundant = plan.included.filter((item) => /redundant/i.test(item.reason));
      if (redundant.length !== 1) {
        return fail(this.id, this.name, `expected exactly one redundant payload, saw ${redundant.length}`);
      }
      return pass(this.id, this.name, "the older identical read is flagged redundant");
    },
  },
  {
    id: "large-shell-output-pruned",
    name: "bulky older shell output is pruned while recent results stay intact",
    run() {
      const messages: EstimatableMessage[] = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 8; i++) messages.push(toolResult(JSON.stringify({ ok: true, output: `${BIG}-${i}` })));
      const pruned = pruneStep(messages);
      if (pruned.prunedCount === 0) return fail(this.id, this.name, "no tool result was pruned");
      if (estimateMessages(pruned.messages) >= estimateMessages(messages)) {
        return fail(this.id, this.name, "pruning did not reduce the estimate");
      }
      return pass(this.id, this.name, `pruned ${pruned.prunedCount} tool result(s)`);
    },
  },
  {
    id: "failed-test-evidence-preserved",
    name: "a failing test result near the prune boundary is not truncated away",
    run() {
      const failure = JSON.stringify({ ok: false, exitCode: 1, output: "1 test failed: expected 2 to be 3" });
      const messages: EstimatableMessage[] = [
        { role: "system", content: "sys" },
        toolResult(JSON.stringify({ ok: true, output: BIG })),
        toolResult(JSON.stringify({ ok: true, output: BIG })),
        toolResult(JSON.stringify({ ok: true, output: BIG })),
        toolResult(JSON.stringify({ ok: true, output: BIG })),
        toolResult(failure),
      ];
      const pruned = pruneStep(messages);
      const kept = pruned.messages.some((message) => String(message.content).includes("expected 2 to be 3"));
      if (!kept) return fail(this.id, this.name, "the failure evidence was pruned away");
      return pass(this.id, this.name, "the failure detail survives pruning");
    },
  },
  {
    id: "permission-denial-protected",
    name: "a permission denial is protected and is not planned away",
    run() {
      const denial = JSON.stringify({ ok: false, decision: "DENY", reason: "write outside workspace" });
      const messages: EstimatableMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "delete /etc/passwd" },
        toolResult(denial),
        { role: "user", content: "do something else" },
        toolResult(JSON.stringify({ ok: true, output: BIG })),
      ];
      const budget = contextManager.budget({ messages, model: "gpt-4o" });
      const plan = planContext({ messages, budget });
      const decision = plan.included.find((item) => item.category === "permission_decisions");
      if (!decision) return fail(this.id, this.name, "the denial was not classified as a permission decision");
      if (!decision.protected) return fail(this.id, this.name, "the denial was not protected");
      return pass(this.id, this.name, "the DENY is a protected permission decision");
    },
  },
  {
    id: "current-goal-preserved-through-compaction",
    name: "compaction keeps the current task rather than summarizing it away",
    async run() {
      const messages = largeTranscript();
      const outcome = await runBoundedCompaction({ messages, model: "gpt-4o", force: true, prune: pruneStep });
      if (!outcome.compacted) return fail(this.id, this.name, "did not compact");
      const kept = (outcome.messages as EstimatableMessage[]).some((message) =>
        String(message.content).includes("Now fix the failing test"),
      );
      if (!kept) return fail(this.id, this.name, "the current task disappeared during compaction");
      return pass(this.id, this.name, "the active instruction survives compaction");
    },
  },
  {
    id: "no-progress-compaction-terminates",
    name: "a compaction that cannot reduce the estimate fails instead of looping",
    async run() {
      const messages = largeTranscript();
      const outcome = await runBoundedCompaction({
        messages,
        model: "gpt-4o",
        force: true,
        prune: (current) => ({ messages: current, prunedCount: 0 }),
      });
      if (outcome.compacted) return fail(this.id, this.name, "a no-op prune was reported as a successful compaction");
      if (outcome.failure !== "no_reduction") {
        return fail(this.id, this.name, `expected no_reduction, saw ${outcome.failure}`);
      }
      return pass(this.id, this.name, "terminated with no_reduction instead of looping");
    },
  },
  {
    id: "compaction-passes-are-bounded",
    name: "a repeatedly-succeeding strategy is still bounded by the pass limit",
    async run() {
      const messages = largeTranscript();
      let calls = 0;
      const outcome = await runBoundedCompaction({
        messages,
        model: "gpt-4o",
        force: true,
        maxPasses: 2,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
        prune: (current) => {
          calls += 1;
          const trimmed = current.slice(0, Math.max(1, current.length - 1));
          return { messages: trimmed, prunedCount: 1 };
        },
        summarize: (current) => ({ compacted: true, messages: current.slice(0, Math.max(1, current.length - 1)) }),
      });
      if (calls > 2) return fail(this.id, this.name, `prune ran ${calls} times past the pass limit`);
      if (outcome.passes > 2) return fail(this.id, this.name, `${outcome.passes} passes exceeded maxPasses=2`);
      return pass(this.id, this.name, `bounded to ${outcome.passes} pass(es)`);
    },
  },
  {
    id: "compaction-increase-is-rejected",
    name: "a summary that grows the estimate is rejected, not applied",
    async run() {
      const messages = largeTranscript();
      const outcome = await runBoundedCompaction({
        messages,
        model: "gpt-4o",
        force: true,
        summarize: () => ({ compacted: true, messages: [...messages, { role: "user", content: BIG }] }),
      });
      if (outcome.compacted) return fail(this.id, this.name, "an increasing summary was accepted");
      if (outcome.failure !== "increased") {
        return fail(this.id, this.name, `expected increased, saw ${outcome.failure}`);
      }
      return pass(this.id, this.name, "an increasing summary is rejected");
    },
  },
  {
    id: "small-request-untouched",
    name: "a normal short request is returned unchanged and never compacts",
    async run() {
      const messages: EstimatableMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "what does this function do?" },
        { role: "assistant", content: "It parses the config." },
      ];
      const result = await contextManager.prepare({ messages, model: "gpt-4o", prune: pruneStep });
      if (result.compacted) return fail(this.id, this.name, "a short request was compacted");
      if (result.messages !== messages) return fail(this.id, this.name, "the message list was rewritten");
      return pass(this.id, this.name, "short request untouched");
    },
  },
  {
    id: "cache-invalidated-on-edit",
    name: "a cached file is re-read after its content changes",
    run() {
      const cache = new ContextCache();
      let content = "export const value = 1;\n";
      const stat = () => ({ size: content.length, mtimeMs: 1 });
      const read = () => content;
      const first = cache.getFile("/tmp/eval-cache.ts", stat, read);
      if (!first || first.hit) return fail(this.id, this.name, "first read should be a miss");

      // A size change is caught from the metadata alone.
      content = "export const value = 200;\n";
      const changedSize = cache.getFile("/tmp/eval-cache.ts", stat, read);
      if (!changedSize) return fail(this.id, this.name, "second read returned nothing");
      if (changedSize.hit) return fail(this.id, this.name, "an edited file was served from cache");
      if (!changedSize.content.includes("200")) return fail(this.id, this.name, "stale content was returned");

      // A same-length write in the same millisecond is invisible to metadata,
      // so the explicit invalidation is the contract that must hold.
      cache.invalidatePath("/tmp/eval-cache.ts");
      content = "export const value = 999;\n";
      const sameSize = cache.getFile("/tmp/eval-cache.ts", stat, read);
      if (!sameSize || sameSize.hit || !sameSize.content.includes("999")) {
        return fail(this.id, this.name, "explicit invalidation did not force a same-size re-read");
      }
      return pass(this.id, this.name, "a size change is a miss and an explicit invalidation beats a same-size edit");
    },
  },
];

export const CONTEXT_EVAL_CASES: string[] = CASES.map((entry) => entry.id);

export async function runContextEval(ids: string[] = CONTEXT_EVAL_CASES): Promise<ContextEvalReport> {
  const selected = ids.length === 0 ? CASES : CASES.filter((entry) => ids.includes(entry.id));
  const results: ContextEvalResult[] = [];
  for (const entry of selected) {
    try {
      results.push(await entry.run.call(entry));
    } catch (error) {
      results.push(
        fail(entry.id, entry.name, `threw: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return { results, passed, failed: results.length - passed };
}
