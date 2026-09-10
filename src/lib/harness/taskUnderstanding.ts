/**
 * Task Understanding Layer — §1 + §2
 *
 * Normalizes a raw user prompt into a structured TaskContext before the
 * AgentLoop runs. The goal is to give the model (and the harness) a clear
 * picture of:
 *   - what the user wants
 *   - what constraints apply
 *   - what files/URLs are referenced
 *   - what capabilities (workspace/network/mutation/execution) are required
 *
 * This is NOT a keyword classifier. It is a structured interpretation step
 * that the model can refine during the agent loop. The initial TaskContext
 * is a best-effort first pass from the prompt + session context.
 */

import type { TaskContext, Intent, ActiveTaskContext, Requirement } from "./types";
import { extractUrls, classifyUrl } from "./urlRouter";
import { TaskContextManager } from "./taskContext";

// ── Helpers ─────────────────────────────────────────────────────────────────

function lower(s: string): string {
  return s.toLowerCase();
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// ── Intent heuristics (lightweight, not the main brain) ─────────────────────

const INTENT_SIGNALS: Record<Intent, string[]> = {
  question: ["là gì", "what is", "giải thích", "explain", "tại sao", "why", "?", "không"],
  inspect: ["đọc", "read", "xem", "inspect", "kiểm tra", "check", "liệt kê", "list", "show", "cấu trúc", "structure"],
  research: ["nghiên cứu", "research", "tìm hiểu", "learn", "học", "study", "so sánh", "compare"],
  create: ["tạo", "create", "thêm mới", "add new", "viết", "write", "khởi tạo", "scaffold", "new file", "tạo file"],
  modify: ["sửa", "fix", "modify", "thay đổi", "change", "cập nhật", "update", "đổi", "chỉnh sửa", "refactor"],
  debug: ["debug", "sửa lỗi", "fix error", "fix bug", "lỗi", "error", "fail", "broken", "không chạy"],
  test: ["test", "kiểm tra", "chạy test", "run test", "verify", "xác nhận"],
  review: ["review", "đánh giá", "code review", "PR", "pull request"],
  explain: ["giải thích", "explain", "cho tôi biết", "walkthrough", "giải thích code"],
  mixed: [],
};

function detectIntent(prompt: string): Intent {
  const p = lower(prompt);

  // Multi-objective prompts → mixed unless one dominates
  const hits: Record<Intent, number> = {
    question: 0,
    inspect: 0,
    research: 0,
    create: 0,
    modify: 0,
    debug: 0,
    test: 0,
    review: 0,
    explain: 0,
    mixed: 0,
  };

  for (const [intent, signals] of Object.entries(INTENT_SIGNALS)) {
    if (intent === "mixed") continue;
    for (const sig of signals) {
      if (p.includes(lower(sig))) {
        hits[intent as Intent]++;
      }
    }
  }

  const sorted = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (top[1] === 0) return "inspect";
  if (top[1] >= 3) return top[0] as Intent; // strong signal wins
  const second = sorted[1];
  if (second[1] > 0 && top[1] - second[1] <= 1) return "mixed";
  return top[0] as Intent;
}

// ── Constraint extraction ───────────────────────────────────────────────────

function extractConstraints(prompt: string): string[] {
  const constraints: string[] = [];
  const p = lower(prompt);

  const patterns = [
    /\b(?:đừng|don't|do not|không)\s+(?:đổi|thay đổi|sửa|modify|change|edit)\s+(?:UI|giao diện|interface|\/tools|\/ui|màu sắc|style)/i,
    /\b(?:chỉ\s+(?:đọc|inspect|analyze|phân tích)|read-only|read only|chỉ\s+xem)\b/i,
    /\b(?:không\s+(?:commit|push|deploy|xóa|delete))\b/i,
    /\b(?:giữ\s+(?:nguyên|preserve|keep)\s+(?:cấu trúc|structure|API|contract))\b/i,
    /\b(?:đừng\s+(?:chạy|run|execute)\s+(?:command|lệnh|script))\b/i,
    /\b(?:chỉ\s+(?:code|source|implementation))\b/i,
  ];

  // Also extract explicit "don't change X" patterns
  const explicitDont = [...prompt.matchAll(/(?:đừng|don't|do not|không)\s+(?:đổi|thay đổi|sửa|modify|change|edit|touch)\s+([^.,;]+)/gi)];
  for (const m of explicitDont) {
    const target = m[1]?.trim();
    if (target && target.length < 80) {
      constraints.push(`don't modify: ${target}`);
    }
  }

  // "keep X unchanged"
  const keepPatterns = [...prompt.matchAll(/(?:giữ|keep|preserve)\s+(?:nguyên|unchanged|as is)\s+(?:của|of|for)?\s*([^.,;]+)/gi)];
  for (const m of keepPatterns) {
    const target = m[1]?.trim();
    if (target && target.length < 80) {
      constraints.push(`preserve: ${target}`);
    }
  }

  return unique(constraints);
}

// ── Objective extraction ────────────────────────────────────────────────────

function extractObjectives(prompt: string, intent: Intent): string[] {
  const objectives: string[] = [intent];
  const p = prompt;

  // Split on sentence boundaries, numbered lists, and connectors
  const parts = p
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);

  // Also split on connectors like "rồi", "sau đó", "và", "then", "and"
  const connectors = /\b(rồi|sau đó|then|after|và|and|followed by|cũng|also|tiếp theo|next)\b/i;

  for (const part of parts) {
    if (connectors.test(part) && part.length > 10) {
      const subParts = part.split(connectors).map((s) => s.trim()).filter((s) => s.length > 3);
      objectives.push(...subParts);
    } else if (part.length > 5) {
      objectives.push(part);
    }
  }

  return unique(objectives).slice(0, 8);
}

// ── File path extraction ────────────────────────────────────────────────────

function extractFilePaths(prompt: string): string[] {
  const paths: string[] = [];

  // Quoted paths: "src/index.ts", 'src/index.ts'
  const quoted = [...prompt.matchAll(/(?:"([^"]+\.(?:ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|sh|sql|yaml|yml|json|md|txt|css|html|xml|toml|lock))|'([^']+\.(?:ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|sh|sql|yaml|yml|json|md|txt|css|html|xml|toml|lock))')/g)];
  for (const m of quoted) {
    const p = m[1] || m[2];
    if (p) paths.push(p);
  }

  // Unquoted paths with extensions
  const unquoted = [...prompt.matchAll(/\b([\w\-./\\]+\.(?:ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|sh|sql|yaml|yml|json|md|txt|css|html|xml|toml|lock))\b/g)];
  for (const m of unquoted) {
    if (!paths.includes(m[1])) paths.push(m[1]);
  }

  return unique(paths);
}

// ── Ambiguity detection ─────────────────────────────────────────────────────

function detectAmbiguities(prompt: string, intent: Intent, files: string[]): string[] {
  const ambiguities: string[] = [];
  const p = lower(prompt);

  if (intent === "modify" && files.length === 0 && !p.includes("tạo") && !p.includes("create")) {
    ambiguities.push("No specific file identified for modification");
  }

  if (intent === "mixed") {
    ambiguities.push("Mixed intent detected — confirm whether to inspect, modify, or both");
  }

  if (p.includes("giống") || p.includes("như") || p.includes("similar") || p.includes("like")) {
    ambiguities.push("Reference target unclear — needs clarification");
  }

  return unique(ambiguities);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function analyzePrompt(prompt: string): TaskContext {
  if (!prompt || typeof prompt !== "string") {
    return {
      rawPrompt: "",
      intent: "inspect",
      objectives: [],
      constraints: [],
      referencedFiles: [],
      referencedUrls: [],
      requiresWorkspace: true,
      requiresNetwork: false,
      requiresMutation: false,
      requiresExecution: false,
      ambiguities: ["Empty prompt"],
    };
  }

  const intent = detectIntent(prompt);
  const urls = extractUrls(prompt);
  const files = extractFilePaths(prompt);
  const constraints = extractConstraints(prompt);
  const objectives = extractObjectives(prompt, intent);
  const ambiguities = detectAmbiguities(prompt, intent, files);

  const requiresNetwork = urls.length > 0;
  const requiresMutation = ["create", "modify", "debug"].includes(intent) ||
    /\b(sửa|fix|thay đổi|change|modify|tạo|create|write|viết|debug|sửa lỗi|fix lỗi|thêm|add)\b/i.test(prompt);
  const requiresExecution = ["test", "debug"].includes(intent) ||
    /\b(test|chạy|run|execute|debug|sửa lỗi|fix lỗi|lỗi|error|fail|broken)\b/i.test(prompt);
  const requiresWorkspace = !["question", "research"].includes(intent) || files.length > 0 || urls.length > 0;

  let requestedOutput: string | undefined;
  if (intent === "question" || intent === "explain") {
    requestedOutput = "text_explanation";
  } else if (intent === "create" && files.length > 0) {
    requestedOutput = `file: ${files[0]}`;
  } else if (intent === "test") {
    requestedOutput = "test_results";
  }

  return {
    rawPrompt: prompt,
    intent,
    objectives,
    constraints,
    referencedFiles: unique(files),
    referencedUrls: unique(urls),
    requiresWorkspace,
    requiresNetwork,
    requiresMutation,
    requiresExecution,
    requestedOutput,
    ambiguities,
  };
}

export function buildSystemPromptForTask(task: TaskContext): string {
  const lines: string[] = [];

  lines.push(`[TASK CONTEXT]`);
  lines.push(`Intent: ${task.intent}`);
  if (task.objectives.length > 0) {
    lines.push(`Objectives:\n${task.objectives.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}`);
  }
  if (task.constraints.length > 0) {
    lines.push(`Constraints:\n${task.constraints.map((c) => `  - ${c}`).join("\n")}`);
  }
  if (task.referencedFiles.length > 0) {
    lines.push(`Referenced files: ${task.referencedFiles.join(", ")}`);
  }
  if (task.referencedUrls.length > 0) {
    lines.push(`Referenced URLs: ${task.referencedUrls.join(", ")}`);
  }
  lines.push(`Requires workspace: ${task.requiresWorkspace}`);
  lines.push(`Requires network: ${task.requiresNetwork}`);
  lines.push(`Requires mutation: ${task.requiresMutation}`);
  lines.push(`Requires execution: ${task.requiresExecution}`);
  lines.push("");

  return lines.join("\n");
}

export { extractUrls } from "./urlRouter";
