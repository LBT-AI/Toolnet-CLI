import type { Command, CommandContext } from "./index";
import { getActiveProviderConfig } from "../providers";

export const statusCommand: Command = {
  name: "status",
  aliases: ["st"],
  description: "Show provider connection status",
  usage: "/status",
  async handler(_args: string[], ctx: CommandContext) {
    const { addMessage } = ctx;

    const providerConfig = getActiveProviderConfig();

    if (!providerConfig) {
      addMessage("assistant",
        "No provider configured.\n\n" +
        "Add one with:\n" +
        "  /provider add <id> --base-url <url> --api-key-env <VAR>\n\n" +
        "Or via CLI:\n" +
        "  toolnet provider add custom --base-url https://api.example.com/v1 --api-key-env API_KEY"
      );
      return;
    }

    const lines: string[] = [];
    lines.push("ToolNet CLI — Provider Status");
    lines.push("───".repeat(18));
    lines.push("");

    lines.push(`  Provider:  ${providerConfig.name} (${providerConfig.id})`);
    lines.push(`  Endpoint:  ${providerConfig.baseUrl}`);

    // Health check if gateway is available
    if (ctx.gateway) {
      try {
        const healthRes = await ctx.gateway.health();
        lines.push(`  Server:    ${healthRes.success ? "\u001b[32mOnline\u001b[0m" : "\u001b[31mOffline\u001b[0m"}`);
      } catch {
        lines.push(`  Server:    \u001b[31mOffline\u001b[0m`);
      }
    } else {
      lines.push(`  Mode:      Direct API (no gateway)`);
    }

    if (providerConfig.defaultModel) {
      lines.push(`  Model:     ${providerConfig.defaultModel}`);
    }

    if (providerConfig.apiKeyEnv) {
      const hasKey = !!process.env[providerConfig.apiKeyEnv];
      lines.push(`  API Key:   ${hasKey ? "\u001b[32mavailable\u001b[0m (env: " + providerConfig.apiKeyEnv + ")" : "\u001b[31mmissing\u001b[0m (env: " + providerConfig.apiKeyEnv + ")"}`);
    } else if (providerConfig.apiKey) {
      lines.push(`  API Key:   \u001b[32mavailable\u001b[0m (stored)`);
    } else {
      lines.push(`  API Key:   \u001b[31mnone configured\u001b[0m`);
    }

    const { getSandboxMode } = await import("../lib/permissions");
    const { getSandboxStatusBadge, detectSandboxCapability } = await import("../lib/security/sandboxExecutor");
    const { permissionGate } = await import("../lib/security/permissionGate");
    const mode = getSandboxMode();
    const cap = detectSandboxCapability();
    lines.push("");
    lines.push(`  Sandbox:   ${mode.toUpperCase()} · ${cap.label}`);
    lines.push(`  FS:        ${mode === "workspace" ? "workspace-rw" : "unrestricted"}`);
    lines.push(`  Network:   ${permissionGate.getNetworkMode().toUpperCase()}`);

    addMessage("assistant", lines.join("\n"));
  },
};
