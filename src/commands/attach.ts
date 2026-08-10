import type { Command, CommandContext } from "./index";
import { processAttachmentPath, isImageFile } from "../lib/attachments";
import { getCwdInfo } from "../lib/codingAgent";

export const attachCommand: Command = {
  name: "attach",
  aliases: ["file", "image"],
  description: "Attach a text file or screenshot/image to the conversation",
  usage: "/attach <path/to/file>",
  async handler(args: string[], ctx: CommandContext): Promise<void> {
    if (args.length === 0) {
      ctx.addMessage("system", "Usage: /attach <path/to/file> (e.g. /attach screenshot.png or /attach src/index.ts)");
      return;
    }

    const filePath = args.join(" ").trim();
    const cwd = getCwdInfo().currentCwd;
    const res = processAttachmentPath(filePath, cwd);

    if ("error" in res) {
      ctx.addMessage("system", `✖ Attachment Error: ${res.error}`);
      return;
    }

    if (res.type === "image") {
      ctx.addMessage("user", `@${filePath}`);
      ctx.addMessage("system", `✔ Attached image: ${filePath} (${res.mimeType}, ~${Math.round(res.base64Data.length * 0.75 / 1024)}KB base64). Ready for Vision model.`);
    } else {
      ctx.addMessage("user", `@${filePath}`);
      ctx.addMessage("system", `✔ Attached text file: ${filePath} (${res.content.length} characters).`);
    }
  },
};
