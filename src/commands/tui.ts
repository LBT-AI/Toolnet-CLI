import type { Command, CommandContext } from "./index";

export const tuiCommand: Command = {
  name: "tui",
  aliases: ["tui-mode"],
  description: "Restart in TUI mode (requires compatible terminal)",
  usage: "/tui",
  async handler(_args: string[], ctx: CommandContext) {
    ctx.addMessage("assistant", [
      "To launch TUI mode, exit this session and run:",
      "",
      "  toolnet",
      "",
      "Or for the full experience on a compatible terminal.",
    ].join("\n"));
  },
};
