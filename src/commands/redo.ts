import type { Command, CommandContext } from "./index";
import { redo, getRedoDescription } from "../lib/history";

export const redoCommand: Command = {
  name: "redo",
  aliases: ["rdo"],
  description: "Redo a previously undone file change",
  usage: "/redo",
  async handler(_args: string[], ctx: CommandContext) {
    const desc = getRedoDescription();
    const result = redo();
    if (!result.success) {
      ctx.addMessage("assistant", `\u001b[33m${result.error}\u001b[0m`);
      return;
    }
    ctx.addMessage("assistant", `\u001b[32m\u2713\u001b[0m Redone: ${result.entry?.description || desc || "(change)"}`);
  },
};
