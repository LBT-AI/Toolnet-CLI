import type { ContextMessage } from "./types";

/**
 * Fast & accurate heuristic token estimator.
 * Handles English, code tokens, whitespace, JSON schemas, and multi-byte UTF-8 (Vietnamese, CJK).
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const len = text.length;
  if (len === 0) return 0;

  // Detect proportion of non-ASCII characters (Vietnamese, East Asian, symbols)
  let nonAsciiCount = 0;
  const sampleSize = Math.min(len, 2000);
  for (let i = 0; i < sampleSize; i++) {
    if (text.charCodeAt(i) > 127) {
      nonAsciiCount++;
    }
  }

  const nonAsciiRatio = nonAsciiCount / sampleSize;
  
  // Base char/token ratio: English/Code ~ 3.8 chars/token, CJK/multibyte ~ 1.5 - 2.2 chars/token
  const charsPerToken = nonAsciiRatio > 0.3 ? 2.2 : 3.8;
  
  // Base token count
  let tokens = Math.ceil(len / charsPerToken);

  // Add slight penalty for complex JSON / symbol sequences
  if (text.includes("```") || (text.startsWith("{") && text.endsWith("}"))) {
    tokens = Math.ceil(tokens * 1.05);
  }

  return Math.max(1, tokens);
}

/**
 * Estimates token count for a single message including role and tool_calls metadata.
 */
export function estimateMessageTokens(msg: ContextMessage): number {
  // Base envelope overhead per message (OpenAI/Anthropic standard ~4 tokens)
  let tokens = 4;

  if (msg.content) {
    tokens += estimateTokens(msg.content);
  }

  if (msg.name) {
    tokens += estimateTokens(msg.name) + 1;
  }

  if (msg.tool_call_id) {
    tokens += estimateTokens(msg.tool_call_id) + 1;
  }

  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      tokens += 8; // Tool call envelope overhead
      if (tc.function?.name) tokens += estimateTokens(tc.function.name);
      if (tc.function?.arguments) tokens += estimateTokens(tc.function.arguments);
    }
  }

  return tokens;
}

/**
 * Estimates total tokens for an entire array of messages.
 */
export function estimateTotalTokens(messages: ContextMessage[]): number {
  let total = 3; // Priming tokens for conversation
  for (const m of messages) {
    total += estimateMessageTokens(m);
  }
  return total;
}

/**
 * Estimates raw character length across all message content and metadata.
 */
export function estimateMessageChars(messages: ContextMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += (m.content || "").length;
    if (m.name) total += m.name.length;
    if (m.tool_calls) {
      try {
        total += JSON.stringify(m.tool_calls).length;
      } catch {
        total += 50;
      }
    }
  }
  return total;
}
