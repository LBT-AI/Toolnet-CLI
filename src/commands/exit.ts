import type { Command, CommandContext } from "./index";

export const exitCommand: Command = {
  name: "exit",
  aliases: ["quit"],
  description: "Exit TOOLNET",
  usage: "/exit",
  async handler(_args: string[], ctx: CommandContext) {
    ctx.exit();
  },
};
