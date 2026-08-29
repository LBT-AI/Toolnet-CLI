import type { Command, CommandContext } from "./index";
import fs from "node:fs";
import path from "node:path";

export const exportCommand: Command = {
  name: "export",
  aliases: ["savechat"],
  description: "Export current chat context to markdown, html, or json",
  usage: "/export [markdown|html|json] [filename]",
  async handler(args: string[], ctx: CommandContext) {
    let format = "markdown";
    let customFile = "";

    const firstArg = args[0]?.toLowerCase();
    if (firstArg === "markdown" || firstArg === "md" || firstArg === "html" || firstArg === "json") {
      format = firstArg.startsWith("m") ? "markdown" : firstArg;
      customFile = args[1] || "";
    } else if (firstArg) {
      customFile = firstArg;
      if (customFile.endsWith(".html")) format = "html";
      else if (customFile.endsWith(".json")) format = "json";
      else format = "markdown";
    }

    const messages = ctx.getMessages ? ctx.getMessages() : [];
    const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "Current";

    let ext = ".md";
    let content = "";

    if (format === "json") {
      ext = ".json";
      content = JSON.stringify({ sessionId: activeId, exportedAt: new Date().toISOString(), messages }, null, 2);
    } else if (format === "html") {
      ext = ".html";
      const bodyHtml = messages
        .map((m) => {
          const roleClass = m.role === "user" ? "user-msg" : m.role === "assistant" ? "assistant-msg" : "system-msg";
          const roleTitle = m.role.toUpperCase();
          const cleanText = (m.content || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return `<div class="msg ${roleClass}"><h3>${roleTitle}</h3><pre>${cleanText}</pre></div>`;
        })
        .join("\n");

      content = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ToolNet Chat Export - ${activeId}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 900px; margin: 0 auto; line-height: 1.5; }
    .msg { background: #1e293b; border-radius: 8px; padding: 1rem 1.5rem; margin-bottom: 1rem; border-left: 4px solid #38bdf8; }
    .user-msg { border-color: #38bdf8; }
    .assistant-msg { border-color: #34d399; }
    .system-msg { border-color: #f59e0b; }
    h3 { margin-top: 0; color: #94a3b8; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; }
    pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  </style>
</head>
<body>
  <h1>ToolNet Chat Export: ${activeId}</h1>
  <p>Exported at ${new Date().toLocaleString()}</p>
  ${bodyHtml}
</body>
</html>`;
    } else {
      ext = ".md";
      content = `# ToolNet Chat Export: ${activeId}\n*Exported: ${new Date().toISOString()}*\n\n`;
      for (const msg of messages) {
        const roleName = msg.role === "user" ? "👤 User" : msg.role === "assistant" ? "🤖 Assistant" : "⚙️ System";
        content += `### ${roleName}\n\n${msg.content || ""}\n\n---\n\n`;
      }
    }

    const filename = customFile || `chat_export_${Date.now()}${ext}`;
    const outPath = path.resolve(process.cwd(), filename);

    try {
      fs.writeFileSync(outPath, content, "utf8");
      ctx.addMessage("assistant", `\x1b[32m✔\x1b[0m Exported conversation (${format}) to: \`${outPath}\``);
    } catch (e: any) {
      ctx.addMessage("assistant", `\x1b[31m✖ Failed to export: ${e.message}\x1b[0m`);
    }
  },
};
