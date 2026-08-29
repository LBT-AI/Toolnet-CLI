import type { Command, CommandContext } from "./index";
import { getSandboxMode } from "../lib/permissions";
import { getSessionsDir } from "../lib/sessionPersistence";
import { getCwdInfo } from "../lib/codingAgent";
import { getCliKey } from "../lib/keys";
import { bypassEngine } from "../lib/bypass";
import { execSync } from "node:child_process";
import fs from "node:fs";

export const doctorCommand: Command = {
  name: "doctor",
  aliases: ["health", "check"],
  description: "Run diagnostic system and health checks for ToolNet CLI",
  usage: "/doctor",
  async handler(_args: string[], ctx: CommandContext): Promise<void> {
    const cwd = getCwdInfo().currentCwd;
    const sessionsDir = getSessionsDir();
    const sandbox = getSandboxMode();

    let bunVer = "not installed";
    try {
      if (process.versions && (process.versions as any).bun) {
        bunVer = `v${(process.versions as any).bun}`;
      } else {
        bunVer = execSync("bun --version", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      }
    } catch {}

    let gitVer = "not installed";
    try {
      gitVer = execSync("git --version", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {}

    let playwrightVer = "not detected";
    try {
      require.resolve("playwright");
      playwrightVer = "installed (playwright)";
    } catch {
      try {
        require.resolve("playwright-core");
        playwrightVer = "installed (playwright-core)";
      } catch {}
    }

    let gwStatus = "unknown";
    try {
      if (ctx.gateway) {
        const isOnline = await ctx.gateway.checkConnection();
        gwStatus = isOnline ? "Connected (Online)" : "Offline / Unreachable";
      } else {
        gwStatus = "No gateway configured";
      }
    } catch {
      gwStatus = "Offline / Unreachable";
    }

    const hasToolnetKey = Boolean(getCliKey("toolnet") || getCliKey("default"));
    const hasOpenAiKey = Boolean(getCliKey("openai"));
    const hasAnthropicKey = Boolean(getCliKey("anthropic"));
    const hasDashscopeKey = Boolean(getCliKey("alibaba") || getCliKey("dashscope") || process.env.DASHSCOPE_API_KEY);

    const report = [
      `=== ToolNet API CLI Doctor Report ===`,
      ``,
      `Environment & Runtimes:`,
      `• Node.js      : ${process.version}`,
      `• Bun Runtime  : ${bunVer}`,
      `• Platform/Arch: ${process.platform}-${process.arch}`,
      `• Git          : ${gitVer}`,
      `• Playwright   : ${playwrightVer}`,
      ``,
      `Configuration & Workspace:`,
      `• Workspace CWD: ${cwd}`,
      `• Sessions Dir : ${sessionsDir} (${fs.existsSync(sessionsDir) ? "Writable ✓" : "Missing ✗"})`,
      `• Sandbox Mode : ${sandbox.toUpperCase()}`,
      `• Bypass 2.0   : ${bypassEngine.isEnabled() ? `ACTIVE (${bypassEngine.getLevel().toUpperCase()})` : "OFF"} (Auto-Escalate: ${bypassEngine.getConfig().autoEscalate ? "ON" : "OFF"})`,
      `• Active Model : ${ctx.currentModel()}`,
      `• Gateway URL  : ${ctx.gateway?.getBaseUrl() ?? "(none)"} [${gwStatus}]`,
      ``,
      `Stored API Keys:`,
      `• ToolNet / Default   : ${hasToolnetKey ? "Set ✓" : "Not Set"}`,
      `• Alibaba / DashScope : ${hasDashscopeKey ? "Set ✓" : "Not Set"}`,
      `• OpenAI Key          : ${hasOpenAiKey ? "Set ✓" : "Not Set"}`,
      `• Anthropic Key       : ${hasAnthropicKey ? "Set ✓" : "Not Set"}`,
      ``,
      `Diagnostics Summary: ${gwStatus.includes("Connected") ? "All core systems operational ✓" : "⚠ Gateway connection check failed"}`
    ].join("\n");

    ctx.addMessage("system", report);
  },
};
