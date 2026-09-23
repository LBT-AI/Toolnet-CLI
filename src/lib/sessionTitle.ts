/**
 * Session-title text rules (pure; no store, no I/O).
 *
 * A session is created untitled. The workspace/project name is a DISPLAY
 * fallback only — it is never persisted as a real title. The first
 * *substantive* user task asks for a short title in the background; the
 * canonical `title` field on the session record is the single durable home for
 * it (see `lib/autoTitle`).
 *
 * Everything here is deterministic and offline so a title can always be
 * produced without a model round-trip.
 */

import { isGreetingOnly } from "./greeting";

/** Titles are scannable labels, not prompts: keep them short. */
export const AUTO_TITLE_MAX_WORDS = 8;
export const AUTO_TITLE_MAX_CHARS = 60;
/** Shorter than this is not a title, it is noise. */
export const AUTO_TITLE_MIN_CHARS = 3;
/** Preview shown by the picker when a session still has no title. */
export const SESSION_PREVIEW_MAX_CHARS = 60;

/**
 * Inputs that carry no task. A closed set after normalization — same discipline
 * as the greeting fast path: any input with real work in it ("ok sửa giúp tôi
 * file này") falls through and DOES get a title.
 */
const NON_TASK_INPUTS = new Set([
  // acknowledgements
  "ok",
  "oke",
  "okay",
  "okie",
  "k",
  "kk",
  "yes",
  "y",
  "yeah",
  "yep",
  "no",
  "nope",
  "sure",
  "got it",
  "noted",
  "done",
  "xong",
  "được",
  "duoc",
  "đồng ý",
  "dong y",
  // thanks
  "thanks",
  "thank you",
  "thx",
  "ty",
  "cảm ơn",
  "cam on",
  "cảm ơn bạn",
  "cam on ban",
  "cám ơn",
  "cam on nhe",
  // continuation nudges
  "continue",
  "go on",
  "keep going",
  "carry on",
  "next",
  "proceed",
  "tiếp",
  "tiep",
  "tiếp tục",
  "tiep tuc",
  "tiếp đi",
  "tiep di",
  "làm tiếp",
  "lam tiep",
  "đi tiếp",
  "di tiep",
  "next step",
  // fillers / probes
  "test",
  "testing",
  "ping",
  "hmm",
  "uhm",
  "ừ",
  "uh",
  "à",
  "vâng",
  "dạ",
]);

/**
 * Conversational filler stripped from the FRONT of a title. Verbs are kept on
 * purpose — "Fix TUI scroll jitter" is a better title than "TUI scroll jitter".
 */
const LEADING_FILLERS = [
  "cho tôi",
  "cho toi",
  "cho mình",
  "cho minh",
  "giúp tôi",
  "giup toi",
  "giúp mình",
  "giup minh",
  "hãy giúp tôi",
  "hay giup toi",
  "làm ơn",
  "lam on",
  "hãy",
  "hay",
  "please",
  "kindly",
  "can you",
  "could you",
  "would you",
  "i want you to",
  "i want to",
  "i need you to",
  "i need to",
  "tôi muốn",
  "toi muon",
  "mình muốn",
  "minh muon",
  "tôi cần",
  "toi can",
  "mình cần",
  "minh can",
];

/** Normalize for closed-set lookup: NFC, trim, lowercase, collapse, de-punctuate. */
function normalizeForLookup(input: string): string {
  return input
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s!.,?~;:]+$/u, "");
}

/** True when the input is real work rather than a greeting/ack/nudge. */
export function isSubstantiveTask(input: string): boolean {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return false;
  if (isGreetingOnly(text)) return false;
  const normalized = normalizeForLookup(text);
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false; // a command is not a task
  if (NON_TASK_INPUTS.has(normalized)) return false;
  return normalized.length >= AUTO_TITLE_MIN_CHARS;
}

