import type { Command, CommandContext } from "./index";
import {
  listAllSessions,
  deleteSessionFile,
  renameSessionFile,
  createNewSession,
  loadSession,
} from "../lib/sessionPersistence";
import { formatRelativeTime } from "../tui/renderers/sessionPickerRenderer";
import { messageQueue } from "../lib/messageQueue";

async function listSessions(ctx: CommandContext) {
  const { addMessage } = ctx;
  const sessions = listAllSessions();
  const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "";

  if (sessions.length === 0) {
    addMessage("assistant", "No saved sessions found.");
    return;
  }

  const lines: string[] = [];
  lines.push(`\u001b[1mSessions (${sessions.length})\u001b[0m — Newest first`);
  lines.push("─".repeat(50));

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const isCurrent = s.sessionId === activeId;
    const marker = isCurrent ? "\u001b[32m●\u001b[0m" : " ";
    const name = s.metadata?.name ? `${s.metadata.name} (${s.sessionId})` : s.sessionId;
    const currentBadge = isCurrent ? " \u001b[36m(current)\u001b[0m" : "";
    const msgCount = `${s.messages.length} msgs`;
    const modelStr = s.metadata?.model || "no model";
    const providerStr = s.metadata?.provider ? `${s.metadata.provider}/` : "";
    const timeStr = formatRelativeTime(s.updatedAt);
    const meta = `\u001b[90m· ${providerStr}${modelStr} · ${msgCount} · ${timeStr}\u001b[0m`;

    lines.push(`  ${marker} \u001b[1m${name}\u001b[0m${currentBadge}  ${meta}`);
  }

  lines.push("");
  lines.push("Commands: /session switch <id> │ /session current │ /session delete <id> │ /session new");
  addMessage("assistant", lines.join("\n"));
}

async function showCurrentSession(ctx: CommandContext) {
  const { addMessage } = ctx;
  const activeId = ctx.getCurrentSessionId ? ctx.getCurrentSessionId() : "";
  if (!activeId) {
    addMessage("assistant", "No active session.");
    return;
  }

  const loaded = loadSession(activeId);
  const provider = loaded?.metadata?.provider || (ctx.provider ? ctx.provider.name : "Not configured");
  const model = loaded?.metadata?.model || (ctx.currentModel ? ctx.currentModel() : "Not selected");
  const workspace = loaded?.metadata?.workspace || process.cwd();
  const msgCount = loaded?.messages?.length || (ctx.getMessages ? ctx.getMessages().length : 0);
  const created = loaded?.metadata?.createdAt || loaded?.updatedAt || "N/A";
  const updated = loaded?.updatedAt || "N/A";
  const queuedCount = messageQueue.size();
  const queuedList = messageQueue.getAll();

  const lines: string[] = [];
  lines.push(`\u001b[1m\u001b[36mSession Details\u001b[0m`);
  lines.push("─".repeat(50));
  lines.push(`  \u001b[1mSession ID:\u001b[0m    ${activeId}`);
  lines.push(`  \u001b[1mProvider:\u001b[0m      ${provider}`);
  lines.push(`  \u001b[1mModel:\u001b[0m         ${model}`);
  lines.push(`  \u001b[1mWorkspace:\u001b[0m     ${workspace}`);
  lines.push(`  \u001b[1mMessages:\u001b[0m      ${msgCount}`);
  lines.push(`  \u001b[1mCreated:\u001b[0m       ${created}`);
  lines.push(`  \u001b[1mUpdated:\u001b[0m       ${updated} (${formatRelativeTime(updated)})`);
  lines.push(`  \u001b[1mQueued tasks:\u001b[0m  ${queuedCount}`);

  if (queuedCount > 0) {
    queuedList.forEach((q, i) => {
      lines.push(`    \u001b[33m›\u001b[0m ${i + 1}. ${q.text.slice(0, 60)}`);
    });
  }

  lines.push("");
  lines.push(`Resume with: \u001b[1m\u001b[36mtoolnet resume ${activeId}\u001b[0m`);
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
      addMessage("assistant", `\u001b[32m✓\u001b[0m Switched to session: \u001b[1m${targetSessionId}\u001b[0m`);
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
  addMessage("assistant", `\u001b[32m✓\u001b[0m Created new session: \u001b[1m${s.metadata?.name || s.sessionId}\u001b[0m`);
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
  if (!deleted) {
    addMessage("assistant", `\u001b[31mFailed to delete session: ${targetId}\u001b[0m`);
    return;
  }

  if (isDeletingActive) {
    const remaining = listAllSessions();
    if (remaining.length > 0 && ctx.switchSession) {
      ctx.switchSession(remaining[0].sessionId);
    } else if (ctx.switchSession) {
      const newS = createNewSession();
      ctx.switchSession(newS.sessionId);
    }
  }
  addMessage("assistant", `\u001b[32m✓\u001b[0m Deleted session: ${targetId}`);
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
    addMessage("assistant", `\u001b[32m✓\u001b[0m Session renamed to: \u001b[1m${name}\u001b[0m`);
  } else {
    addMessage("assistant", `\u001b[31mFailed to rename session.\u001b[0m`);
  }
}

export const sessionCommand: Command = {
  name: "session",
  aliases: ["sessions", "tab"],
  description: "Manage conversation sessions & tabs",
  usage: "/session [current|list|new|switch|delete|rename] ...",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0) {
      if (typeof ctx.openSessionPicker === "function") {
        await ctx.openSessionPicker();
        return;
      }
      await listSessions(ctx);
      return;
    }

    const sub = args[0].toLowerCase();
    const subArgs = args.slice(1);

    if (sub === "current" || sub === "info" || sub === "status") {
      await showCurrentSession(ctx);
      return;
    }
    if (sub === "list" || sub === "ls") {
      await listSessions(ctx);
      return;
    }
    if (sub === "new" || sub === "create") {
      createSession(subArgs, ctx);
      return;
    }
    if (sub === "switch" || sub === "goto" || sub === "resume") {
      await switchToSession(subArgs, ctx);
      return;
    }
    if (sub === "delete" || sub === "rm") {
      deleteSession(subArgs, ctx);
      return;
    }
    if (sub === "rename") {
      rename(subArgs, ctx);
      return;
    }

    ctx.addMessage("assistant", `Unknown subcommand: ${sub}\nTry: /session current, /session new, /session switch <id>, /session delete <id>, /session rename <name>`);
  },
};
