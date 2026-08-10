import type { Command, CommandContext } from "./index";
import {
  listAllSessions,
  deleteSessionFile,
  renameSessionFile,
  createNewSession,
} from "../lib/sessionPersistence";

async function listSessions(ctx: CommandContext) {
  const { addMessage } = ctx;
  const sessions = listAllSessions();
  const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "";
  const lines: string[] = [];
  lines.push(`Sessions (${sessions.length})`);
  lines.push("───".repeat(10));
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const isCurrent = s.sessionId === activeId;
    const marker = isCurrent ? "\u001b[32m\u25B6\u001b[0m" : " ";
    const name = s.metadata?.name || s.sessionId;
    const msgCount = s.messages.length;
    const modelStr = s.metadata?.model ? `, ${s.metadata.model}` : "";
    lines.push(`  ${marker} \u001b[1m${name}\u001b[0m (${msgCount} msgs${modelStr})`);
    lines.push(`        id: ${s.sessionId}`);
  }
  addMessage("assistant", lines.join("\n"));
}

async function switchToSession(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  if (args.length < 1) {
    addMessage("assistant", "Usage: /session switch <index|id>");
    return;
  }
  const target = args[0];
  const sessions = listAllSessions();
  let targetSessionId = "";
  const numIdx = parseInt(target, 10);
  if (!isNaN(numIdx) && numIdx >= 1 && numIdx <= sessions.length) {
    targetSessionId = sessions[numIdx - 1].sessionId;
  } else {
    const found = sessions.find(s => s.sessionId === target || s.metadata?.name === target);
    if (found) targetSessionId = found.sessionId;
  }

  if (targetSessionId && ctx.switchSession) {
    const ok = ctx.switchSession(targetSessionId);
    if (ok) {
      addMessage("assistant", `\u001b[32m\u2713\u001b[0m Switched to session: ${targetSessionId}`);
      return;
    }
  }
  addMessage("assistant", `\u001b[31mSession not found: ${target}\u001b[0m`);
}

function createSession(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  const name = args.join(" ") || undefined;
  const s = createNewSession(name);
  if (ctx.switchSession) {
    ctx.switchSession(s.sessionId);
  }
  addMessage("assistant", `\u001b[32m\u2713\u001b[0m Created new session: ${s.metadata?.name || s.sessionId}`);
}

function deleteSession(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  const sessions = listAllSessions();
  if (sessions.length <= 1) {
    addMessage("assistant", "\u001b[33mCannot delete the last session.\u001b[0m");
    return;
  }
  let targetId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : sessions[0].sessionId;
  if (args.length > 0) {
    const target = args[0];
    const numIdx = parseInt(target, 10);
    if (!isNaN(numIdx) && numIdx >= 1 && numIdx <= sessions.length) {
      targetId = sessions[numIdx - 1].sessionId;
    } else {
      const found = sessions.find(s => s.sessionId === target || s.metadata?.name === target);
      if (found) targetId = found.sessionId;
    }
  }

  const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "";
  const isDeletingActive = targetId === activeId;
  const deleted = deleteSessionFile(targetId);
  if (deleted) {
    if (isDeletingActive) {
      const remaining = listAllSessions();
      if (remaining.length > 0 && ctx.switchSession) {
        ctx.switchSession(remaining[0].sessionId);
      } else if (ctx.switchSession) {
        const newS = createNewSession();
        ctx.switchSession(newS.sessionId);
      }
    }
    addMessage("assistant", `\u001b[32m\u2713\u001b[0m Deleted session: ${targetId}`);
  } else {
    addMessage("assistant", `\u001b[31mFailed to delete session: ${targetId}\u001b[0m`);
  }
}

function rename(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  if (args.length < 1) {
    addMessage("assistant", "Usage: /session rename <name>");
    return;
  }
  const name = args.join(" ");
  const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "";
  if (activeId && renameSessionFile(activeId, name)) {
    addMessage("assistant", `\u001b[32m\u2713\u001b[0m Session renamed to: ${name}`);
  } else {
    addMessage("assistant", `\u001b[31mFailed to rename session.\u001b[0m`);
  }
}

export const sessionCommand: Command = {
  name: "session",
  aliases: ["sessions", "tab"],
  description: "Manage multi-session tabs",
  usage: "/session [list|new|switch|delete|rename] ...",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0 || args[0] === "list") {
      await listSessions(ctx);
      return;
    }
    const sub = args[0].toLowerCase();
    const subArgs = args.slice(1);
    switch (sub) {
      case "new":
      case "create":  createSession(subArgs, ctx); break;
      case "switch":
      case "goto":    await switchToSession(subArgs, ctx); break;
      case "delete":
      case "rm":      deleteSession(subArgs, ctx); break;
      case "rename":  rename(subArgs, ctx); break;
      default:        ctx.addMessage("assistant", `Unknown: ${sub}\nTry: list, new, switch, delete, rename`); break;
    }
  },
};
