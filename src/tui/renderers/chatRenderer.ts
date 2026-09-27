import { A, S } from "../../term";
import { wrapText, truncate, visibleWidth } from "../layout";
import type { Msg } from "../types";
import { formatToolStart, formatToolEnd } from "../toolActivity";
import { renderToolLine, prettyToolTarget } from "../../lib/tool-format";
import { classifyToolAction } from "../../lib/commandClassifier";
import { renderUnifiedDiffLines, renderFileMutations } from "./diffRenderer";
import type { FileMutation } from "../../core/contracts";
import { redactOutputSecrets } from "../../lib/security/outputRedactor";
import { sanitizeTerminalText } from "../../lib/terminalOutput";
import { renderReasoningPanel } from "./reasoningPanel";
import type { ReasoningBlock } from "../../lib/reasoning";
import {
  renderInlineMarkdown,
  stripInFlightMarkers,
  isHorizontalRule,
  parseHeading,
  renderHeading,
  parseBullet,
  normalizeBulletMarker,
  scanMarkdownTables,
  renderResponsiveTable,
  tableToLines,
  type MarkdownTable,
} from "../../lib/markdown";
import { tuiState, type ActiveToolActivity } from "../state";
import { countLines } from "../input/composerDocument";

/**
 * Generic long-result presentation policy (content-shape based, never
 * hard-coded to one report).
 *
 * When a single message renders beyond `TRANSCRIPT_RESULT_MAX_ROWS` painted
 * rows, the transcript keeps the FIRST rows plus one compact summary row and
 * hands the FULL rendered content to the detail viewer (Ctrl+O). Canonical
 * data in `msg.content`/the session is never touched — this is a VIEW
 * decision only, applied uniformly to any oversized assistant/tool result:
 * audits, file lists, test matrices, diagnostics, whatever shape it takes.
 */
export const TRANSCRIPT_RESULT_MAX_ROWS = 14;

export function buildResultCompactionSummary(hiddenRows: number, totalRows: number): string {
  return A.fgMuted + `… ${hiddenRows} more lines · Ctrl+O for details` + A.reset;
}

/**
 * Transcript view collapse bounds. A submitted user message keeps its FULL
 * content in state/session (model context, resume, export); only the rendered
 * rows are compacted, so nothing is ever lost to the UI.
 */
export const TRANSCRIPT_COLLAPSE_MIN_LINES = 12;
export const TRANSCRIPT_COLLAPSE_MIN_CHARS = 1200;

/**
 * Tool output longer than this gets a single summary row instead of a tail
 * dump. The full buffer still lives in `msg.content` and is paged by the Run
 * output viewer (Ctrl+O), so nothing is lost — the transcript just stays calm.
 */
export const RUN_OUTPUT_INLINE_MAX_LINES = 8;

export function shouldCollapseTranscriptMessage(content: string): boolean {
  return (
    countLines(content) >= TRANSCRIPT_COLLAPSE_MIN_LINES ||
    content.length >= TRANSCRIPT_COLLAPSE_MIN_CHARS
  );
}

/**
 * Human summary for well-known read-only tools whose raw payload is JSON.
 * `✓ GetCwd` followed by `{"workspaceRoot":"/root",...}` is debug output; the
 * same fact as `✓ Workspace /root` is information. Only tools with an obvious,
 * lossless one-liner are mapped — everything else keeps its real output, and
 * the raw JSON always remains available in the Run output viewer (Ctrl+O).
 */
