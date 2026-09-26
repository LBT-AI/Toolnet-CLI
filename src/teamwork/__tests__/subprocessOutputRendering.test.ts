/**
 * Subprocess output rendering regression suite.
 *
 * Reported bug: a CLI with progress/interactive output (`vpsoci`) rendered its
 * stdout into the transcript as garbage (`] à ê 1 à ụ ạ ừ: 41, 277`). Two
 * independent defects caused it:
 *
 *   1. `toolBash` decoded each raw stdin chunk with `Buffer.toString("utf8")`,
 *      so a multi-byte Vietnamese character split across chunks decoded to
 *      replacement characters.
 *   2. Committed stdout kept ANSI escapes and carriage-return progress frames
 *      verbatim, so every spinner/progress frame and every escape byte leaked
 *      into the transcript.
 *
 * These tests drive the canonical normalizer (`TerminalOutputBuffer`) and the
 * pure helpers directly, so a regression in the byte-level behavior fails here.
 */
import { test, expect, describe } from "bun:test";
import {
  TerminalOutputBuffer,
  sanitizeTerminalText,
  interpretCsi,
  hasControlSequences,
} from "../../lib/terminalOutput";

/** UTF-8 bytes of a string, so tests never rely on JS string decoding. */
const bytes = (s: string) => Buffer.from(s, "utf8");

describe("subprocess output — UTF-8 decoding", () => {
  test("A. plain output keeps its real newlines", () => {
    const b = new TerminalOutputBuffer();
    b.write(bytes("hello\nworld\n"));
    expect(b.flush()).toBe("hello\nworld");
  });

  test("B. a multi-byte character split across chunks decodes once", () => {
    const b = new TerminalOutputBuffer();
    const full = bytes("bạn"); // 62 E1 BA A1 6E
    b.write(full.subarray(0, 3)); // splits the 'ạ' sequence
    b.write(full.subarray(3));
    b.write(bytes("\n"));
    expect(b.flush()).toBe("bạn");
    expect(b.flush()).not.toContain("\uFFFD");
  });

  test("B2. Vietnamese survives a pathological 1-byte-per-chunk stream", () => {
    const b = new TerminalOutputBuffer();
    const full = bytes("người dùng\n");
    for (let i = 0; i < full.length; i++) b.write(full.subarray(i, i + 1));
    expect(b.flush()).toBe("người dùng");
  });

  test("H. flush drains a character whose last byte arrives at exit", () => {
    const b = new TerminalOutputBuffer();
    const full = bytes("đường"); // 'đ' + 'ư' etc.
    b.write(full.subarray(0, full.length - 1)); // hold back the final byte
    const out = b.flush();
    expect(out.startsWith("đườ")).toBe(true);
  });
});

describe("subprocess output — ANSI control", () => {
  test("C. SGR color is stripped, text stays readable", () => {
    const b = new TerminalOutputBuffer();
    b.write("\u001b[31mError\u001b[0m\n");
    expect(b.flush()).toBe("Error");
  });

  test("C2. OSC title sequences never reach the transcript", () => {
    const b = new TerminalOutputBuffer();
    b.write("\u001b]0;my window title\u0007visible\n");
    expect(b.flush()).toBe("visible");
  });

  test("C3. OSC terminated by ST (ESC \\) is also removed", () => {
    const b = new TerminalOutputBuffer();
    b.write("\u001b]2;name\u001b\\after\n");
    expect(b.flush()).toBe("after");
  });

  test("C4. escape split across chunks is still consumed", () => {
    const b = new TerminalOutputBuffer();
    b.write("\u001b[3");
    b.write("6mINFO\u001b[0m\n");
    expect(b.flush()).toBe("INFO");
  });

  test("interpretCsi maps line operations only", () => {
    expect(interpretCsi("2K").kind).toBe("erase-all");
    expect(interpretCsi("K").kind).toBe("erase-to-end");
    expect(interpretCsi("1K").kind).toBe("erase-to-start");
    expect(interpretCsi("12G")).toEqual({ kind: "column", column: 11 });
    expect(interpretCsi("3D")).toEqual({ kind: "cursor-back", count: 3 });
    expect(interpretCsi("?25l").kind).toBe("none"); // private mode set
    expect(interpretCsi("32m").kind).toBe("none"); // SGR
  });
});

