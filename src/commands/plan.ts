import type { Command, CommandContext } from "./index";

export const planCommand: Command = {
  name: "plan",
  aliases: ["planning"],
  description: "Trigger planning mode",
  usage: "/plan",
  async handler(_args: string[], ctx: CommandContext) {
    if (ctx.setAgentMode) {
      ctx.setAgentMode("Plan");
    }
    ctx.setStatusMsg("Mode: Plan");
    ctx.addMessage("assistant", "\x1b[32m\u2713\x1b[0m Switched to Plan mode.");
  },
};
