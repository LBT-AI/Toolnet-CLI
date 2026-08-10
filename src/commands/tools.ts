import type { Command, CommandContext } from "./index";

function getFormattedToolsList(): string {
  const CHECK = "\u001b[32m✓\u001b[0m";
  const BOLD = "\u001b[1m";
  const RESET = "\u001b[0m";
  const DIM = "\u001b[90m";
  
  return `\n${BOLD}Agent Tools Overview${RESET}

${CHECK} ${BOLD}Filesystem${RESET}
  ${DIM}read, write, edit, glob, grep${RESET}

${CHECK} ${BOLD}Shell${RESET}
  ${DIM}bash${RESET}

${CHECK} ${BOLD}Web${RESET}
  ${DIM}search, fetch${RESET}

${CHECK} ${BOLD}MCP${RESET}
  ${DIM}(dynamic extensions)${RESET}\n`;
}

export const toolsCommand: Command = {
  name: "tools",
  aliases: ["cli-tools"],
  description: "View available agent tools and categories",
  usage: "/tools",
  async handler(args: string[], ctx: CommandContext) {
    if (args[0] === "--help" || args[0] === "help") {
      ctx.addMessage(
        "assistant",
        "/tools — View available agent tools\n\n" +
        "  /tools    Show the beautifully formatted tools overview\n"
      );
      return;
    }
    
    ctx.addMessage("assistant", getFormattedToolsList());
  },
};
