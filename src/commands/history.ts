import type { Command, CommandContext } from "./index";
import { listAllSessions } from "../lib/sessionPersistence";

export const historyCommand: Command = {
  name: "history",
  aliases: ["hist"],
  description: "Show the chat history or list available sessions",
  usage: "/history [sessions]",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length > 0 && args[0].toLowerCase() === "sessions") {
      const sessions = listAllSessions();
      const lines = sessions.map((s, i) => `${i + 1}. ${s.metadata?.name || s.sessionId} (${s.messages.length} msgs)`);
      ctx.addMessage("assistant", `Available Sessions:\n${lines.join("\n")}`);
      return;
    }

    const messages = ctx.getMessages ? ctx.getMessages() : [];
    if (!messages || messages.length === 0) {
      ctx.addMessage("assistant", "The current session has no history.");
      return;
    }
    
    const lines = messages.map((m: any, i: number) => {
      let preview = (m.content || "").replace(/\n/g, " ");
      if (preview.length > 80) preview = preview.slice(0, 77) + "...";
      const roleStr = m.role === 'user' ? 'User' : 'Assistant';
      return `[${i + 1}] ${roleStr}: ${preview}`;
    });

    const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "Current";
    ctx.addMessage("assistant", `Chat History (${activeId}):\n${lines.join("\n")}`);
  },
};
