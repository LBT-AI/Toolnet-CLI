import type { Command, CommandContext } from "./index";
import { getCwdInfo } from "../lib/codingAgent";

export const pwdCommand: Command = {
  name: "pwd",
  aliases: [],
  description: "Print process.cwd(), workspaceRoot, and shell cwd",
  usage: "/pwd",
  async handler(args: string[], ctx: CommandContext) {
    const { currentCwd, workspaceRoot } = getCwdInfo();
    const processCwd = process.cwd();
    ctx.addMessage(
      "assistant",
      `process.cwd(): ${processCwd}\nworkspaceRoot: ${workspaceRoot}\nshell cwd: ${currentCwd}`
    );
  },
};
