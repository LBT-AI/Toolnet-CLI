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
      "  " + ctx.gateway.getBaseUrl().replace(/https?:\/\//, "").includes("20128") ? "toolnet --tui" : "toolnet --tui",
      "",
      "Or for the full OpenCode-style experience on a compatible terminal.",
    ].join("\n"));
  },
};
