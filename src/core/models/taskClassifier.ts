/**
 * Phase 80 §2 — Deterministic TaskClassifier.
 *
 * NO LLM call. Classification is a pure function of the request's own signals
 * (prompt text, requested tools, attachments, context size, agent role, mode),
 * so it is reproducible and testable.
 *
 * It never inspects a model id. "coding" is derived from the *task*, and the
 * task is then mapped to capabilities and a routing profile — the model is
 * chosen later from metadata/eval, never from a name.
 */

import type { CapabilityRequirement } from "./types";
import type { RoutingProfileName } from "./profiles";

export type TaskType =
  | "general"
  | "coding"
  | "debugging"
  | "planning"
  | "review"
  | "search"
  | "tool_heavy"
  | "vision"
  | "long_context"
  | "reasoning"
  | "fast"
  | "background";

export interface TaskClassification {
  primaryType: TaskType;
  secondaryTypes: TaskType[];
  requiredCapabilities: CapabilityRequirement;
  preferredCapabilities: CapabilityRequirement;
  confidence: number;
  reasons: string[];
  profile: RoutingProfileName;
}

export interface ClassifyInput {
  prompt: string;
  /** Tool names the caller already decided to offer (strong explicit signal). */
  requestedTools?: string[];
  attachments?: Array<{ type?: string; mimeType?: string; kind?: string; mediaType?: string }>;
  /** Total prompt/context size in tokens, when known. */
  contextSize?: number;
  agentRole?: string;
  executionMode?: string;
}

interface Signal {
  type: TaskType;
  weight: number;
  pattern?: RegExp;
  test?: (input: ClassifyInput) => boolean;
  reason: string;
}

/** Prompt patterns. Word boundaries keep "api" out of "capital". */
const SIGNALS: Signal[] = [
  // Ordering is load-bearing: it breaks weight TIES. `coding` is listed first
  // so a prompt like "fix TypeScript error and run tests" classifies as coding
  // with `debugging` as the secondary type (matching the documented example).
  {
    type: "coding",
    weight: 3,
    pattern: /\b(code|refactor|implement|function|class|method|module|compile|typescript|javascript|python|golang|rust|sql|api endpoint|unit test)\b|\.[a-z]{1,4}\b/i,
    reason: "coding vocabulary",
  },
  {
    type: "debugging",
    weight: 3,
    pattern: /\b(debug|stack ?trace|traceback|exception|error|failing|fail(?:ed|s)?|broken|crash(?:es|ed)?|regression|bug|bisect|root cause)\b/i,
    reason: "debugging vocabulary",
  },
  {
    type: "planning",
    weight: 2,
    pattern: /\b(plan|roadmap|architect(?:ure)?|design|strategy|break (?:it )?down|milestones?|approach|proposal)\b/i,
    reason: "planning vocabulary",
  },
  {
    type: "review",
    weight: 2,
    pattern: /\b(review|audit|critique|inspect|assess|pull request|\bpr\b|diff|code smell|security review)\b/i,
    reason: "review vocabulary",
  },
  {
    type: "search",
    weight: 2,
    pattern: /\b(search|find|locate|look up|where is|which file|grep|find all)\b/i,
    reason: "search vocabulary",
  },
  {
    type: "reasoning",
    weight: 2,
    pattern: /\b(why|prove|derive|analy[sz]e|reason|logic|complexity|algorithm|mathematically|trade-?offs?)\b/i,
    reason: "reasoning vocabulary",
  },
  {
    type: "fast",
    weight: 2,
    pattern: /\b(quick(?:ly)?|briefly|one[- ]?lin(?:e|er)|tl;?dr|short answer|in a sentence)\b/i,
    reason: "explicit brevity request",
  },
  {
    type: "vision",
    weight: 3,
    pattern: /\b(screenshot|image|diagram|photo|picture|chart|mockup|wireframe)\b/i,
    reason: "image reference",
  },
  {
    type: "long_context",
    weight: 2,
    pattern: /\b(entire (?:repo|codebase|project)|whole (?:file|repo)|all files|long document|full history)\b/i,
    reason: "whole-context request",
  },
  {
    type: "tool_heavy",
    weight: 2,
    pattern: /\b(run (?:the )?tests?|build|install|execute|shell|command|script|benchmark|lint|typecheck)\b/i,
    reason: "execution vocabulary",
  },
];

const IMAGE_MEDIA = /^image\//i;
/** Context size above which a request is treated as long-context. */
export const LONG_CONTEXT_THRESHOLD = 100_000;
/** Requested tool count above which a request is treated as tool-heavy. */
export const TOOL_HEAVY_THRESHOLD = 3;

function hasImageAttachment(input: ClassifyInput): boolean {
  return (input.attachments ?? []).some((attachment) => {
    const media = attachment.mimeType ?? attachment.mediaType ?? "";
    if (IMAGE_MEDIA.test(media)) return true;
    const kind = (attachment.type ?? attachment.kind ?? "").toLowerCase();
    return kind === "image";
  });
}

/**
 * Classify a task. Deterministic and side-effect free.
 *
 * The primary type is the highest-weighted signal; ties break by the order of
 * SIGNALS (the more specific/debugging-leaning signals are listed first) and
 * then by TaskType name for full determinism.
 */
