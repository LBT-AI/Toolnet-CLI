import type { GatewayClient } from "../lib/gateway";
import { helpCommand } from "./help";
import { statusCommand } from "./status";
import { modelCommand } from "./model";
import { exitCommand } from "./exit";
import { toolsCommand } from "./tools";
import { mcpCommand } from "./mcp";
import { skillsCommand } from "./skills";
import { undoCommand } from "./undo";
import { redoCommand } from "./redo";
import { configCommand } from "./config";
import { sessionCommand } from "./session";
import { jailbreakCommand } from "./jailbreak";
import { tuiCommand } from "./tui";
import { teamworkCommand } from "./teamwork";
import { clearCommand } from "./clear";
import { resetCommand } from "./reset";
import { historyCommand } from "./history";
import { planCommand } from "./plan";
import { exportCommand } from "./export";
import { cdCommand } from "./cd";
import { pwdCommand } from "./pwd";
import { artifactCommand } from "./artifact";
import { qaCommand } from "./qa";
import { workspaceCommand } from "./workspace";
import { sandboxCommand } from "./sandbox";
import { compactCommand } from "./compact";
import { attachCommand } from "./attach";
import { doctorCommand } from "./doctor";
import { updateCommand } from "./update";
import { subagentCommand } from "./subagent";
import { harnessCommand } from "./harness";

export interface CommandContext {
  gateway: GatewayClient;
  addMessage: (role: "user" | "assistant" | "system", content: string) => void;
  setModel: (model: string) => void;
  setStatusMsg: (msg: string) => void;
  exit: () => void;
  currentModel: () => string;
  setBypassMode?: (enabled: boolean) => void;
  getCurrentSessionId?: () => string;
  setCurrentSessionId?: (id: string) => void;
  getMessages?: () => any[];
  setMessages?: (messages: any[]) => void;
  clearMessages?: () => void;
  switchSession?: (sessionId: string) => boolean;
  setAgentMode?: (mode: "Build" | "Plan") => void;
}

export interface Command {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  handler: (args: string[], ctx: CommandContext) => Promise<void>;
}

const builtinCommands: Command[] = [
  helpCommand,
  statusCommand,
  modelCommand,
  exitCommand,
  toolsCommand,
  mcpCommand,
  skillsCommand,
  undoCommand,
  redoCommand,
  configCommand,
  sessionCommand,
  jailbreakCommand,
  tuiCommand,
  teamworkCommand,
  clearCommand,
  resetCommand,
  historyCommand,
  planCommand,
  exportCommand,
  cdCommand,
  pwdCommand,
  artifactCommand,
  qaCommand,
  workspaceCommand,
  sandboxCommand,
  compactCommand,
  attachCommand,
  doctorCommand,
  updateCommand,
  subagentCommand,
  harnessCommand,
];

export function getAllCommands(): Command[] {
  return builtinCommands;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function findCommand(input: string): { command: Command; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const rawArgsString = trimmed.slice(1);
  // Match non-space words, OR double-quoted strings, OR single-quoted strings
  const tokenRegex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const parts: string[] = [];
  let match;
  
  while ((match = tokenRegex.exec(rawArgsString)) !== null) {
    // match[1] is double quotes content, match[2] is single quotes content
    // match[0] is unquoted word
    parts.push(match[1] ?? match[2] ?? match[0]);
  }

  if (parts.length === 0) return null;

  const cmdName = parts[0].toLowerCase();
  const args = parts.slice(1);

  for (const cmd of builtinCommands) {
    if (cmd.name === cmdName || cmd.aliases.includes(cmdName)) {
      return { command: cmd, args };
    }
  }

  return null;
}

export async function dispatchCommand(
  input: string,
  ctx: CommandContext
): Promise<boolean> {
  const found = findCommand(input);
  if (!found) return false;

  const { command, args } = found;
  await command.handler(args, ctx);
  return true;
}
