/**
 * Conversation language handling.
 *
 * The ToolNet agent must reply in the same language as the user. This module
 * provides a lightweight heuristic (no heavy detector dependency), an explicit
 * language-request extractor (e.g. "trả lời bằng tiếng Việt"), and the system
 * prompt directive that keeps the model consistent across a session.
 */

export type ConversationLanguage = "vi" | "en" | "zh" | "auto";

/** CJK Unified Ideographs — unambiguous (Vietnamese never uses these glyphs). */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** Vietnamese diacritic characters unique to the writing system. */
const VI_DIACRITICS = /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđĐ]/;

/** Common Vietnamese words — catches unaccented Vietnamese ("xin chao ban"). */
const VI_WORDS =
  /\b(tôi|bạn|em|anh|chị|chúng|tớ|cậu|xin chào|xin chao|tạm biệt|cảm ơn|cam on|không|khong|nhưng|nhung|của|cua|với|voi|được|duoc|là|la|cho|bằng|bang|viết|viet|hãy|hay|giúp|giup|này|nay|nhé|nhe|ạ|và|va|toi|lam|roi|dang)\b/i;

const VI_EXPLICIT = /(tiếng việt|tieng viet|vietnamese)/i;
const EN_EXPLICIT = /(tiếng anh|tieng anh|english)/i;
const ZH_EXPLICIT = /(中文|汉语|普通话|用中文|chinese)/i;

/** Heuristic language detection: zh is unambiguous, then Vietnamese, else en. */
export function detectLanguage(text: string): "vi" | "zh" | "en" {
  if (!text) return "en";
  const zhCount = (text.match(CJK_PATTERN) || []).length;
  if (zhCount > 0) return "zh";
  const viDiacritics = (text.match(VI_DIACRITICS) || []).length;
  const viWords = (text.match(VI_WORDS) || []).length;
  if (viDiacritics >= 2 || viWords >= 2 || (viDiacritics >= 1 && viWords >= 1)) {
    return "vi";
  }
  return "en";
}

/**
 * Detects an explicit response-language request in a user message.
 * Returns null when the message just happens to mention a language.
 */
export function extractLanguageRequest(text: string): ConversationLanguage | null {
  if (!text) return null;
  if (VI_EXPLICIT.test(text)) return "vi";
  if (EN_EXPLICIT.test(text)) return "en";
  if (ZH_EXPLICIT.test(text)) return "zh";
  return null;
}

/**
 * Resolves the language the agent should respond in: an explicit preference
 * wins; otherwise the latest user message decides (auto mode).
 */
export function resolveResponseLanguage(
  latestUserMessage: string,
  preference: ConversationLanguage
): ConversationLanguage {
  if (preference !== "auto") return preference;
  const explicit = extractLanguageRequest(latestUserMessage);
  if (explicit) return explicit;
  return detectLanguage(latestUserMessage);
}

const LANGUAGE_NAMES: Record<Exclude<ConversationLanguage, "auto">, string> = {
  vi: "Vietnamese",
  en: "English",
  zh: "Chinese",
};

/** System-prompt directive that keeps the model's output language consistent. */
export function getLanguageDirective(language: ConversationLanguage): string {
  if (language === "auto") {
    return (
      "LANGUAGE CONSISTENCY:\n" +
      "You should normally respond in the same language as the user's latest message.\n" +
      "If the user explicitly requests a response language, continue using that language until they request another one."
    );
  }
  const name = LANGUAGE_NAMES[language];
  return (
    "LANGUAGE CONSISTENCY:\n" +
    `Respond in ${name}. Continue using ${name} until the user explicitly requests another language. ` +
    "If the user's latest message switches language, match it unless it conflicts with this directive."
  );
}

// ---------------------------------------------------------------------------
// In-memory session preference (set by the TUI when the user asks, persisted
// via session metadata and restored on resume).
// ---------------------------------------------------------------------------

let currentResponseLanguage: ConversationLanguage = "auto";

export function setResponseLanguage(language: ConversationLanguage): void {
  currentResponseLanguage = language;
}

export function getResponseLanguage(): ConversationLanguage {
  return currentResponseLanguage;
}