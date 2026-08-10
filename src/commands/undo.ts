import type { Command, CommandContext } from "./index";
import { undo, getUndoDescription } from "../lib/history";

export const undoCommand: Command = {
  name: "undo",
  aliases: ["u"],
  description: "Undo the last file change",
  usage: "/undo",
  async handler(_args: string[], ctx: CommandContext) {
    const desc = getUndoDescription();
    const result = undo();
    if (!result.success) {
      ctx.addMessage("assistant", `\u001b[33m${result.error}\u001b[0m`);
      return;
    }
    ctx.addMessage("assistant", `\u001b[32m\u2713\u001b[0m Undone: ${result.entry?.description || desc || "(change)"}`);
  },
};
