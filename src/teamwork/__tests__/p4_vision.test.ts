import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateAndLoadImage,
  detectImageMime,
  isModelVisionSupported,
  MAX_IMAGE_SIZE_BYTES,
  formatMultimodalMessage,
} from "../../lib/vision";
import { setSandboxMode } from "../../lib/permissions";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-vision-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("P4.5 & P4.6 — Vision / Image Input & Security", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    setSandboxMode("ask");
  });

  afterEach(() => {
    cleanDir(dir);
  });

  it("7. image MIME validation detects valid formats and rejects unsupported files", () => {
    expect(detectImageMime("screenshot.png")).toBe("image/png");
    expect(detectImageMime("photo.jpg")).toBe("image/jpeg");
    expect(detectImageMime("photo.jpeg")).toBe("image/jpeg");
    expect(detectImageMime("graphic.webp")).toBe("image/webp");
    expect(detectImageMime("animation.gif")).toBe("image/gif");
    expect(detectImageMime("binary.exe")).toBeNull();
    expect(detectImageMime("document.pdf")).toBeNull();
  });

  it("8. oversized image is rejected with structured error", () => {
    const hugeImagePath = path.join(dir, "large.png");
    // Create dummy image file that exceeds max size
    const testLimit = 1024 * 100; // 100KB for test
    fs.writeFileSync(hugeImagePath, Buffer.alloc(testLimit + 10));

    const res = validateAndLoadImage(hugeImagePath, dir, testLimit);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("FILE_TOO_LARGE");
    expect(res.error).toContain("too large");
  });

  it("9. sandbox blocks image path escape in workspace mode", () => {
    setSandboxMode("workspace");
    const insideWorkspace = path.join(dir, "workspace_dir");
    const outsideWorkspace = path.join(dir, "outside_dir");
    fs.mkdirSync(insideWorkspace, { recursive: true });
    fs.mkdirSync(outsideWorkspace, { recursive: true });

    const outsideImage = path.join(outsideWorkspace, "secret.png");
    fs.writeFileSync(outsideImage, Buffer.from("fake-png-data"));

    // Attempt to validate image from outside workspace root
    const res = validateAndLoadImage(outsideImage, insideWorkspace);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("SANDBOX_ESCAPE");
  });

  it("10. unsupported vision model returns structured error", () => {
    const textOnlyModel = "deepseek/deepseek-chat";
    const check = isModelVisionSupported(textOnlyModel);
    expect(check.supported).toBe(false);
    expect(check.reason).toContain("does not support vision");

    const visionModel = "openai/gpt-4o";
    const checkVision = isModelVisionSupported(visionModel);
    expect(checkVision.supported).toBe(true);
  });

  it("formats multimodal messages with valid base64 data urls", () => {
    const validImage = path.join(dir, "test.png");
    fs.writeFileSync(validImage, Buffer.from("png-content"));

    const val = validateAndLoadImage(validImage, dir);
    expect(val.ok).toBe(true);
    expect(val.image).toBeDefined();

    const parts = formatMultimodalMessage("Review UI", [val.image!]);
    expect(parts.length).toBe(2);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url?.url).toContain("data:image/png;base64,");
  });
});
