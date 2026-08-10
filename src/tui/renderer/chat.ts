import { A } from "../../term";
import { store } from "../store";
import { wrapText } from "../utils/string";

export function renderChatHistory(cols: number, chatRows: number, primaryColor: string): string[] {
  const chatLines: string[] = [];
  
  for (const msg of store.messages) {
    const isUser = msg.role === "user";
    const prefix = isUser
      ? primaryColor + A.bold + " ❯ " + A.reset
      : A.fgYellow + A.bold + " ✦ " + A.reset;
    const prefixStripped = " ❯ ";
    const wrapWidth = cols - prefixStripped.length - 2;

    // Cache invalidation: if terminal resizes or cache doesn't exist, recalculate
    if (!msg._renderedLines || msg._lastRenderCols !== cols) {
      const newLines: string[] = [];
      const lines = wrapText(msg.content, wrapWidth);
      let inCodeBlock = false;
      let codeLang = "";

      for (let i = 0; i < lines.length; i++) {
        const linePrefix = i === 0 ? prefix : " ".repeat(prefixStripped.length);
        let content = lines[i];
        let color = isUser ? A.fgText : A.fgText + A.dim; // default

        // Syntax & Diff Highlighting
        if (content.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          if (inCodeBlock) codeLang = content.slice(3).trim().toLowerCase();
          color = A.fgSubtext; // backticks color
        } else if (inCodeBlock) {
          if (codeLang === "diff" || codeLang === "") {
            if (content.startsWith("+") && !content.startsWith("+++")) {
              color = A.fgGreen;
            } else if (content.startsWith("-") && !content.startsWith("---")) {
              color = A.fgRed;
            } else {
              color = A.fgText; // normal code
            }
          } else {
            color = A.fgText; // normal code
            // Rudimentary syntax highlight
            content = content
              .replace(/\b(const|let|var|function|class|return|if|else|for|while|import|from|export)\b/g, A.fgBlue + "$1" + A.fgText)
              .replace(/\b(true|false|null|undefined)\b/g, A.fgPeach + "$1" + A.fgText)
              .replace(/(["'`])(.*?)(["'`])/g, A.fgGreen + "$1$2$3" + A.fgText);
          }
        }
        newLines.push(linePrefix + color + content + A.reset);
      }
      newLines.push(""); // blank line between messages for whitespace
      
      // Update cache
      msg._renderedLines = newLines;
      msg._lastRenderCols = cols;
    }

    // Push from cache
    chatLines.push(...msg._renderedLines);
  }

  const out: string[] = [];
  // Scroll logic
  const totalLines = chatLines.length;
  const maxScroll = Math.max(0, totalLines - chatRows);
  const clampedScroll = Math.min(store.scrollOffset, maxScroll);
  const startLine = Math.max(0, totalLines - chatRows - clampedScroll);
  const visibleLines = chatLines.slice(startLine, startLine + chatRows);

  // Pad if fewer lines than chatRows
  for (let i = 0; i < chatRows; i++) {
    const line = visibleLines[i] ?? "";
    const stripped = line.replace(/\x1b\[[^m]*m/g, "");
    const pad = Math.max(0, cols - stripped.length);
    out.push(line + " ".repeat(pad) + A.reset + "\r\n");
  }

  return out;
}
