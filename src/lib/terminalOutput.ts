/**
 * Canonical child-process output normalizer.
 *
 * A CLI's stdout/stderr is a TERMINAL BYTE STREAM, not a log file: it arrives
 * in arbitrary chunks, mixes UTF-8, ANSI control sequences and carriage-return
 * line rewrites, and reuses one line for a whole progress animation. Rendering
 * it verbatim produces the classic garbage every terminal app must prevent:
 *
 *   - a multi-byte character split across two chunks decoded twice → "�";
 *   - escape bytes kept as text → "[36m", "]0;title";
 *   - every spinner/progress frame appended as its own line.
 *
 * `TerminalOutputBuffer` owns the smallest correct interpretation:
 *   decode UTF-8 with state → strip/consume control sequences → apply the few
 *   line operations a progress UI relies on (`\r`, `\b`, erase-line,
 *   cursor-to-column) → expose STABLE committed lines separately from the
 *   mutable LIVE line.
 *
 * It is deliberately NOT a full terminal emulator: no scrollback, no cursor
 * addressing across lines, no alternate screen. Just enough that `\r` progress
 * reads as one updating line and committed output is clean, wrapped text.
 *
 * Lives outside `src/tui` so headless runs, the TUI and tests all share it.
 */

import { StringDecoder } from "node:string_decoder";
import { stripAnsi, previousGraphemeStart } from "./text";

export interface TerminalOutputOptions {
  /** Committed lines retained (oldest dropped). Keeps memory bounded. */
  maxLines?: number;
  /** Cap on committed+live characters; further output is dropped. 0 = unbounded. */
  maxChars?: number;
}

export const DEFAULT_TERMINAL_MAX_LINES = 5000;

/** What a completed CSI control sequence does. Everything else is ignored. */
export type ControlAction =
  | { kind: "none" }
  | { kind: "erase-to-end" }
  | { kind: "erase-to-start" }
  | { kind: "erase-all" }
  | { kind: "column"; column: number }
  | { kind: "cursor-back"; count: number }
  | { kind: "cursor-forward"; count: number };

/**
 * Interpret a finished CSI sequence (bytes after `ESC[`, ending in the final
 * byte). Only the operations that affect a single live line are honored.
 */
export function interpretCsi(sequence: string): ControlAction {
  if (sequence.length === 0) return { kind: "none" };
  const final = sequence[sequence.length - 1];
  const paramsPart = sequence.slice(0, -1);
  // Private/intermediate prefixes (`?`, `>`, `<`, `!`) are device reports —
  // never line edits.
  if (paramsPart.length > 0 && !/^[0-9;]*$/.test(paramsPart)) return { kind: "none" };
  const first = paramsPart.length === 0 ? 1 : parseInt(paramsPart.split(";")[0], 10);
  const count = Number.isFinite(first) && first > 0 ? first : 1;
  switch (final) {
    case "K": {
      // EL: 0/default from cursor to end, 1 from start to cursor, 2 whole line.
      if (paramsPart === "1") return { kind: "erase-to-start" };
      if (paramsPart === "2") return { kind: "erase-all" };
      return { kind: "erase-to-end" };
    }
    case "G": // CHA — cursor to absolute column (1-based)
      return { kind: "column", column: Math.max(0, count - 1) };
    case "D": // CUB — cursor back N
      return { kind: "cursor-back", count };
    case "C": // CUF — cursor forward N
      return { kind: "cursor-forward", count };
    case "J": // ED — erase display. Only the all-clear forms reset the live line.
      return paramsPart === "2" || paramsPart === "3" ? { kind: "erase-all" } : { kind: "none" };
    default:
      return { kind: "none" };
  }
}

/**
 * Whether a decoded string still holds any escape/control byte that must never
 * reach the transcript. Used by renderers as a cheap guard.
 */
