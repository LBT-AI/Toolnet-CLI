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
import { validateAndLoadImage, isModelVisionSupported, type ValidatedImage, getImageMetadataSummary } from "./vision";
import { redactOutputSecrets } from "./security/outputRedactor";
import { getActiveDefaultModel } from "../providers";

export interface NonInteractiveOptions {
  prompt: string;
  images?: string[];
  json?: boolean;
  format?: OutputFormat;
  verbose?: boolean;
  model?: string;
}

export async function runNonInteractive(options: NonInteractiveOptions): Promise<void> {
  const { prompt, images = [], json = false, format = json ? "json" : "text", verbose = false } = options;

  if (verbose) {
    process.env.TOOLNET_DEBUG = "1";
  }

  const startTime = Date.now();
  const tracker = getGlobalTracker();
  const model = options.model || getActiveDefaultModel() || "";

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
    // Validate images if provided
    const validatedImages: ValidatedImage[] = [];
    if (images && images.length > 0) {
      const visionCheck = isModelVisionSupported(model);
      if (!visionCheck.supported) {
        throw new Error(`MODEL_VISION_UNSUPPORTED: ${visionCheck.reason}`);
      }

      for (const imgPath of images) {
        const valRes = validateAndLoadImage(imgPath, process.cwd());
        if (!valRes.ok || !valRes.image) {
          throw new Error(`Image validation failed for '${imgPath}': ${valRes.error}`);
        }
        validatedImages.push(valRes.image);
      }
    }

    const harness = getHarness({ model });

    // Wire streaming callbacks for JSONL
    let accumulatedOutput = "";
    let toolCallIndex = 0;

    // Compose prompt with image metadata if any (or pass multimodal if harness supports)
    let finalPrompt = prompt;
    if (validatedImages.length > 0) {
      const meta = getImageMetadataSummary(validatedImages);
      finalPrompt = `${prompt}\n\n[Attached Images: ${meta.map((m) => `${m.filename} (${m.mime}, ${m.size}B)`).join(", ")}]`;
    }

    const result = await harness.runHeadless(finalPrompt, {
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
        if (event === "tool:start" || event === "agent:tool_start") {
          writer.write({
            type: "tool_start",
            toolCallId: data.id ?? `tc_${Date.now()}`,
            tool: data.toolName ?? "unknown",
            args: redactSecretArgs(data.toolArgs ?? {}),
          });
        } else if (event === "tool:complete" || event === "tool:error" || event === "agent:tool_end") {
          writer.write({
            type: "tool_result",
            toolCallId: data.id ?? `tc_${Date.now()}`,
            tool: data.toolName ?? "unknown",
            exitCode: data.result?.exitCode ?? (event === "tool:error" ? 1 : 0),
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
    const cleanOutput = redactOutputSecrets(result.output.trim());

    switch (format) {
      case "json": {
        const response: StructuredResponse = {
          ok: result.success,
          response: cleanOutput,
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
        if (!result.success) response.error = redactOutputSecrets(result.error || "Execution failed");
        const jsonStr = JSON.stringify(response, null, 2);
        process.stdout.write(redactOutputSecrets(jsonStr) + "\n");
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
            response: cleanOutput,
            sessionId: result.sessionId,
            model,
            durationMs,
          });
          if (!result.success) {
            const classified = classifyError(result.error || "Execution failed");
            writer.write({
              type: "error",
              code: classified.code,
              message: redactOutputSecrets(classified.message),
              retryable: classified.retryable,
            });
          }
          writer.flush();
        }
        break;
      }
      case "markdown":
      case "text":
      default:
        if (result.success) {
          process.stdout.write(cleanOutput + "\n");
        } else {
          process.stderr.write(`Error: ${redactOutputSecrets(result.error || "Execution failed")}\n`);
        }
        break;
    }

    process.exit(result.success ? 0 : 1);
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const classified = classifyError(err);
    const safeMessage = redactOutputSecrets(classified.message);

    if (format === "json") {
      const response: StructuredResponse = {
        ok: false,
        response: "",
        durationMs,
        error: safeMessage,
      };
      const jsonStr = JSON.stringify(response, null, 2);
      process.stdout.write(redactOutputSecrets(jsonStr) + "\n");
    } else if (format === "jsonl" && writer) {
      writer.write({
        type: "error",
        code: classified.code,
        message: safeMessage,
        retryable: classified.retryable,
      });
      writer.flush();
    } else {
      process.stderr.write(`Error [${classified.code}]: ${safeMessage}\n`);
    }

    process.exit(1);
  }
}
