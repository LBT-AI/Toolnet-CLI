/**
 * Normalized Model Adapter — §2 + §3
 *
 * Every provider/model speaks its own dialect (OpenAI chat/completions,
 * Anthropic messages, Gemini generateContent, ToolNet gateway). The rest of
 * ToolNet (Agent Loop, TUI, Harness, Tool Router) must not know that dialect.
 *
 * This adapter is the single translation layer:
 *   Provider ChatResponse/ChatChunk  →  AgentModelResponse
 *
 * It also implements the structured tool protocol for models that do not
 * support native function calling. Those models cannot emit `tool_calls` — they
 * emit a JSON block inside their text content:
 *
 *   {"type":"tool_call","tool":"write_file","arguments":{"path":"test.py","content":"..."}}
 *
 * Only this adapter knows that. Callers always see AgentToolCall[].
 */

import type {
  Provider,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatMessage,
  ModelCapabilities,
} from "../../providers/types";

// ── Public contract — the ONLY shape the agent loop/TUI may depend on ───────

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface AgentModelResponse {
  /** Final assistant text (may be empty when toolCalls are present). */
  content: string;
  /** Optional concise reasoning summary when the model exposes it. */
  reasoningSummary?: string;
  /** Normalized tool calls — empty when the model is answering. */
  toolCalls: AgentToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  /** Provider finish_reason when available (stop / tool_calls / length …). */
  finishReason?: string | null;
}

export interface AgentModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: "auto" | "required" | "none";
  signal?: AbortSignal;
  headers?: Record<string, string>;
  reasoningEffort?: "low" | "medium" | "high";
}

// ── Capability resolution ────────────────────────────────────────────────────

import { getModelCapabilities } from "../reasoning";

/**
 * Runtime capabilities seen by the adapter. Undefined → unknown → assume
 * the model is capable (fail-open for tool delivery, fail-closed for fake
 * success is handled elsewhere — claimGuard + verification).
 */
function resolveCaps(modelId: string): ModelCapabilities | undefined {
  return getModelCapabilities(modelId);
}

// ── Structured tool protocol (non-native tool calling) ──────────────────────

/**
 * Strict JSON schema for one structured tool call. We only accept this shape —
 * prose like "I created test.py" is never parsed.
 */
interface StructuredToolCall {
  type: "tool_call";
  tool: string;
  arguments: Record<string, unknown>;
}

const KNOWN_TOOLS = new Set([
  "get_cwd",
  "list_dir",
  "tree",
  "read_file",
  "write_file",
  "edit_file",
  "replace_all",
  "file_exists",
  "apply_patch",
  "git_status",
  "git_diff",
  "find_path",
  "grep",
  "grep_search",
  "glob",
  "glob_search",
  "shell",
  "run_command",
  "bash",
  "web_fetch",
  "browser",
  "create_artifact",
  "update_artifact",
  "audit_url",
  "spawn_subagent",
  "save_plan",
]);

function isStructuredToolCall(v: unknown): v is StructuredToolCall {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.type !== "tool_call") return false;
  if (typeof o.tool !== "string" || !KNOWN_TOOLS.has(o.tool)) return false;
  if (!o.arguments || typeof o.arguments !== "object") return false;
  return true;
}

/**
 * Try to extract structured tool calls from plain text content.
 * We look for fenced ```json blocks and for bare JSON objects.
 * Returns null when nothing strict matches.
 */
