/**
 * The optional model call behind a session title.
 *
 * Titling is a background nicety: the deterministic title in
 * `lib/sessionTitle` is the fallback and needs no provider at all. When a model
 * is available this produces the tighter, task-shaped label ("Build
 * Mercedes-AMG WordPress page" instead of the first line of the prompt).
 *
 * Same two load-bearing properties as the checkpoint summarizer:
 *  - TOOLS ARE DISABLED — a titler holding tools would start working instead of
 *    labelling.
 *  - The output is bounded (`maxTokens`). A title is one line; anything longer
 *    is rejected by `sanitizeGeneratedTitle`.
 */

import type { Provider } from "../../providers";
import { ModelAdapter } from "./modelAdapter";
import type { TitleGenerator } from "../autoTitle";

export const TITLE_MAX_TOKENS = 64;
/** Only the head of the prompt is needed to name the task; never ship a paste. */
export const TITLE_PROMPT_MAX_CHARS = 600;

export const TITLE_SYSTEM_PROMPT =
  "You name coding sessions. Reply with a single short title of 4 to 8 words that states the " +
  "main action and its object (for example: \"Fix TUI scroll jitter\", \"Build Mercedes-AMG " +
  "WordPress page\"). Name the task itself, not the conversation. Never copy the prompt " +
  "verbatim, never add quotes, markdown, labels, punctuation at the end, or newlines. " +
  "Reply with the title only.";

export interface TitleGeneratorOptions {
  provider: Provider;
  model: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function buildTitlePrompt(prompt: string): string {
  const head = prompt.trim().slice(0, TITLE_PROMPT_MAX_CHARS);
  return `${TITLE_SYSTEM_PROMPT}\n\nUser message:\n${head}`;
}

/**
 * Build a `TitleGenerator`. Rejections are expected and harmless: the caller
 * falls back to the deterministic title.
 */
export function makeTitleGenerator(options: TitleGeneratorOptions): TitleGenerator {
  const adapter = new ModelAdapter(options.provider);
  return async (prompt: string) => {
    const response = await adapter.complete({
      model: options.model,
      messages: [{ role: "user", content: buildTitlePrompt(prompt) }],
      // Explicitly empty: no tool schema reaches the titler at all.
      tools: [],
      toolChoice: "none",
      maxTokens: TITLE_MAX_TOKENS,
      temperature: 0,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    return response.content ?? null;
  };
}
