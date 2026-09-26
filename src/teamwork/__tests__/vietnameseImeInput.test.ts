/**
 * Vietnamese / mobile-IME input regression suite.
 *
 * Reported bug (iPhone + Termius, Vietnamese keyboard): typed "bạn ơi" could
 * arrive on screen corrupted — first character missing, diacritics detached,
 * characters reordered. Two independent defects caused this:
 *
 *   1. A stray ESC in front of text was decoded as an "Alt-key": the following
 *      byte was swallowed as latin1 mojibake (or the ESC deadline flushed a
 *      standalone Esc that cancelled the stream). The first character vanished.
 *   2. Composer Backspace/Delete/cursor moved by UTF-16 code unit, so a base
 *      character and its combining mark (NFD "a" + U+0323) were split apart.
 *
 * These tests drive the REAL pipeline (TerminalKeyDecoder → handleKey → composer
 * document), never a re-implementation, so a regression in any layer fails here.
 */
import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { TerminalKeyDecoder, decodedKeyBytes, type DecodedKey } from "../../tui/input/keyDecoder";
import { handleKey, getInputState, resetInputState } from "../../tui/input/inputHandler";
import { MultilineInputBuffer } from "../../tui/input/multilineInput";
import {
  previousGraphemeStart,
  nextGraphemeEnd,
} from "../../lib/text";
import { computeLayoutGeometry } from "../../tui/layout";
import { tuiState } from "../../tui/state";

const VIETNAMESE_WORDS = [
  "bạn ơi",
  "tiếng Việt",
  "Tấn",
  "đường",
  "người dùng",
  "kiểm tra",
  "chỉnh sửa",
  "tôi đang làm việc",
];

/** Drive a UTF-8 string through the decoder in `chunkSize`-byte stdin chunks. */
function typeThroughPipeline(str: string, chunkSize: number, gapMs = 5): { buffer: string; keys: DecodedKey[] } {
  const decoder = new TerminalKeyDecoder();
  const bytes = Buffer.from(str, "utf8");
  const keys: DecodedKey[] = [];
  let now = 0;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    now += gapMs;
    keys.push(...decoder.feed(bytes.subarray(i, i + chunkSize), now));
  }
  keys.push(...decoder.flush());
  for (const key of keys) {
    handleKey(decodedKeyBytes(key), { renderAll: () => {} });
  }
  return { buffer: getInputState().buffer, keys };
}

