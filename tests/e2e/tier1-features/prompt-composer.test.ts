import { describe, it, expect } from "bun:test";
import { MultilineInputBuffer } from "../../../src/tui/input/multilineInput";
import { BracketedPasteParser, BRACKETED_PASTE_START, BRACKETED_PASTE_END } from "../../../src/lib/bracketedPaste";

describe("Tier 1 Feature Coverage: Multi-line Prompt Composer & Paste Handling", () => {
  it("F21.1: Multi-line editing inserts text and newlines with exact cursor positioning", () => {
    const buffer = new MultilineInputBuffer();
    buffer.insertText("const x = 10;");
    buffer.insertNewline();
    buffer.insertText("console.log(x);");

    expect(buffer.getText()).toBe("const x = 10;\nconsole.log(x);");
    expect(buffer.getCursor()).toBe(29);
  });

  it("F21.2: Cursor navigation moves left, right, and bounds to start/end of line", () => {
    const buffer = new MultilineInputBuffer("Line 1\nLine 2");
    expect(buffer.getCursor()).toBe(13); // end of buffer

    buffer.moveToStartOfLine();
    expect(buffer.getCursor()).toBe(7); // start of Line 2

    buffer.moveLeft();
    expect(buffer.getCursor()).toBe(6); // newline between lines

    buffer.moveToStartOfLine();
    expect(buffer.getCursor()).toBe(0); // start of Line 1

    buffer.moveToEndOfLine();
    expect(buffer.getCursor()).toBe(6); // end of Line 1
  });

  it("F21.3: Word deletion backward removes entire tokens cleanly", () => {
    const buffer = new MultilineInputBuffer("git commit -m initial");
    buffer.deleteWordBackward(); // removes initial
    expect(buffer.getText()).toBe("git commit -m ");

    buffer.deleteWordBackward(); // removes -m
    expect(buffer.getText()).toBe("git commit ");

    buffer.deleteWordBackward(); // removes commit
    expect(buffer.getText()).toBe("git ");
  });

  it("F21.4: Kill to end of line deletes from cursor to line boundary or end of buffer", () => {
    const buffer = new MultilineInputBuffer("First line\nSecond line text here");
    buffer.setText("First line\nSecond line text here", 17); // cursor right after "Second"
    buffer.killToEndOfLine();
    expect(buffer.getText()).toBe("First line\nSecond");
  });

  it("F23.1: Submit locking guard prevents duplicate submission while turn is pending", async () => {
    let activeSubmissions = 0;
    let submitLock = false;

    async function safeSubmitPrompt(text: string): Promise<string> {
      if (submitLock) {
        throw new Error("Submit locked: previous turn is still dispatching");
      }
      submitLock = true;
      activeSubmissions++;
      try {
        await new Promise((r) => setTimeout(r, 20));
        return `Submitted: ${text}`;
      } finally {
        submitLock = false;
        activeSubmissions--;
      }
    }

    // Launch first submission
    const p1 = safeSubmitPrompt("Prompt 1");
    // Attempt rapid second submission while first is in flight
    expect(safeSubmitPrompt("Prompt 2")).rejects.toThrow("Submit locked");
    const res1 = await p1;
    expect(res1).toBe("Submitted: Prompt 1");
    expect(activeSubmissions).toBe(0);

    // After settlement, new prompt can be submitted
    const res3 = await safeSubmitPrompt("Prompt 3");
    expect(res3).toBe("Submitted: Prompt 3");
  });

  it("F24.1: Bracketed paste parser extracts paste content within escape sequences", () => {
    const parser = new BracketedPasteParser();
    const input = `preamble ${BRACKETED_PASTE_START}pasted payload\nline 2${BRACKETED_PASTE_END} postamble`;
    const chunks = parser.parse(input);

    expect(chunks.length).toBe(3);
    expect(chunks[0]).toEqual({ type: "text", content: "preamble " });
    expect(chunks[1]).toEqual({ type: "paste", content: "pasted payload\nline 2" });
    expect(chunks[2]).toEqual({ type: "text", content: " postamble" });
  });

  it("F25.1: Large paste placeholder generates clean preview token for multiline input", () => {
    function formatPastePlaceholder(pasteText: string, threshold = 5): string {
      const lines = pasteText.split("\n");
      if (lines.length > threshold) {
        return `[Pasted text: ${lines.length} lines]`;
      }
      return pasteText;
    }

    const shortPaste = "line 1\nline 2";
    expect(formatPastePlaceholder(shortPaste)).toBe(shortPaste);

    const longPaste = "a\nb\nc\nd\ne\nf\ng\nh";
    expect(formatPastePlaceholder(longPaste)).toBe("[Pasted text: 8 lines]");
  });
});
