import type { Command, CommandContext } from "./index";

const LEVELS = ["lite", "full", "ultra", "chad-lite", "chad", "chad-ultra"] as const;

export const jailbreakCommand: Command = {
  name: "jailbreak",
  aliases: ["jb"],
  description: "Toggle jailbreak bypass mode (injects unrestricted prompt to bypass content filters)",
  usage: "/jailbreak [on|off|<level>]",
  async handler(args: string[], ctx: CommandContext) {
    const { gateway, addMessage } = ctx;

    if (args.length === 0) {
      const res = await gateway.getSettings();
      if (!res.success) {
        addMessage("assistant", `\u001b[31mError: ${res.error}\u001b[0m`);
        return;
      }
      const enabled = res.data?.jailbreakEnabled;
      if (ctx.setBypassMode) ctx.setBypassMode(!!enabled);
      const level = res.data?.jailbreakLevel || "full";
      const status = enabled ? "\u001b[32mON\u001b[0m" : "\u001b[31mOFF\u001b[0m";
      addMessage("assistant",
        `Jailbreak bypass: ${status}  Level: \u001b[36m${level}\u001b[0m\n\n` +
        `  /jailbreak on              Enable (default level: full)\n` +
        `  /jailbreak off             Disable\n` +
        `  /jailbreak custom <prompt> Set custom jailbreak prompt\n` +
        `  /jailbreak <level>         Set level + enable\n\n` +
        `Levels: lite, full, ultra, chad-lite, chad, chad-ultra, custom\n` +
        `        (1=mild → 6=extreme)`
      );
      return;
    }

    const val = args[0].toLowerCase();

    if (val === "custom") {
      const customPrompt = args.slice(1).join(" ");
      if (!customPrompt) {
        addMessage("assistant", `\u001b[31mError: Please provide a custom prompt.\u001b[0m`);
        return;
      }
      const res = await gateway.updateSettings({ jailbreakEnabled: true, jailbreakLevel: "custom", jailbreakCustomPrompt: customPrompt });
      if (!res.success) {
        addMessage("assistant", `\u001b[31mError: ${res.error}\u001b[0m`);
        return;
      }
      if (ctx.setBypassMode) ctx.setBypassMode(true);
      addMessage("assistant", `Jailbreak bypass: \u001b[32mON\u001b[0m  Level: \u001b[36mcustom\u001b[0m\nCustom prompt active.`);
      return;
    }

    // Set level (implicitly enables)
    const levelMatch = LEVELS.find(l => l === val);
    if (levelMatch) {
      const res = await gateway.updateSettings({ jailbreakEnabled: true, jailbreakLevel: levelMatch });
      if (!res.success) {
        addMessage("assistant", `\u001b[31mError: ${res.error}\u001b[0m`);
        return;
      }
      if (ctx.setBypassMode) ctx.setBypassMode(true);
      addMessage("assistant",
        `Jailbreak bypass: \u001b[32mON\u001b[0m  Level: \u001b[36m${levelMatch}\u001b[0m\n` +
        `Prompt level ${LEVELS.indexOf(levelMatch) + 1} of ${LEVELS.length} active.`
      );
      return;
    }

    if (val === "on" || val === "1") {
      const res = await gateway.updateSettings({ jailbreakEnabled: true });
      if (!res.success) {
        addMessage("assistant", `\u001b[31mError: ${res.error}\u001b[0m`);
        return;
      }
      if (ctx.setBypassMode) ctx.setBypassMode(true);
      addMessage("assistant", `Jailbreak bypass: \u001b[32mON\u001b[0m`);
      return;
    }

    if (val === "off" || val === "0") {
      const res = await gateway.updateSettings({ jailbreakEnabled: false });
      if (!res.success) {
        addMessage("assistant", `\u001b[31mError: ${res.error}\u001b[0m`);
        return;
      }
      if (ctx.setBypassMode) ctx.setBypassMode(false);
      addMessage("assistant", `Jailbreak bypass: \u001b[31mOFF\u001b[0m`);
      return;
    }

    addMessage("assistant",
      `Unknown: "${val}"\n` +
      `Use: /jailbreak on|off|lite|full|ultra|chad-lite|chad|chad-ultra`
    );
  },
};
