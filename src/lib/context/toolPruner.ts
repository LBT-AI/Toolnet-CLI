import type { ContextMessage, PruneOptions } from "./types";
import { estimateMessageChars, estimateMessageTokens, estimateTokens } from "./tokenEstimator";

const DEFAULT_MAX_TOOL_RESULT_CHARS = 600;
const DEFAULT_KEEP_RECENT_TOOLS_COUNT = 3;

/**
 * Prunes large tool outputs from older turns while strictly maintaining:
 * 1. 1-to-1 matching tool_call_id pairs.
 * 2. Error details and status codes.
 * 3. Recent active tool executions in full fidelity.
 */
export function pruneOldToolResults(
  messages: ContextMessage[],
  options?: PruneOptions
): {
  messages: ContextMessage[];
  prunedCount: number;
  savedChars: number;
  savedTokens: number;
} {
  const maxChars = options?.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const keepRecent = options?.keepRecentToolsCount ?? DEFAULT_KEEP_RECENT_TOOLS_COUNT;
  const preserveErrors = options?.alwaysPreserveErrors ?? true;

  // Identify all tool message indices
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      toolIndices.push(i);
    }
  }

  if (toolIndices.length <= keepRecent) {
    return {
      messages: [...messages],
      prunedCount: 0,
      savedChars: 0,
      savedTokens: 0,
    };
  }

  const pruneBoundaryIdx = toolIndices[toolIndices.length - keepRecent];
  let prunedCount = 0;
  let savedChars = 0;
  let savedTokens = 0;

  const resultMessages: ContextMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== "tool" || i >= pruneBoundaryIdx || (msg.pruned ?? false)) {
      resultMessages.push(msg);
      continue;
    }

    const rawContent = msg.content || "";
    if (rawContent.length <= maxChars) {
      resultMessages.push(msg);
      continue;
    }

    const origChars = rawContent.length;
    const origTokens = estimateMessageTokens(msg);

    let parsed: any = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch {}

    let isError = false;
    let toolName = msg.name || "tool";
    let summaryText = "";

    if (parsed && typeof parsed === "object") {
      const exitCode = parsed.exitCode ?? 0;
      const stdout = String(parsed.stdout || "");
      const stderr = String(parsed.stderr || "");
      isError = exitCode !== 0 || Boolean(stderr);

      if (isError && preserveErrors) {
        // For errors, keep stderr and truncate stdout
        const truncatedStdout = stdout.length > 200 ? stdout.slice(0, 200) + "... [truncated]" : stdout;
        summaryText = JSON.stringify({
          stdout: truncatedStdout,
          stderr: stderr.slice(0, 400),
          exitCode,
          _pruned: true,
        });
      } else {
        // Success case with large output: summarize line count or key header
        const lines = stdout.split("\n");
        const preview = lines.slice(0, 3).join("\n").slice(0, 150);
        const lineCount = lines.length;
        const charCount = stdout.length;

        summaryText = JSON.stringify({
          stdout: `[Tool result pruned: ${lineCount} lines, ${charCount} chars. Initial content: "${preview}..."]`,
          stderr: "",
          exitCode: 0,
          _pruned: true,
        });
      }
    } else {
      // Plain text tool output
      const preview = rawContent.slice(0, 150).replace(/\n+/g, " ");
      summaryText = `[Tool output pruned (${rawContent.length} chars). Preview: "${preview}..."]`;
    }

    const prunedMsg: ContextMessage = {
      ...msg,
      content: summaryText,
      pruned: true,
    };

    resultMessages.push(prunedMsg);
    prunedCount++;
    savedChars += Math.max(0, origChars - summaryText.length);
    savedTokens += Math.max(0, origTokens - estimateMessageTokens(prunedMsg));
  }

  return {
    messages: resultMessages,
    prunedCount,
    savedChars,
    savedTokens,
  };
}
