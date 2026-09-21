/**
 * Deterministic greeting fast-path.
 *
 * A bare greeting ("hello", "xin chào", ...) is answered locally with a fixed
 * one-line reply instead of a model round-trip, so the reply can never grow
 * into a capability brochure. Matching is an exact lookup against a closed
 * set after normalization — no fuzzy matching — so any input carrying a real
 * task ("hello sửa package.json") falls through to the agent.
 */

const GREETINGS = new Set([
  "hello",
  "helo", // common typo
  "hi",
  "hey",
  "hello there",
  "hi there",
  "hey there",
  "xin chào",
  "xin chao",
  "chào",
  "chao",
  "chào bạn",
  "chao ban",
]);

/** Trim, lowercase, NFC-normalize, collapse whitespace, drop trailing punctuation. */
function normalizeGreeting(input: string): string {
  return input
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s!.,?~]+$/u, "");
}

export function isGreetingOnly(input: string): boolean {
  return GREETINGS.has(normalizeGreeting(input));
}

export function greetingReply(workspace: string): string {
  return `Hello. I'm ToolNet. What would you like help with in ${workspace}?`;
}

/** Returns the canned reply for a greeting-only input, or null to use the agent. */
export function matchGreetingFastPath(input: string, workspace: string): string | null {
  return isGreetingOnly(input) ? greetingReply(workspace) : null;
}
