import type { Command, CommandContext } from "./index";
import { getAllCommands, findCommand } from "./index";

function buildHelpText(): string {
  const lines: string[] = [];
  lines.push("TOOLNET — Slash Commands");
  lines.push("─".repeat(50));
  lines.push("");

  const cmds = getAllCommands();
  const maxNameLen = Math.max(...cmds.map((c) => c.name.length));

  for (const cmd of cmds) {
    const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})` : "";
    const padded = cmd.name.padEnd(maxNameLen + 2);
    lines.push(`  /${padded}${cmd.description}${aliases}`);
  }

  lines.push("");
  lines.push("Tip: Type /help <command> or /<command> --help for specific command details.");

  return lines.join("\n");
}

function buildCommandHelp(cmd: Command): string {
  const lines: string[] = [];
  lines.push(`Command: /${cmd.name}`);
  lines.push("─".repeat(40));
  lines.push(`Description: ${cmd.description}`);
  if (cmd.usage) {
    lines.push(`Usage:       ${cmd.usage}`);
  }
  if (cmd.aliases && cmd.aliases.length > 0) {
    lines.push(`Aliases:     ${cmd.aliases.map((a) => `/${a}`).join(", ")}`);
  }
  return lines.join("\n");
}

export const helpCommand: Command = {
  name: "help",
  aliases: ["h", "?"],
  description: "Show list of commands or details for a specific command",
  usage: "/help [command]",
  async handler(args: string[], ctx: CommandContext) {
    const target = args[0]?.replace(/^\//, "").trim();
    if (target) {
      const found = findCommand("/" + target);
      if (found) {
        ctx.addMessage("assistant", buildCommandHelp(found.command));
        return;
      }
      ctx.addMessage("assistant", `Unknown command '/${target}'. Type /help to see all available commands.`);
      return;
    }
    ctx.addMessage("assistant", buildHelpText());
  },
};
