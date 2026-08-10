import type { Command, CommandContext } from "./index";
import { getAllCommands } from "./index";

function buildHelpText(): string {
  const lines: string[] = [];
  lines.push("TOOLNET — Slash Commands");
  lines.push("───".repeat(18));
  lines.push("");

  const cmds = getAllCommands();
  const maxNameLen = Math.max(...cmds.map(c => c.name.length));

  for (const cmd of cmds) {
    const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.map(a => `/${a}`).join(", ")})` : "";
    const padded = cmd.name.padEnd(maxNameLen + 2);
    lines.push(`  /${padded}${cmd.description}${aliases}`);
    if (cmd.usage) {
      lines.push(`    ${" ".repeat(maxNameLen + 2)}Usage: ${cmd.usage}`);
    }
  }

  lines.push("");
  lines.push("Tip: Type /<command> --help for details on any command.");

  return lines.join("\n");
}

export const helpCommand: Command = {
  name: "help",
  aliases: ["h", "?"],
  description: "Show this help message",
  usage: "/help [command]",
  async handler(args: string[], ctx: CommandContext) {
    ctx.addMessage("assistant", buildHelpText());
  },
};