export function parseStructuredToolCalls(content: string): AgentToolCall[] | null {
  if (!content || typeof content !== "string") return null;

  const candidates: string[] = [];

  // 1) ```json ... ``` blocks (most common for non-native models)
  for (const m of content.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)) {
    const inner = m[1].trim();
    if (inner) candidates.push(inner);
  }
  // 2) Bare JSON objects on their own line — only when the whole content is JSON-ish
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed);
  }
  // 3) Array of tool calls
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    candidates.push(trimmed);
  }

  const calls: AgentToolCall[] = [];
  let seq = 0;

  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isStructuredToolCall(item)) {
            calls.push({
              id: `structured_${Date.now()}_${seq++}`,
              name: item.tool,
              arguments: item.arguments,
            });
          }
        }
      } else if (isStructuredToolCall(parsed)) {
        calls.push({
          id: `structured_${Date.now()}_${seq++}`,
          name: parsed.tool,
          arguments: parsed.arguments,
        });
      }
    } catch {
      // Not JSON — ignore
    }
  }

  return calls.length > 0 ? calls : null;
}

// ── Normalization helpers ───────────────────────────────────────────────────

function normalizeToolCallsFromResponse(msg: ChatMessage): AgentToolCall[] {
  const raw = msg.tool_calls;
  if (!raw || raw.length === 0) return [];
  const out: AgentToolCall[] = [];
  for (const tc of raw) {
    let args: unknown = {};
    const rawArgs = tc.function.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        // Malformed JSON from provider — keep raw string as fallback
        args = rawArgs;
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs;
    }
    out.push({ id: tc.id, name: tc.function.name, arguments: args });
  }
  return out;
}

function extractReasoningFromChunk(delta: Record<string, unknown>): string | undefined {
  const v =
    (delta.reasoning_content as string) ??
    (delta.reasoning as string) ??
    (delta.thinking as string);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function usageFromResponse(u: ChatResponse["usage"]): AgentModelResponse["usage"] | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.prompt_tokens ?? u.input_tokens,
    outputTokens: u.completion_tokens ?? u.output_tokens,
    reasoningTokens:
      (u as Record<string, unknown>).reasoning_tokens as number | undefined ??
      u.completion_tokens_details?.reasoning_tokens ??
      undefined,
    totalTokens: u.total_tokens,
  };
}

// ── Adapter class ───────────────────────────────────────────────────────────

export class ModelAdapter {
  constructor(private readonly provider: Provider) {}

  get providerId(): string {
    return this.provider.id;
  }

  /**
   * Non-streaming complete — returns a fully normalized AgentModelResponse.
   * This is what the agent loop (runAgent) uses. The TUI streaming path
   * should use stream() below and coalesce deltas.
   */
  async complete(req: AgentModelRequest): Promise<AgentModelResponse> {
    const caps = resolveCaps(req.model);

    // Capability guard: when the model has explicitly declared tools=false,
    // never hand it tool definitions. It will answer with text only.
    const toolsForRequest =
      caps?.tools === false ? undefined : (req.tools as ChatRequest["tools"]);

    // When the model advertises tools but not nativeToolCalls, we still give
    // it the schemas but also enable the structured-protocol fallback below.
    // The provider adapter may ignore tools it doesn't understand — that's fine.
    const chatReq: ChatRequest = {
      model: req.model,
      messages: req.messages,
      tools: toolsForRequest,
      tool_choice: toolsForRequest ? req.toolChoice ?? "auto" : undefined,
      headers: req.headers,
      signal: req.signal,
      reasoningEffort: req.reasoningEffort,
    };

    const res: ChatResponse = await this.provider.chat(chatReq);
    const choice = res.choices?.[0];
    const msg = choice?.message;

    if (!msg) {
      return { content: "", toolCalls: [], usage: usageFromResponse(res.usage), finishReason: choice?.finish_reason ?? null };
    }

    // Native tool calls
    let toolCalls = normalizeToolCallsFromResponse(msg);
    let content = msg.content ?? "";

    // Structured fallback — only when the model lacks native tool calling.
    // We deliberately check nativeToolCalls !== true (explicit opt-out) so
    // unknown models stay on the native path.
    const needsStructuredFallback =
      toolCalls.length === 0 &&
      Boolean(content) &&
      caps?.nativeToolCalls === false;

    if (needsStructuredFallback) {
      const structured = parseStructuredToolCalls(content);
      if (structured && structured.length > 0) {
        toolCalls = structured;
        // When we extracted structured calls, the prose wrapper is not the answer
        content = "";
      }
    }

    // Never synthesize tool calls from prose — only strict JSON above counts.
    return {
      content,
      toolCalls,
      usage: usageFromResponse(res.usage),
      finishReason: choice.finish_reason,
    };
  }

