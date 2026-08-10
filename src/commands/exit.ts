import type { Command, CommandContext } from "./index";

export const exitCommand: Command = {
  name: "exit",
  aliases: ["quit", "q"],
  description: "Exit TOOLNET",
  usage: "/exit",
  async handler(_args: string[], ctx: CommandContext) {
    ctx.exit();
  },
};
