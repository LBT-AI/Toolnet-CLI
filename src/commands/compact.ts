import type { Command, CommandContext } from "./index";
import { contextEngine, estimateMessageChars } from "../lib/context";
import { makeCheckpointSummarizer } from "../lib/harness/checkpointSummarizer";

/**
 * /compact — compact the CURRENT session's model-facing context.
 *
 * This is a checkpoint, not a new session: the session id is unchanged and the
 * durable history keeps every message. What changes is what the model sees from
 * the next turn on: a summary of the older history plus the recent tail.
 *
 * The summary is written by a model when one is reachable (tools disabled,
 * bounded output) and falls back to the deterministic checkpoint otherwise, so
 * the command still works offline.
 */
export const compactCommand: Command = {
  name: "compact",
  aliases: ["compress", "summarize"],
  description: "Compact conversation history to free context window space",
  usage: "/compact [force]",
  async handler(args: string[], ctx: CommandContext): Promise<void> {
    if (!ctx.getMessages || !ctx.setMessages) {
      ctx.addMessage("system", "✖ Context compaction is not supported in this environment.");
      return;
    }

    const model = ctx.currentModel ? ctx.currentModel() : "default";
    const messages = ctx.getMessages();
    const beforeCount = messages.length;
    const beforeBudget = contextEngine.getBudget(messages as any, model);

    // Manual invocation compacts even below the trigger; auto-compaction is what
    // waits for `used >= usable`. `force` is accepted explicitly for symmetry.
    const force = args.includes("force") || args.length === 0;
    const summarizeWithModel = resolveSummarizer(ctx, model);
    const result = await contextEngine.compact(messages as any, {
      force,
      model,
      ...(ctx.getCurrentSessionId ? { sessionId: ctx.getCurrentSessionId() } : {}),
      ...(summarizeWithModel ? { summarizeWithModel } : {}),
    });

    if (!result.compacted) {
      ctx.addMessage(
        "system",
        result.reason ||
          `Context (${beforeCount} messages, ~${beforeBudget.currentEstimatedTokens} tokens / ${beforeBudget.utilizationPercent}% capacity) does not need compaction.`
      );
      return;
    }

    ctx.setMessages(result.messages as any);
    const afterBudget = contextEngine.getBudget(result.messages as any, model);

    const savedKb = (result.savedChars / 1024).toFixed(1);
    // The summary is lossy on purpose: say so, and say where the checkpoint
    // came from, because that is what the model now depends on.
    const source =
      result.summarySource === "model"
        ? "model-written summary"
        : "deterministic summary (no model summarizer available)";
    const chained = result.chainedFromPriorSummary
      ? "\n• Chained: the previous checkpoint was folded into this summary"
      : "";
    ctx.addMessage(
      "system",
      `→ Context Compacted Successfully!\n` +
        `• Messages: ${beforeCount} → ${result.newCount}\n` +
        `• Token Usage: ${beforeBudget.currentEstimatedTokens} → ${afterBudget.currentEstimatedTokens} tokens (~${savedKb} KB saved)\n` +
        `• Model Capacity: ${beforeBudget.utilizationPercent}% → ${afterBudget.utilizationPercent}% (${model})\n` +
        `• Checkpoint: ${source}${chained}\n` +
        `• Session unchanged; original history retained for resume and export.`
    );
  },
};

/** Prefer the host's canonical model call, then the command's own provider. */
function resolveSummarizer(
  ctx: CommandContext,
  model: string,
): ((request: { prompt: string; maxTokens: number }) => Promise<string>) | undefined {
  if (ctx.summarizeWithModel) return ctx.summarizeWithModel;
  if (!ctx.provider) return undefined;
  return makeCheckpointSummarizer({ provider: ctx.provider, model });
}
