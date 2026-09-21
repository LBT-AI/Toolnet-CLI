import { A } from "../../term";
import { wrapText, truncate, visibleWidth } from "../layout";
import type { Msg } from "../types";
import { formatToolStart, formatToolEnd } from "../toolActivity";
import { renderToolLine, prettyToolTarget } from "../../lib/tool-format";
import { classifyToolAction } from "../../lib/commandClassifier";
import { renderUnifiedDiffLines } from "./diffRenderer";
import { redactOutputSecrets } from "../../lib/security/outputRedactor";
import { renderReasoningPanel } from "./reasoningPanel";
import type { ReasoningBlock } from "../../lib/reasoning";
import { tuiState, type ActiveToolActivity } from "../state";

export function renderActiveToolActivity(activity: ActiveToolActivity, cols: number): string[] {
  const isNarrow = cols <= 60;
  const elapsedSec = Math.max(0, Math.floor(activity.elapsedMs / 1000));
  const elapsedStr = `${elapsedSec}s`;

  const actionInfo = classifyToolAction(activity.name, activity.args);
  const action = activity.actionLabel || actionInfo.actionLabel;
  const target = activity.target || prettyToolTarget(activity.name, activity.args);

  const dot = `${A.fgAmber}●${A.reset}`;
  const label = `${A.bold}${A.fgAmber}${action}${A.reset}`;
  const elapsed = `${A.dim}${A.fgMuted}· ${elapsedStr}${A.reset}`;

  const lines: string[] = [];

  const rawTargetMax = Math.max(5, cols - visibleWidth(action) - elapsedStr.length - 10);
  const targetFormatted = target ? ` ${A.dim}${A.fgSubtext}${truncate(target, rawTargetMax)}${A.reset}` : "";
  lines.push(`  ${dot} ${label}${targetFormatted} ${elapsed}`);

  // Bounded live tail lines
  if (activity.tail && activity.tail.length > 0) {
    const maxTail = isNarrow ? 1 : 3;
    const shownTail = activity.tail.slice(-maxTail);
    const maxTailWidth = Math.max(10, cols - 6);
    for (const t of shownTail) {
      lines.push(`    ${A.fgSubtext}${A.dim}${truncate(t, maxTailWidth)}${A.reset}`);
    }
  }

  return lines;
}

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

    // ── 0. Finalized Reasoning Block ───────────────────────────────────────
    if (msg.role === "reasoning") {
      const block: ReasoningBlock | undefined = msg.reasoning;
      const text = block?.text || msg.content || "";
      if (text.trim() || block?.collapsed) {
        const durationStr = block?.durationMs
          ? `${(block.durationMs / 1000).toFixed(1)}s`
          : (msg as any).elapsed || "";
        const panelLines = renderReasoningPanel(chatCols, {
          text,
          elapsed: durationStr,
          effort: block?.effort || (msg as any).effort || "",
          collapsed: block?.collapsed ?? (msg as any).collapsed ?? false,
          tokens: block?.tokens || (msg as any).tokens || 0,
          streaming: false,
        });
        chatLines.push(...panelLines);
      }
      continue;
    }

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

      const isCancelled = Boolean((msg as any).cancelled || (parsedTool && parsedTool.cancelled) || parsedTool?.exitCode === 130);
      const isSuccess = !isCancelled && (parsedTool
        ? parsedTool.exitCode === 0 || !("exitCode" in parsedTool) || !parsedTool.error
        : !String(msg.content || "").toLowerCase().startsWith("error"));

      const durationMs = (msg as any).durationMs ?? parsedTool?.durationMs;
      const status = isCancelled ? "cancelled" : isSuccess ? "success" : "error";
      const headerText = renderToolLine(toolName, argsObj, status, durationMs);
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
        } else if (isCancelled) {
          // No output tail dumped for cancelled operations
        } else if (verbose || isDiffTool || !isSuccess) {
          const lines = outStr.trim().split("\n").filter((l) => l.trim().length > 0);
          const maxLines = isDiffTool ? 20 : (chatCols < 60 ? 3 : 6);
          const tail = lines.slice(-maxLines);
          for (let i = 0; i < tail.length; i++) {
            chatLines.push("    " + A.fgSubtext + A.dim + truncate(tail[i], chatCols - 6) + A.reset);
          }
          if (lines.length > maxLines) {
            chatLines.push("    " + A.fgMuted + `… (${lines.length - maxLines} more lines)` + A.reset);
          }
        } else {
          // Successful verbose commands: show small tail/summary (1-3 lines)
          const lines = outStr.trim().split("\n").filter((l) => l.trim().length > 0);
          const maxSummaryLines = chatCols < 60 ? 1 : 3;
          if (lines.length > 0) {
            const tail = lines.slice(-maxSummaryLines);
            for (let i = 0; i < tail.length; i++) {
              chatLines.push("    " + A.fgSubtext + A.dim + truncate(tail[i], chatCols - 6) + A.reset);
            }
          }
        }
      }
      chatLines.push("");
      continue;
    }

    // ── 2. Tool Calls Requested by Model ───────────────────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        // If already completed in the transcript, avoid duplicate start row
        const alreadyAnswered = messages.some(
          (m) => m.role === "tool" && m.tool_call_id === tc.id
        );
        if (alreadyAnswered) continue;

        // If in flight, rendered by activeToolActivity at transcript tail
        if (tuiState.activeToolActivity && tuiState.activeToolActivity.callId === tc.id) {
          continue;
        }

        let argsObj: any = null;
        try {
          argsObj = JSON.parse(tc.function?.arguments || "{}");
        } catch {}
        chatLines.push(formatToolStart(tc.function?.name || "tool", argsObj));
      }
      continue;
    }

    // ── 3. Regular Conversation Messages (User / Assistant / System) ───────
    const prefix = isUser
      ? primaryColor + A.bold + " ❯ " + A.reset
      : A.fgCyan + A.bold + " ✦ " + A.reset;
    const prefixIndent = "   ";
    // Visual hierarchy: assistant responses get a soft background block so
    // they read as distinct from user prompts (which stay on the bare panel).
    const msgBg = isUser ? "" : A.bgTool;
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
            chatLines.push(msgBg + linePrefix + A.fgBorder + "┌─ " + A.fgCyan + (codeLang || "code") + " " + "─".repeat(Math.max(0, wrapWidth - 8 - (codeLang || "code").length)) + A.reset);
            continue;
          } else {
            chatLines.push(msgBg + linePrefix + A.fgBorder + "└" + "─".repeat(Math.max(0, wrapWidth - 2)) + A.reset);
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
          chatLines.push(msgBg + linePrefix + A.fgBorder + "│ " + A.reset + msgBg + color + content + A.reset);
          continue;
        }

        if (inThoughtBlock) {
          color = A.fgSubtext + A.italic;
        }

        if (closeThought) {
          inThoughtBlock = false;
        }

        chatLines.push(msgBg + linePrefix + color + content + A.reset);
      }
    }
    chatLines.push("");
  }

  if (tuiState.activeToolActivity && tuiState.activeToolActivity.status === "running") {
    chatLines.push(...renderActiveToolActivity(tuiState.activeToolActivity, chatCols));
    chatLines.push("");
  }

  return chatLines;
}
