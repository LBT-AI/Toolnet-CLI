/**
 * The model call behind a compaction checkpoint.
 *
 * The compaction layer builds the prompt and never touches a provider, so the
 * adapter call lives here, next to the only other place that assembles provider
 * requests. Two properties are load-bearing:
 *
 *  - TOOLS ARE DISABLED. A summarizer holding tools keeps working instead of
 *    reporting, which would turn "compact the history" into "start a new task
 *    with the old one as context".
 *  - The output is bounded (`maxTokens`). A summary is a summary; letting it run
 *    to the model's full output allowance reintroduces the cost it just removed.
 */

import type { Provider } from "../../providers";
import { ModelAdapter } from "./modelAdapter";

export interface CheckpointSummarizerOptions {
  provider: Provider;
  model: string;
  signal?: AbortSignal;
  /** Extra headers forwarded to the provider (kept for parity with the loop). */
  headers?: Record<string, string>;
}

/**
 * Build the `summarizeWithModel` callback handed to `ContextEngine`.
 *
 * Failures are the caller's to interpret: the compaction pipeline treats a
 * rejected summary as "fall back to the deterministic checkpoint", not as a
 * failed turn.
 */
export function makeCheckpointSummarizer(
  options: CheckpointSummarizerOptions,
): (request: { prompt: string; maxTokens: number }) => Promise<string> {
  const adapter = new ModelAdapter(options.provider);
  return async (request) => {
    const response = await adapter.complete({
      model: options.model,
      messages: [{ role: "user", content: request.prompt }],
      // Explicitly empty: no tool schema reaches the summarizer at all.
      tools: [],
      toolChoice: "none",
      maxTokens: request.maxTokens,
      temperature: 0,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    return response.content ?? "";
  };
}
