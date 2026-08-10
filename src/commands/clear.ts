import type { Command, CommandContext } from "./index";

export const clearCommand: Command = {
  name: "clear",
  aliases: ["cls"],
  description: "Clear the chat screen",
  usage: "/clear",
  async handler(args: string[], ctx: CommandContext) {
    if (ctx.clearMessages) {
      ctx.clearMessages();
    }
    ctx.addMessage("assistant", "Chat screen cleared.");
  },
};
