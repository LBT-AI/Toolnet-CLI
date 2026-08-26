import { getHarness } from "./harness";
import {
  type OutputFormat,
  type StructuredResponse,
  type JsonlEvent,
  JsonlWriter,
  classifyError,
  redactSecretArgs,
} from "./structuredOutput";
import { getGlobalTracker } from "./usage";

export interface NonInteractiveOptions {
  prompt: string;
  json?: boolean;
  format?: OutputFormat;
  verbose?: boolean;
  model?: string;
}

export async function runNonInteractive(options: NonInteractiveOptions): Promise<void> {
  const { prompt, json = false, format = json ? "json" : "text", verbose = false } = options;

  if (verbose) {
    process.env.TOOLNET_DEBUG = "1";
  }

  const startTime = Date.now();
  const tracker = getGlobalTracker();
  const model = options.model ?? "openai/gpt-4o";

  // Suppress background update notice in headless mode
  process.env.TOOLNET_HEADLESS = "1";

  const writer = format === "jsonl" ? new JsonlWriter() : null;
  const sessionId = `sess_${Date.now()}`;

  if (writer) {
    writer.write({
      type: "session_start",
      sessionId,
      model,
      timestamp: Date.now(),
    });
  }

  try {
    const harness = getHarness({ model });

    // Wire streaming callbacks for JSONL
    let accumulatedOutput = "";
    let toolCallIndex = 0;

    const result = await harness.runHeadless(prompt, {
      model,
      sessionId,
      onChunk: (chunk: string) => {
        accumulatedOutput += chunk;
        if (writer) {
          writer.write({ type: "assistant_delta", text: chunk, index: toolCallIndex++ });
        }
      },
      onEvent: (event: string, data: any) => {
        if (!writer) return;
        if (event === "agent:tool_start") {
          writer.write({
            type: "tool_start",
            toolCallId: data.id ?? `tc_${Date.now()}`,
            tool: data.toolName ?? "unknown",
            args: redactSecretArgs(data.toolArgs ?? {}),
          });
        } else if (event === "agent:tool_end") {
          writer.write({
            type: "tool_result",
            toolCallId: data.id ?? `tc_${Date.now()}`,
            tool: data.toolName ?? "unknown",
            exitCode: data.result?.exitCode ?? 0,
            cached: data.result?.cached ?? false,
            truncated: data.result?.truncated ?? false,
            durationMs: data.result?.durationMs ?? 0,
          });
        }
      },
    });

    const durationMs = Date.now() - startTime;

    // Record usage
    if (result.tokensUsed && result.tokensUsed > 0) {
      tracker.recordUsage({
        inputTokens: Math.round(result.tokensUsed * 0.7),
        outputTokens: Math.round(result.tokensUsed * 0.3),
        model,
        latencyMs: durationMs,
        estimated: true,
      });
    }

    const usage = tracker.getSessionUsage();

    switch (format) {
      case "json": {
        const response: StructuredResponse = {
          ok: result.success,
          response: result.output.trim(),
          sessionId: result.sessionId,
          model,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            totalTokens: usage.totalTokens,
            estimatedCostUsd: usage.estimatedCostUsd,
            estimated: true,
          },
          durationMs,
        };
        if (!result.success) response.error = result.error || "Execution failed";
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        break;
      }
      case "jsonl": {
        if (writer) {
          writer.write({
            type: "usage",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            totalTokens: usage.totalTokens,
            estimatedCostUsd: usage.estimatedCostUsd,
            estimated: true,
          });
          writer.write({
            type: "final",
            response: result.output.trim(),
            sessionId: result.sessionId,
            model,
            durationMs,
          });
          if (!result.success) {
            const classified = classifyError(result.error || "Execution failed");
            writer.write({
              type: "error",
              code: classified.code,
              message: classified.message,
              retryable: classified.retryable,
            });
          }
          writer.flush();
        }
        break;
      }
      case "markdown":
        if (result.success) {
          process.stdout.write(result.output.trim() + "\n");
        } else {
          process.stderr.write(`Error: ${result.error || "Execution failed"}\n`);
        }
        break;
      case "text":
      default:
        if (result.success) {
          process.stdout.write(result.output.trim() + "\n");
        } else {
          process.stderr.write(`Error: ${result.error || "Execution failed"}\n`);
        }
        break;
    }

    process.exit(result.success ? 0 : 1);
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const classified = classifyError(err);

    if (format === "json") {
      const response: StructuredResponse = {
        ok: false,
        response: "",
        durationMs,
        error: classified.message,
      };
      process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    } else if (format === "jsonl" && writer) {
      writer.write({
        type: "error",
        code: classified.code,
        message: classified.message,
        retryable: classified.retryable,
      });
      writer.flush();
    } else {
      process.stderr.write(`Error [${classified.code}]: ${classified.message}\n`);
    }

    process.exit(1);
  }
}