  /**
   * Streaming complete — yields normalized deltas. The caller is responsible
   * for accumulating content/toolCalls and for coalescing repaints.
   */
  async *stream(req: AgentModelRequest): AsyncIterable<{
    contentDelta?: string;
    reasoningDelta?: string;
    toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string };
    usage?: AgentModelResponse["usage"];
    finishReason?: string | null;
  }> {
    if (typeof this.provider.stream !== "function") {
      // Fallback to non-streaming
      const res = await this.complete(req);
      if (res.content) yield { contentDelta: res.content };
      for (let i = 0; i < res.toolCalls.length; i++) {
        const tc = res.toolCalls[i];
        yield {
          toolCallDelta: {
            index: i,
            id: tc.id,
            name: tc.name,
            argumentsDelta: JSON.stringify(tc.arguments),
          },
        };
      }
      if (res.usage) yield { usage: res.usage };
      if (res.finishReason) yield { finishReason: res.finishReason };
      return;
    }

    const caps = resolveCaps(req.model);
    const toolsForRequest = caps?.tools === false ? undefined : (req.tools as ChatRequest["tools"]);

    const chatReq: ChatRequest = {
      model: req.model,
      messages: req.messages,
      tools: toolsForRequest,
      tool_choice: toolsForRequest ? req.toolChoice ?? "auto" : undefined,
      headers: req.headers,
      signal: req.signal,
      reasoningEffort: req.reasoningEffort,
      stream: true,
    };

    for await (const chunk of this.provider.stream(chatReq)) {
      const delta = chunk.choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (!delta) {
        if (chunk.usage) yield { usage: usageFromResponse(chunk.usage) };
        continue;
      }
      const reasoningDelta = extractReasoningFromChunk(delta);
      if (reasoningDelta) yield { reasoningDelta };

      const contentDelta = delta.content as string | undefined;
      if (contentDelta) yield { contentDelta };

      // Tool call deltas — OpenAI streaming shape may send index + partials
      const rawToolDeltas = (delta as { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }).tool_calls;
      if (Array.isArray(rawToolDeltas)) {
        for (const td of rawToolDeltas) {
          yield {
            toolCallDelta: {
              index: td.index ?? 0,
              id: td.id,
              name: td.function?.name,
              argumentsDelta: td.function?.arguments,
            },
          };
        }
      }

      if (chunk.usage) yield { usage: usageFromResponse(chunk.usage) };
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) yield { finishReason: fr };
    }
  }
}

/**
 * Convenience: one-shot normalize of a ChatResponse without constructing an adapter.
 * Useful in tests and in harness resume paths.
 */
export function normalizeChatResponse(res: ChatResponse, modelId?: string): AgentModelResponse {
  const choice = res.choices?.[0];
  const msg = choice?.message;
  if (!msg) return { content: "", toolCalls: [], usage: usageFromResponse(res.usage), finishReason: choice?.finish_reason ?? null };

  let toolCalls = normalizeToolCallsFromResponse(msg);
  let content = msg.content ?? "";

  if (modelId) {
    const caps = resolveCaps(modelId);
    const needsFallback =
      toolCalls.length === 0 && Boolean(content) && caps?.nativeToolCalls === false;
    if (needsFallback) {
      const structured = parseStructuredToolCalls(content);
      if (structured) {
        toolCalls = structured;
        content = "";
      }
    }
  }

  return { content, toolCalls, usage: usageFromResponse(res.usage), finishReason: choice?.finish_reason ?? null };
}
