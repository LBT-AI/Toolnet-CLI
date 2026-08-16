import type { Command, CommandContext } from "./index";
import { contextEngine, estimateMessageChars } from "../lib/context";

export const compactCommand: Command = {
  name: "compact",
  aliases: ["compress"],
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

    const force = args.includes("force") || args.length === 0; // default manual invocation forces compaction
    const result = contextEngine.compact(messages as any, { force, model });

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
    ctx.addMessage(
      "system",
      `→ Context Compacted Successfully!\n` +
        `• Messages: ${beforeCount} → ${result.newCount}\n` +
        `• Token Usage: ${beforeBudget.currentEstimatedTokens} → ${afterBudget.currentEstimatedTokens} tokens (~${savedKb} KB saved)\n` +
        `• Model Capacity: ${beforeBudget.utilizationPercent}% → ${afterBudget.utilizationPercent}% (${model})\n` +
        `• Preserved: Active session memory, atomic tool call pairs, and recent conversation turns.`
    );
  },
};
