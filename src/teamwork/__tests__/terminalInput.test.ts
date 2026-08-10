import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
  BracketedPasteParser,
  parseBracketedPaste,
  stripBracketedPaste,
} from "../../lib/bracketedPaste";
import { restoreTerminal, resetTerminalState } from "../../lib/terminalLifecycle";
import {
  handleKey,
  getInputState,
  setInputState,
  resetInputState,
} from "../../tui";

describe("Terminal Input & Bracketed Paste Tests", () => {
  let stdoutSpy: any;

  beforeEach(() => {
    resetInputState();
    resetTerminalState();
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  describe("Bracketed Paste Sequence Parsing", () => {
    test("defines correct ANSI escape sequence constants", () => {
      expect(BRACKETED_PASTE_START).toBe("\x1b[200~");
      expect(BRACKETED_PASTE_END).toBe("\x1b[201~");
      expect(ENABLE_BRACKETED_PASTE).toBe("\x1b[?2004h");
      expect(DISABLE_BRACKETED_PASTE).toBe("\x1b[?2004l");
    });

    test("parseBracketedPaste handles a standalone paste sequence", () => {
      const input = "\x1b[200~pasted buffer data\x1b[201~";
      const chunks = parseBracketedPaste(input);

      expect(chunks).toEqual([
        { type: "paste", content: "pasted buffer data" },
      ]);
    });

    test("parseBracketedPaste parses mixed text and paste sequences", () => {
      const input = "prefix \x1b[200~pasted content\x1b[201~ suffix";
      const chunks = parseBracketedPaste(input);

      expect(chunks).toEqual([
        { type: "text", content: "prefix " },
        { type: "paste", content: "pasted content" },
        { type: "text", content: " suffix" },
      ]);
    });

    test("BracketedPasteParser handles paste sequences split across multiple chunks", () => {
      const parser = new BracketedPasteParser();

      const chunk1 = parser.parse("start \x1b[200~first part ");
      expect(chunk1).toEqual([
        { type: "text", content: "start " },
        { type: "paste", content: "first part " },
      ]);
      expect(parser.isPasting()).toBe(true);

      const chunk2 = parser.parse("second part\x1b[201~ end");
      expect(chunk2).toEqual([
        { type: "paste", content: "second part" },
        { type: "text", content: " end" },
      ]);
      expect(parser.isPasting()).toBe(false);
    });

    test("BracketedPasteParser handles escape sequence split across chunk boundaries", () => {
      const parser = new BracketedPasteParser();

      // Split \x1b[200~ across two chunks: "\x1b[20" and "0~data\x1b[201~"
      const chunk1 = parser.parse("hello \x1b[20");
      expect(chunk1).toEqual([{ type: "text", content: "hello " }]);

      const chunk2 = parser.parse("0~pasted data\x1b[201~");
      expect(chunk2).toEqual([{ type: "paste", content: "pasted data" }]);
    });

    test("stripBracketedPaste removes paste markers from strings", () => {
      const raw = "\x1b[200~pasted text\x1b[201~";
      expect(stripBracketedPaste(raw)).toBe("pasted text");
    });
  });

  describe("Readline Navigation Shortcuts", () => {
    test("Ctrl+A (\\x01) moves cursor to the beginning of the input line", () => {
      setInputState("hello world", 11);
      expect(getInputState()).toEqual({ buffer: "hello world", cursor: 11 });

      handleKey(Buffer.from("\x01"));
      expect(getInputState()).toEqual({ buffer: "hello world", cursor: 0 });
    });

    test("Ctrl+E (\\x05) moves cursor to the end of the input line", () => {
      setInputState("hello world", 0);
      expect(getInputState()).toEqual({ buffer: "hello world", cursor: 0 });

      handleKey(Buffer.from("\x05"));
      expect(getInputState()).toEqual({ buffer: "hello world", cursor: 11 });
    });

    test("Ctrl+K (\\x0b) kills text from cursor to the end of the line", () => {
      setInputState("hello world", 5);
      expect(getInputState()).toEqual({ buffer: "hello world", cursor: 5 });

      handleKey(Buffer.from("\x0b"));
      expect(getInputState()).toEqual({ buffer: "hello", cursor: 5 });
    });

    test("Ctrl+U (\\x15) clears the entire input line", () => {
      setInputState("hello world", 5);
      expect(getInputState()).toEqual({ buffer: "hello world", cursor: 5 });

      handleKey(Buffer.from("\x15"));
      expect(getInputState()).toEqual({ buffer: "", cursor: 0 });
    });
  });

  describe("Terminal Lifecycle Integration", () => {
    test("restoreTerminal() disables bracketed paste mode with \\x1b[?2004l", () => {
      restoreTerminal();
      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining(DISABLE_BRACKETED_PASTE)
      );
    });
  });
});
