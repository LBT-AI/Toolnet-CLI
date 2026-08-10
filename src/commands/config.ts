import type { Command, CommandContext } from "./index";

export const configCommand: Command = {
  name: "config",
  aliases: ["cfg", "settings", "options"],
  description: "View unified Configuration hub",
  usage: "/config",
  async handler(args: string[], ctx: CommandContext) {
    const { addMessage } = ctx;
    
    const output = [
      "\x1b[1m\x1b[38;5;63mToolNet Configuration\x1b[0m",
      "\x1b[38;5;239m─────────────────────────────────────────\x1b[0m",
      "\x1b[1m\x1b[38;5;253m› General\x1b[0m",
      "  \x1b[38;5;111mModels\x1b[0m",
      "  \x1b[38;5;111mProviders\x1b[0m",
      "  \x1b[38;5;111mAPI Keys\x1b[0m",
      "  \x1b[38;5;111mPermissions\x1b[0m",
      "  \x1b[38;5;111mAgent\x1b[0m",
      "  \x1b[38;5;111mTeamwork\x1b[0m",
      "  \x1b[38;5;111mAppearance\x1b[0m"
    ].join("\n");

    addMessage("assistant", output);
  },
};