describe("Vietnamese IME input", () => {
  let stdoutSpy: any;

  beforeEach(() => {
    resetInputState();
    tuiState.appState = "ready";
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  describe("decoder → composer round-trip", () => {
    for (const chunkSize of [1, 2, 3, 5, 8, 64]) {
      test(`preserves Vietnamese text across ${chunkSize}-byte stdin chunks`, () => {
        for (const word of VIETNAMESE_WORDS) {
          resetInputState();
          const { buffer } = typeThroughPipeline(word, chunkSize);
          expect(buffer).toBe(word);
        }
      });
    }

    test("preserves precomposed (NFC) Vietnamese", () => {
      const nfc = "bạn ơi".normalize("NFC");
      resetInputState();
      expect(typeThroughPipeline(nfc, 1).buffer).toBe(nfc);
    });

    test("preserves decomposed (NFD) Vietnamese without dropping marks", () => {
      // "bạn" built from base + combining dot below, "ơi" precomposed.
      const nfd = "ba\u0323n \u01a1i".normalize("NFD");
      resetInputState();
      expect(typeThroughPipeline(nfd, 1).buffer).toBe(nfd);
      resetInputState();
      expect(typeThroughPipeline(nfd, 2).buffer).toBe(nfd);
    });

    test("fast burst (whole word in one chunk) matches char-by-char", () => {
      resetInputState();
      const burst = typeThroughPipeline("bạn ơi", 4096).buffer;
      resetInputState();
      const slow = typeThroughPipeline("bạn ơi", 1).buffer;
      expect(burst).toBe("bạn ơi");
      expect(burst).toBe(slow);
    });
  });

  describe("stray ESC before text (mobile IME prefix)", () => {
    test("does not swallow the byte after ESC and does not emit a standalone Esc", () => {
      const decoder = new TerminalKeyDecoder();
      const keys = decoder.feed(
        Buffer.concat([Buffer.from([0x1b]), Buffer.from("bạn ơi", "utf8")]),
      );
      const standalone = keys.filter((k) => k.kind === "key" && k.s === "\u001b");
      expect(standalone).toHaveLength(0);
      const text = keys.filter((k) => k.kind === "text").map((k) => k.s).join("");
      expect(text).toBe("bạn ơi");
    });

    test("ESC in its own chunk (fragmented SSH) preserves the next char", () => {
      resetInputState();
      const decoder = new TerminalKeyDecoder();
      const bytes = Buffer.from("bạn ơi", "utf8");
      let now = 0;
      const keys: DecodedKey[] = [];
      // ESC arrives alone and its disambiguation window expires before text.
      now += 200;
      keys.push(...decoder.feed(Buffer.from([0x1b]), now));
      now += 1;
      keys.push(...decoder.feed(bytes, now));
      keys.push(...decoder.flush());
      expect(keys.some((k) => k.kind === "key" && k.s === "\u001b")).toBe(false);
      for (const key of keys) handleKey(decodedKeyBytes(key), { renderAll: () => {} });
      expect(getInputState().buffer).toBe("bạn ơi");
    });
  });

  describe("grapheme-cluster editing", () => {
    test("grapheme helpers span base + combining mark", () => {
      const s = "ba\u0323n"; // b, a+dot-below, n
      expect(previousGraphemeStart(s, 3)).toBe(1); // before the a+mark cluster
      expect(nextGraphemeEnd(s, 1)).toBe(3); // past the a+mark cluster
      const emoji = "x😀y";
      expect(nextGraphemeEnd(emoji, 1)).toBe(3); // past the surrogate pair
      expect(previousGraphemeStart(emoji, 3)).toBe(1);
    });

    test("Backspace removes a whole NFD cluster, never a lone combining mark", () => {
      const buf = new MultilineInputBuffer("ba\u0323");
      buf.deleteBackward();
      expect(buf.getText()).toBe("b");
      buf.deleteBackward();
      expect(buf.getText()).toBe("");
    });

    test("Backspace removes an astral emoji whole", () => {
      const buf = new MultilineInputBuffer("hi 😀");
      buf.deleteBackward();
      expect(buf.getText()).toBe("hi ");
    });

    test("Delete removes the whole cluster at the caret", () => {
      const buf = new MultilineInputBuffer("ba\u0323n");
      buf.setText("ba\u0323n", 1);
      buf.deleteForward();
      expect(buf.getText()).toBe("bn");
    });

    test("Left/Right move cluster-by-cluster", () => {
      const buf = new MultilineInputBuffer("ba\u0323n");
      expect(buf.getCursor()).toBe(4);
      buf.moveLeft(); // over "n"
      expect(buf.getCursor()).toBe(3);
      buf.moveLeft(); // over the "a"+mark cluster as one unit
      expect(buf.getCursor()).toBe(1);
      buf.moveRight();
      expect(buf.getCursor()).toBe(3);
    });

    test("insert in the middle keeps Vietnamese intact", () => {
      // Caret just after "bạn " (index 4), then type the word "rất".
      const buf = new MultilineInputBuffer("bạn ơi", 4);
      buf.insertText("rất ");
      expect(buf.getText()).toBe("bạn rất ơi");
      expect(buf.getCursor()).toBe(8);
    });
  });

  describe("paste vs IME burst classification", () => {
    test("a short Vietnamese word is inserted inline, never collapsed", () => {
      const buf = new MultilineInputBuffer();
      const result = buf.insertPaste("bạn ơi");
      expect(result.collapsed).toBe(false);
      expect(buf.getText()).toBe("bạn ơi");
      expect(buf.hasCollapsedPaste()).toBe(false);
    });

    test("a real multi-line paste collapses but keeps its exact content", () => {
      const buf = new MultilineInputBuffer();
      const content = Array.from({ length: 12 }, (_, i) => `dòng ${i}`).join("\n");
      const result = buf.insertPaste(content);
      expect(result.collapsed).toBe(true);
      expect(buf.getText()).toContain("lines pasted");
      expect(buf.getContent()).toBe(content);
    });
  });

  describe("52x20 mobile layout", () => {
    test("caret stays inside the viewport for Vietnamese text", () => {
      const layout = computeLayoutGeometry(52, 20, 0, 2, "bạn ơi".length, false, 1, "bạn ơi");
      expect(layout.cursorCol).toBeGreaterThanOrEqual(0);
      expect(layout.cursorCol).toBeLessThanOrEqual(layout.cols - 1);
      expect(layout.cursorRow).toBeGreaterThanOrEqual(0);
      expect(layout.cursorRow).toBeLessThan(layout.rows);
    });

    test("a very long Vietnamese line clamps the caret column", () => {
      const long = "đường ".repeat(40);
      const layout = computeLayoutGeometry(52, 20, 0, 2, long.length, false, 1, long);
      expect(layout.cursorCol).toBeLessThanOrEqual(layout.cols - 1);
      expect(layout.cursorCol).toBeGreaterThanOrEqual(0);
    });
  });

  describe("submit", () => {
    test("Enter sends the exact typed Vietnamese text", () => {
      resetInputState();
      typeThroughPipeline("bạn ơi", 1);
      let sent = "";
      handleKey(Buffer.from([0x0d]), {
        renderAll: () => {},
        sendMessage: (text: string) => {
          sent = text;
        },
      });
      expect(sent).toBe("bạn ơi");
      expect(getInputState().buffer).toBe("");
    });
  });
});
