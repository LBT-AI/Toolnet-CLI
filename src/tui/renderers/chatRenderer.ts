import { A } from "../../term";
import { wrapText, truncate } from "../layout";
import type { Msg } from "../types";
import { formatToolStart, formatToolEnd } from "../toolActivity";
import { renderUnifiedDiffLines } from "./diffRenderer";
import { redactOutputSecrets } from "../../lib/security/outputRedactor";

export function renderChatMessages(
  messages: Msg[],
  chatCols: number,
  primaryColor: string,
  verbose = false
): string[] {
  const chatLines: string[] = [];

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    const isUser = msg.role === "user";

    // ── 1. Tool Response / Result ──────────────────────────────────────────
    let isToolResponse = msg.role === "tool";
    let parsedTool: any = null;

    if (!isToolResponse && typeof msg.content === "string" && msg.content.trim().startsWith("{")) {
      try {
        const tmp = JSON.parse(msg.content);
        if (tmp && (tmp.stdout !== undefined || tmp.stderr !== undefined || tmp.exitCode !== undefined || tmp.result !== undefined)) {
          isToolResponse = true;
          parsedTool = tmp;
        }
      } catch {}
    } else if (isToolResponse && typeof msg.content === "string") {
      try {
        parsedTool = JSON.parse(msg.content);
      } catch {}
    }

    if (isToolResponse) {
      let toolName = msg.name || "Tool";
      let argsObj: any = null;
      if (msg.tool_call_id) {
        for (const prev of messages) {
          if (prev.tool_calls) {
            const tc = prev.tool_calls.find((t: any) => t.id === msg.tool_call_id);
            if (tc) {
              toolName = tc.function?.name || toolName;
              try {
                argsObj = JSON.parse(tc.function.arguments);
              } catch {}
            }
          }
        }
      }

      const isSuccess = parsedTool
        ? parsedTool.exitCode === 0 || !("exitCode" in parsedTool) || !parsedTool.error
        : !String(msg.content || "").toLowerCase().startsWith("error");

      const headerText = formatToolEnd(toolName, argsObj, isSuccess);
      chatLines.push(headerText);

      const tNameLower = toolName.toLowerCase();
      const isDiffTool =
        tNameLower.includes("edit") ||
        tNameLower.includes("write") ||
        tNameLower.includes("replace") ||
        tNameLower.includes("patch");

      let outStr = "";
      if (parsedTool) {
        let outText = parsedTool.stdout ?? parsedTool.output ?? parsedTool.result ?? "";
        let errText = parsedTool.stderr ?? parsedTool.error ?? "";
        if (typeof outText !== "string") outText = JSON.stringify(outText, null, 2);
        if (typeof errText !== "string") errText = JSON.stringify(errText, null, 2);
        outStr = outText;
        if (errText) outStr += (outStr ? "\n" : "") + errText;
      } else if (typeof msg.content === "string") {
        outStr = msg.content;
      }

      // Redact output secrets
      outStr = redactOutputSecrets(outStr);

      if (outStr.trim()) {
        if (isDiffTool && (outStr.includes("@@") || outStr.includes("+++") || outStr.includes("---"))) {
          const diffLines = renderUnifiedDiffLines(outStr, 25, chatCols - 6);
          chatLines.push(...diffLines);
        } else if (verbose || isDiffTool || !isSuccess) {
          const lines = outStr.trim().split("\n");
          const maxLines = isDiffTool ? 20 : 6;
          for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
            chatLines.push("    " + A.fgSubtext + A.dim + truncate(lines[i], chatCols - 6) + A.reset);
          }
          if (lines.length > maxLines) {
            chatLines.push("    " + A.fgMuted + `… (${lines.length - maxLines} more lines)` + A.reset);
          }
        }
      }
      chatLines.push("");
      continue;
    }

    // ── 2. Tool Calls Requested by Model ───────────────────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let argsObj: any = null;
        try {
          argsObj = JSON.parse(tc.function?.arguments || "{}");
        } catch {}
        chatLines.push(formatToolStart(tc.function?.name || "tool", argsObj));
      }
      chatLines.push("");
      continue;
    }

    // ── 3. Regular Conversation Messages (User / Assistant / System) ───────
    const prefix = isUser
      ? primaryColor + A.bold + " ❯ " + A.reset
      : A.fgCyan + A.bold + " ✦ " + A.reset;
    const prefixIndent = "   ";
    const wrapWidth = Math.max(20, chatCols - prefixIndent.length - 2);

    const cleanContent = redactOutputSecrets(msg.content || "");
    const rawLines = cleanContent.split("\n");

    let inCodeBlock = false;
    let codeLang = "";
    let inThoughtBlock = false;

    for (let lIdx = 0; lIdx < rawLines.length; lIdx++) {
      const rawLine = rawLines[lIdx];
      const wrapped = wrapText(rawLine, wrapWidth);

      for (let wIdx = 0; wIdx < wrapped.length; wIdx++) {
        const isFirstLine = lIdx === 0 && wIdx === 0;
        const linePrefix = isFirstLine ? prefix : prefixIndent;
        let content = wrapped[wIdx];
        let color = isUser ? A.fgText : A.fgText;

        if (content.includes("<thought>") || content.includes("<thinking>")) {
          inThoughtBlock = true;
          content = content.replace(/<thought>|<thinking>/g, A.fgMuted + "💭 " + A.reset + A.fgSubtext + A.italic);
        }

        const closeThought = content.includes("</thought>") || content.includes("</thinking>");
        if (closeThought) {
          content = content.replace(/<\/thought>|<\/thinking>/g, A.reset);
        }

        // Code block and syntax formatting
        if (content.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          if (inCodeBlock) {
            codeLang = content.trim().slice(3).toLowerCase();
            chatLines.push(linePrefix + A.fgBorder + "┌─ " + A.fgCyan + (codeLang || "code") + " " + "─".repeat(Math.max(0, wrapWidth - 8 - (codeLang || "code").length)) + A.reset);
            continue;
          } else {
            chatLines.push(linePrefix + A.fgBorder + "└" + "─".repeat(Math.max(0, wrapWidth - 2)) + A.reset);
            continue;
          }
        }

        if (inCodeBlock) {
          if (codeLang === "diff") {
            if (content.startsWith("+") && !content.startsWith("+++")) {
              color = A.fgGreen;
            } else if (content.startsWith("-") && !content.startsWith("---")) {
              color = A.fgRed;
            } else {
              color = A.fgText;
            }
          } else {
            color = A.fgText;
            content = content
              .replace(/\b(const|let|var|function|class|return|if|else|for|while|import|from|export|async|await|try|catch)\b/g, A.fgBlue + "$1" + A.fgText)
              .replace(/\b(true|false|null|undefined)\b/g, A.fgPeach + "$1" + A.fgText)
              .replace(/(["'`])(.*?)(["'`])/g, A.fgGreen + "$1$2$3" + A.fgText);
          }
          chatLines.push(linePrefix + A.fgBorder + "│ " + A.reset + color + content + A.reset);
          continue;
        }

        if (inThoughtBlock) {
          color = A.fgSubtext + A.italic;
        }

        if (closeThought) {
          inThoughtBlock = false;
        }

        chatLines.push(linePrefix + color + content + A.reset);
      }
    }
    chatLines.push("");
  }

  return chatLines;
}
