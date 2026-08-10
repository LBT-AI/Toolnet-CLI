import type { Command, CommandContext } from "./index";

export const statusCommand: Command = {
  name: "status",
  aliases: ["st"],
  description: "Show gateway connection status",
  usage: "/status",
  async handler(_args: string[], ctx: CommandContext) {
    const { gateway, addMessage } = ctx;

    addMessage("assistant", "Fetching gateway status...");

    const [healthRes, provRes, comboRes, keyRes, settingsRes] = await Promise.all([
      gateway.health(),
      gateway.getProviders(),
      gateway.getCombos(),
      gateway.getApiKeys(),
      gateway.getSettings(),
    ]);

    const lines: string[] = [];
    lines.push("ToolNet API Gateway — Status");
    lines.push("───".repeat(18));
    lines.push("");

    const baseUrl = gateway.getBaseUrl();
    lines.push(`  Endpoint:  ${baseUrl}/v1`);
    lines.push(`  Server:    ${healthRes.success ? "\u001b[32mOnline\u001b[0m" : "\u001b[31mOffline\u001b[0m"}`);

    const tunnelStatus = settingsRes.success && (settingsRes.data as any)?.tunnelEnabled
      ? "\u001b[32mON\u001b[0m"
      : "\u001b[90mOFF\u001b[0m (local only)";
    lines.push(`  Tunnel:    ${tunnelStatus}`);

    lines.push("");

    const providers = provRes.success ? (provRes.data?.connections || []) : [];
    const activeProviders = providers.filter((p: any) => p.isActive !== false);
    lines.push(`  Providers: ${activeProviders.length} active / ${providers.length} total`);

    const combos = comboRes.success ? (comboRes.data?.combos || []) : [];
    lines.push(`  Combos:    ${combos.length} configured`);

    const keys = keyRes.success ? (keyRes.data?.keys || []) : [];
    const activeKeys = keys.filter((k: any) => k.isActive !== false);
    lines.push(`  API Keys:  ${activeKeys.length} active / ${keys.length} total`);

    const rtkEnabled = settingsRes.success && (settingsRes.data as any)?.rtkEnabled !== false;
    const headroomEnabled = settingsRes.success && (settingsRes.data as any)?.headroomEnabled === true;
    lines.push(`  RTK:       ${rtkEnabled ? "\u001b[32mON\u001b[0m" : "\u001b[33mOFF\u001b[0m"}`);
    lines.push(`  Headroom:  ${headroomEnabled ? "\u001b[32mON\u001b[0m" : "\u001b[33mOFF\u001b[0m"}`);

    if (providers.length > 0) {
      lines.push("");
      lines.push("  Connected Providers:");
      for (const p of providers.slice(0, 20)) {
        const status = p.testStatus === "active" ? "\u001b[32m\u2713\u001b[0m" : "\u001b[33m?\u001b[0m";
        const name = p.displayName || p.name || p.email || p.providerId || p.provider || "unknown";
        lines.push(`    ${status} ${name}`);
      }
      if (providers.length > 20) {
        lines.push(`    ... and ${providers.length - 20} more`);
      }
    }

    addMessage("assistant", lines.join("\n"));
  },
};