/** First line that actually carries text (skips blanks and code fences). */
function firstMeaningfulLine(input: string): string {
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(`{3,}|~{3,})/.test(line)) continue;
    return line;
  }
  return "";
}

/** Remove markdown/quoting noise that should never reach a title. */
function stripMarkup(input: string): string {
  return input
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "") // heading / quote / bullet / list
    .replace(/^\[[ xX]\]\s*/, "") // task-list checkbox
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links keep their text
    .replace(/[*_~`]+/g, "") // emphasis + inline code
    .replace(/\|/g, " "); // table pipes
}

/** Strip one leading conversational filler (case-insensitive, word-bounded). */
function stripLeadingFillers(input: string): string {
  let text = input.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const lower = text.toLowerCase();
    for (const filler of LEADING_FILLERS) {
      if (!lower.startsWith(filler)) continue;
      const rest = text.slice(filler.length);
      // Only strip when it is a whole word boundary ("hãy..." vs "hãyX…").
      if (rest && !/^[\s,.:;!?…-]/.test(rest)) continue;
      text = rest.replace(/^[\s,.:;!?…-]+/, "");
      changed = true;
      break;
    }
  }
  return text;
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return trimmed.replace(/[\s,.:;!?…-]+$/u, "");
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Deterministic title from a prompt. Returns null when the input carries no
 * task, which is the signal to leave the session untitled.
 */
export function buildDeterministicTitle(input: string): string | null {
  if (!isSubstantiveTask(input)) return null;
  let text = stripMarkup(firstMeaningfulLine(input));
  text = stripLeadingFillers(text);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length < AUTO_TITLE_MIN_CHARS) return null;

  let title = text.split(" ").slice(0, AUTO_TITLE_MAX_WORDS).join(" ");
  title = truncateAtWord(title, AUTO_TITLE_MAX_CHARS);
  title = title.replace(/[\s:;,.\-–—]+$/u, "").trim();
  if (title.length < AUTO_TITLE_MIN_CHARS) return null;
  return capitalizeFirst(title);
}

/**
 * Accept a model-authored title only if it obeys the same contract as the
 * deterministic one: single line, no markdown, no newline, bounded length.
 */
export function sanitizeGeneratedTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.split(/\r?\n/)[0] ?? "";
  text = stripMarkup(text);
  text = text
    .replace(/^\s*["'“”‘’]+/, "")
    .replace(/["'“”‘’]+\s*$/, "")
    .replace(/^title\s*[:=]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/[\s:;,.\-–—]+$/u, "").trim();
  if (text.length < AUTO_TITLE_MIN_CHARS) return null;
  let title = text.split(" ").slice(0, AUTO_TITLE_MAX_WORDS).join(" ");
  title = truncateAtWord(title, AUTO_TITLE_MAX_CHARS);
  if (title.length < AUTO_TITLE_MIN_CHARS) return null;
  return title;
}

/**
 * Display-only project name for a workspace path ("…/mercedes-benz-vns.com" →
 * "mercedes-benz-vns.com"). Display fallback for an untitled session — never
 * persisted as a title.
 */
export function workspaceDisplayName(workspacePath?: string | null): string | null {
  if (typeof workspacePath !== "string") return null;
  const trimmed = workspacePath.trim().replace(/[/\\]+$/u, "");
  if (!trimmed) return null;
  const parts = trimmed.split(/[/\\]+/u);
  const last = parts[parts.length - 1] ?? "";
  return last.length >= 1 ? last : null;
}

/**
 * One-line preview for an untitled session in the picker. Uses the first
 * substantive user message so a "hello" never becomes a session's label.
 */
export function buildSessionPreview(messages: Array<{ role?: string; content?: unknown }> | undefined): string | null {
  for (const message of messages ?? []) {
    if (message?.role !== "user") continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (!isSubstantiveTask(content)) continue;
    const flat = content.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!flat) continue;
    return truncateAtWord(stripMarkup(flat), SESSION_PREVIEW_MAX_CHARS);
  }
  return null;
}
