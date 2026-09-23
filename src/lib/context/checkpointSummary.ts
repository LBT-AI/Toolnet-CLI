/**
 * Compaction checkpoint — the model-facing summary of the conversation HEAD.
 *
 * Compaction is LOSSY on purpose: the durable session keeps every message, but
 * the model continues from a checkpoint (`summary + recent`) instead of the raw
 * transcript. This module owns the two halves of producing that checkpoint that
 * are pure text work — serializing the head into something a summarizer can
 * read, and the prompt that constrains the answer.
 *
 * Two rules shape the prompt:
 *  - The head is bounded. A tool result is capped, and anything that is really a
 *    blob (a data URI, a base64 payload) becomes a DESCRIPTION rather than being
 *    copied into the summary, so one huge output cannot re-inflate the context
 *    it was just removed from.
 *  - A previous checkpoint is an INPUT, not a starting point to be re-derived.
 *    It is handed over as `<prior-summary>` next to the new `<conversation>`, and
 *    the prompt states plainly that it will be discarded afterwards, so whatever
 *    still matters has to be carried into the new summary.
 */

import type { ContextMessage } from "./types";

/** The answer is a summary, not a task: it gets a bounded budget. */
export const SUMMARY_MAX_TOKENS = 4_096;

/** Per-tool-output cap for the serialized head. */
export const SUMMARY_TOOL_RESULT_CHAR_CAP = 2_000;

/** Cap for a single tool call's rendered arguments. */
export const SUMMARY_TOOL_ARGS_CHAR_CAP = 400;

/** Marker that makes a checkpoint summary recognizable at the head of a list. */
export const CHECKPOINT_SUMMARY_MARKER = "[Context Compaction Summary]";

/** The sections the summarizer must produce, in order. */
export const CHECKPOINT_SUMMARY_SECTIONS = [
  "## Objective",
  "## Important Details",
  "## Work State",
  "### Completed",
  "### Active",
  "### Blocked",
  "## Next Move",
  "## Relevant Files",
] as const;

/**
 * A payload, not prose: the base64 alphabet only, with line breaks allowed but
 * NO spaces or tabs. Requiring the absence of spaces is what keeps ordinary long
 * text (which is full of them) out of this branch.
 */
const BASE64_BLOB = /^[A-Za-z0-9+/=\r\n]{512,}$/;

const DATA_URI = /^data:([^;,]{1,80})?(;base64)?,/;

/** True when content is a media/blob payload that must not be copied verbatim. */
export function looksLikeAttachment(content: string): boolean {
  if (DATA_URI.test(content)) return true;
  if (content.length < 512) return false;
  // A long run of base64 alphabet with no spaces is a payload, not prose.
  return BASE64_BLOB.test(content);
}

/**
 * Describe a blob instead of embedding it: the summary needs to know WHAT was
 * attached, not carry the bytes forward.
 */
export function describeAttachment(content: string): string {
  const dataUri = DATA_URI.exec(content);
  if (dataUri) {
    const mime = dataUri[1] || "application/octet-stream";
    const base64 = content.slice(dataUri[0].length);
    return `[attachment: ${mime}, ${base64.length} base64 chars — contents omitted from the summary]`;
  }
  return `[attachment: ${content.length} bytes of binary/encoded data — contents omitted from the summary]`;
}

/** Bound a tool result, keeping the head and stating exactly what was dropped. */
export function capToolResult(content: string, cap = SUMMARY_TOOL_RESULT_CHAR_CAP): string {
  if (looksLikeAttachment(content)) return describeAttachment(content);
  if (content.length <= cap) return content;
  const omitted = content.length - cap;
  return `${content.slice(0, cap)}\n… [${omitted} more characters omitted from the summary]`;
}

function oneLine(text: string, cap: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length <= cap) return flattened;
  return `${flattened.slice(0, cap)}…`;
}

function renderToolCalls(message: ContextMessage): string[] {
  const lines: string[] = [];
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name || "tool";
    const args = oneLine(call.function?.arguments || "{}", SUMMARY_TOOL_ARGS_CHAR_CAP);
    lines.push(`[Assistant tool call]: ${name}(${args})`);
  }
  return lines;
}

/**
 * Render the head of the conversation as plain text.
 *
 * The previous checkpoint is skipped when it appears here — it travels
 * separately as `<prior-summary>` so it is never summarized twice.
 */
export function serializeHeadTranscript(
  messages: ContextMessage[],
  options: { priorSummary?: string; maxToolResultChars?: number } = {},
): string {
  const cap = options.maxToolResultChars ?? SUMMARY_TOOL_RESULT_CHAR_CAP;
  const prior = options.priorSummary?.trim();
  const blocks: string[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (prior && content.trim() === prior) continue;

    switch (message.role) {
      case "user":
        blocks.push(`[User]: ${content}`);
        break;
      case "assistant": {
        if (content.trim()) blocks.push(`[Assistant]: ${content}`);
        blocks.push(...renderToolCalls(message));
        break;
      }
      case "tool": {
        const label = message.name ? `[Tool result: ${message.name}]` : "[Tool result]";
        blocks.push(`${label}: ${capToolResult(content, cap)}`);
        break;
      }
      default:
        blocks.push(`[${message.role}]: ${content}`);
    }
  }

  return blocks.join("\n\n");
}

export interface SummaryPromptInput {
  /** Serialized head, from `serializeHeadTranscript`. */
  headTranscript: string;
  /** The checkpoint being replaced, when this is not the first compaction. */
  priorSummary?: string;
}

/**
 * The summarization prompt. `tools` are disabled by the caller: a summarizer
 * that can call tools would keep working instead of reporting.
 */
export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const prior = input.priorSummary?.trim();
  const parts: string[] = [
    "You are compacting the EARLIER part of a coding session so the agent can continue with less context.",
    "Later messages are still available to you verbatim; summarize only what is given below.",
    "",
  ];

  if (prior) {
    parts.push(
      "<prior-summary>",
      prior,
      "</prior-summary>",
      "",
      "The prior summary above is being REPLACED by your answer and will be discarded after this step.",
      "Anything from it that is still needed must be carried into your new summary; anything you leave out is lost.",
      "",
    );
  }

  parts.push(
    "<conversation>",
    input.headTranscript,
    "</conversation>",
    "",
    "Produce the summary using EXACTLY this structure:",
    ...CHECKPOINT_SUMMARY_SECTIONS,
    "",
    "Rules:",
    "- Keep identifiers verbatim: file paths, commands, error strings, URLs, symbol and function names, versions, ids, environment variables.",
    "- State what was actually done and verified, not what was intended.",
    "- Put still-open work under ### Active, and real blockers (missing access, unresolved errors, decisions needed) under ### Blocked.",
    "- ## Next Move must be a concrete next action, not a restatement of the objective.",
    "- ## Relevant Files lists the files that still matter, with a short note on why.",
    "- Do not invent facts, paths, or results that are not in the conversation.",
    "- Do not include a preamble, a sign-off, or any commentary about the summary itself.",
  );

  return parts.join("\n");
}
