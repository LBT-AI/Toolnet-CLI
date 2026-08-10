import fs from "node:fs";
import path from "node:path";
import type { Command, CommandContext } from "./index";
import { currentCwd } from "../lib/codingAgent";
import { AgentRuntime } from "../lib/agentRuntime";

export const qaCommand: Command = {
  name: "qa",
  aliases: ["verify"],
  description: "Run a QA verification loop using an Auditor subagent on the current workspace",
  usage: "/qa [path]",
  async handler(args: string[], ctx: CommandContext) {
    const { addMessage, currentModel } = ctx;
    const targetDir = args.length > 0 ? path.resolve(args[0]) : currentCwd;

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      addMessage("assistant", `\x1b[31mError:\x1b[0m Not a directory: ${targetDir}`);
      return;
    }

    addMessage("assistant", `\x1b[36mQA Auditor starting in:\x1b[0m ${targetDir}\n*Analyzing repository to determine testing strategy...*`);
    ctx.setStatusMsg("Auditor is running...");

    const runtime = new AgentRuntime({
      model: currentModel(),
      maxTurns: 15,
      timeoutMs: 120000,
      onEvent: (event, data) => {
        if (event === "TOOL_START") {
          ctx.setStatusMsg(`Auditor running: ${data.toolName}...`);
        }
      }
    });

    const messages = [
      {
        role: "system",
        content: `You are the QA Auditor. Your objective is to thoroughly verify the codebase located in: ${targetDir}
1. Analyze the project files to determine the appropriate framework and test commands (e.g., look at package.json, Cargo.toml, pyproject.toml, go.mod, etc.).
2. Execute the tests/checks using the run_command tool.
3. If tests fail, you DO NOT need to fix them. Just report the failures and the overall state.
4. Conclude your task with a clear, final summary of the QA results.`
      },
      {
        role: "user",
        content: `Please run QA checks in ${targetDir}.`
      }
    ];

    try {
      const result = await runtime.runLoop(messages as any);
      
      if (result.success) {
        addMessage("assistant", `\n\x1b[36m── QA Auditor Summary ──\x1b[0m\n${result.output}`);
      } else {
        addMessage("assistant", `\x1b[33mQA Auditor stopped:\x1b[0m ${result.error || result.output}`);
      }
    } catch (err: any) {
      addMessage("assistant", `\x1b[31mError:\x1b[0m ${err.message}`);
    } finally {
      ctx.setStatusMsg("");
    }
  },
};