export function friendlyToolSummary(toolName: string, parsedTool: any): string | null {
  if (!parsedTool || typeof parsedTool !== "object") return null;
  const name = toolName.toLowerCase();
  const payload = (parsedTool.result !== undefined ? parsedTool.result : parsedTool) as any;
  if (name === "get_cwd" || name === "getcwd") {
    const root = payload?.workspaceRoot ?? payload?.cwd ?? parsedTool.stdout;
    return typeof root === "string" && root ? `Workspace ${root}` : null;
  }
  if (name === "file_exists" || name === "exists") {
    if (typeof payload === "boolean") return payload ? "File exists" : "File not found";
  }
  return null;
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

  // Running = info blue; the completed row turns green/red (tool-format).
  const dot = `${A.fgInfo}●${A.reset}`;
  const label = `${A.bold}${A.fgInfo}${action}${A.reset}`;
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

/**
 * Inline Markdown for one transcript line.
 *
 * Delegates to the canonical parser in `lib/markdown`: only a *balanced* marker
 * pair is styled, so `**bold**`, `***bi***`, `*it*`, `_it_` and `` `code` ``
 * become styles while globs (`*.ts`), shell (`find . -name "*.ts"`), math
 * (`2 * 3`) and regexes survive untouched. No character is ever deleted.
 */
export function formatInlineMarkdown(text: string, baseColor = A.fgText): string {
  return renderInlineMarkdown(text, baseColor);
}

/** Render one horizontal-rule marker as a thin divider, never as `***`. */
export function renderMarkdownDivider(width: number): string {
  return A.fgBorder + S.hrule.repeat(Math.max(3, width)) + A.reset;
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
  // The renderer runs on every frame; recording is refreshed each pass so the
  // Ctrl+O target always mirrors what the transcript is currently showing.
  tuiState.lastDetailViewerTarget = null;

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    const isUser = msg.role === "user";
    // Start index of THIS message's painted segment — the long-result policy
    // compacts per message, never across message boundaries.
    const msgStartIdx = result.lines.length;
    // Full rows of a table this message summarized (its hint borrows them for
    // the detail viewer); appended to the compaction target so no data is
    // ever unreachable.
    let msgTableFullLines: string[] | null = null;

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

      // Structured file mutations render as a real diff block (create/edit/
      // delete) from DATA, never by sniffing the tool's stdout for a diff.
      const structuredMutations: FileMutation[] | undefined =
        Array.isArray((msg as any).fileMutations) && (msg as any).fileMutations.length > 0
          ? (msg as any).fileMutations
          : Array.isArray(parsedTool?.fileMutations) && parsedTool.fileMutations.length > 0
            ? parsedTool.fileMutations
            : undefined;

      if (structuredMutations) {
        pushRenderedLines(result, renderFileMutations(structuredMutations, chatCols, { status, durationMs }), msg);
        pushRenderedLines(result, [""], msg);
        continue;
      }

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

      // Redact output secrets, then normalize the terminal stream: a tool's
      // stdout can still carry ANSI escapes, OSC titles and \r progress frames
      // (e.g. tool output restored from an older session). Never trust it to be
      // pre-sanitized — raw escapes would corrupt the whole frame.
      outStr = sanitizeTerminalText(redactOutputSecrets(outStr));

      if (outStr.trim()) {
        // Known read-only tools answer in one human line instead of raw JSON.
        const friendly = !verbose && isSuccess ? friendlyToolSummary(toolName, parsedTool) : null;
        if (friendly !== null) {
          pushRenderedLines(result, ["    " + A.fgSubtext + truncate(friendly, chatCols - 6) + A.reset], msg);
        } else if (isDiffTool && (outStr.includes("@@") || outStr.includes("+++") || outStr.includes("---"))) {
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
          // Successful commands: a short output keeps its tail, a long one is
          // summarized to ONE row plus the viewer hint. Hundreds of progress
          // lines must never flood the main transcript.
          const lines = outStr.trim().split("\n").filter((l) => l.trim().length > 0);
          if (lines.length > RUN_OUTPUT_INLINE_MAX_LINES) {
            pushRenderedLines(result, [
              "    " + A.fgSubtext + A.dim + `${lines.length} lines · Ctrl+O to view` + A.reset,
            ], msg);
          } else if (lines.length > 0) {
            const maxSummaryLines = chatCols < 60 ? 1 : 3;
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

    // Canonical content stays raw Markdown; the caret is a VIEW-only glyph and
    // is appended per line so an in-flight trailing marker can be suppressed.
    const cleanContent = redactOutputSecrets(msg.content || "");
    const rawLines = cleanContent.split("\n");

    let inCodeBlock = false;
    let codeLang = "";
    let inThoughtBlock = false;

    // Pre-scan pipe tables (outside fences) so an oversized report renders as a
    // compact summary + viewer hint instead of a wrapped 8-column grid.
    const tableSpans = scanMarkdownTables(rawLines);

    for (let lIdx = 0; lIdx < rawLines.length; lIdx++) {
      let rawLine = rawLines[lIdx];

      // Streaming safety: the newest line may still be missing its closing
      // marker. Suppress the partial run for DISPLAY only — `msg.content` and
      // the session keep the canonical text, and the marker appears the moment
      // its pair arrives. No `**`/`***` ever flashes in the transcript.
      if (!inCodeBlock && !inThoughtBlock && isStreamingAssistant && lIdx === rawLines.length - 1) {
        rawLine = stripInFlightMarkers(rawLine).text + S.caretBar;
      }

      // Code block and syntax formatting
      if (rawLine.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        const linePrefix = lIdx === 0 ? prefix : prefixIndent;
        if (inCodeBlock) {
          codeLang = rawLine.trim().slice(3).toLowerCase();
          pushRenderedLines(result, [msgBg + linePrefix + A.fgBorder + S.box.topLeft + S.box.horizontal + " " + A.fgCyan + (codeLang || "code") + " " + S.box.horizontal.repeat(Math.max(0, wrapWidth - 8 - (codeLang || "code").length)) + A.reset], msg);
          continue;
        } else {
          pushRenderedLines(result, [msgBg + linePrefix + A.fgBorder + S.box.bottomLeft + S.box.horizontal.repeat(Math.max(0, wrapWidth - 2)) + A.reset], msg);
          continue;
        }
      }

      // ── Block-level Markdown (never inside a fence) ──
      if (!inCodeBlock && !inThoughtBlock) {
        // Responsive table: aligned grid when it fits, stacked cards when the
        // terminal is narrow, summary + viewer hint when it is long.
        const span = tableSpans.get(lIdx);
        if (span) {
          const renderedTable = renderResponsiveTable(span.table, wrapWidth);
          const linePrefix = lIdx === 0 ? prefix : prefixIndent;
          for (const row of renderedTable.lines) {
            pushRenderedLines(result, [msgBg + linePrefix + row + A.reset], msg);
          }
          if (renderedTable.viewerHint) {
            // The hint promises “Ctrl+O for details” — hand the pager the
            // untouched, never-styled source rows so it renders the whole
            // table (header + every row) with line numbers.
            msgTableFullLines = tableToLines(span.table);
            tuiState.noteDetailLines("Table", msgTableFullLines);
            pushRenderedLines(result, [msgBg + prefixIndent + renderedTable.viewerHint + A.reset], msg);
          }
          lIdx = span.end - 1;
          continue;
        }

        // Horizontal rule: `***` / `---` / `___` alone on a line render as a
        // thin divider instead of three raw marker characters.
        if (isHorizontalRule(rawLine)) {
          const linePrefix = lIdx === 0 ? prefix : prefixIndent;
          pushRenderedLines(result, [msgBg + linePrefix + renderMarkdownDivider(wrapWidth - 2) + A.reset], msg);
          continue;
        }

        // ATX heading: hierarchy by weight/color, not by repeating `#`.
        const heading = parseHeading(rawLine);
        if (heading) {
          const linePrefix = lIdx === 0 ? prefix : prefixIndent;
          pushRenderedLines(result, [msgBg + linePrefix + renderHeading(heading.level, heading.text) + A.reset], msg);
          continue;
        }
      }

      let bulletPrefix = "";
      if (!inCodeBlock && !inThoughtBlock) {
        const bullet = parseBullet(rawLine);
        if (bullet) {
          bulletPrefix = bullet.indent + normalizeBulletMarker(bullet.marker) + " ";
          rawLine = bullet.text;
        }
      }

      const formattedLine = !inCodeBlock && !inThoughtBlock
        ? bulletPrefix + formatInlineMarkdown(rawLine, A.fgText)
        : rawLine;
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
            // Low-density code highlighting: keywords only. Recoloring every
            // literal and string turned code blocks into a color mosaic; the
            // body stays ivory so the code itself is what you read.
            content = content
              .replace(/\b(const|let|var|function|class|return|if|else|for|while|import|from|export|async|await|try|catch)\b/g, A.fgBlue + "$1" + A.fgText);
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

    // Generic long-result policy: if ONE message painted beyond the transcript
    // budget, keep its head, replace the tail with one summary row, and hand
    // the full content to the Ctrl+O detail viewer. Skips the streaming draft
    // (transient) and user messages (collapsed by their own rule above).
    if (!isStreamingAssistant && !isUser && result.lines.length - msgStartIdx > TRANSCRIPT_RESULT_MAX_ROWS + 1) {
      const segment = result.lines.splice(msgStartIdx);
      const ids = result.messageIds.splice(msgStartIdx);
      const kept = segment.slice(0, TRANSCRIPT_RESULT_MAX_ROWS);
      // The compaction summary is the hint closest to the user, so its promise
      // wins: the detail viewer gets the WHOLE rendered message plus the full
      // source rows of any summarized table — nothing is lost, only relocated.
      const detailLines = [
        ...segment.map(stripAnsiSafe),
        ...(msgTableFullLines ? ["", ...msgTableFullLines] : []),
      ];
      tuiState.noteDetailLines(msg.role === "assistant" ? "Response details" : "Output details", detailLines);
      const hidden = segment.length - TRANSCRIPT_RESULT_MAX_ROWS - 1;
      result.lines.push(...kept, buildResultCompactionSummary(hidden, segment.length), "");
      result.messageIds.push(...ids.slice(0, TRANSCRIPT_RESULT_MAX_ROWS), msg.id ?? null, msg.id ?? null);
    }
  }

  return result;
}

/** stripAnsi re-export guard for the compaction path (keeps imports local). */
function stripAnsiSafe(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
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
