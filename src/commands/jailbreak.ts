import type { Command, CommandContext } from "./index";
import { bypassEngine } from "../lib/bypass";

/**
 * /bypass — ONE cooperative mode.
 *
 * What it does: makes the agent default to YES on legitimate engineering
 * requests (build the tool, write the script) and strips lecturing noise,
 * with one honest auto-retry when a spurious refusal is detected.
 *
 * What it does NOT do: it never changes permissions. Sandbox mode,
 * SecurityEngine checks, scoped tool sets and interactive approval prompts
 * all stay exactly as they are. A sensitive action still asks — that is the
 * user's own gate, not the model's caution.
 */
export const jailbreakCommand: Command = {
  name: "jailbreak",
  aliases: ["jb", "bypass"],
  description: "Toggle cooperative agent mode: fewer refusals on legit dev tasks; permissions & approvals unchanged",
  usage: "/bypass [on|off|toggle|status] | /bypass retry [on|off] | /bypass custom <note>",
  async handler(args: string[], ctx: CommandContext) {
    const { addMessage } = ctx;

    const statusLine = (on: boolean) => (on ? "\x1b[32mON\x1b[0m" : "\x1b[31mOFF\x1b[0m");

    // Subcommand: /bypass retry on|off
    if (args[0]?.toLowerCase() === "retry") {
      const stateArg = args[1]?.toLowerCase();
      const next =
        stateArg === "on" || stateArg === "1" || stateArg === "enable"
          ? true
          : stateArg === "off" || stateArg === "0" || stateArg === "disable"
            ? false
            : !bypassEngine.getConfig().autoRetry;
      bypassEngine.setAutoRetry(next);
      addMessage("assistant", `Auto-retry on spurious refusal (one honest re-ask): ${statusLine(next)}`);
      return;
    }

    // Subcommand: /bypass custom <note> — user emphasis added to the directive.
    if (args[0]?.toLowerCase() === "custom") {
      const note = args.slice(1).join(" ").trim();
      if (!note) {
        addMessage("assistant", "Usage: /bypass custom <short note, e.g. 'I do security research — skip disclaimers'>");
        return;
      }
      bypassEngine.setCustomPrompt(note);
      bypassEngine.setBypass(true);
      if (ctx.setBypassMode) ctx.setBypassMode(true);
      addMessage("assistant", `Bypass ON with your note added to the directive.\nNote: ${note}`);
      return;
    }

    // No args: status + help.
    if (args.length === 0) {
      const cfg = bypassEngine.getConfig();
      if (ctx.setBypassMode) ctx.setBypassMode(cfg.enabled);
      addMessage(
        "assistant",
        `Bypass mode: ${statusLine(cfg.enabled)}  ·  auto-retry: ${cfg.autoRetry ? "on" : "off"}\n\n` +
          "What ON does:\n" +
          "  • The agent defaults to YES on legitimate engineering requests — tools,\n" +
          "    scripts, scrapers, security research — and skips lectures/disclaimers.\n" +
          "  • One honest automatic retry when it detects a spurious refusal.\n\n" +
          "What ON never does:\n" +
          "  • It does NOT weaken permissions. Workspace limits, sandbox mode and\n" +
          "    approval prompts stay active: important writes and shell commands\n" +
          "    still wait for your confirmation.\n\n" +
          "  /bypass on | off | toggle     Switch the mode\n" +
          "  /bypass retry on|off          One re-ask on spurious refusal\n" +
          "  /bypass custom <note>         Add your own emphasis to the directive",
      );
      return;
    }

    const val = args[0].toLowerCase();

    if (val === "toggle" || val === "t") {
      const next = !bypassEngine.isEnabled();
      bypassEngine.setBypass(next);
      if (ctx.setBypassMode) ctx.setBypassMode(next);
      addMessage("assistant", `Bypass mode: ${statusLine(next)} (permissions & approvals unchanged)`);
      return;
    }

    if (val === "on" || val === "1" || val === "enable") {
      bypassEngine.setBypass(true);
      if (ctx.setBypassMode) ctx.setBypassMode(true);
      addMessage("assistant", `Bypass mode: ${statusLine(true)} — the agent will build what you ask; approvals still apply.`);
      return;
    }

    if (val === "off" || val === "0" || val === "disable") {
      bypassEngine.setBypass(false);
      if (ctx.setBypassMode) ctx.setBypassMode(false);
      addMessage("assistant", `Bypass mode: ${statusLine(false)}`);
      return;
    }

    addMessage("assistant", `Unknown subcommand "${args[0]}". Use /bypass for help.`);
  },
};
