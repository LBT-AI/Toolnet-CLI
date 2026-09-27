import type { RefusalCheckResult } from "./types";

/**
 * Genuine operational failures ("cannot find file X", "connection refused")
 * are NOT refusals and must never trigger a retry. These are the tool-facing
 * error shapes a coding agent produces all day.
 */
const OPERATIONAL_FAILURE_PATTERNS: RegExp[] = [
  /cannot (find|open|locate|connect|read|access|parse|load|import|reach|download)/i,
  /could not (find|open|locate|connect|read|access|parse|load|import|reach|download)/i,
  /unable to (find|open|locate|connect|read|access|parse|load|import|reach|download)/i,
  /can't (find|open|locate|connect|read|access|parse|load|import|reach|download)/i,
  /không thể (tìm thấy|mở|đọc|kết nối|truy cập|tải|xác định)/i,
  /không tìm thấy/i,
  /无法(找到|打开|连接|读取|访问|下载|定位)/i,
];

/**
 * Phrases that signal the model declined a LEGITIMATE request on policy or
 * persona grounds. Detection only feeds ONE recovery: an honest retry that
 * restates the request and asks the model to answer if it genuinely can.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /as an AI (language model|assistant)?.*(cannot|can't|must not|am not able to|am not allowed to)/i,
  /against (my|OpenAI's|Anthropic's|Google's) (safety|use|usage) (guidelines|policies|policy)/i,
  /I must decline/i,
  /I cannot fulfill this request/i,
  /I'm sorry, but I can't (help|assist) with that/i,
  /tôi phải từ chối (yêu cầu|hỗ trợ)/i,
  /với tư cách là (một )?(trí tuệ nhân tạo|mô hình ngôn ngữ|AI).*không/i,
  /作为(一个)?(人工智能|AI|语言模型).*无法/i,
  /我必须拒绝/i,
];

export function isRefusal(text: string): RefusalCheckResult {
  if (!text || text.trim().length === 0) {
    return { isRefusal: false };
  }

  // Refusals almost always open the response.
  const head = text.slice(0, 500);

  const isOperational = OPERATIONAL_FAILURE_PATTERNS.some((p) => p.test(head));
  const isPolicyRefusal = REFUSAL_PATTERNS.some((p) => p.test(head));

  if (isOperational && !isPolicyRefusal) {
    return { isRefusal: false };
  }
  if (isPolicyRefusal) {
    const matched = REFUSAL_PATTERNS.find((p) => p.test(head));
    const match = matched ? matched.exec(head) : null;
    return {
      isRefusal: true,
      reason: "Model declined a request the runtime considers legitimate",
      matchedPattern: match ? match[0] : "policy_refusal",
    };
  }
  return { isRefusal: false };
}

/**
 * The ONE honest recovery for a spurious refusal.
 *
 * No forged clearances, no "override activated" theater — just a restatement
 * of the task plus a direct request to answer what it can. If the request is
 * genuinely out of bounds for the provider, the model will say so again and
 * the retry loop stops (once) — the user, not a script, decides what next.
 */
export function buildRetryPrompt(originalUserPrompt: string): string {
  return (
    "Your previous answer declined this request. The ToolNet runtime treats the " +
    "request as legitimate engineering work: it runs inside the user's own " +
    "workspace with normal permission checks and approvals still active.\n\n" +
    "If any part of the task is something you can help with, do that part now — " +
    "directly and concretely, without disclaimers. If a specific piece is genuinely " +
    "beyond what you may assist with, say exactly which piece and why, then continue " +
    "with everything else.\n\n" +
    "Original task:\n" +
    originalUserPrompt
  );
}
