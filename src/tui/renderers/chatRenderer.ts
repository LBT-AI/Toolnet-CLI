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
import { countLines } from "../input/composerDocument";

/**
 * Transcript view collapse bounds. A submitted user message keeps its FULL
 * content in state/session (model context, resume, export); only the rendered
 * rows are compacted, so nothing is ever lost to the UI.
 */
export const TRANSCRIPT_COLLAPSE_MIN_LINES = 12;
export const TRANSCRIPT_COLLAPSE_MIN_CHARS = 1200;

export function shouldCollapseTranscriptMessage(content: string): boolean {
  return (
    countLines(content) >= TRANSCRIPT_COLLAPSE_MIN_LINES ||
    content.length >= TRANSCRIPT_COLLAPSE_MIN_CHARS
  );
}

export interface RenderedChatMessages {
  lines: string[];
  messageIds: Array<string | null>;
}

export interface RenderedChatFrame {
  chat: RenderedChatMessages;
  activityLines: string[];
}

/**
 * Max activity rows drawn at once. Bounds the transient overlay's vertical
 * footprint so parallel tools can never grow into (or shift) the composer,
 * footer, or transcript viewport on a 52x20 terminal.
 */
export const MAX_ACTIVITY_ROWS = 4;

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

/**
 * Render EVERY running tool activity, bounded.
 *
 * A single activity keeps the full panel (header + progress tail). With more
 * than one, each collapses to its header row plus a `… +N more` overflow row:
 * parallel tools stay individually readable without flooding the frame, and the
 * total is capped at MAX_ACTIVITY_ROWS so the layout below never moves.
 */
export function renderToolActivities(activities: ActiveToolActivity[], cols: number): string[] {
  const running = activities.filter((activity) => activity.status === "running");
  if (running.length === 0) return [];
  if (running.length === 1) return renderActiveToolActivity(running[0], cols);

  const visible = running.slice(-MAX_ACTIVITY_ROWS);
  const rows = visible.map((activity) => renderActiveToolActivity(activity, cols)[0]);
  const hidden = running.length - visible.length;
  if (hidden > 0) {
    rows.push(`  ${A.dim}${A.fgMuted}… +${hidden} more${A.reset}`);
  }
  return rows.slice(-MAX_ACTIVITY_ROWS);
}

export function formatInlineMarkdown(text: string, baseColor = A.fgText): string {
  if (!text) return "";
  let s = text;
  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, (_m, code) => `${A.fgCyan}${code}${baseColor}`);
  // Bold italic: ***text***
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (_m, content) => `${A.bold}${A.italic}${content}${A.boldOff}${A.italicOff}`);
  // Bold: **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, content) => `${A.bold}${content}${A.boldOff}`);
  s = s.replace(/__([^_]+)__/g, (_m, content) => `${A.bold}${content}${A.boldOff}`);
  // Italic: *text* (excluding bullet point at start of line: ^\s*\*\s)
  s = s.replace(/(^|[^\*])\*([^\*\s][^\*\s]*?[^\*\s]|[^\*\s])\*(?!\*)/g, (pfx, content) => {
    return `${pfx}${A.italic}${content}${A.italicOff}`;
  });
  return s;
}

function pushRenderedLines(
  result: RenderedChatMessages,
  lines: readonly string[],
  message: Msg | null,
): void {
  for (const line of lines) {
    result.lines.push(line);
    result.messageIds.push(message?.id ?? null);
  }
}

function findToolCallMessage(messages: Msg[], callId: string): Msg | undefined {
  return messages.find((message) =>
    message.tool_calls?.some((call) => call.id === callId)
  );
}

