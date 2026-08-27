import { A } from "../../term";
import { wrapText, truncate } from "../layout";
import type { Msg } from "../types";
import { formatToolStart, formatToolEnd } from "../toolActivity";
import { renderUnifiedDiffLines, parseDiffStats, renderCompactDiffSummary } from "./diffRenderer";
import { redactOutputSecrets } from "../../lib/security/outputRedactor";

export function renderChatMessages(
  messages: Msg[],
  chatCols: number,
  primaryColor: string,
  verbose = false
): string[] {
  const chatLines: string[] = [];

  for (const msg of messages) {
    const isUser = msg.role === "user";
    const prefix = isUser
      ? primaryColor + A.bold + " ❯ " + A.reset
      : A.fgYellow + A.bold + " ✦ " + A.reset;
    const prefixStripped = " ❯ ";
    const wrapWidth = chatCols - prefixStripped.length - 2;

    let isToolResponse = msg.role === "tool";
    let parsedTool: any = null;

    if (!isToolResponse && typeof msg.content === "string" && msg.content.trim().startsWith("{")) {
      try {
        const tmp = JSON.parse(msg.content);
        if (tmp && (tmp.stdout !== undefined || tmp.stderr !== undefined || tmp.exitCode !== undefined)) {
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

      const isSuccess = parsedTool ? (parsedTool.exitCode === 0 || !("exitCode" in parsedTool) || !parsedTool.error) : true;
      const headerText = formatToolEnd(toolName, argsObj, isSuccess);
      chatLines.push(" " + headerText);

      const tNameLower = toolName.toLowerCase();
      const isDiffTool = tNameLower.includes("edit") || tNameLower.includes("write") || tNameLower.includes("replace") || tNameLower.includes("patch");

      let outStr = "";
      if (verbose || isDiffTool) {
        if (parsedTool) {
          let outText = parsedTool.stdout || parsedTool.output || parsedTool.result || "";
          let errText = parsedTool.stderr || parsedTool.error || "";
          if (typeof outText !== "string") outText = JSON.stringify(outText);
          if (typeof errText !== "string") errText = JSON.stringify(errText);
          outStr = outText;
          if (errText) outStr += (outStr ? "\n" : "") + errText;
        } else if (typeof msg.content === "string") {
          outStr = msg.content;
        }
      }

      // Redact output secrets
      outStr = redactOutputSecrets(outStr);

      if (outStr.trim()) {
        if (isDiffTool && (outStr.includes("@@") || outStr.includes("+++") || outStr.includes("---"))) {
          const diffLines = renderUnifiedDiffLines(outStr, 30, chatCols - 6);
          chatLines.push(...diffLines);
        } else if (verbose) {
          const lines = outStr.trim().split("\n");
          const maxLines = isDiffTool ? 30 : 3;
          for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
            chatLines.push("    " + A.fgSubtext + A.dim + truncate(lines[i], chatCols - 6) + A.reset);
          }
          if (lines.length > maxLines) {
            chatLines.push("    " + A.fgSubtext + A.dim + `... (${lines.length - maxLines} more lines)` + A.reset);
          }
        }
      }
      chatLines.push("");
      continue;
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let argsObj: any = null;
        try {
          argsObj = JSON.parse(tc.function.arguments || "{}");
        } catch {}
        chatLines.push(" " + formatToolStart(tc.function.name, argsObj));
      }
      chatLines.push("");
      continue;
    }

    const cleanContent = redactOutputSecrets(msg.content);
    const lines = wrapText(cleanContent, wrapWidth);
    let inCodeBlock = false;
    let codeLang = "";
    let inThoughtBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const linePrefix = i === 0 ? prefix : " ".repeat(prefixStripped.length);
      let content = lines[i];
      let color = isUser ? A.fgText : A.fgText + A.dim;

      if (content.includes("<thought>")) {
        inThoughtBlock = true;
      }
      const closeThought = content.includes("</thought>");

      // Syntax & Diff Highlighting
      if (content.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (inCodeBlock) codeLang = content.slice(3).trim().toLowerCase();
        color = A.fgSubtext;
      } else if (inCodeBlock) {
        if (codeLang === "diff" || codeLang === "") {
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
            .replace(/\b(const|let|var|function|class|return|if|else|for|while|import|from|export)\b/g, A.fgBlue + "$1" + A.fgText)
            .replace(/\b(true|false|null|undefined)\b/g, A.fgPeach + "$1" + A.fgText)
            .replace(/(["'`])(.*?)(["'`])/g, A.fgGreen + "$1$2$3" + A.fgText);
        }
      } else if (inThoughtBlock) {
        color = A.fgSubtext + A.italic;
      }

      if (closeThought) {
        inThoughtBlock = false;
      }

      chatLines.push(linePrefix + color + content + A.reset);
    }
    chatLines.push("");
  }

  return chatLines;
}
