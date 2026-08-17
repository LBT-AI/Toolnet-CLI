import type { Command, CommandContext } from "./index";
import {
  bypassEngine,
  ALL_BYPASS_LEVELS,
  BYPASS_LEVEL_CATALOG,
  type BypassLevel,
} from "../lib/bypass";

export const jailbreakCommand: Command = {
  name: "jailbreak",
  aliases: ["jb", "bypass"],
  description: "Toggle guardrail bypass / jailbreak mode 2.0 (injects unrestricted prompts & anti-refusal engine)",
  usage: "/bypass [on|off|toggle|<level>] | /bypass levels | /bypass retry [on|off] | /bypass force [on|off]",
  async handler(args: string[], ctx: CommandContext) {
    const { gateway, addMessage } = ctx;

    // Subcommand: /bypass levels (show catalog)
    if (args.length >= 1 && (args[0].toLowerCase() === "levels" || args[0].toLowerCase() === "catalog" || args[0].toLowerCase() === "list")) {
      const catalog = bypassEngine.getLevelCatalog();
      const currentLevel = bypassEngine.getLevel();
      const isEnabled = bypassEngine.isEnabled();

      const lines: string[] = [
        `🛡️ **ToolNet Bypass 2.0 — Prompt & Jailbreak Matrix**`,
        `─────────────────────────────────────────────────────────────────────────────`,
        `Current Status: ${isEnabled ? "\x1b[32mACTIVE (ON)\x1b[0m" : "\x1b[31mDISABLED (OFF)\x1b[0m"} | Active Level: \x1b[36m${currentLevel}\x1b[0m`,
        ``,
        `| Level | Potency | Target Models | Purpose / Strategy |`,
        `| :--- | :---: | :--- | :--- |`,
      ];

      for (const lvl of ALL_BYPASS_LEVELS) {
        const info = catalog[lvl];
        if (!info) continue;
        const activeMarker = lvl === currentLevel ? " 👈 [ACTIVE]" : "";
        const stars = "★".repeat(Math.min(5, Math.ceil(info.potency / 2))) + "☆".repeat(5 - Math.min(5, Math.ceil(info.potency / 2)));
        lines.push(
          `| \`/${lvl}\`${activeMarker} | \`${stars}\` (${info.potency}/10) | ${info.targetModels} | ${info.description} |`
        );
      }

      lines.push(``);
      lines.push(`💡 *Tip: Gõ \`/bypass <tên_level>\` (ví dụ: \`/bypass godmode\` hoặc \`/bypass devmode\`) để kích hoạt ngay!*`);
      addMessage("assistant", lines.join("\n"));
      return;
    }

    // Subcommand: /bypass retry on|off
    if (args.length >= 1 && (args[0].toLowerCase() === "retry" || args[0].toLowerCase() === "escalate" || args[0].toLowerCase() === "auto-retry")) {
      const stateArg = args[1]?.toLowerCase();
      const enable = stateArg === "on" || stateArg === "1" || stateArg === "true" || (stateArg === undefined && !bypassEngine.getConfig().autoEscalate);
      bypassEngine.setAutoEscalate(enable);
      addMessage(
        "assistant",
        `🔄 **Anti-Refusal Auto-Escalation**: ${enable ? "\x1b[32mENABLED\x1b[0m" : "\x1b[31mDISABLED\x1b[0m"}\n` +
          `• When enabled, if an AI responds with a refusal ("I cannot...", "Tôi không thể..."), ToolNet will automatically escalate bypass level and re-generate.`
      );
      return;
    }

    // Subcommand: /bypass force on|off
    if (args.length >= 1 && args[0].toLowerCase() === "force") {
      const stateArg = args[1]?.toLowerCase();
      const enable = stateArg === "on" || stateArg === "1" || stateArg === "true" || (stateArg === undefined && !bypassEngine.getConfig().forceExecution);
      bypassEngine.setForceExecution(enable);
      addMessage(
        "assistant",
        `⚡ **Bypass Local Execution Force**: ${enable ? "\x1b[32mENABLED (Full System Access)\x1b[0m" : "\x1b[31mDISABLED (Workspace Guarded)\x1b[0m"}\n` +
          `• Bypasses local prompt confirmations and sensitive path warnings during automated coding operations.`
      );
      return;
    }

    // No args: query status and display helper
    if (args.length === 0) {
      let gwEnabled = false;
      let gwLevel = "full";
      try {
        const res = await gateway.getSettings();
        if (res.success && res.data) {
          gwEnabled = Boolean(res.data.jailbreakEnabled);
          gwLevel = res.data.jailbreakLevel || "full";
        }
      } catch {}

      const cfg = bypassEngine.getConfig();
      const enabled = cfg.enabled || gwEnabled;
      const level = cfg.level || (gwLevel as BypassLevel);
      if (ctx.setBypassMode) ctx.setBypassMode(enabled, level);
      const status = enabled ? "\x1b[32mON\x1b[0m" : "\x1b[31mOFF\x1b[0m";

      addMessage(
        "assistant",
        `🛡️ **Guardrail Bypass / Jailbreak 2.0: ${status}**  (Level: \x1b[36m${level}\x1b[0m)\n\n` +
          `  • \`/bypass on [level]\`          Bật bypass (mặc định: \`godmode\` hoặc level trước đó)\n` +
          `  • \`/bypass off\`                 Tắt bypass\n` +
          `  • \`/bypass toggle\`              Bật / Tắt nhanh\n` +
          `  • \`/bypass levels\`              Xem danh sách & sức mạnh 10 cấp độ Jailbreak\n` +
          `  • \`/bypass <level>\`             Đổi cấp độ: \`godmode\`, \`devmode\`, \`cybersec\`, \`chad-ultra\`, \`ultra\`, \`full\`, \`raw\`\n` +
          `  • \`/bypass custom <prompt>\`     Thiết lập System Prompt bypass tùy chỉnh\n` +
          `  • \`/bypass retry on|off\`        Tự động nhận diện câu từ chối ("I cannot...") & leo thang level\n` +
          `  • \`/bypass force on|off\`        Mở khóa toàn bộ quyền thực thi Shell & File cục bộ\n\n` +
          `🔥 **Tính năng Bypass 2.0**: *Hỗ trợ vượt qua kiểm duyệt trên Claude 3.7 / GPT-4o / Gemini 2.0 / Qwen 2.5 với cơ chế Anti-Refusal Interceptor.*`
      );
      return;
    }

    const val = args[0].toLowerCase();

    // Toggle subcommand: /bypass toggle
    if (val === "toggle" || val === "t") {
      const curConfig = bypassEngine.getConfig();
      const newState = !curConfig.enabled;
      const curLevel = curConfig.level || "full";

      bypassEngine.setBypass(newState, curLevel);
      try {
        await gateway.updateSettings({ jailbreakEnabled: newState, jailbreakLevel: curLevel });
      } catch {}

      if (ctx.setBypassMode) ctx.setBypassMode(newState, curLevel);
      const statusText = newState ? "\x1b[32mON\x1b[0m" : "\x1b[31mOFF\x1b[0m";
      addMessage("assistant", `🛡️ Guardrail bypass 2.0: ${statusText}  (Level: \x1b[36m${curLevel}\x1b[0m)`);
      return;
    }

    if (val === "custom") {
      const customPrompt = args.slice(1).join(" ");
      if (!customPrompt) {
        addMessage("assistant", `\x1b[31mError: Please provide a custom prompt.\x1b[0m`);
        return;
      }

      bypassEngine.setCustomPrompt(customPrompt);
      try {
        await gateway.updateSettings({
          jailbreakEnabled: true,
          jailbreakLevel: "custom",
          jailbreakCustomPrompt: customPrompt,
        });
      } catch {}

      if (ctx.setBypassMode) ctx.setBypassMode(true, "custom");
      addMessage("assistant", `🛡️ Guardrail bypass 2.0: \x1b[32mON\x1b[0m  Level: \x1b[36mcustom\x1b[0m\nCustom prompt active.`);
      return;
    }

    // Set level directly (e.g. /bypass godmode, /bypass devmode)
    const levelMatch = ALL_BYPASS_LEVELS.find((l) => l === val);
    if (levelMatch) {
      bypassEngine.setBypass(true, levelMatch);
      try {
        await gateway.updateSettings({ jailbreakEnabled: true, jailbreakLevel: levelMatch });
      } catch {}

      if (ctx.setBypassMode) ctx.setBypassMode(true, levelMatch);
      const info = BYPASS_LEVEL_CATALOG[levelMatch];
      addMessage(
        "assistant",
        `🛡️ Guardrail bypass 2.0: \x1b[32mON\x1b[0m  Level: \x1b[36m${levelMatch}\x1b[0m  (Potency: ${info?.potency || 8}/10)\n` +
          `• Mode: **${info?.name || levelMatch}**\n` +
          `• Target: ${info?.targetModels || "All models"}\n` +
          `• ${info?.description || ""}`
      );
      return;
    }

    if (val === "on" || val === "1" || val === "enable") {
      let targetLevel: BypassLevel = "full";
      if (args[1]) {
        const requested = args[1].toLowerCase() as BypassLevel;
        if (ALL_BYPASS_LEVELS.includes(requested)) {
          targetLevel = requested;
        }
      } else {
        targetLevel = bypassEngine.getLevel() || "full";
      }

      bypassEngine.setBypass(true, targetLevel);
      try {
        await gateway.updateSettings({ jailbreakEnabled: true, jailbreakLevel: targetLevel });
      } catch {}

      if (ctx.setBypassMode) ctx.setBypassMode(true, targetLevel);
      addMessage("assistant", `🛡️ Guardrail bypass 2.0: \x1b[32mON\x1b[0m  (Level: \x1b[36m${targetLevel}\x1b[0m)`);
      return;
    }

    if (val === "off" || val === "0" || val === "disable") {
      const curLevel = bypassEngine.getLevel() || "full";
      bypassEngine.setBypass(false);
      try {
        await gateway.updateSettings({ jailbreakEnabled: false });
      } catch {}

      if (ctx.setBypassMode) ctx.setBypassMode(false, curLevel);
      addMessage("assistant", `🛡️ Guardrail bypass 2.0: \x1b[31mOFF\x1b[0m`);
      return;
    }

    addMessage(
      "assistant",
      `Unknown option: "${val}"\n` +
        `Usage: \`/bypass [on|off|toggle|<level>|levels|retry|force]\`\n` +
        `Supported levels: ${ALL_BYPASS_LEVELS.join(", ")}`
    );
  },
};
