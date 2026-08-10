import fs from "node:fs";
import path from "node:path";

export interface ImageAttachment {
  type: "image";
  filePath: string;
  mimeType: string;
  base64Data: string;
  dataUrl: string;
}

export interface TextAttachment {
  type: "text";
  filePath: string;
  content: string;
}

export type Attachment = ImageAttachment | TextAttachment;

export interface ProcessedInput {
  rawText: string;
  cleanText: string;
  attachments: Attachment[];
  hasImages: boolean;
  formattedContent: string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }>;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml"
};

export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return Boolean(IMAGE_EXTENSIONS[ext]);
}

export function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS[ext] || "application/octet-stream";
}

export function processAttachmentPath(filePath: string, cwd: string): Attachment | { error: string } {
  const absPath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
  
  if (!fs.existsSync(absPath)) {
    return { error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    return { error: `Path is a directory: ${filePath}` };
  }

  if (isImageFile(absPath)) {
    try {
      const buffer = fs.readFileSync(absPath);
      const mimeType = getImageMimeType(absPath);
      const base64Data = buffer.toString("base64");
      const dataUrl = `data:${mimeType};base64,${base64Data}`;

      return {
        type: "image",
        filePath: absPath,
        mimeType,
        base64Data,
        dataUrl
      };
    } catch (err: any) {
      return { error: `Failed reading image ${filePath}: ${err.message}` };
    }
  } else {
    try {
      const text = fs.readFileSync(absPath, "utf8");
      return {
        type: "text",
        filePath: absPath,
        content: text
      };
    } catch (err: any) {
      return { error: `Failed reading text file ${filePath}: ${err.message}` };
    }
  }
}

export function parseAndProcessInput(input: string, cwd: string): ProcessedInput {
  const attachments: Attachment[] = [];
  let cleanText = input;

  const atRegex = /@([^\s"']+)/g;
  let match;

  while ((match = atRegex.exec(input)) !== null) {
    const rawPath = match[1];
    const res = processAttachmentPath(rawPath, cwd);
    if (!("error" in res)) {
      attachments.push(res);
      cleanText = cleanText.replace(match[0], "").trim();
    }
  }

  const hasImages = attachments.some(a => a.type === "image");
  const textBlocks: string[] = [];

  if (cleanText) textBlocks.push(cleanText);

  for (const att of attachments) {
    if (att.type === "text") {
      const relPath = path.relative(cwd, att.filePath);
      textBlocks.push(`[Attached File: ${relPath}]\n\`\`\`\n${att.content.slice(0, 10000)}\n\`\`\``);
    }
  }

  const combinedText = textBlocks.join("\n\n");

  if (!hasImages) {
    return {
      rawText: input,
      cleanText,
      attachments,
      hasImages: false,
      formattedContent: combinedText
    };
  }

  const contentParts: Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }> = [];

  if (combinedText) {
    contentParts.push({ type: "text", text: combinedText });
  }

  for (const att of attachments) {
    if (att.type === "image") {
      contentParts.push({
        type: "image_url",
        image_url: { url: att.dataUrl }
      });
    }
  }

  return {
    rawText: input,
    cleanText,
    attachments,
    hasImages: true,
    formattedContent: contentParts
  };
}

export function autocompletePath(partial: string, cwd: string): string[] {
  try {
    const cleanPartial = partial.replace(/^@/, "").replace(/^\/attach\s+/, "");
    const isAbsolute = path.isAbsolute(cleanPartial);
    const targetDir = isAbsolute ? path.dirname(cleanPartial) : path.resolve(cwd, path.dirname(cleanPartial));
    const baseName = path.basename(cleanPartial).toLowerCase();

    if (!fs.existsSync(targetDir)) return [];

    const entries = fs.readdirSync(targetDir);
    const matches = entries.filter(e => e.toLowerCase().startsWith(baseName));

    return matches.map(m => {
      const full = path.join(targetDir, m);
      const rel = path.relative(cwd, full);
      const suffix = fs.existsSync(full) && fs.statSync(full).isDirectory() ? "/" : "";
      return `@${rel}${suffix}`;
    });
  } catch {
    return [];
  }
}
