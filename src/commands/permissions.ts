import type { Command, CommandContext } from "./index";
import { getSandboxMode, setSandboxMode, type SandboxMode } from "../lib/permissions";
import { getSandboxStatusBadge, detectSandboxCapability } from "../lib/security/sandboxExecutor";
import { permissionGate } from "../lib/security/permissionGate";
import { SessionTrustManager } from "../lib/security/sessionTrust";

export const permissionsCommand: Command = {
  name: "permissions",
  aliases: ["permission", "sandbox", "perm"],
  description: "View and configure security sandbox mode, OS isolation, and network policy",
  usage: "/permissions [workspace|ask|full-access|network <allowed|ask|denied>]",
  async handler(args: string[], ctx: CommandContext) {
    const sub = args[0]?.toLowerCase();

    if (sub === "workspace" || sub === "ask" || sub === "full-access") {
      setSandboxMode(sub as SandboxMode);
      const cap = detectSandboxCapability();
      ctx.addMessage(
        "assistant",
        `✔ Security sandbox mode switched to **${sub.toUpperCase()}**.\n` +
        `• Filesystem: ${sub === "workspace" ? "workspace-rw (Host root & outside paths blocked)" : sub === "ask" ? "interactive approval" : "unrestricted"}\n` +
        `• OS Isolation: ${cap.label} (${cap.details})\n` +
        `• Network Policy: ${permissionGate.getNetworkMode()}`
      );
      ctx.setStatusMsg(`Sandbox: ${sub}`);
      return;
    }

    if (sub === "network" && args[1]) {
      const netVal = args[1].toLowerCase();
      if (netVal === "allowed" || netVal === "ask" || netVal === "denied") {
        permissionGate.setNetworkMode(netVal as any);
        ctx.addMessage("assistant", `✔ Network policy set to **${netVal.toUpperCase()}**.`);
        return;
      }
    }

    const currentMode = getSandboxMode();
    const badgeInfo = getSandboxStatusBadge(currentMode, permissionGate.getNetworkMode());
    const cap = detectSandboxCapability();
    const trusted = new SessionTrustManager().listTrusted(ctx.getCurrentSessionId?.() || "");

    const lines: string[] = [
      `🛡️ **ToolNet Security Sandbox & Isolation Status**`,
      `────────────────────────────────────────────────`,
      `• **Sandbox Mode**: \`${currentMode.toUpperCase()}\` (${currentMode === "workspace" ? "Strict Workspace Containment" : currentMode === "ask" ? "Interactive User Approval" : "Full Access"})`,
      `• **OS Isolation**: \`${cap.label}\` — ${cap.details}`,
      `• **Filesystem Boundary**: \`${currentMode === "workspace" ? "workspace-rw" : "system-wide"}\``,
      `• **Network Policy**: \`${permissionGate.getNetworkMode().toUpperCase()}\``,
      `• **Session-Trusted Rules**: ${trusted.length} rule(s)`,
    ];

    if (trusted.length > 0) {
      for (const t of trusted) {
        lines.push(`  - \`${t}\` (until session exit)`);
      }
    }

    lines.push("");
    lines.push(`*Usage:* \`/permissions [workspace|ask|full-access|network <allowed|ask|denied>]\``);

    ctx.addMessage("assistant", lines.join("\n"));
  },
};
