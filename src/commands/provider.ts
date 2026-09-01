/**
 * Provider management CLI commands.
 *
 * Provides:
 *   toolnet provider list      — list all configured providers
 *   toolnet provider add       — add a new provider
 *   toolnet provider use <id>  — set active provider
 *   toolnet provider current   — show current active provider
 *   toolnet provider remove <id> — remove a provider
 *   toolnet provider status    — check health of configured providers
 */

import type { Command, CommandContext } from "./index";
import {
  listProviders,
  addProvider,
  setActiveProvider,
  removeProvider,
  getActiveProviderConfig,
  resolveApiKey,
  createProviderInstance,
  type ProviderConfig,
  onProviderSwitch,
  notifyProviderSwitch,
  type ProviderSwitchListener,
} from "../providers";

export { onProviderSwitch, notifyProviderSwitch, type ProviderSwitchListener };

export const providerCommand: Command = {
  name: "provider",
  aliases: ["providers", "prov"],
  description: "Manage AI model providers (add, use, list, current, remove, status)",
  usage: "/provider [list|add|use|current|remove|status] [options]",
  async handler(args: string[], ctx: CommandContext) {
    const { addMessage } = ctx;
    const subcommand = args[0]?.toLowerCase() || "current";

    switch (subcommand) {
      case "list":
      case "ls": {
        const providers = listProviders();
        const active = getActiveProviderConfig();

        if (providers.length === 0) {
          addMessage("assistant",
            "No providers configured.\n\n" +
            "Add one with:\n" +
            "  /provider add openai-compatible --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY\n\n" +
            "Or via CLI:\n" +
            "  toolnet provider add custom --base-url https://api.example.com/v1 --api-key-env API_KEY"
          );
          return;
        }

        const lines: string[] = ["Configured Providers:", "───".repeat(18), ""];
        for (const p of providers) {
          const isActive = active?.id === p.id;
          const status = isActive ? "\u001b[32m● active\u001b[0m" : "\u001b[90m○ inactive\u001b[0m";
          const keySource = p.apiKeyEnv ? `env:${p.apiKeyEnv}` : p.apiKey ? "(stored)" : "none";
          lines.push(`  ${status} \u001b[1m${p.id}\u001b[0m — ${p.name}`);
          lines.push(`    URL:   ${p.baseUrl}`);
          lines.push(`    Key:   ${keySource}`);
          if (p.defaultModel) lines.push(`    Model: ${p.defaultModel}`);
          lines.push("");
        }

        addMessage("assistant", lines.join("\n"));
        break;
      }

      case "add":
      case "new": {
        const opts: Partial<ProviderConfig> = {
          id: "",
          name: "",
          baseUrl: "",
        };

        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          if (arg === "--base-url" && args[i + 1]) {
            opts.baseUrl = args[++i];
          } else if (arg === "--api-key-env" && args[i + 1]) {
            opts.apiKeyEnv = args[++i];
          } else if (arg === "--api-key" && args[i + 1]) {
            opts.apiKey = args[++i];
          } else if (arg === "--default-model" && args[i + 1]) {
            opts.defaultModel = args[++i];
          } else if (arg === "--name" && args[i + 1]) {
            opts.name = args[++i];
          } else if (!arg.startsWith("--") && !opts.id) {
            opts.id = arg;
          }
        }

        if (!opts.id) {
          addMessage("assistant",
            "Usage: /provider add <id> --base-url <url> [options]\n\n" +
            "Options:\n" +
            "  --base-url <url>       API base URL (required)\n" +
            "  --api-key-env <VAR>    Environment variable containing API key\n" +
            "  --api-key <key>        API key (stored in config, less secure)\n" +
            "  --default-model <m>    Default model to use\n" +
            "  --name <display-name>  Display name (default: id)\n\n" +
            "Examples:\n" +
            "  /provider add openai --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY\n" +
            "  /provider add deepseek --base-url https://api.deepseek.com/v1 --api-key-env DEEPSEEK_API_KEY\n" +
            "  /provider add custom --base-url https://my-proxy.com/v1 --api-key-env MY_KEY"
          );
          return;
        }

        if (!opts.baseUrl) {
          addMessage("assistant", "Error: --base-url is required. Example: /provider add myapi --base-url https://api.example.com/v1");
          return;
        }

        const config: ProviderConfig = {
          id: opts.id,
          name: opts.name || opts.id,
          baseUrl: opts.baseUrl,
          apiKeyEnv: opts.apiKeyEnv,
          apiKey: opts.apiKey,
          defaultModel: opts.defaultModel,
        };

        addProvider(config);
        addMessage("assistant",
          `✅ Provider \`${config.id}\` added!\n\n` +
          `  URL:   ${config.baseUrl}\n` +
          `  Key:   ${config.apiKeyEnv ? `env:${config.apiKeyEnv}` : config.apiKey ? "(stored)" : "none"}\n` +
          `${config.defaultModel ? `  Model: ${config.defaultModel}\n` : ""}` +
          `\nTo activate: /provider use ${config.id}`
        );
        break;
      }

      case "use":
      case "switch":
      case "set": {
        const id = args[1]?.trim();
        if (!id) {
          addMessage("assistant", "✖ Usage: `/provider use <provider-id>`\nExample: `/provider use openai`");
          return;
        }

        const ok = setActiveProvider(id);
        if (!ok) {
          addMessage("assistant", `✖ Provider \`${id}\` not found. Use /provider list to see available providers.`);
          return;
        }

        const config = getActiveProviderConfig();
        const providerName = config?.name || id;
        const defaultModel = config?.defaultModel || "";

        // Notify listeners cleanly
        notifyProviderSwitch(id, config);

        addMessage("assistant",
          `✅ Active provider set to \`${id}\`\n\n` +
          `  Name:  ${providerName}\n` +
          `  URL:   ${config?.baseUrl || "unknown"}\n` +
          `${defaultModel ? `  Model: ${defaultModel}\n` : ""}` +
          `\nProvider activated immediately in current session.`
        );
        break;
      }

      case "current":
      case "show": {
        const config = getActiveProviderConfig();
        if (!config) {
          addMessage("assistant",
            "No active provider configured.\n\n" +
            "Add one with: /provider add <id> --base-url <url> --api-key-env <VAR>"
          );
          return;
        }

        const apiKey = resolveApiKey(config);
        const keyStatus = apiKey ? "\u001b[32mavailable\u001b[0m" : "\u001b[31mmissing\u001b[0m";

        addMessage("assistant",
          `Active Provider:\n` +
          `───`.repeat(18) + "\n\n" +
          `  ID:     ${config.id}\n` +
          `  Name:   ${config.name}\n` +
          `  URL:    ${config.baseUrl}\n` +
          `  Key:    ${keyStatus}${config.apiKeyEnv ? ` (env: ${config.apiKeyEnv})` : ""}\n` +
          `  Model:  ${config.defaultModel || "(none configured)"}`
        );
        break;
      }

      case "status":
      case "health": {
        const providers = listProviders();
        if (providers.length === 0) {
          addMessage("assistant", "No providers configured to test.");
          return;
        }

        addMessage("assistant", "Testing provider connectivity...");
        const results: string[] = ["Provider Health Status:", "───".repeat(18), ""];

        for (const p of providers) {
          const instance = createProviderInstance(p);
          const start = Date.now();
          let isOk = false;
          try {
            if (typeof instance.health === "function") {
              isOk = await instance.health();
            } else {
              const models = await instance.listModels();
              isOk = Array.isArray(models);
            }
          } catch {
            isOk = false;
          }
          const latency = Date.now() - start;
          const statusIcon = isOk ? "\u001b[32m● Online\u001b[0m" : "\u001b[31m✖ Unreachable\u001b[0m";
          results.push(`  ${statusIcon} \u001b[1m${p.id}\u001b[0m (${p.name}) — ${latency}ms`);
        }

        addMessage("assistant", results.join("\n"));
        break;
      }

      case "remove":
      case "delete":
      case "rm": {
        const id = args[1];
        if (!id) {
          addMessage("assistant", "Usage: /provider remove <provider-id>");
          return;
        }

        const removed = removeProvider(id);
        if (removed) {
          addMessage("assistant", `✅ Provider \`${id}\` removed.`);
        } else {
          addMessage("assistant", `✖ Provider \`${id}\` not found.`);
        }
        break;
      }

      default:
        addMessage("assistant",
          "Usage:\n" +
          "  /provider list         List configured providers\n" +
          "  /provider add <id>     Add a new provider\n" +
          "  /provider use <id>     Set active provider\n" +
          "  /provider current      Show current provider\n" +
          "  /provider status       Check health of providers\n" +
          "  /provider remove <id>  Remove a provider"
        );
    }
  },
};
