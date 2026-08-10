import type { Command, CommandContext } from "./index";
import { setWorkspaceRoot, getCwdInfo } from "../lib/codingAgent";

export const cdCommand: Command = {
  name: "cd",
  aliases: [],
  description: "Change workspace root directory",
  usage: "/cd <path>",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0) {
      ctx.addMessage("assistant", `Usage: /cd <path>`);
      return;
    }
    const newPath = args[0];
    const success = setWorkspaceRoot(newPath);
    if (success) {
      const { workspaceRoot } = getCwdInfo();
      ctx.addMessage("assistant", `Workspace root changed to: ${workspaceRoot}`);
    } else {
      ctx.addMessage("assistant", `Failed to change workspace root to: ${newPath}`);
    }
  },
};
