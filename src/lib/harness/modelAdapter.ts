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
import { hookRegistry } from "../../core/hooks";

// ── Public contract — the ONLY shape the agent loop/TUI may depend on ───────

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface AgentModelResponse {
  content: string;
  reasoningSummary?: string;
  toolCalls: AgentToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
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
  /** Sampling temperature — planner-style callers rely on low values. */
  temperature?: number;
  /** Phase 77.11 — session id for hook metadata (observability only). */
  sessionId?: string;
}

// ── Phase 77.11 — model lifecycle hooks ──────────────────────────────────────
//
// The adapter is the ONLY place any provider call is assembled, so it is the
// only place `model.before` / `model.after` can fire exactly once. Putting them
// here (rather than in the harness) means the planner and any future caller get
// the same contract for free, with no per-caller wiring to forget.

/**
 * What a `model.before` hook may inspect or transform.
 *
 * `toolNames` is reported for observability ONLY. A hook can never change it:
 * widening the tool set would bypass both model capability gating
 * (`caps.tools === false`) and the permission system, which owns tool scope.
 */
export interface ModelRequestPayload {
  model: string;
  providerId: string;
  sessionId?: string;
  streaming: boolean;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  toolNames: string[];
  /** Extra system text a plugin may append (the only content transform allowed). */
  systemAdditions: string[];
}

