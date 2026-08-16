import type { Command, CommandContext } from "./index";

const LEVELS = ["lite", "full", "ultra", "chad-lite", "chad", "chad-ultra"] as const;

export const jailbreakCommand: Command = {
  name: "jailbreak",
  aliases: ["jb", "bypass"],
  description: "Toggle guardrail bypass / jailbreak mode (injects unrestricted prompt to bypass LLM content filters)",
  usage: "/bypass [on|off|toggle|<level>] | /jailbreak [on|off|<level>]",
  async handler(args: string[], ctx: CommandContext) {
    const { gateway, addMessage } = ctx;

    // No args: query status and display helper
    if (args.length === 0) {
      const res = await gateway.getSettings();
      if (!res.success) {
        addMessage("assistant", `\x1b[31mError: ${res.error}\x1b[0m`);
        return;
      }
      const enabled = Boolean(res.data?.jailbreakEnabled);
      const level = res.data?.jailbreakLevel || "full";
      if (ctx.setBypassMode) ctx.setBypassMode(enabled, level);
      const status = enabled ? "\x1b[32mON\x1b[0m" : "\x1b[31mOFF\x1b[0m";
      addMessage(
        "assistant",
        `🛡️ **Guardrail Bypass / Jailbreak: ${status}**  (Level: \x1b[36m${level}\x1b[0m)\n\n` +
          `  • \`/bypass on\` / \`/jailbreak on\`              Enable bypass (default level: full)\n` +
          `  • \`/bypass off\` / \`/jailbreak off\`            Disable bypass\n` +
          `  • \`/bypass toggle\`                            Toggle bypass state\n` +
          `  • \`/bypass <level>\`                           Set level + enable (lite, full, ultra, chad-lite, chad, chad-ultra)\n` +
          `  • \`/bypass custom <prompt>\`                  Set custom system bypass prompt\n\n` +
          `🔒 **Nguyên tắc an ninh**: *7 cấp độ Bypass chỉ mở khóa tầng Prompt LLM để không bị từ chối câu trả lời. Toàn bộ lệnh Shell và thao tác File cục bộ vẫn LUÔN BỊ KIỂM SOÁT chặt chẽ bởi hệ thống Permissions & SecretGuard (Chế độ Sandbox hiện tại).*`
      );
      return;
    }

    const val = args[0].toLowerCase();

    // Toggle subcommand: /bypass toggle
    if (val === "toggle" || val === "t") {
      const cur = await gateway.getSettings();
      const newState = !cur.data?.jailbreakEnabled;
      const curLevel = cur.data?.jailbreakLevel || "full";
      const res = await gateway.updateSettings({ jailbreakEnabled: newState });
      if (!res.success) {
        addMessage("assistant", `\x1b[31mError: ${res.error}\x1b[0m`);
        return;
      }
      if (ctx.setBypassMode) ctx.setBypassMode(newState, curLevel);
      const statusText = newState ? "\x1b[32mON\x1b[0m" : "\x1b[31mOFF\x1b[0m";
      addMessage("assistant", `🛡️ Guardrail bypass: ${statusText}  (Level: \x1b[36m${curLevel}\x1b[0m)`);
      return;
    }

    if (val === "custom") {
      const customPrompt = args.slice(1).join(" ");
      if (!customPrompt) {
        addMessage("assistant", `\x1b[31mError: Please provide a custom prompt.\x1b[0m`);
        return;
      }
      const res = await gateway.updateSettings({
        jailbreakEnabled: true,
        jailbreakLevel: "custom",
        jailbreakCustomPrompt: customPrompt,
      });
      if (!res.success) {
        addMessage("assistant", `\x1b[31mError: ${res.error}\x1b[0m`);
        return;
      }
      if (ctx.setBypassMode) ctx.setBypassMode(true, "custom");
      addMessage("assistant", `🛡️ Guardrail bypass: \x1b[32mON\x1b[0m  Level: \x1b[36mcustom\x1b[0m\nCustom prompt active.`);
      return;
    }

    // Set level (implicitly enables)
    const levelMatch = LEVELS.find((l) => l === val);
    if (levelMatch) {
      const res = await gateway.updateSettings({ jailbreakEnabled: true, jailbreakLevel: levelMatch });
      if (!res.success) {
        addMessage("assistant", `\x1b[31mError: ${res.error}\x1b[0m`);
        return;
      }
      if (ctx.setBypassMode) ctx.setBypassMode(true, levelMatch);
      addMessage(
        "assistant",
        `🛡️ Guardrail bypass: \x1b[32mON\x1b[0m  Level: \x1b[36m${levelMatch}\x1b[0m\n` +
          `Prompt level ${LEVELS.indexOf(levelMatch) + 1} of ${LEVELS.length} active.`
      );
      return;
    }

    if (val === "on" || val === "1" || val === "enable") {
      const res = await gateway.updateSettings({ jailbreakEnabled: true });
      if (!res.success) {
        addMessage("assistant", `\x1b[31mError: ${res.error}\x1b[0m`);
        return;
      }
      const cur = await gateway.getSettings();
      const level = cur.data?.jailbreakLevel || "full";
      if (ctx.setBypassMode) ctx.setBypassMode(true, level);
      addMessage("assistant", `🛡️ Guardrail bypass: \x1b[32mON\x1b[0m  (Level: \x1b[36m${level}\x1b[0m)`);
      return;
    }

    if (val === "off" || val === "0" || val === "disable") {
      const res = await gateway.updateSettings({ jailbreakEnabled: false });
      if (!res.success) {
        addMessage("assistant", `\x1b[31mError: ${res.error}\x1b[0m`);
        return;
      }
      const cur = await gateway.getSettings();
      const level = cur.data?.jailbreakLevel || "full";
      if (ctx.setBypassMode) ctx.setBypassMode(false, level);
      addMessage("assistant", `🛡️ Guardrail bypass: \x1b[31mOFF\x1b[0m`);
      return;
    }

    addMessage(
      "assistant",
      `Unknown option: "${val}"\n` +
        `Usage: \`/bypass [on|off|toggle|<level>]\`\n` +
        `Supported levels: ${LEVELS.join(", ")}`
    );
  },
};
