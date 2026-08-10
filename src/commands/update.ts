import type { Command, CommandContext } from "./index";

export const updateCommand: Command = {
  name: "update",
  aliases: ["upgrade"],
  description: "Check npm registry for toolnet-api CLI updates",
  usage: "/update",
  async handler(_args: string[], ctx: CommandContext): Promise<void> {
    const currentVersion = "1.0.0";
    ctx.setStatusMsg("Checking npm registry for updates...");

    try {
      const res = await fetch("https://registry.npmjs.org/toolnet-api/latest", {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        ctx.addMessage("system", `Current CLI version: v${currentVersion}\nUnable to check npm registry (package might not be published yet).`);
        return;
      }

      const data: any = await res.json();
      const latestVersion = data.version || currentVersion;

      if (latestVersion === currentVersion) {
        ctx.addMessage("system", `✔ toolnet-api is up to date (v${currentVersion}).`);
      } else {
        ctx.addMessage(
          "system",
          `→ Update Available!\n• Installed: v${currentVersion}\n• Latest   : v${latestVersion}\n\nTo update, run:\n  npm install -g toolnet-api@latest`
        );
      }
    } catch (err: any) {
      ctx.addMessage("system", `Current CLI version: v${currentVersion}\n(Offline/Network timeout checking updates: ${err?.message || String(err)})`);
    }
  },
};
