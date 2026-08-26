import type { Command, CommandContext } from "./index";
import { getVersion } from "../lib/version";
import { backgroundCheck } from "../lib/updater";

export const updateCommand: Command = {
  name: "update",
  aliases: ["upgrade"],
  description: "Check for and apply updates",
  usage: "/update",
  async handler(_args: string[], ctx: CommandContext): Promise<void> {
    const currentVersion = getVersion();
    ctx.setStatusMsg("Checking for updates...");

    try {
      const info = await backgroundCheck();
      if (!info) {
        ctx.addMessage("system", `Current CLI version: v${currentVersion}\n(Offline/Network timeout checking updates)`);
        return;
      }

      if (!info.hasUpdate) {
        ctx.addMessage("system", `✔ ToolNet CLI is up to date (v${currentVersion}).`);
      } else {
        ctx.addMessage(
          "system",
          `→ Update Available!\n• Installed: v${currentVersion}\n• Latest   : v${info.latestVersion}\n\nTo update, run:\n  toolnet update`
        );
      }
    } catch (err: any) {
      ctx.addMessage("system", `Current CLI version: v${currentVersion}\n(Offline/Network timeout checking updates: ${err?.message || String(err)})`);
    }
  },
};
