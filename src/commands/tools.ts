import type { Command, CommandContext } from "./index";
import { agentTools } from "../lib/agentTools";

function getFormattedToolsList(): string {
  const CHECK = "\u001b[32m✓\u001b[0m";
  const BOLD = "\u001b[1m";
  const RESET = "\u001b[0m";
  const DIM = "\u001b[90m";
  
  const toolNames = agentTools.map(t => t.function.name).join(", ");

  return `\n${BOLD}Agent Tools Registry (${agentTools.length} tools)${RESET}
` + "───".repeat(12) + `\n
${CHECK} ${BOLD}Local Execution Tools:${RESET}
  ${DIM}${toolNames}${RESET}

${CHECK} ${BOLD}Categories:${RESET}
  • ${BOLD}Filesystem:${RESET} read_file, write_file, edit_file, glob, grep
  • ${BOLD}Shell & Command:${RESET} bash, run_command
  • ${BOLD}Web & Networking:${RESET} web_search, fetch_web_page
  • ${BOLD}MCP Extensibility:${RESET} dynamic external server tools

${DIM}Note: For instructional guides and workflows, use /skills.${RESET}\n`;
}

export const toolsCommand: Command = {
  name: "tools",
  aliases: ["cli-tools"],
  description: "View available agent execution tools (read_file, write_file, shell, etc.)",
  usage: "/tools",
  async handler(args: string[], ctx: CommandContext) {
    if (args[0] === "--help" || args[0] === "help") {
      ctx.addMessage(
        "assistant",
        "/tools — View available agent tools\n\n" +
        "  /tools    Show the agent tools registry\n\n" +
        "Tools are local executable functions (read_file, bash, edit_file, etc.)\n" +
        "invoked by the AI agent during task execution."
      );
      return;
    }
    
    ctx.addMessage("assistant", getFormattedToolsList());
  },
};
