import type { Command, CommandContext } from "./index";
import { saveCliKey, deleteCliKey, listAllCliKeys } from "../lib/keys";

const KNOWN_PROVIDERS = [
  "alibaba",
  "dashscope",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "groq",
  "openrouter",
  "together",
  "mistral",
  "xai",
  "minimax",
  "cohere",
  "toolnet",
];

export const keyCommand: Command = {
  name: "key",
  aliases: ["keys", "apikey", "apikeys"],
  description: "Manage local API keys for AI model providers (Alibaba, OpenAI, Anthropic, Gemini, etc.)",
  usage: "/key [provider] [api-key] | /key list | /key delete <provider>",
  async handler(args: string[], ctx: CommandContext) {
    const { addMessage } = ctx;

    // Subcommand: /key delete <provider>
    if (args.length >= 2 && (args[0].toLowerCase() === "delete" || args[0].toLowerCase() === "remove" || args[0].toLowerCase() === "rm")) {
      const provider = args[1].toLowerCase().trim();
      const deleted = deleteCliKey(provider);
      if (deleted) {
        addMessage("assistant", `🗑️ Deleted local API key for **${provider}**.`);
      } else {
        addMessage("assistant", `✖ No stored key found for provider **${provider}**.`);
      }
      return;
    }

    // Subcommand: /key set <provider> <key> OR /key <provider> <key>
    if (args.length >= 2) {
      let provider = args[0].toLowerCase().trim();
      let key = args.slice(1).join(" ").trim();

      if (provider === "set" || provider === "add") {
        provider = args[1]?.toLowerCase().trim();
        key = args.slice(2).join(" ").trim();
      }

      if (!provider || !key) {
        addMessage("system", "✖ Usage: `/key <provider> <api-key>` (e.g. `/key alibaba sk-xxxxxxxx`)");
        return;
      }

      saveCliKey(provider, key);
      addMessage(
        "assistant",
        `✅ **API key for \`${provider}\` saved successfully!**\n\n` +
          `• Stored securely in \`~/.toolnetcli/cli-keys.json\` (mode 0600)\n` +
          `• You can now use models under provider \`${provider}/*\` (e.g. \`alibaba/qwen-max\`, \`alibaba/qwen-2.5-coder\`).`
      );
      return;
    }

    if (args[0] === "--help") {
      addMessage("assistant",
        "/key — API Key Management\n\n" +
        "  /key                           Open interactive API Keys manager\n" +
        "  /key <provider> <api-key>      Set API key directly\n" +
        "  /key delete <provider>         Delete API key for provider\n" +
        "  /key list                      List configured keys\n" +
        "  /key --help                    Show this help"
      );
      return;
    }

    // If in interactive TUI, open the Key Manager modal
    if (typeof ctx.openKeyManager === "function" && args.length === 0) {
      await ctx.openKeyManager();
      return;
    }

    // Default for non-interactive / headless CLI or /key list
    const activeKeys = listAllCliKeys();
    const lines: string[] = [
      `🔑 **ToolNet CLI — API Key Management**`,
      `───────────────────────────────────────────────────────`,
    ];

    if (activeKeys.length === 0) {
      lines.push(`  *No API keys configured yet.*`);
    } else {
      lines.push(`  **Configured API Keys:**`);
      for (const k of activeKeys) {
        const sourceLabel = k.source === "env" ? `(env: ${k.envVar})` : `(stored)`;
        lines.push(`  • **${k.provider.padEnd(12, " ")}**: \`${k.maskedKey}\` ${sourceLabel}`);
      }
    }

    lines.push(``);
    lines.push(`📖 **Commands & Usage:**`);
    lines.push(`  • Add/Update Key: \`/key <provider> <api-key>\``);
    lines.push(`    *Example*: \`/key alibaba sk-xxxxxxxxxxxxxxxxxxxxxxxx\``);
    lines.push(`    *Example*: \`/key openai sk-proj-xxxxxxxxxxxxxxxxxxxx\``);
    lines.push(`  • Delete Key    : \`/key delete <provider>\``);
    lines.push(``);
    lines.push(`🌐 **Supported Providers:**`);
    lines.push(`  ${KNOWN_PROVIDERS.map((p) => `\`${p}\``).join(", ")}`);

    addMessage("assistant", lines.join("\n"));
  },
};
