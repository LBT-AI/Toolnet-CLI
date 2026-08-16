import { getHarness } from "./harness";

export interface NonInteractiveOptions {
  prompt: string;
  json?: boolean;
  verbose?: boolean;
  model?: string;
}

export async function runNonInteractive(options: NonInteractiveOptions): Promise<void> {
  const { prompt, json = false, verbose = false, model = "openai/gpt-4o" } = options;

  if (verbose) {
    process.env.TOOLNET_DEBUG = "1";
  }

  const harness = getHarness({ model });
  const result = await harness.runHeadless(prompt, { model });

  if (json) {
    console.log(
      JSON.stringify(
        {
          success: result.success,
          prompt,
          model,
          output: result.output.trim(),
          turns: result.turnsUsed,
          toolCallsCount: result.toolCallsCount,
          tokensUsed: result.tokensUsed,
          error: result.error,
        },
        null,
        2
      )
    );
  } else {
    if (result.success) {
      console.log(result.output.trim());
    } else {
      console.error(`\x1b[31mError:\x1b[0m ${result.error || result.output || "Execution failed"}`);
    }
  }

  process.exit(result.success ? 0 : 1);
}
