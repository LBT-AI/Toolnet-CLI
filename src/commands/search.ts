import type { Command, CommandContext } from "./index";

export const searchCommand: Command = {
  name: "search",
  aliases: ["find", "grep-chat"],
  description: "Search for text or pattern in current conversation history",
  usage: "/search <query>",
  async handler(args: string[], ctx: CommandContext) {
    const query = args.join(" ").trim();
    if (!query) {
      ctx.addMessage("assistant", "✖ Usage: `/search <query>`\nExample: `/search function test`");
      return;
    }

    const messages = ctx.getMessages ? ctx.getMessages() : [];
    if (messages.length === 0) {
      ctx.addMessage("assistant", "Conversation is currently empty.");
      return;
    }

    const lowerQuery = query.toLowerCase();
    const matches: Array<{ turn: number; role: string; snippet: string }> = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as { role?: string; content?: any };
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      if (text.toLowerCase().includes(lowerQuery)) {
        // Extract line snippet around match
        const lines = text.split("\n");
        const matchingLines = lines.filter((l: string) => l.toLowerCase().includes(lowerQuery));
        const snippet = matchingLines.slice(0, 3).join("\n  ");
        matches.push({
          turn: i + 1,
          role: msg.role || "unknown",
          snippet: snippet.length > 200 ? snippet.slice(0, 200) + "..." : snippet,
        });
      }
    }

    if (matches.length === 0) {
      ctx.addMessage("assistant", `🔍 No matches found for: \`${query}\``);
      return;
    }

    const lines = [
      `🔍 Found **${matches.length}** match(es) for \`${query}\`:`,
      "───".repeat(16),
      "",
    ];

    for (const m of matches.slice(0, 10)) {
      const roleBadge = m.role === "user" ? "👤 User" : m.role === "assistant" ? "🤖 Assistant" : "⚙️ System";
      lines.push(`• **Turn #${m.turn}** (${roleBadge}):`);
      lines.push(`  \`\`\`\n  ${m.snippet}\n  \`\`\``);
      lines.push("");
    }

    if (matches.length > 10) {
      lines.push(`*(showing first 10 of ${matches.length} matches)*`);
    }

    ctx.addMessage("assistant", lines.join("\n"));
  },
};
