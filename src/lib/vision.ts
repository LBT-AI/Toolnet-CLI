import fs from "node:fs";
import path from "node:path";
import { evaluatePermission, getSandboxMode } from "./permissions";

export interface ValidatedImage {
  filePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64Data: string;
  dataUrl: string;
}

export interface ImageValidationResult {
  ok: boolean;
  image?: ValidatedImage;
  error?: string;
  errorCode?: "FILE_NOT_FOUND" | "NOT_A_FILE" | "UNSUPPORTED_MIME" | "FILE_TOO_LARGE" | "SANDBOX_ESCAPE" | "READ_ERROR";
}

const SUPPORTED_IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// Models known to support multimodal / vision
const KNOWN_VISION_MODEL_PATTERNS = [
  /gpt-4o/i,
  /gpt-4-turbo/i,
  /gpt-4-vision/i,
  /claude-3/i,
  /claude-sonnet/i,
  /claude-opus/i,
  /gemini/i,
  /qwen.*vl/i,
  /vision/i,
  /llava/i,
];

// Models explicitly known NOT to support vision
const KNOWN_TEXT_ONLY_MODEL_PATTERNS = [
  /gpt-3\.5/i,
  /deepseek-chat/i,
  /deepseek-coder/i,
  /deepseek-r1/i,
  /llama-3-[0-9]+b-instruct/i,
  /mistral-7b/i,
  /text-embedding/i,
];

export function supportsVision(modelName: string): boolean {
  if (!modelName) return false;
  for (const pattern of KNOWN_TEXT_ONLY_MODEL_PATTERNS) {
    if (pattern.test(modelName)) return false;
  }
  for (const pattern of KNOWN_VISION_MODEL_PATTERNS) {
    if (pattern.test(modelName)) return true;
  }
  // Default to true for modern models unless matching text-only
  return true;
}

export function isModelVisionSupported(modelName: string): { supported: boolean; reason?: string } {
  for (const pattern of KNOWN_TEXT_ONLY_MODEL_PATTERNS) {
    if (pattern.test(modelName)) {
      return {
        supported: false,
        reason: `Model '${modelName}' does not support vision or image attachments. Use a vision-capable model (e.g. openai/gpt-4o, anthropic/claude-3-5-sonnet, google/gemini-2.0-flash).`,
      };
    }
  }
  return { supported: true };
}

export function detectImageMime(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_IMAGE_MIMES[ext] || null;
}

export function validateAndLoadImage(filePath: string, cwd = process.cwd(), maxSizeBytes = MAX_IMAGE_SIZE_BYTES): ImageValidationResult {
  const absPath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);

  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `Image file not found: ${filePath}`, errorCode: "FILE_NOT_FOUND" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err: any) {
    return { ok: false, error: `Cannot stat image file: ${err.message}`, errorCode: "READ_ERROR" };
  }

  if (!stat.isFile()) {
    return { ok: false, error: `Path is not a regular file: ${filePath}`, errorCode: "NOT_A_FILE" };
  }

  // Check MIME
  const mimeType = detectImageMime(absPath);
  if (!mimeType) {
    return {
      ok: false,
      error: `Unsupported image format for '${path.basename(filePath)}'. Supported: PNG, JPG/JPEG, WEBP, GIF`,
      errorCode: "UNSUPPORTED_MIME",
    };
  }

  // Check Sandbox escape
  const sandboxMode = getSandboxMode();
  const perm = evaluatePermission("read_file", { path: absPath }, sandboxMode, cwd, cwd);
  if (!perm.allowed && !perm.needsApproval) {
    return {
      ok: false,
      error: `Sandbox policy blocked access to image outside workspace: ${filePath}`,
      errorCode: "SANDBOX_ESCAPE",
    };
  }

  // Check File Size
  if (stat.size > maxSizeBytes) {
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      error: `Image file too large: ${sizeMb}MB (max allowed: ${maxMb}MB)`,
      errorCode: "FILE_TOO_LARGE",
    };
  }

  try {
    const buffer = fs.readFileSync(absPath);
    const base64Data = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    return {
      ok: true,
      image: {
        filePath: absPath,
        fileName: path.basename(absPath),
        mimeType,
        sizeBytes: stat.size,
        base64Data,
        dataUrl,
      },
    };
  } catch (err: any) {
    return { ok: false, error: `Failed to read image file: ${err.message}`, errorCode: "READ_ERROR" };
  }
}

export function formatMultimodalMessage(
  textPrompt: string,
  images: ValidatedImage[]
): Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }> {
  const parts: Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }> = [];

  if (textPrompt) {
    parts.push({ type: "text", text: textPrompt });
  }

  for (const img of images) {
    parts.push({
      type: "image_url",
      image_url: { url: img.dataUrl },
    });
  }

  return parts;
}

export function getImageMetadataSummary(images: ValidatedImage[]): Array<{ filename: string; mime: string; size: number }> {
  return images.map((img) => ({
    filename: img.fileName,
    mime: img.mimeType,
    size: img.sizeBytes,
  }));
}
