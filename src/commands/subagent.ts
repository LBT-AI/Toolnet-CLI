import type { Command, CommandContext } from "./index";
import { executeSubagentTask } from "../teamwork/subagentRuntime";
import type { AgentRole } from "../teamwork/types";

const VALID_ROLES = ["CODER", "RESEARCHER", "TESTER", "REVIEWER", "ARCHITECT", "GENERAL"];

export const subagentCommand: Command = {
  name: "subagent",
  aliases: ["sub", "agent", "delegate"],
  description: "Spawn an autonomous specialized sub-agent for a specific task",
  usage: "/subagent [CODER|RESEARCHER|TESTER|REVIEWER|ARCHITECT] <task description>",
  async handler(args: string[], ctx: CommandContext): Promise<void> {
    if (args.length === 0) {
      ctx.addMessage(
        "assistant",
        `🤖 **ToolNet Sub-Agent Execution**\n\n` +
          `Usage: \`/subagent [role] <task description>\`\n\n` +
          `Available Roles:\n` +
          `  • **RESEARCHER**: Inspect code, search codebase, find patterns, analyze dependencies\n` +
          `  • **CODER**: Write, edit, and refactor code directly with surgical precision\n` +
          `  • **TESTER**: Run unit tests, verify build status, and diagnose test failures\n` +
          `  • **REVIEWER**: Review recent git changes, check security, audit code quality\n` +
          `  • **ARCHITECT**: High-level system design, module boundary planning\n\n` +
          `Example: \`/subagent researcher Tìm tất cả các file liên quan đến auth\``
      );
      return;
    }

    let role: AgentRole = "GENERAL";
    let promptArgs = args;

    const firstArgUpper = args[0].toUpperCase();
    if (VALID_ROLES.includes(firstArgUpper)) {
      role = firstArgUpper as AgentRole;
      promptArgs = args.slice(1);
    }

    const taskPrompt = promptArgs.join(" ");
    if (!taskPrompt) {
      ctx.addMessage("system", "✖ Vui lòng cung cấp mô tả công việc cho Sub-Agent.");
      return;
    }

    const model = ctx.currentModel ? ctx.currentModel() : "default";
    ctx.setStatusMsg(`Sub-Agent [${role}] đang thực thi...`);
    ctx.addMessage(
      "system",
      `🚀 Khởi chạy Sub-Agent **[${role}]**\n` +
        `• Nhiệm vụ: "${taskPrompt}"\n` +
        `• Model: ${model}\n` +
        `• Bắt đầu vòng lặp thực thi độc lập...`
    );

    try {
      const res = await executeSubagentTask(
        {
          id: `manual-${Date.now()}`,
          title: taskPrompt.slice(0, 60),
          role,
          prompt: taskPrompt,
          status: "PENDING",
          dependencies: [],
        },
        {
          model,
          onEvent: (event, data) => {
            if (event === "subagent:tool") {
              ctx.setStatusMsg(`Sub-Agent [${role}] executing ${data.toolName}...`);
            }
          },
        }
      );

      ctx.setStatusMsg("");

      if (res.success) {
        ctx.addMessage(
          "assistant",
          `✅ **Sub-Agent [${role}] hoàn thành nhiệm vụ!**\n\n` +
            `${res.output}\n\n` +
            `*(Đã thực thi: ${res.toolCallsCount} tool calls | ${res.turnsUsed} turns | ~${res.tokensUsed} tokens)*`
        );
      } else {
        ctx.addMessage(
          "assistant",
          `❌ **Sub-Agent [${role}] thất bại:** ${res.error || "Unknown error"}\n` +
            `*(Đã thử: ${res.toolCallsCount} tool calls | ${res.turnsUsed} turns)*`
        );
      }
    } catch (err: any) {
      ctx.setStatusMsg("");
      ctx.addMessage("system", `❌ Lỗi khi khởi chạy Sub-Agent: ${err?.message || String(err)}`);
    }
  },
};