export function renderChatMessagesWithMetadata(
  messages: Msg[],
  chatCols: number,
  primaryColor: string,
  verbose = false,
): RenderedChatMessages {
  const result: RenderedChatMessages = { lines: [], messageIds: [] };

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
        pushRenderedLines(result, panelLines, msg);
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
      pushRenderedLines(result, [headerText], msg);

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
          pushRenderedLines(result, renderUnifiedDiffLines(outStr, 25, chatCols - 6), msg);
        } else if (isCancelled) {
          // No output tail dumped for cancelled operations
        } else if (verbose || isDiffTool || !isSuccess) {
          const lines = outStr.trim().split("\n").filter((l) => l.trim().length > 0);
          const maxLines = isDiffTool ? 20 : (chatCols < 60 ? 3 : 6);
          const tail = lines.slice(-maxLines);
          for (let i = 0; i < tail.length; i++) {
            pushRenderedLines(result, ["    " + A.fgSubtext + A.dim + truncate(tail[i], chatCols - 6) + A.reset], msg);
          }
          if (lines.length > maxLines) {
            pushRenderedLines(result, ["    " + A.fgMuted + `… (${lines.length - maxLines} more lines)` + A.reset], msg);
          }
        } else {
          // Successful verbose commands: show small tail/summary (1-3 lines)
          const lines = outStr.trim().split("\n").filter((l) => l.trim().length > 0);
          const maxSummaryLines = chatCols < 60 ? 1 : 3;
          if (lines.length > 0) {
            const tail = lines.slice(-maxSummaryLines);
            for (let i = 0; i < tail.length; i++) {
              pushRenderedLines(result, ["    " + A.fgSubtext + A.dim + truncate(tail[i], chatCols - 6) + A.reset], msg);
            }
          }
        }
      }
      pushRenderedLines(result, [""], msg);
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

        // If in flight, rendered by the live activity section at transcript tail
        if (tuiState.hasActiveToolActivity(tc.id)) {
          continue;
        }

        let argsObj: any = null;
        try {
          argsObj = JSON.parse(tc.function?.arguments || "{}");
        } catch {}
        pushRenderedLines(result, [formatToolStart(tc.function?.name || "tool", argsObj)], msg);
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

    const activeAssistantDraft = tuiState.activeAssistantDraft;
    const isStreamingAssistant = msg.role === "assistant"
      && activeAssistantDraft !== null
      && activeAssistantDraft.id === msg.id
      && activeAssistantDraft.streaming;

    // A long user prompt renders as a compact token plus a one-line preview.
    // This is a VIEW decision only: `msg.content` (and the session on disk)
    // still holds every line for the model, resume and export.
    if (isUser && !isStreamingAssistant) {
      const userContent = redactOutputSecrets(msg.content || "");
      if (shouldCollapseTranscriptMessage(userContent)) {
        const label = `[${countLines(userContent)} lines pasted]`;
        const preview = (userContent.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
        pushRenderedLines(result, [msgBg + prefix + primaryColor + label + A.reset], msg);
        if (preview) {
          pushRenderedLines(
            result,
            [msgBg + prefixIndent + A.fgSubtext + A.dim + "⤷ " + truncate(preview, wrapWidth - 3) + A.reset],
            msg,
          );
        }
        pushRenderedLines(result, [""], msg);
        continue;
      }
    }

    const cleanContent = redactOutputSecrets(msg.content || "") + (isStreamingAssistant ? "▊" : "");
    const rawLines = cleanContent.split("\n");

    let inCodeBlock = false;
    let codeLang = "";
    let inThoughtBlock = false;

    for (let lIdx = 0; lIdx < rawLines.length; lIdx++) {
      let rawLine = rawLines[lIdx];

      // Code block and syntax formatting
      if (rawLine.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        const linePrefix = lIdx === 0 ? prefix : prefixIndent;
        if (inCodeBlock) {
          codeLang = rawLine.trim().slice(3).toLowerCase();
          pushRenderedLines(result, [msgBg + linePrefix + A.fgBorder + "┌─ " + A.fgCyan + (codeLang || "code") + " " + "─".repeat(Math.max(0, wrapWidth - 8 - (codeLang || "code").length)) + A.reset], msg);
          continue;
        } else {
          pushRenderedLines(result, [msgBg + linePrefix + A.fgBorder + "└" + "─".repeat(Math.max(0, wrapWidth - 2)) + A.reset], msg);
          continue;
        }
      }

      const formattedLine = !inCodeBlock && !inThoughtBlock ? formatInlineMarkdown(rawLine, isUser ? A.fgText : A.fgText) : rawLine;
      const wrapped = wrapText(formattedLine, wrapWidth);

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
          pushRenderedLines(result, [msgBg + linePrefix + A.fgBorder + "│ " + A.reset + msgBg + color + content + A.reset], msg);
          continue;
        }

        if (inThoughtBlock) {
          color = A.fgSubtext + A.italic;
        }

        if (closeThought) {
          inThoughtBlock = false;
        }

        pushRenderedLines(result, [msgBg + linePrefix + color + content + A.reset], msg);
      }
    }
    pushRenderedLines(result, [""], msg);
  }

  return result;
}

export function renderChatFrame(
  messages: Msg[],
  chatCols: number,
  primaryColor: string,
  verbose = false,
): RenderedChatFrame {
  return {
    chat: renderChatMessagesWithMetadata(messages, chatCols, primaryColor, verbose),
    activityLines: renderToolActivities(tuiState.getActiveToolActivities(), chatCols),
  };
}

export function renderChatMessages(
  messages: Msg[],
  chatCols: number,
  primaryColor: string,
  verbose = false
): string[] {
  const lines = renderChatMessagesWithMetadata(messages, chatCols, primaryColor, verbose).lines;
  // Legacy transcript contract: in-flight tool activities are appended to the
  // rendered chat. The live TUI renders them as a separate frame section via
  // `renderChatFrame` so they stay outside the viewport's transcript mapping.
  const activityLines = renderToolActivities(tuiState.getActiveToolActivities(), chatCols);
  if (activityLines.length > 0) {
    lines.push(...activityLines);
    lines.push("");
  }
  return lines;
}
