/**
 * THE token estimator.
 *
 * There is exactly one implementation of "how big is this text" so a future
 * change cannot fix budgeting in one place and leave another path dividing by
 * four. It also carries provenance: callers receive `{tokens, confidence,
 * source}` and must not treat an estimate as exact.
 *
 * Provider-reported usage is the only exact signal available, and it is evidence
 * about a request that has ALREADY been made — the prompt shape, tool schemas
 * and attachments of the next request are not guaranteed identical. It is
 * therefore used only to nudge a bounded calibration factor, never to overwrite
 * a historical measurement.
 */

import type { Confidence, TokenEstimate } from "./types";

/** Bounds keep a single odd measurement from distorting future estimates. */
const MIN_CALIBRATION = 0.6;
const MAX_CALIBRATION = 1.6;
const CALIBRATION_ALPHA = 0.3;
const MAX_TRACKED_MODELS = 64;

/** Message envelope cost (role + separators) charged per message. */
const MESSAGE_ENVELOPE_TOKENS = 4;
const TOOL_CALL_ENVELOPE_TOKENS = 8;
const CONVERSATION_PRIMING_TOKENS = 3;

export interface EstimatableMessage {
  role?: string;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

function heuristicTokens(text: string): number {
  const len = text.length;
  if (len === 0) return 0;

  // Multibyte scripts pack fewer characters per token; sampling a prefix keeps
  // this O(1) for very large tool outputs.
  let nonAscii = 0;
  const sample = Math.min(len, 2000);
  for (let i = 0; i < sample; i++) {
    if (text.charCodeAt(i) > 127) nonAscii++;
  }
  const charsPerToken = nonAscii / sample > 0.3 ? 2.2 : 3.8;

  let tokens = Math.ceil(len / charsPerToken);
  // Dense punctuation (code, JSON) tokenizes worse than prose.
  if (text.includes("```") || (text.startsWith("{") && text.endsWith("}"))) {
    tokens = Math.ceil(tokens * 1.05);
  }
  return Math.max(1, tokens);
}

export class TokenEstimator {
  private readonly calibration = new Map<string, number>();

  private key(model?: string): string {
    return (model ?? "default").toLowerCase();
  }

  /** Current calibration multiplier applied to raw heuristics for a model. */
  factorFor(model?: string): number {
    return this.calibration.get(this.key(model)) ?? 1;
  }

  estimateText(text: string | null | undefined, model?: string): TokenEstimate {
    if (!text) return { tokens: 0, confidence: "low", source: "estimated" };
    const raw = heuristicTokens(text);
    const scaled = Math.max(1, Math.round(raw * this.factorFor(model)));
    return { tokens: scaled, confidence: "low", source: "estimated" };
  }

  estimateMessage(message: EstimatableMessage, model?: string): TokenEstimate {
    let tokens = MESSAGE_ENVELOPE_TOKENS;
    if (message.content) tokens += this.estimateText(message.content, model).tokens;
    if (message.name) tokens += this.estimateText(message.name, model).tokens + 1;
    if (message.tool_call_id) tokens += this.estimateText(message.tool_call_id, model).tokens + 1;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        tokens += TOOL_CALL_ENVELOPE_TOKENS;
        if (call?.function?.name) tokens += this.estimateText(call.function.name, model).tokens;
        if (call?.function?.arguments) tokens += this.estimateText(call.function.arguments, model).tokens;
      }
    }
    return { tokens, confidence: "low", source: "estimated" };
  }

  estimateMessages(messages: EstimatableMessage[], model?: string): TokenEstimate {
    let tokens = CONVERSATION_PRIMING_TOKENS;
    for (const message of messages) tokens += this.estimateMessage(message, model).tokens;
    return { tokens, confidence: "low", source: "estimated" };
  }

  /**
   * Fold a provider-reported prompt size back into the calibration factor.
   *
   * This is a *bounded* correction, applied per model. A reported value of zero
   * (provider omitted usage) is ignored rather than treated as an empty prompt.
   */
  observeProviderUsage(input: { model?: string; estimatedInputTokens: number; actualPromptTokens: number }): void {
    const { model, estimatedInputTokens, actualPromptTokens } = input;
    if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens <= 0) return;
    if (!Number.isFinite(actualPromptTokens) || actualPromptTokens <= 0) return;

    const key = this.key(model);
    const observed = clamp(actualPromptTokens / estimatedInputTokens, MIN_CALIBRATION, MAX_CALIBRATION);
    const previous = this.calibration.get(key);
    const next = previous === undefined ? observed : previous * (1 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA;
    this.calibration.set(key, clamp(next, MIN_CALIBRATION, MAX_CALIBRATION));

    if (this.calibration.size > MAX_TRACKED_MODELS) {
      const oldest = this.calibration.keys().next().value;
      if (oldest !== undefined) this.calibration.delete(oldest);
    }
  }

  /** Mark a value that came from the provider for the completed request. */
  fromProviderUsage(actualPromptTokens: number): TokenEstimate {
    return {
      tokens: Math.max(0, Math.floor(actualPromptTokens)),
      confidence: "exact",
      source: "provider_usage",
    };
  }

  reset(): void {
    this.calibration.clear();
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.calibration);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export const tokenEstimator = new TokenEstimator();

/** Convenience for call sites that only need a number. */
export function estimateTokens(text: string | null | undefined, model?: string): number {
  return tokenEstimator.estimateText(text, model).tokens;
}

export function estimateMessages(messages: EstimatableMessage[], model?: string): number {
  return tokenEstimator.estimateMessages(messages, model).tokens;
}

export function estimateConfidence(): Confidence {
  return "low";
}
