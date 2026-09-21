import type { Command, CommandContext } from "./index";
import { getModelTags } from "../lib/modelTags";
import { getActiveProvider, getActiveBaseUrl } from "../providers";
import { getActiveProviderConfig, listProviders } from "../providers/registry";
import {
  upsertCustomModel,
  removeCustomModel,
  isCustomModel,
  listCustomModelsForProvider,
} from "../core/models/customModels";
import { resolveModelArg, commitModelSelection } from "../tui/modelPickerWorkflow";

export const modelCommand: Command = {
  name: "model",
  aliases: ["m"],
  description: "List available models or select a model",
  usage: "/model [provider/]model-id | add | remove | edit",
  async handler(args: string[], ctx: CommandContext) {
    const { gateway, addMessage, setModel, currentModel } = ctx;

    const modelArg = args.join(" ").trim();

    // Subcommands: add / remove / edit — custom-model management.
    const sub = modelArg.split(/\s+/)[0];
    if (sub === "add" || sub === "remove" || sub === "edit") {
      await handleCustomModelSubcommand(sub, args.slice(1), ctx);
      return;
    }

    if (modelArg) {
      // Provider-qualified refs switch BOTH provider and model atomically;
      // bare ids keep the active provider (legacy behavior preserved).
      const known = listProviders().map((p) => p.id);
      const resolved = resolveModelArg(modelArg, known);
      if (resolved) {
        const { providerId, apiModelId } = resolved;
        const active = getActiveProviderConfig();
        const knownQualified = providerId !== active?.id && known.includes(providerId);
        if (knownQualified || isCustomModel(providerId, apiModelId) || providerId === active?.id) {
          await commitModelSelection(providerId, apiModelId);
          addMessage("assistant", `Model set to: ${providerId}/${apiModelId}`);
          return;
        }
      }
      setModel(modelArg);
      addMessage("assistant", `Model set to: ${modelArg}`);
      return;
    }

    if (modelArg === "--help") {
      addMessage("assistant",
        "/model — Model Selection\n\n" +
        "  /model                                  Open provider → model picker\n" +
        "  /model <model-id>                       Select model on the active provider\n" +
        "  /model <provider-id>/<api-model-id>     Select provider AND model atomically\n" +
        "  /model add <provider> <model-id>        Add a custom model (flags: --name --context --max-output --tools --native-tools --streaming --reasoning --vision)\n" +
        "  /model remove <provider> <model-id>     Remove a custom model\n" +
        "  /model edit <provider> <model-id>       Edit custom-model metadata\n" +
        "  /model --help                           Show this help\n\n" +
        "Current: " + (currentModel() || "Not selected")
      );
      return;
    }

    if (typeof ctx.openModelPicker === "function") {
      await ctx.openModelPicker();
      return;
    }

    addMessage("assistant", "Fetching available models...");

    // Try provider first, then gateway fallback
    const provider = getActiveProvider();
    if (provider) {
      try {
        const models = await provider.listModels();
        if (models.length === 0) {
          addMessage("assistant", "No models available. Check your provider configuration.");
          return;
        }

        const lines: string[] = [];
        lines.push(`Available Models (${models.length} total)`);
        lines.push("───".repeat(18));
        lines.push(`Current: ${currentModel() || "Not selected"}`);
        lines.push("");

        const grouped: Record<string, string[]> = {};
        for (const m of models) {
          const owner = m.owned_by || provider.id;
          if (!grouped[owner]) grouped[owner] = [];
          grouped[owner].push(m.id);
        }

        for (const [providerName, modelIds] of Object.entries(grouped)) {
          lines.push(`\x1b[1m${providerName}\x1b[0m`);
          for (const id of modelIds.slice(0, 10)) {
            const tags = getModelTags(id);
            lines.push(`  ${id}\x1b[90m${tags}\x1b[0m`);
          }
          if (modelIds.length > 10) {
            lines.push(`  ... and ${modelIds.length - 10} more`);
          }
          lines.push("");
        }

        lines.push("Select a model: /model <model-id>");
        addMessage("assistant", lines.join("\n"));
      } catch (err: any) {
        addMessage("assistant", `\x1b[31mFailed to fetch models: ${err.message}\x1b[0m`);
      }
      return;
    }

    // Fallback: try gateway if available
    if (gateway) {
      const res = await gateway.getAvailableModels();
      if (!res.success || !res.data) {
        addMessage("assistant", `\x1b[31mFailed to fetch models: ${res.error}\x1b[0m`);
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
      lines.push(`Current: ${currentModel() || "Not selected"}`);
      lines.push("");

      if (combos.length > 0) {
        lines.push(`\x1b[1mCombos\x1b[0m`);
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

      for (const [providerName, modelIds] of Object.entries(grouped)) {
        lines.push(`\x1b[1m${providerName}\x1b[0m`);
        for (const id of modelIds.slice(0, 10)) {
          const tags = getModelTags(id);
          lines.push(`  ${id}\x1b[90m${tags}\x1b[0m`);
        }
        if (modelIds.length > 10) {
          lines.push(`  ... and ${modelIds.length - 10} more`);
        }
        lines.push("");
      }

      lines.push("Select a model: /model <model-id>");
      addMessage("assistant", lines.join("\n"));
      return;
    }

    addMessage("assistant", "No provider configured. Use /provider add to set one up.");
  },
};

/**
 * Custom-model management CLI:
 *   /model add <provider-id> <api-model-id> [--name X] [--context N] [--max-output N] [--tools --streaming ...]
 *   /model remove <provider-id> <api-model-id>
 *   /model edit  <provider-id> <api-model-id> [--name X] ...
 *
 * A custom model may only reference an EXISTING configured provider; the
 * command fails explicitly otherwise (no silent provider creation).
 */
async function handleCustomModelSubcommand(
  sub: "add" | "remove" | "edit",
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const { addMessage } = ctx;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const CAP_FLAGS = ["tools", "native-tools", "streaming", "reasoning", "vision"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name" || a === "--context" || a === "--max-output") {
      flags.set(a.slice(2), args[++i] ?? "");
    } else if (CAP_FLAGS.includes(a.slice(2)) && a.startsWith("--")) {
      flags.set(a.slice(2), true);
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }

  const [providerId, apiModelId] = positional;
  if (!providerId || !apiModelId) {
    addMessage(
      "assistant",
      `Usage: /model ${sub} <provider-id> <api-model-id> [--name "Display"] [--context N] [--max-output N] [--tools] [--native-tools] [--streaming] [--reasoning] [--vision]`,
    );
    return;
  }

  const known = listProviders();
  const providerExists = known.some((p) => p.id.toLowerCase() === providerId.toLowerCase());
  if (!providerExists) {
    addMessage(
      "assistant",
      `\x1b[31mProvider '${providerId}' does not exist.\x1b[0m Add it first with /provider add — no provider is created implicitly.`,
    );
    return;
  }

  if (sub === "remove") {
    if (!isCustomModel(providerId, apiModelId)) {
      addMessage(
        "assistant",
        `\x1b[31m'${providerId}/${apiModelId}' is not a custom model.\x1b[0m Discovered models are managed via provider configuration, not removal.`,
      );
      return;
    }
    removeCustomModel(providerId, apiModelId);
    addMessage("assistant", `Removed custom model ${providerId}/${apiModelId}`);
    return;
  }

  const existing = listCustomModelsForProvider(providerId).find((e) => e.apiModelId === apiModelId);
  if (sub === "edit" && !existing) {
    addMessage("assistant", `\x1b[31m'${providerId}/${apiModelId}' is not a custom model — nothing to edit.\x1b[0m`);
    return;
  }

  // Unknown capability stays UNKNOWN: only explicit flags become booleans.
  const capabilities: Record<string, boolean> = {};
  const capAliases: Record<string, string> = { "native-tools": "nativeToolCalls" };
  for (const flag of CAP_FLAGS) {
    if (flags.get(flag) === true) {
      capabilities[capAliases[flag] ?? flag] = true;
    }
  }
  const contextRaw = flags.get("context");
  const maxOutRaw = flags.get("max-output");
  const contextWindow = contextRaw ? Number(contextRaw) : undefined;
  const maxOutputTokens = maxOutRaw ? Number(maxOutRaw) : undefined;

  upsertCustomModel({
    providerId,
    apiModelId,
    ...(flags.get("name") ? { displayName: String(flags.get("name")) } : {}),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(contextWindow && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
    ...(maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens: Math.floor(maxOutputTokens) } : {}),
  });

  if (sub === "add") {
    addMessage("assistant", `Added custom model ${providerId}/${apiModelId}`);
  } else {
    addMessage("assistant", `Updated custom model ${providerId}/${apiModelId}`);
  }
}
