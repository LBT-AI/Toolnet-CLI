import type { Command, CommandContext } from "./index";

const EFFORTS = ["auto", "low", "medium", "high", "off"] as const;

export const reasoningCommand: Command = {
  name: "reasoning",
  aliases: ["reason", "think"],
  description: "Configure reasoning/thinking for models that support it (auto|low|medium|high|off)",
  usage: "/reasoning [auto|low|medium|high|off]",
  handler: async (args: string[], ctx: CommandContext): Promise<void> => {
    const arg = (args[0] || "").toLowerCase();

    if (!arg) {
      const summary = ctx.getReasoningStatus?.() ?? "";
      ctx.addMessage(
        "assistant",
        "/reasoning — Reasoning/thinking configuration\n\n" +
          "  /reasoning auto        Default — follow each model's capability\n" +
          "  /reasoning low         Reduced reasoning effort\n" +
          "  /reasoning medium      Balanced reasoning effort\n" +
          "  /reasoning high        Maximum reasoning effort\n" +
          "  /reasoning off         Disable reasoning when possible\n\n" +
          (summary ? `Current: ${summary}\n` : "") +
          "Models that do not support configurable reasoning ignore this setting."
      );
      return;
    }

    if (!(EFFORTS as readonly string[]).includes(arg)) {
      ctx.addMessage("assistant", `Unknown reasoning level '${arg}'. Usage: /reasoning auto|low|medium|high|off`);
      return;
    }

    const applied = ctx.setReasoningEffort?.(arg as (typeof EFFORTS)[number]) ?? false;
    if (!applied) {
      ctx.addMessage(
        "assistant",
        "This model does not support configurable reasoning — settings kept as-is."
      );
      return;
    }
    ctx.addMessage("assistant", `Reasoning set to \`${arg}\`.`);
  },
};