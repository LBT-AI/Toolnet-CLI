/**
 * Canonical VT decoder contract: a logical key must decode identically no
 * matter how the terminal fragments it across stdin chunks, a real standalone
 * Esc must still work (bounded timeout, no indefinite wait), and bracketed
 * paste blocks must survive fragmentation and control bytes untouched.
 */
import { describe, expect, it } from "bun:test";
import {
  TerminalKeyDecoder,
  ESC_FLUSH_TIMEOUT_MS,
} from "../../../src/tui/input/keyDecoder";

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const feedAll = (d: TerminalKeyDecoder, chunks: Buffer[], t0 = 1000) => {
  const out = [];
  chunks.forEach((c, i) => out.push(...d.feed(c, t0 + i * 5)));
  return out;
};

describe("TerminalKeyDecoder — complete sequences in one chunk", () => {
  it("decodes CSI arrows as single keys", () => {
    const d = new TerminalKeyDecoder();
    const keys = d.feed(Buffer.from("\u001b[A\u001b[B\u001b[C\u001b[D", "latin1"), 1000);
    expect(keys.map((k) => k.s)).toEqual([UP, DOWN, "\u001b[C", "\u001b[D"]);
    expect(keys.every((k) => k.kind === "key")).toBe(true);
  });

  it("decodes SS3 arrows as single keys", () => {
    const d = new TerminalKeyDecoder();
    const keys = d.feed(Buffer.from("\u001bOA\u001bOB", "latin1"), 1000);
    expect(keys.map((k) => k.s)).toEqual(["\u001bOA", "\u001bOB"]);
  });

  it("decodes Home/End/Delete/PageUp/PageDown", () => {
    const d = new TerminalKeyDecoder();
    const keys = d.feed(
      Buffer.from("\u001b[H\u001b[F\u001b[3~\u001b[5~\u001b[6~", "latin1"),
      1000,
    );
    expect(keys.map((k) => k.s)).toEqual([
      "\u001b[H", "\u001b[F", "\u001b[3~", "\u001b[5~", "\u001b[6~",
    ]);
  });

  it("passes plain text through as text events", () => {
    const d = new TerminalKeyDecoder();
    const keys = d.feed(Buffer.from("xin ha"), 1000);
    expect(keys.map((k) => k.s).join("")).toBe("xin ha");
    expect(keys.every((k) => k.kind === "text")).toBe(true);
  });

  it("passes control bytes through as keys", () => {
    const d = new TerminalKeyDecoder();
    const keys = d.feed(Buffer.from("\u0003\r\u007f"), 1000);
    expect(keys.map((k) => k.s)).toEqual(["\u0003", "\r", "\u007f"]);
  });
});

describe("TerminalKeyDecoder — fragmented sequences", () => {
  it("Down split as ESC | '[B' decodes to exactly one Down", () => {
    const d = new TerminalKeyDecoder();
    const k1 = d.feed(Buffer.from([0x1b]), 1000);
    expect(k1).toEqual([]);
    const k2 = d.feed(Buffer.from("[B", "latin1"), 1005);
    expect(k2.map((k) => k.s)).toEqual([DOWN]);
  });

  it("Down split as ESC[ | 'B' decodes to exactly one Down", () => {
    const d = new TerminalKeyDecoder();
    const k1 = d.feed(Buffer.from("\u001b[", "latin1"), 1000);
    expect(k1).toEqual([]);
    const k2 = d.feed(Buffer.from("B", "latin1"), 1005);
    expect(k2.map((k) => k.s)).toEqual([DOWN]);
  });

  it("Down delivered byte-by-byte decodes to exactly one Down", () => {
    const d = new TerminalKeyDecoder();
    const keys = feedAll(d, [
      Buffer.from([0x1b]),
      Buffer.from([0x5b]),
      Buffer.from([0x42]),
    ]);
    expect(keys.map((k) => k.s)).toEqual([DOWN]);
  });

  it("Up delivered byte-by-byte decodes to exactly one Up", () => {
    const d = new TerminalKeyDecoder();
    const keys = feedAll(d, [
      Buffer.from([0x1b]),
      Buffer.from([0x5b]),
      Buffer.from([0x41]),
    ]);
    expect(keys.map((k) => k.s)).toEqual([UP]);
  });

  it("text interleaved between fragments preserves order", () => {
    const d = new TerminalKeyDecoder();
    const keys = [
      ...d.feed(Buffer.from("x", "latin1"), 1000),
      ...d.feed(Buffer.from([0x1b]), 1010),
      ...d.feed(Buffer.from("[B", "latin1"), 1020),
      ...d.feed(Buffer.from("y", "latin1"), 1030),
    ];
    expect(keys.map((k) => k.s).join("")).toBe("x" + DOWN + "y");
  });
});

describe("TerminalKeyDecoder — standalone ESC disambiguation", () => {
  it("flushes a lone ESC as standalone after the timeout window", () => {
    const d = new TerminalKeyDecoder();
    expect(d.feed(Buffer.from([0x1b]), 1000)).toEqual([]);
    expect(d.hasTimedOut(1000 + ESC_FLUSH_TIMEOUT_MS)).toBe(true);
    const keys = d.flush();
    expect(keys).toEqual([{ s: "\u001b", kind: "key", standalone: true }]);
  });

  it("does not time out before the window elapses", () => {
    const d = new TerminalKeyDecoder();
    d.feed(Buffer.from([0x1b]), 1000);
    expect(d.hasTimedOut(1000 + ESC_FLUSH_TIMEOUT_MS - 1)).toBe(false);
  });

  it("a continuation arriving just inside the window still forms a sequence", () => {
    const d = new TerminalKeyDecoder();
    d.feed(Buffer.from([0x1b]), 1000);
    const keys = d.feed(Buffer.from("[B", "latin1"), 1000 + ESC_FLUSH_TIMEOUT_MS - 5);
    expect(keys.map((k) => k.s)).toEqual([DOWN]);
  });
});

describe("TerminalKeyDecoder — bracketed paste", () => {
  it("delivers a complete paste block as one paste event", () => {
    const d = new TerminalKeyDecoder();
    const keys = d.feed(Buffer.from("\u001b[200~pasted\r\ntext\u001b[201~", "latin1"), 1000);
    expect(keys).toHaveLength(1);
    expect(keys[0].kind).toBe("paste");
    expect(keys[0].s).toBe("pasted\r\ntext");
  });

  it("survives fragmentation and keeps control bytes as content", () => {
    const d = new TerminalKeyDecoder();
    const keys = [
      ...d.feed(Buffer.from("\u001b[200~pa", "latin1"), 1000),
      ...d.feed(Buffer.from("\u0003ste", "latin1"), 1010),
      ...d.feed(Buffer.from("\u001b[Bd\u001b[201~", "latin1"), 1020),
    ];
    expect(keys).toHaveLength(1);
    expect(keys[0].kind).toBe("paste");
    expect(keys[0].s).toBe("pa\u0003ste\u001b[Bd");
  });

  it("decodes keys normally before and after a paste", () => {
    const d = new TerminalKeyDecoder();
    const keys = d.feed(
      Buffer.from("a\u001b[200~p\u001b[201~b", "latin1"),
      1000,
    );
    expect(keys.map((k) => k.kind)).toEqual(["text", "paste", "text"]);
    expect(keys.map((k) => k.s)).toEqual(["a", "p", "b"]);
  });
});
