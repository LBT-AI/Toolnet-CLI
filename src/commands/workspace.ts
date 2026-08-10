import type { Command, CommandContext } from "./index";
import { getCwdInfo } from "../lib/codingAgent";

export const workspaceCommand: Command = {
  name: "workspace",
  aliases: [],
  description: "Display current workspace root",
  usage: "/workspace",
  async handler(args: string[], ctx: CommandContext) {
    const { workspaceRoot } = getCwdInfo();
    ctx.addMessage("assistant", `Current workspace: ${workspaceRoot}`);
  },
};
