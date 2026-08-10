/**
 * Direct 1-agent Turbo Execution Engine for ToolNet Teamwork v2
 * Target File: cli/src/teamwork/turboExecutor.ts
 */

import { detectGatewayUrl } from "../lib/gateway";
import { agentTools, executeTool } from "../lib/agentTools";
import type { TurboExecutionResult, TurboExecutionOptions } from "./types";

const TURBO_SYSTEM_PROMPT = `You are ToolNet Turbo Agent, a hyper-optimized single-pass agent for small, localized tasks.
Your goal is to execute the user request immediately with maximum efficiency and minimal latency.

Guidelines:
1. Use available tools directly to inspect or edit code when necessary.
2. Complete the task in as few tool iterations as possible.
3. Do NOT output plan descriptions or progress logs.
4. When finished executing tools, you MUST provide a final textual response summarizing the outcome to the user. Do not just stop without a message.`;

/**
 * Direct 1-agent execution engine for tiny tasks.
 * Bypasses Smart Planner DAG generation and QA review rounds for minimal latency.
 */
export async function executeTurboTask(
  userPrompt: string,
  options: TurboExecutionOptions = {}
): Promise<TurboExecutionResult> {
  const startTime = Date.now();
  const sessionId = options.sessionId || `turbo-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const gatewayUrl = options.gatewayUrl || detectGatewayUrl();
  const maxIterations = options.maxIterations ?? 5;
  const timeoutMs = options.timeoutMs ?? 30000;
  const eventBus = options.eventBus;

  // 1. Log session & execution start if eventBus provided
  if (eventBus) {
    try {
      await eventBus.emit("SESSION_START", { sessionId, mode: "TURBO", prompt: userPrompt });
      await eventBus.emit("TURBO_EXECUTION_STARTED", { sessionId, maxIterations });
    } catch {}
  }

  const messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string }> = [
    { role: "system", content: TURBO_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let toolCallsCount = 0;
  let totalTokens = 0;
  let iteration = 0;

  try {
    while (iteration < maxIterations) {
      iteration++;

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Turbo execution timed out after ${timeoutMs}ms`);
      }

      let response: Response;
      try {
        response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: options.model || "default",
            messages,
            tools: agentTools,
            tool_choice: "auto",
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (networkErr: unknown) {
        const message = networkErr instanceof Error ? networkErr.message : String(networkErr);
        throw new Error(`Network/Gateway connection failed: ${message}`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gateway returned HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      const assistantMessage = choice?.message;

      if (data.usage?.total_tokens) {
        totalTokens += data.usage.total_tokens;
      }

      if (!assistantMessage) {
        throw new Error("Invalid response format from gateway: missing assistant message");
      }

      messages.push(assistantMessage);

      // Check if tool calls exist
      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Task completed
        const output = assistantMessage.content || "Task completed successfully.";
        const durationMs = Date.now() - startTime;

        if (eventBus) {
          try {
            await eventBus.emit("TURBO_EXECUTION_COMPLETED", {
              sessionId,
              output,
              toolCallsCount,
              tokensUsed: totalTokens,
              durationMs,
            });
            await eventBus.emit("SESSION_END", { sessionId, status: "COMPLETED" });
          } catch {}
        }

        return {
          sessionId,
          success: true,
          output,
          toolCallsCount,
          tokensUsed: totalTokens,
          durationMs,
        };
      }

      // Execute tool calls in sequence
      for (const call of toolCalls) {
        const toolName = call.function.name;
        let toolArgs: any = {};
        try {
          toolArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          toolArgs = {};
        }

        toolCallsCount++;

        if (eventBus) {
          try {
            await eventBus.emit("TOOL_CALL_STARTED", { sessionId, toolName, toolArgs, callId: call.id });
          } catch {}
        }

        const toolResult = await executeTool(toolName, toolArgs);

        if (eventBus) {
          try {
            await eventBus.emit("TOOL_CALL_COMPLETED", { sessionId, toolName, result: toolResult, callId: call.id });
          } catch {}
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
        });
      }
    }

    // Exceeded max iterations
    throw new Error(`Turbo mode reached maximum tool iteration limit (${maxIterations})`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;

    if (eventBus) {
      try {
        await eventBus.emit("TURBO_EXECUTION_FAILED", { sessionId, error: errorMessage, durationMs });
        await eventBus.emit("SESSION_END", { sessionId, status: "FAILED", error: errorMessage });
      } catch {}
    }

    return {
      sessionId,
      success: false,
      output: "",
      toolCallsCount,
      tokensUsed: totalTokens,
      durationMs,
      error: errorMessage,
    };
  }
}
