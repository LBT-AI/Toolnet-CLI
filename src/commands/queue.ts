import type { Command, CommandContext } from "./index";
import { messageQueue } from "../lib/messageQueue";

export const queueCommand: Command = {
  name: "queue",
  aliases: ["q", "tasks"],
  description: "View and manage queued user messages / tasks",
  usage: "/queue [list|clear|remove <n>|add <text>]",
  async handler(args: string[], ctx: CommandContext) {
    const sub = (args[0] || "").toLowerCase().trim();

    if (sub === "--help" || sub === "help") {
      ctx.addMessage(
        "assistant",
        "/queue — Message & Task Queue Manager\n\n" +
        "  /queue               Open interactive queue manager popup\n" +
        "  /queue list          List all queued messages (FIFO order)\n" +
        "  /queue clear         Clear all items in the queue\n" +
        "  /queue remove <n>    Remove task #n from the queue\n" +
        "  /queue add <text>    Add a new task directly into the queue\n\n" +
        "When the agent is currently working on a task, any message you submit\n" +
        "is automatically enqueued and executed in FIFO order when current task finishes."
      );
      return;
    }

    if (sub === "clear") {
      const count = messageQueue.size();
      messageQueue.clear();
      ctx.setStatusMsg(`Cleared ${count} queued messages`);
      ctx.addMessage("assistant", `\u001b[32m✓\u001b[0m Cleared \u001b[1m${count}\u001b[0m queued tasks.`);
      return;
    }

    if (sub === "remove" || sub === "delete" || sub === "rm") {
      const idxStr = args[1];
      const idxNum = parseInt(idxStr, 10);
      if (isNaN(idxNum) || idxNum < 1 || idxNum > messageQueue.size()) {
        ctx.addMessage("assistant", `\u001b[31mInvalid task number.\u001b[0m Use /queue list to see numbered tasks.`);
        return;
      }
      const removed = messageQueue.removeAt(idxNum - 1);
      ctx.setStatusMsg(`Removed task #${idxNum}`);
      ctx.addMessage(
        "assistant",
        `\u001b[32m✓\u001b[0m Removed task #${idxNum}: "\u001b[1m${removed?.text}\u001b[0m"`
      );
      return;
    }

    if (sub === "add") {
      const taskText = args.slice(1).join(" ").trim();
      if (!taskText) {
        ctx.addMessage("assistant", "Usage: /queue add <task text>");
        return;
      }
      const queued = messageQueue.enqueue(taskText);
      if (queued) {
        ctx.setStatusMsg(`Enqueued task #${messageQueue.size()}`);
        ctx.addMessage(
          "assistant",
          `\u001b[32m✓\u001b[0m Enqueued as task #${messageQueue.size()}: "\u001b[1m${taskText}\u001b[0m"`
        );
      }
      return;
    }

    // Interactive TUI mode popup
    if (typeof ctx.openQueueManager === "function" && args.length === 0) {
      await ctx.openQueueManager();
      return;
    }

    // CLI / headless list mode
    const items = messageQueue.getAll();
    if (items.length === 0) {
      ctx.addMessage("assistant", "Queue is currently empty.\nMessages entered while agent is working are queued automatically.");
      return;
    }

    const lines: string[] = [];
    lines.push(`Message Queue (${items.length} tasks) — FIFO order:`);
    lines.push("───".repeat(12));
    items.forEach((item, idx) => {
      lines.push(`  \u001b[36m${idx + 1}.\u001b[0m ${item.text}`);
    });
    lines.push("");
    lines.push("Commands: /queue remove <n> │ /queue clear │ /queue add <text>");
    ctx.addMessage("assistant", lines.join("\n"));
  },
};
