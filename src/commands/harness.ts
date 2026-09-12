import type { Command, CommandContext } from "./index";
import { getHarness } from "../lib/harness";
import { contextEngine } from "../lib/context";
import { sessionTrust } from "../lib/security/sessionTrust";
// Phase 81 §19 — the TUI is a CONSUMER of the canonical harness registry and
// config owner. It implements no policy and never constructs a harness of its
// own; selection uses the same API as `toolnet harness use`.
import {
  currentHarnessSettings,
  harnessRegistry,
  persistHarnessProfile,
  summarizeHarnessProfile,
} from "../core/harness";

function getFormattedHarnessStatus(ctx: CommandContext): string {
  const harness = getHarness({
    model: ctx.currentModel ? ctx.currentModel() : undefined,
  });
  const snap = harness.getSnapshot();
  const memory = contextEngine.getSessionMemory(snap.sessionId);
  const trustedRules = sessionTrust.listTrusted();

  const lines: string[] = [
    `⚙️ **ToolNet AgentHarness 2.0 (Unified Execution Kernel)**`,
    `───────────────────────────────────────────────────────`,
    `  • **Session ID**: \`${snap.sessionId}\``,
    `  • **Active Model**: \`${snap.currentModel}\``,
    `  • **Workspace Root**: \`${snap.workspaceRoot}\``,
    `  • **Detected Stack**: \`${snap.activeFramework}\``,
    `  • **Security Sandbox**: \`${snap.sandboxMode}\` (${trustedRules.length} session-trusted rules)`,
    ``,
    `📊 **Subsystems & Observability Telemetry**:`,
    `  • **Context Engine**: Atomic compaction ready | ${memory.keyFilesTouched.length} tracked files`,
    `  • **Security Engine**: SecretGuard & Semantic Classifier active`,
    `  • **Total Tool Calls**: ${snap.totalToolCalls}`,
    `  • **Accumulated Tokens**: ~${snap.totalTokensUsed}`,
    `  • **Uptime**: ${Math.round((Date.now() - snap.initializedAt) / 1000)}s`,
    ``,
    `💡 *Execution Strategies available: Headless (-p), Turbo, Teamwork DAG, and Subagents.*`,
  ];

  return lines.join("\n");
}

export const harnessCommand: Command = {
  name: "harness",
  aliases: ["kernel", "sys"],
  description: "Display Unified AgentHarness status, active subsystems, and runtime telemetry",
  usage: "/harness [section] | /harness use <profile> | /harness profile",
  async handler(args: string[], ctx: CommandContext) {
    const action = (args[0] ?? "").toLowerCase();

    if (action === "--help" || action === "help") {
      ctx.addMessage(
        "assistant",
        "/harness — ToolNet Agent Harness status\n\n" +
        "  /harness                 Open the interactive Harness Panel\n" +
        "  /harness <section>       Open one section (profile, session, security, tools, ...)\n" +
        "  /harness profile         Show the active harness policy profile\n" +
        "  /harness use <profile>   Select a profile (same API as `toolnet harness use`)\n\n" +
        "Sections: Profile, Session, Execution, Security, Context, Tools, Telemetry, Subagents."
      );
      return;
    }

    if (action === "use" || action === "set") {
      const id = args[1]?.trim().toLowerCase();
      if (!id) {
        ctx.addMessage(
          "assistant",
          `Usage: /harness use <profile>\nProfiles: ${harnessRegistry.ids().join(", ")}`
        );
        return;
      }
      const result = persistHarnessProfile(id);
      if (!result.ok) {
        // Loud failure — never silently run a different contract.
        ctx.addMessage("assistant", result.errors.join("\n"));
        return;
      }
      ctx.addMessage("assistant", `Harness profile set to '${result.settings.profile}'.`);
      return;
    }

    if (action === "profile" || action === "profiles") {
      const settings = currentHarnessSettings();
      const profile = harnessRegistry.get(settings.profile);
      if (!profile) {
        ctx.addMessage(
          "assistant",
          `Configured profile '${settings.profile}' is not registered. Known: ${harnessRegistry.ids().join(", ")}.`
        );
        return;
      }
      ctx.addMessage(
        "assistant",
        [`Harness profile: ${profile.id} (v${profile.version})`, ...summarizeHarnessProfile(profile)].join("\n")
      );
      return;
    }

    // Interactive TUI: open the Harness Panel overlay (nothing printed to chat).
    if (typeof ctx.openHarnessPanel === "function") {
      const target = args.length > 0 ? args.join(" ").trim() : undefined;
      await ctx.openHarnessPanel(target);
      return;
    }

    // Non-interactive fallback: dump full status as a chat message.
    ctx.addMessage("assistant", getFormattedHarnessStatus(ctx));
  },
};