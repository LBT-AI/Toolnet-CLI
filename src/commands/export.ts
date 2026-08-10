import type { Command, CommandContext } from "./index";
import fs from "node:fs";
import path from "node:path";

export const exportCommand: Command = {
  name: "export",
  aliases: [],
  description: "Export the current chat context to a markdown file",
  usage: "/export [filename]",
  async handler(args: string[], ctx: CommandContext) {
    const filename = args[0] || "chat_export.md";
    const messages = ctx.getMessages ? ctx.getMessages() : [];
    const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "Current";
    
    let content = `# Chat Export: ${activeId}\n\n`;
    for (const msg of messages) {
      const roleName = msg.role === "user" ? "User" : "Assistant";
      content += `## ${roleName}\n\n${msg.content || ""}\n\n`;
    }
    
    const outPath = path.resolve(process.cwd(), filename);
    try {
      fs.writeFileSync(outPath, content, "utf8");
      ctx.addMessage("assistant", `\x1b[32m\u2713\x1b[0m Exported chat to ${outPath}`);
    } catch (e: any) {
      ctx.addMessage("assistant", `\x1b[31mFailed to export: ${e.message}\x1b[0m`);
    }
  },
};
