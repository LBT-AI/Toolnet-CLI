/**
 * Unbacked side-effect claim detection.
 *
 * Video repro: the model printed a code block and answered "Tôi đã tạo file
 * Python cho bạn..." while test.py never existed — the model NARRATED a file
 * mutation without ever emitting a tool call. The agent loop correctly treated
 * the answer as final (nothing to execute, nothing to verify), so the false
 * claim reached the user unchallenged.
 *
 * This module catches that exact failure mode at the agent-loop level. It is
 * deliberately NOT the primary correctness mechanism (tools + postcondition
 * verification are) — it is a safety net that catches models which ignore the
 * tool-calling contract despite the system prompt, and gives them ONE chance
 * to convert the claim into real tool calls before the answer ships.
 *
 * Detection is intentionally narrow to avoid false positives:
 *  - the answer must CONTAIN a fenced code block (model produced code), and
 *  - the model must claim file-mutation success in prose, and
 *  - the turn must NOT have executed any mutating tool (verified above by
 *    the real executor + postconditions).
 */

/** Languages the guard treats as code blocks likely intended as file content. */
const FENCE_RE = /```[\w+-]*\r?\n[\s\S]*?\r?\n```|```[\w+-]*\r?\n[\s\S]*$/;

/** Claim phrases: EN + VI, first person, file/dir mutation completed. */
const CLAIM_PATTERNS: RegExp[] = [
  // English
  /\b(i(?:'ve| have|'ve)?\s+(?:created|saved|written|wrote|made|generated|added|updated|modified|edited))\b/i,
  /\b(file (?:has been|was|is) (?:created|saved|written|updated))\b/i,
  /\b(created|saved|written)\s+(?:the\s+)?(?:file|script|module|component|config)\b/i,
  // Vietnamese — diacritic and unaccented variants. Alternations must list
  // BOTH spellings: đ(?:ã|a) matches only đã/đa, never the plain "da".
  /\bt(?:ô|o)i\s+(?:đã|da)\s+t(?:ạ|a)o\b/i,
  /\b(?:đã|da)\s+t(?:ạ|a)o(?:\s+file|\s+th(?:ư|u)\s+m(?:ụ|u)c)?\b/i,
  /\bt(?:ạ|a)o\s+(?:file|t(?:ệ|e)p)\s*(?:nh(?:é|e)|r(?:ồ|o)i|xong)\b/i,
  /\b(?:đã|da)\s+(?:l(?:ư|u)u|ghi|c(?:ậ|a)p\s+n(?:ậ|a)t)\b/i,
];

export interface ClaimScanResult {
  /** True when the answer looks like an unbacked mutation claim. */
  suspected: boolean;
  /** Matched claim phrase (for the corrective nudge message). */
  matchedPhrase?: string;
}

export function scanForUnbackedClaim(answerText: string): ClaimScanResult {
  if (!answerText || typeof answerText !== "string") return { suspected: false };

  const hasCodeBlock = FENCE_RE.test(answerText);
  if (!hasCodeBlock) return { suspected: false };

  for (const re of CLAIM_PATTERNS) {
    const m = answerText.match(re);
    if (m) {
      return { suspected: true, matchedPhrase: m[0] };
    }
  }
  return { suspected: false };
}

/**
 * Build the corrective system nudge sent back to the model when an unbacked
 * claim is detected. One retry — the model must either call the tool for real
 * or reword its answer truthfully.
 */
export function buildClaimGuardNudge(matchedPhrase: string, workspaceHint: string): string {
  return [
    "[CORRECTION REQUIRED — side-effect claim without tool execution]",
    "",
    `Your latest answer contains the phrase "${matchedPhrase}" while also presenting code,`,
    "but NO file-mutating tool (write_file / edit_file / apply_patch) has executed in this turn.",
    "",
    "The user cannot use a file that was never written. Choose ONE:",
    `  1. If the user wanted the file on disk: call write_file now with the full content (workspace root: ${workspaceHint}), then confirm only after the tool result returns success.`,
    "  2. If the user only asked to SEE the code: rewrite your answer to say you are PROVIDING the code, and remove all claims that a file was created/saved.",
    "",
    "Never claim a side effect that no tool has performed.",
  ].join("\n");
}