export function hasControlSequences(value: string): boolean {
  // Tab (0x09) and newline (0x0a) are legitimate transcript characters; every
  // other C0 byte, DEL and carriage return are not.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

/** Strip every control sequence AND collapse carriage-return overwrites. */
export function sanitizeTerminalText(value: string): string {
  const buffer = new TerminalOutputBuffer();
  buffer.write(value);
  return buffer.flush();
}

/**
 * A single stream's terminal output: stateful UTF-8 decode plus a one-line
 * editor for live rewrites. One instance per stream — never share across
 * stdout/stderr, or a partial sequence from one corrupts the other.
 */
export class TerminalOutputBuffer {
  private readonly utf8 = new StringDecoder("utf8");
  private readonly maxLines: number;
  private readonly maxChars: number;

  private committed: string[] = [];
  /** Current, still-mutable line (progress/spinner target). */
  private current = "";
  /** Insertion point within `current` (UTF-16 offset). */
  private cursor = 0;

  /** Partial escape sequence carried across chunks (starts with ESC). */
  private pendingEscape: string | null = null;
  /** True once we entered an OSC/DCS-style string that ends with BEL or ST. */
  private pendingString = false;
  /** Inside a pending string, whether the previous char was ESC (for ST). */
  private stringSawEsc = false;
  private stringLength = 0;
  private droppedChars = 0;

  constructor(options: TerminalOutputOptions = {}) {
    this.maxLines = Math.max(1, options.maxLines ?? DEFAULT_TERMINAL_MAX_LINES);
    this.maxChars = Math.max(0, options.maxChars ?? 0);
  }

  /**
   * Feed one raw chunk. `string` input is assumed already UTF-8 decoded by the
   * caller (e.g. tests); `Buffer` runs through the stateful decoder.
   * Returns the plain text that became visible for this chunk (for live deltas).
   */
  write(chunk: Buffer | string): string {
    const text = typeof chunk === "string" ? chunk : this.utf8.write(chunk);
    if (!text) return "";
    let visible = "";
    for (const ch of text) {
      visible += this.consume(ch);
    }
    return visible;
  }

  /** Finalize the live line (process end): commits it, clears all state. */
  flush(): string {
    // Drain the UTF-8 decoder so a character whose last byte arrived at exit
    // is still shown (a genuinely truncated sequence becomes U+FFFD, never a
    // silently dropped buffer).
    const tail = this.utf8.end();
    if (tail) this.write(tail);
    // A dangling partial escape at stream end is discarded, never printed.
    this.pendingEscape = null;
    this.pendingString = false;
    // Commit the live line ONLY if it holds something: a stream that ended with
    // `\n` must not gain a spurious trailing empty line.
    if (this.current.length > 0) this.commitCurrent();
    this.current = "";
    this.cursor = 0;
    return this.getCommittedText();
  }

  /** Stable, scroll-back-worthy text. Never contains a live frame. */
  getCommittedText(): string {
    return this.committed.join("\n");
  }

  /** The mutable tail line the driver wants to show while the command runs. */
  getLiveLine(): string {
    return this.current;
  }

  /** Committed text plus the live line — the full picture. */
  getText(): string {
    return this.current.length > 0
      ? [...this.committed, this.current].join("\n")
      : this.getCommittedText();
  }

  /** Last `count` non-empty lines (committed + live), for a bounded preview. */
  getTailLines(count = 5): string[] {
    const lines = this.current.length > 0 ? [...this.committed, this.current] : this.committed;
    return lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-count);
  }

  /** Number of committed lines (cheap viewport sizing). */
  getCommittedLineCount(): number {
    return this.committed.length;
  }

  /** How many characters were dropped by the char cap, if any. */
  getDroppedChars(): number {
    return this.droppedChars;
  }

  // ── Line editor ──────────────────────────────────────────────────────────

  private consume(ch: string): string {
    if (this.pendingEscape !== null || this.pendingString) {
      return this.consumeEscape(ch);
    }
    switch (ch) {
      case "\u001b":
        this.pendingEscape = ch;
        return "";
      case "\n":
        this.commitCurrent();
        this.current = "";
        this.cursor = 0;
        return "";
      case "\r":
        this.cursor = 0;
        return "";
      case "\b":
        this.cursor = Math.max(0, previousGraphemeStart(this.current, this.cursor));
        return "";
      case "\t": {
        const spaces = 8 - (this.cursor % 8);
        return this.insert(" ".repeat(spaces));
      }
      default:
        break;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return ""; // other C0/DEL: no visual effect
    return this.insert(ch);
  }

  /** Continue an escape sequence; returns any printable text it released. */
  private consumeEscape(ch: string): string {
    // OSC/DCS/SOS/PM/APC strings terminate on BEL or ST (ESC \).
    if (this.pendingString) {
      if (ch === "\u0007" || (this.stringSawEsc && ch === "\\")) {
        this.endString();
        return "";
      }
      this.stringSawEsc = ch === "\u001b";
      this.stringLength += 1;
      // Guard against an unterminated string (e.g. a truncated title) eating
      // the rest of the stream.
      if (this.stringLength > 4096) this.endString();
      return "";
    }

    const isControl = (ch.codePointAt(0) ?? 0) < 0x20;
    const seq = (this.pendingEscape ?? "\u001b") + ch;

    if (seq.length === 2) {
      // ESC <introducer>: decide which parser to run.
      if (ch === "[") {
        this.pendingEscape = seq;
        return ""; // CSI — wait for final byte
      }
      if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
        this.pendingEscape = seq;
        this.pendingString = true;
        this.stringSawEsc = false;
        this.stringLength = 0;
        return "";
      }
      // Two-character escape (ESC 7, ESC M, …). If it was ESC + control, the
      // control (newline/carriage return) still matters — reprocess it.
      this.pendingEscape = null;
      return isControl ? this.consume(ch) : "";
    }

    // CSI: a control char can never be part of a sequence — abort and reprocess.
    if (isControl) {
      this.pendingEscape = null;
      return this.consume(ch);
    }
    // Final byte is 0x40–0x7E; parameters/intermediates precede it.
    const payload = seq.slice(2);
    const last = payload[payload.length - 1];
    if (last >= "@" && last <= "~") {
      this.pendingEscape = null;
      this.applyControl(interpretCsi(payload));
    } else {
      this.pendingEscape = seq;
    }
    return "";
  }

  /** Close an OSC/DCS/SOS/PM/APC string and forget it. */
  private endString(): void {
    this.pendingString = false;
    this.pendingEscape = null;
    this.stringSawEsc = false;
    this.stringLength = 0;
  }

  private applyControl(action: ControlAction): void {
    switch (action.kind) {
      case "erase-to-end":
        this.current = this.current.slice(0, this.cursor);
        break;
      case "erase-to-start":
        this.current = this.current.slice(this.cursor);
        this.cursor = 0;
        break;
      case "erase-all":
        this.current = "";
        this.cursor = 0;
        break;
      case "column":
        this.cursor = Math.max(0, Math.min(action.column, this.current.length));
        break;
      case "cursor-back":
        this.cursor = Math.max(0, previousGraphemeStart(this.current, this.cursor - action.count + 1));
        break;
      case "cursor-forward":
        this.cursor = Math.min(this.current.length, this.cursor + action.count);
        break;
      case "none":
        break;
    }
  }

  /** Insert visible text at the live cursor (overwriting rewritten cells). */
  private insert(text: string): string {
    if (this.maxChars > 0) {
      const used = this.committed.reduce((n, line) => n + line.length, 0) + this.current.length;
      if (used >= this.maxChars) {
        this.droppedChars += text.length;
        return "";
      }
    }
    const before = this.current.slice(0, this.cursor);
    const after = this.current.slice(this.cursor + text.length);
    this.current = before + text + after;
    this.cursor += text.length;
    return text;
  }

  private commitCurrent(): void {
    // Trailing spaces are an artifact of erase/clear padding, never content.
    const line = this.current.replace(/[ \t]+$/, "");
    if (this.maxChars > 0) {
      const used = this.committed.reduce((n, l) => n + l.length, 0);
      if (used >= this.maxChars) return;
    }
    this.committed.push(line);
    if (this.committed.length > this.maxLines) {
      this.committed.splice(0, this.committed.length - this.maxLines);
    }
  }
}

/** Re-exported so non-TUI consumers get consistent sanitization. */
export { stripAnsi };