interface PreparedModelRequest {
  caps: ModelCapabilities | undefined;
  chatReq: ChatRequest;
  hookPayload: ModelRequestPayload;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReasoningEffort(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

/** Provider-facing tool names, used only to report the exposed set to hooks. */
function toolNamesOf(tools: unknown[] | undefined): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => (tool as { function?: { name?: string } })?.function?.name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * Merge plugin-provided system text into the transcript WITHOUT adding a second
 * system message: providers and the harness both assume a single primary system
 * message, so additions are appended to the existing one.
 */
function withSystemAdditions(messages: ChatMessage[], additions: string[]): ChatMessage[] {
  if (additions.length === 0) return messages;
  const block = additions.join("\n\n");
  const next = [...messages];
  const index = next.findIndex((message) => (message as { role?: string })?.role === "system");
  if (index === -1) return [{ role: "system", content: block } as ChatMessage, ...next];

  const existing = next[index] as { content?: unknown };
  const base = typeof existing.content === "string" ? existing.content : "";
  next[index] = {
    ...(existing as object),
    content: base ? `${base}\n\n${block}` : block,
  } as ChatMessage;
  return next;
}

// ── Capability resolution ────────────────────────────────────────────────────

import { getModelCapabilities } from "../reasoning";

function resolveCaps(modelId: string): ModelCapabilities | undefined {
  return getModelCapabilities(modelId);
}

// ── Structured tool protocol (non-native tool calling) ──────────────────────

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

export function parseStructuredToolCalls(content: string): AgentToolCall[] | null {
  if (!content || typeof content !== "string") return null;

  const candidates: string[] = [];

  for (const m of content.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)) {
    const inner = m[1].trim();
    if (inner) candidates.push(inner);
  }
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed);
  }
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
   * Assemble the provider request and give `model.before` a chance to adjust the
   * permitted knobs.
   *
   * Transform scope is intentionally narrow: sampling temperature, reasoning
   * effort and appended system text. Tool scope, capability gating and the
   * message history are NOT transformable, because an extension must not be able
   * to widen what the model may do — that is the permission system's job.
   */
  private async prepareRequest(
    req: AgentModelRequest,
    streaming: boolean,
  ): Promise<PreparedModelRequest> {
    const caps = resolveCaps(req.model);
    const toolsForRequest =
      caps?.tools === false ? undefined : (req.tools as ChatRequest["tools"]);

    let temperature = req.temperature;
    let reasoningEffort = req.reasoningEffort;
    let messages = req.messages;

    const payload: ModelRequestPayload = {
      model: req.model,
      providerId: this.provider.id,
      sessionId: req.sessionId,
      streaming,
      temperature,
      reasoningEffort,
      toolNames: toolNamesOf(req.tools),
      systemAdditions: [],
    };

    const report = await hookRegistry.run(
      "model.before",
      {
        model: req.model,
        providerId: this.provider.id,
        sessionId: req.sessionId,
        streaming,
        messageCount: req.messages.length,
      },
      payload,
      { sessionId: req.sessionId, signal: req.signal },
    );

    const transformed = (report.output ?? payload) as Partial<ModelRequestPayload>;

    if (typeof transformed.temperature === "number" && Number.isFinite(transformed.temperature)) {
      temperature = transformed.temperature;
    }
    if (isReasoningEffort(transformed.reasoningEffort)) {
      reasoningEffort = transformed.reasoningEffort;
    }
    if (Array.isArray(transformed.systemAdditions)) {
      messages = withSystemAdditions(
        messages,
        transformed.systemAdditions.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
      );
    }

    // Capability/scope guard: a hook that tries to widen the tool set is
    // ignored loudly rather than silently obeyed.
    if (
      Array.isArray(transformed.toolNames) &&
      transformed.toolNames.join("\u0000") !== payload.toolNames.join("\u0000")
    ) {
      console.error(
        "[hooks] model.before attempted to change the exposed tool set — ignored (tool scope belongs to the permission system)",
      );
    }

    const chatReq: ChatRequest = {
      model: req.model,
      messages,
      tools: toolsForRequest,
      tool_choice: toolsForRequest ? req.toolChoice ?? "auto" : undefined,
      headers: req.headers,
      signal: req.signal,
      reasoningEffort,
      temperature,
      ...(streaming ? { stream: true } : {}),
    };

    return {
      caps,
      chatReq,
      hookPayload: { ...payload, temperature, reasoningEffort },
    };
  }

  /**
   * Fire `model.after` exactly once per model call.
   *
   * Contract: this edge ALWAYS fires when the request settles — on success with
   * `outcome: "completed"` and the normalized response summary, and on provider
   * failure with `outcome: "error"` plus the message. There is deliberately no
   * separate `model.error` hook, so a plugin has exactly one place to observe a
   * completion and cannot be surprised by an edge that sometimes never fires.
   */
  private async notifyModelAfter(
    prepared: PreparedModelRequest,
    result: { outcome: "completed" | "error"; response?: AgentModelResponse; error?: string },
  ): Promise<void> {
    await hookRegistry.run(
      "model.after",
      {
        model: prepared.hookPayload.model,
        providerId: prepared.hookPayload.providerId,
        sessionId: prepared.hookPayload.sessionId,
        streaming: prepared.hookPayload.streaming,
        outcome: result.outcome,
      },
      {
        model: prepared.hookPayload.model,
        providerId: prepared.hookPayload.providerId,
        outcome: result.outcome,
        toolCallCount: result.response?.toolCalls.length ?? 0,
        finishReason: result.response?.finishReason ?? null,
        usage: result.response?.usage,
        error: result.error,
      },
      { sessionId: prepared.hookPayload.sessionId },
    );
  }

  async complete(req: AgentModelRequest): Promise<AgentModelResponse> {
    const prepared = await this.prepareRequest(req, false);
    try {
      const response = await this.invokeProvider(prepared);
      await this.notifyModelAfter(prepared, { outcome: "completed", response });
      return response;
    } catch (error) {
      await this.notifyModelAfter(prepared, { outcome: "error", error: describeError(error) });
      throw error;
    }
  }

  /**
   * Raw provider call + normalization. Hooks are deliberately NOT fired here:
   * `complete` and `stream` own the model lifecycle, so a streaming fallback
   * onto this method cannot double-fire `model.after`.
   */
  private async invokeProvider(prepared: PreparedModelRequest): Promise<AgentModelResponse> {
    const { caps, chatReq } = prepared;

    const res: ChatResponse = await this.provider.chat(chatReq);
    const choice = res.choices?.[0];
    const msg = choice?.message;

    if (!msg) {
      return { content: "", toolCalls: [], usage: usageFromResponse(res.usage), finishReason: choice?.finish_reason ?? null };
    }

    let toolCalls = normalizeToolCallsFromResponse(msg);
    let content = msg.content ?? "";

    const needsStructuredFallback =
      toolCalls.length === 0 &&
      Boolean(content) &&
      caps?.nativeToolCalls === false;

    if (needsStructuredFallback) {
      const structured = parseStructuredToolCalls(content);
      if (structured && structured.length > 0) {
        toolCalls = structured;
        content = "";
      }
    }

    return {
      content,
      toolCalls,
      usage: usageFromResponse(res.usage),
      finishReason: choice.finish_reason,
    };
  }

  async *stream(req: AgentModelRequest): AsyncIterable<{
    contentDelta?: string;
    reasoningDelta?: string;
    toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string };
    usage?: AgentModelResponse["usage"];
    finishReason?: string | null;
  }> {
    // Decide the transport up front so `model.before` reports the real mode and
    // the non-streaming fallback cannot inherit `stream: true`.
    const willStream = typeof this.provider.stream === "function";
    const prepared = await this.prepareRequest(req, willStream);

    let outcome: "completed" | "error" = "completed";
    let errorMessage: string | undefined;

    try {
      yield* this.iterateProvider(prepared, willStream);
    } catch (error) {
      outcome = "error";
      errorMessage = describeError(error);
      throw error;
    } finally {
      // Exactly once per model call — including on abort or an early `break`,
      // because a consumer calling `return()` on the generator still runs this.
      await this.notifyModelAfter(prepared, { outcome, error: errorMessage });
    }
  }

  /** Provider iteration only — no hooks, so the wrapper fires them once. */
  private async *iterateProvider(prepared: PreparedModelRequest, willStream: boolean): AsyncIterable<{
    contentDelta?: string;
    reasoningDelta?: string;
    toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string };
    usage?: AgentModelResponse["usage"];
    finishReason?: string | null;
  }> {
    if (!willStream) {
      const res = await this.invokeProvider(prepared);
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

    // Guard clause: `willStream` was decided by the caller, so re-resolve the
    // method here rather than asserting non-null.
    const stream = this.provider.stream?.bind(this.provider);
    if (!stream) return;

    for await (const chunk of stream(prepared.chatReq)) {
      const delta = chunk.choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (!delta) {
        if (chunk.usage) yield { usage: usageFromResponse(chunk.usage) };
        continue;
      }
      const reasoningDelta = extractReasoningFromChunk(delta);
      if (reasoningDelta) yield { reasoningDelta };

      const contentDelta = delta.content as string | undefined;
      if (contentDelta) yield { contentDelta };

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

export function normalizeChatResponse(res: ChatResponse, modelId?: string): AgentModelResponse {
  const choice = res.choices?.[0];
  const msg = choice?.message;
  if (!msg) {
    return {
      content: "",
      toolCalls: [],
      usage: usageFromResponse(res.usage),
      finishReason: choice?.finish_reason ?? null,
    };
  }

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

  return {
    content,
    toolCalls,
    usage: usageFromResponse(res.usage),
    finishReason: choice?.finish_reason ?? null,
  };
}
