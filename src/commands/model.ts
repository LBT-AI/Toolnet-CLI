import type { Command, CommandContext } from "./index";
import { getModelTags } from "../lib/modelTags";
export const modelCommand: Command = {
  name: "model",
  aliases: ["m"],
  description: "List available models or select a model",
  usage: "/model [model-id]",
  async handler(args: string[], ctx: CommandContext) {
    const { gateway, addMessage, setModel, currentModel } = ctx;

    const modelArg = args.join(" ").trim();

    if (modelArg) {
      setModel(modelArg);
      addMessage("assistant", `Model set to: ${modelArg}`);
      return;
    }

    if (modelArg === "--help") {
      addMessage("assistant",
        "/model — Model Selection\n\n" +
        "  /model                         List available models\n" +
        "  /model <model-id>              Select a model (e.g., /model cc/claude-sonnet-4-5)\n" +
        "  /model --help                  Show this help\n\n" +
        "Current: " + currentModel()
      );
      return;
    }

    addMessage("assistant", "Fetching available models...");

    const res = await gateway.getAvailableModels();

    if (!res.success || !res.data) {
      addMessage("assistant", `\u001b[31mFailed to fetch models: ${res.error}\u001b[0m`);
      return;
    }

    const models = res.data.data || [];
    if (models.length === 0) {
      addMessage("assistant", "No models available. Connect a provider first.");
      return;
    }

    const combos = models.filter(m => m.owned_by === "combo");
    const providerModels = models.filter(m => m.owned_by !== "combo");

    const lines: string[] = [];
    lines.push(`Available Models (${models.length} total)`);
    lines.push("───".repeat(18));
    lines.push(`Current: ${currentModel()}`);
    lines.push("");

    if (combos.length > 0) {
      lines.push(`\u001b[1mCombos\u001b[0m`);
      for (const c of combos) {
        lines.push(`  ${c.id}`);
      }
      lines.push("");
    }

    const grouped: Record<string, string[]> = {};
    for (const m of providerModels) {
      if (!grouped[m.owned_by]) grouped[m.owned_by] = [];
      grouped[m.owned_by].push(m.id);
    }

    for (const [provider, modelIds] of Object.entries(grouped)) {
      lines.push(`\u001b[1m${provider}\u001b[0m`);
      for (const id of modelIds.slice(0, 10)) {
        const tags = getModelTags(id);
        lines.push(`  ${id}\u001b[90m${tags}\u001b[0m`);
      }
      if (modelIds.length > 10) {
        lines.push(`  ... and ${modelIds.length - 10} more`);
      }
      lines.push("");
    }

    lines.push("Select a model: /model <model-id>");

    addMessage("assistant", lines.join("\n"));
  },
};
