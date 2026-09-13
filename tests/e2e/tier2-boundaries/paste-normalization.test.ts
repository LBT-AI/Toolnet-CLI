import { describe, it, expect } from "bun:test";

export function normalizePastedLinebreaks(text: string): string {
  // Replaces CRLF (\r\n) and bare CR (\r) with \n
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export interface PasteTokenInfo {
  token: string;
  isPlaceholder: boolean;
  originalText: string;
  lineCount: number;
}

export function processPastedContent(rawText: string, threshold = 5): PasteTokenInfo {
  const normalized = normalizePastedLinebreaks(rawText);
  const lines = normalized.split("\n");
  const lineCount = lines.length;

  if (lineCount > threshold) {
    return {
      token: `[Pasted text: ${lineCount} lines]`,
      isPlaceholder: true,
      originalText: normalized,
      lineCount,
    };
  }

  return {
    token: normalized,
    isPlaceholder: false,
    originalText: normalized,
    lineCount,
  };
}

describe("Tier 2 Boundary & Corner Cases: Paste Normalization & Large Pastes", () => {
  it("B2.1: CRLF line endings (\\r\\n) are strictly normalized to \\n", () => {
    const windowsText = "Line 1\r\nLine 2\r\nLine 3\r\n";
    const normalized = normalizePastedLinebreaks(windowsText);

    expect(normalized).toBe("Line 1\nLine 2\nLine 3\n");
    expect(normalized.includes("\r")).toBe(false);
  });

  it("B2.2: Bare carriage returns (\\r) are normalized to \\n", () => {
    const classicMacText = "Heading\rParagraph 1\rParagraph 2";
    const normalized = normalizePastedLinebreaks(classicMacText);

    expect(normalized).toBe("Heading\nParagraph 1\nParagraph 2");
    expect(normalized.includes("\r")).toBe(false);
  });

  it("B2.3: Mixed line endings (\\r\\n, \\r, \\n) within single payload normalize consistently", () => {
    const mixed = "Unix\nWindows\r\nClassicMac\rEnd";
    const normalized = normalizePastedLinebreaks(mixed);

    expect(normalized).toBe("Unix\nWindows\nClassicMac\nEnd");
  });

  it("B2.4: Massive paste (1,000 lines) produces clean placeholder and preserves verbatim text for submit", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `function testCase${i}() { return ${i}; }`);
    const giantPayload = lines.join("\r\n"); // Windows CRLF

    const info = processPastedContent(giantPayload);
    expect(info.isPlaceholder).toBe(true);
    expect(info.token).toBe("[Pasted text: 1000 lines]");
    expect(info.lineCount).toBe(1000);
    // Verbatim text is normalized and fully retained
    expect(info.originalText.includes("\r")).toBe(false);
    expect(info.originalText.startsWith("function testCase0()")).toBe(true);
    expect(info.originalText.endsWith("return 999; }")).toBe(true);
  });

  it("B2.5: Small paste (<= threshold) is preserved inline without placeholder token", () => {
    const shortText = "export const PI = 3.14159;\nexport const E = 2.71828;";
    const info = processPastedContent(shortText, 5);

    expect(info.isPlaceholder).toBe(false);
    expect(info.token).toBe(shortText);
    expect(info.lineCount).toBe(2);
  });

  it("B2.6: Empty or whitespace-only paste does not corrupt line count or token", () => {
    const emptyInfo = processPastedContent("");
    expect(emptyInfo.token).toBe("");
    expect(emptyInfo.lineCount).toBe(1);

    const whitespaceInfo = processPastedContent("   \n   \n   ");
    expect(whitespaceInfo.lineCount).toBe(3);
    expect(whitespaceInfo.isPlaceholder).toBe(false);
  });
});