describe("subprocess output — carriage return and live line", () => {
  test("D. \\r progress updates ONE line; committed keeps only the final", () => {
    const b = new TerminalOutputBuffer();
    b.write("Creating VPS... 10%\r");
    expect(b.getLiveLine()).toBe("Creating VPS... 10%");
    b.write("Creating VPS... 34%\r");
    b.write("Creating VPS... 68%\r");
    b.write("Creating VPS... 100%\n");
    expect(b.flush()).toBe("Creating VPS... 100%");
    expect(b.getCommittedLineCount()).toBe(1);
  });

  test("E. spinner frames never become transcript lines", () => {
    const b = new TerminalOutputBuffer();
    b.write("|\r/\r-\r\\\rDone\n");
    expect(b.flush()).toBe("Done");
  });

  test("E2. progress frames before real lines keep the real lines", () => {
    const b = new TerminalOutputBuffer();
    b.write("10%\r20%\r\nActual result\n");
    expect(b.flush()).toBe("20%\nActual result");
  });

  test("F. backspace rewrites the live line", () => {
    const b = new TerminalOutputBuffer();
    b.write("abc\b\bXY\n");
    expect(b.flush()).toBe("aXY");
  });

  test("F2. erase-line control clears the live line", () => {
    const b = new TerminalOutputBuffer();
    b.write("partial junk\u001b[2Kdone\n");
    expect(b.flush()).toBe("done");
  });

  test("F3. cursor-to-column rewrites in place", () => {
    const b = new TerminalOutputBuffer();
    b.write("12345\u001b[3GXY\n"); // column 3 → overwrite from '3'
    expect(b.flush()).toBe("12XY5");
  });

  test("live vs committed: the live line is mutable, committed is stable", () => {
    const b = new TerminalOutputBuffer();
    b.write("line one\nDownloading 5%\r");
    expect(b.getCommittedText()).toBe("line one");
    expect(b.getLiveLine()).toBe("Downloading 5%");
    expect(b.getText()).toBe("line one\nDownloading 5%");
  });

  test("getTailLines returns a bounded non-empty preview", () => {
    const b = new TerminalOutputBuffer();
    b.write("a\nb\n\nc\nDownloading 9%\r");
    const tail = b.getTailLines(3);
    expect(tail).toEqual(["b", "c", "Downloading 9%"]);
  });
});

describe("subprocess output — stream isolation", () => {
  test("G. a partial char on stderr never corrupts stdout", () => {
    const out = new TerminalOutputBuffer();
    const err = new TerminalOutputBuffer();
    const vn = bytes("lỗi");
    out.write(bytes("ok\n"));
    // stderr holds half a character while stdout keeps flowing.
    err.write(vn.subarray(0, 2));
    out.write(bytes("done\n"));
    err.write(vn.subarray(2));
    expect(out.flush()).toBe("ok\ndone");
    expect(err.flush()).toBe("lỗi");
  });
});

describe("sanitizeTerminalText helper", () => {
  test("strips escapes and collapses CR overlays for renderers", () => {
    expect(sanitizeTerminalText("\u001b[32m[OK]\u001b[0m Thành công\n")).toBe("[OK] Thành công");
    expect(sanitizeTerminalText("x\r\ry")).toBe("y");
  });

  test("hasControlSequences flags raw control bytes", () => {
    expect(hasControlSequences("plain")).toBe(false);
    expect(hasControlSequences("\u001b[2K")).toBe(true);
    expect(hasControlSequences("a\rb")).toBe(true);
  });
});
