import { describe, test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isImageFile,
  getImageMimeType,
  processAttachmentPath,
  parseAndProcessInput,
  autocompletePath,
} from "../../lib/attachments";

describe("File & Image Attachments (Vision Support & @file Parsing)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-attach-test-"));
  });

  test("isImageFile correctly identifies image extensions", () => {
    expect(isImageFile("screenshot.png")).toBe(true);
    expect(isImageFile("photo.JPEG")).toBe(true);
    expect(isImageFile("ui.webp")).toBe(true);
    expect(isImageFile("script.ts")).toBe(false);
  });

  test("getImageMimeType returns correct MIME type", () => {
    expect(getImageMimeType("img.png")).toBe("image/png");
    expect(getImageMimeType("img.jpg")).toBe("image/jpeg");
    expect(getImageMimeType("img.webp")).toBe("image/webp");
  });

  test("processAttachmentPath processes text file into TextAttachment", () => {
    const textFile = path.join(tmpDir, "code.ts");
    fs.writeFileSync(textFile, "console.log('hello world');");

    const res = processAttachmentPath(textFile, tmpDir);
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.type).toBe("text");
      expect((res as any).content).toBe("console.log('hello world');");
    }
  });

  test("parseAndProcessInput extracts @file reference and formats Vision payload for images", () => {
    // Create dummy 1x1 PNG image
    const dummyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const imgFile = path.join(tmpDir, "mock_ui.png");
    fs.writeFileSync(imgFile, Buffer.from(dummyPngBase64, "base64"));

    const input = `Please inspect this frontend bug @${imgFile}`;
    const result = parseAndProcessInput(input, tmpDir);

    expect(result.hasImages).toBe(true);
    expect(result.attachments.length).toBe(1);
    expect(Array.isArray(result.formattedContent)).toBe(true);

    if (Array.isArray(result.formattedContent)) {
      expect(result.formattedContent.length).toBe(2);
      expect(result.formattedContent[0].type).toBe("text");
      expect(result.formattedContent[1].type).toBe("image_url");
      expect(result.formattedContent[1].image_url?.url).toContain("data:image/png;base64,");
    }

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("autocompletePath provides path suggestions for @ inputs", () => {
    const file1 = path.join(tmpDir, "app.ts");
    const file2 = path.join(tmpDir, "api.ts");
    fs.writeFileSync(file1, "export const app = 1;");
    fs.writeFileSync(file2, "export const api = 2;");

    const suggestions = autocompletePath("@ap", tmpDir);
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    expect(suggestions.some(s => s.includes("app.ts"))).toBe(true);
    expect(suggestions.some(s => s.includes("api.ts"))).toBe(true);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});
