import type { Command, CommandContext } from "./index";
import { compactMessages, estimateMessageChars } from "../lib/compaction";

export const compactCommand: Command = {
  name: "compact",
  aliases: ["compress"],
  description: "Compact conversation history to free context window space",
  usage: "/compact",
  async handler(_args: string[], ctx: CommandContext): Promise<void> {
    if (!ctx.getMessages || !ctx.setMessages) {
      ctx.addMessage("system", "✖ Context compaction is not supported in this environment.");
      return;
    }

    const messages = ctx.getMessages();
    const beforeCount = messages.length;
    const beforeChars = estimateMessageChars(messages);

    const result = compactMessages(messages, { force: true });

    if (!result.compacted) {
      ctx.addMessage("system", result.reason || `Context size (${beforeCount} messages, ~${Math.round(beforeChars / 1024)}KB) does not need compaction.`);
      return;
    }

    ctx.setMessages(result.messages);

    const savedKb = (result.savedChars / 1024).toFixed(1);
    ctx.addMessage("system", `→ Context Compacted Successfully!\n• Messages: ${beforeCount} → ${result.newCount}\n• Context space freed: ~${savedKb} KB (~${Math.round(result.savedChars / 3.8)} tokens)\n• Preserved: System prompts, structured history summary, and recent messages.`);
  },
};