export function classifyTask(input: ClassifyInput): TaskClassification {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const reasons: string[] = [];
  const scores = new Map<TaskType, number>();

  const add = (type: TaskType, weight: number): void => {
    scores.set(type, (scores.get(type) ?? 0) + weight);
  };

  for (const signal of SIGNALS) {
    if (signal.pattern?.test(prompt)) {
      add(signal.type, signal.weight);
      reasons.push(`${signal.type}: ${signal.reason}`);
    }
  }

  // Explicit, structured signals beat text heuristics.
  const requestedTools = input.requestedTools ?? [];
  if (requestedTools.length > 0) {
    add("tool_heavy", 1);
    reasons.push(`tool_heavy: ${requestedTools.length} tool(s) requested`);
  }
  if (requestedTools.length >= TOOL_HEAVY_THRESHOLD) {
    add("tool_heavy", 2);
    reasons.push(`tool_heavy: >= ${TOOL_HEAVY_THRESHOLD} tools requested`);
  }
  if (hasImageAttachment(input)) {
    add("vision", 3);
    reasons.push("vision: image attachment present");
  }
  if (typeof input.contextSize === "number" && input.contextSize >= LONG_CONTEXT_THRESHOLD) {
    add("long_context", 2);
    reasons.push(`long_context: ${input.contextSize} tokens >= ${LONG_CONTEXT_THRESHOLD}`);
  }
  if ((input.executionMode ?? "").toLowerCase() === "background") {
    add("background", 3);
    reasons.push("background: execution mode is background");
  }
  if ((input.agentRole ?? "").toLowerCase().includes("background")) {
    add("background", 2);
    reasons.push(`background: agent role '${input.agentRole}'`);
  }

  // Deterministic ordering: score desc, then SIGNALS order, then name.
  const order = new Map<TaskType, number>();
  SIGNALS.forEach((signal, index) => {
    if (!order.has(signal.type)) order.set(signal.type, index);
  });
  const ranked = [...scores.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const orderA = order.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
    const orderB = order.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  const primaryType: TaskType = ranked.length > 0 ? ranked[0][0] : "general";
  const secondaryTypes = ranked.slice(1).map(([type]) => type);

  if (ranked.length === 0) reasons.push("general: no specific task signal");

  const requiredCapabilities: CapabilityRequirement = {};
  const preferredCapabilities: CapabilityRequirement = {};

  const toolish =
    primaryType === "tool_heavy" ||
    primaryType === "coding" ||
    primaryType === "debugging" ||
    secondaryTypes.includes("tool_heavy") ||
    requestedTools.length > 0;
  if (toolish) {
    // A task that must edit or execute cannot be served by a model that cannot
    // act — this is a requirement, not a preference.
    requiredCapabilities.tools = true;
    preferredCapabilities.nativeToolCalls = true;
  }
  if (primaryType === "reasoning") requiredCapabilities.reasoning = true;
  if (primaryType === "vision" || secondaryTypes.includes("vision")) requiredCapabilities.vision = true;

  if (primaryType === "coding" || primaryType === "debugging" || primaryType === "planning" || primaryType === "review") {
    preferredCapabilities.reasoning = true;
  }
  const profile = profileFor(primaryType, secondaryTypes);

  const topScore = ranked.length > 0 ? ranked[0][1] : 0;
  const secondScore = ranked.length > 1 ? ranked[1][1] : 0;
  const confidence = confidenceFor(topScore, secondScore);

  return {
    primaryType,
    secondaryTypes,
    requiredCapabilities,
    preferredCapabilities,
    confidence,
    reasons,
    profile,
  };
}

function profileFor(primary: TaskType, secondary: TaskType[]): RoutingProfileName {
  switch (primary) {
    case "coding":
    case "debugging":
      return "coding";
    case "tool_heavy":
      return "tool-heavy";
    case "reasoning":
      return "reasoning";
    case "long_context":
      return "long-context";
    case "fast":
      return "fast";
    case "background":
      return "cheap";
    case "vision":
    case "review":
    case "planning":
      return "quality";
    case "search":
      return secondary.includes("reasoning") ? "reasoning" : "auto";
    case "general":
    default:
      return "auto";
  }
}

/** Confidence is high when one signal dominates and capped below certainty. */
function confidenceFor(top: number, second: number): number {
  if (top <= 0) return 0.3;
  const dominance = top / (top + second || top);
  const raw = 0.4 + dominance * 0.5 + Math.min(top, 6) * 0.02;
  return Math.round(Math.max(0.3, Math.min(0.95, raw)) * 100) / 100;
}

/**
 * Translate a classification into routing request fields. Keeps the router
 * ignorant of TaskType while giving callers a one-liner:
 *
 *   modelRouter.resolve({ ...classificationToRoutingRequest(classifyTask(...)) })
 */
export function classificationToRoutingRequest(classification: TaskClassification): {
  taskType: TaskType;
  profile: RoutingProfileName;
  requiredCapabilities: CapabilityRequirement;
  preferredCapabilities: CapabilityRequirement;
} {
  return {
    taskType: classification.primaryType,
    profile: classification.profile,
    requiredCapabilities: classification.requiredCapabilities,
    preferredCapabilities: classification.preferredCapabilities,
  };
}
