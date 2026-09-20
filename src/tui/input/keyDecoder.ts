/**
 * Canonical stateful terminal key decoder.
 *
 * Terminal input is a byte protocol, not a key-event API: a single logical key
 * may arrive split across stdin data events (mobile SSH commonly delivers
 * `ESC` alone, then `"[B"`). Parsing each chunk independently therefore
 * mis-dispatches a standalone-Esc (closing pickers) and leaks the remainder
 * into the composer. This decoder persists partial sequences across chunks
 * and emits exactly one logical key per sequence.
 *
 * Ownership: exactly one decoder instance sits between stdin and the input
 * router. Callers must not pre-split escape sequences themselves.
 */

/**
 * How long a lone ESC waits for a possible continuation before flushing.
 * Must exceed a mobile-SSH inter-chunk gap (one RTT ~50-150ms), otherwise a
 * Down arriving as ESC|`[B` decodes as Esc + text. Standalone Esc paying one
 * short window is the cheap side of the trade.
 */
export const ESC_FLUSH_TIMEOUT_MS = 120;

/**
 * A decoded logical key event.
 *
 * `kind`:
 *   - "key"   — a control byte or complete escape sequence (`s` is the
 *               canonical sequence text, e.g. "\u001b[B" for Down);
 *   - "text"  — one printable character;
 *   - "paste" — one bracketed-paste block delivered as a whole.
 */
export interface DecodedKey {
  s: string;
  kind: "key" | "text" | "paste";
  /**
   * True when this ESC did not begin any sequence (timeout elapsed with no
   * continuation): the universal cancel/close key.
   */
  standalone: boolean;
}

interface PendingSequence {
  bytes: number[];
  /** Monotonic arrival deadline after which the sequence flushes as-is. */
  deadline: number;
}

export class TerminalKeyDecoder {
  private pending: PendingSequence | null = null;
  private static readonly ESC = 0x1b;

  /** Inside a bracketed-paste block everything buffers verbatim. */
  private inPaste = false;
  private pasteBytes: number[] = [];

  constructor(private readonly escTimeoutMs: number = ESC_FLUSH_TIMEOUT_MS) {}

  /** True while an escape sequence is mid-assembly. */
  get hasPendingSequence(): boolean {
    return this.pending !== null;
  }

  /**
   * Feed one raw stdin chunk, emitting zero or more decoded keys. Incomplete
   * trailing sequences stay buffered across chunks; text and single-byte
   * control keys dispatch immediately.
   */
  feed(data: Buffer | string, now: number = Date.now()): DecodedKey[] {
    const bytes = Array.from(typeof data === "string" ? Buffer.from(data, "utf8") : data);
    const out: DecodedKey[] = [];

    // The deadline only disambiguates a lone ESC whose next byte could be an
    // Alt-modified key (`ESC x`). A CSI/SS3 continuation (`ESC [`, `ESC O`,
    // or a final byte for an in-progress sequence) is unambiguous VT grammar
    // and must extend the pending sequence no matter how late it arrives —
    // mobile SSH routinely delivers fragments slower than the ESC window.
    if (this.pending && bytes.length > 0) {
      const b0 = bytes[0];
      const unambiguous =
        this.pending.bytes.length > 1 || b0 === 0x5b /* [ */ || b0 === 0x4f /* O */;
      if (!unambiguous && now >= this.pending.deadline) {
        this.flushPending(out);
      }
    }

    let i = 0;
    while (i < bytes.length) {
      if (this.inPaste) {
        i = this.consumePasteBytes(bytes, i, out);
        continue;
      }

      if (this.pending) {
        this.pending.bytes.push(bytes[i]);
        i += 1;
        if (this.tryCompleteSequence(out)) continue;
        // Still incomplete: either keep accumulating, or abort on garbage.
        if (!this.sequenceCanContinue(this.pending.bytes)) {
          this.abortPending(out);
        }
        continue;
      }

      const b = bytes[i];
      if (b === TerminalKeyDecoder.ESC) {
        this.pending = { bytes: [b], deadline: now + this.escTimeoutMs };
        i += 1;
        // Complete in-chunk sequences immediately — zero latency for a
        // well-behaved terminal that delivers each sequence in one event.
        if (!this.tryCompleteSequence(out) && !this.sequenceCanContinue(this.pending.bytes)) {
          this.abortPending(out);
        }
        continue;
      }

      if (b < 0x20 || b === 0x7f) {
        // Control byte: one byte = one logical key.
        out.push({ s: String.fromCharCode(b), kind: "key", standalone: false });
        i += 1;
        continue;
      }

      // Printable run: decode as UTF-8 text, one DecodedKey per character.
      let j = i;
      while (j < bytes.length && bytes[j] >= 0x20 && bytes[j] !== TerminalKeyDecoder.ESC) j += 1;
      const text = Buffer.from(bytes.slice(i, j)).toString("utf8");
      for (const ch of text) out.push({ s: ch, kind: "text", standalone: false });
      i = j;
    }

    return out;
  }

  /**
   * Flush whatever is buffered (no timeout wait): a completed sequence and
   * any text that followed. Used before passthrough modal dispatch and at
   * stream end so nothing is lost when the user stops typing.
   */
  flush(): DecodedKey[] {
    const out: DecodedKey[] = [];
    if (this.pending) this.flushPending(out);
    return out;
  }

  /**
   * True when the pending partial sequence has exceeded its disambiguation
   * window and should be flushed by a timer tick or the next feed().
   */
  hasTimedOut(now: number): boolean {
    return this.pending !== null && now >= this.pending.deadline;
  }

  private flushPending(out: DecodedKey[]): void {
    if (!this.pending) return;
    const bytes = this.pending.bytes;
    this.pending = null;
    if (this.inPaste) {
      // A paste is open and the stream went quiet with an unterminated block:
      // the pending bytes were a keystroke, not paste content — decode them.
      this.decodeCompleteBytes(bytes, out);
      return;
    }
    this.decodeCompleteBytes(bytes, out);
  }

  /**
   * Consume bytes while inside a bracketed paste: everything up to the end
   * marker becomes ONE paste event, so control bytes or arrow sequences
   * inside pasted text can never be mistaken for live keystrokes.
   * Returns the index to continue decoding from.
   */
  private consumePasteBytes(bytes: number[], start: number, out: DecodedKey[]): number {
    const endMarker = PASTE_END_BYTES;
    let i = start;
    while (i < bytes.length) {
      if (this.matchesAhead(bytes, i, endMarker)) {
        this.emitPaste(out);
        this.inPaste = false;
        return i + endMarker.length;
      }
      this.pasteBytes.push(bytes[i]);
      i += 1;
    }
    return i;
  }

  private matchesAhead(bytes: number[], at: number, marker: number[]): boolean {
    if (at + marker.length > bytes.length) return false;
    for (let k = 0; k < marker.length; k++) {
      if (bytes[at + k] !== marker[k]) return false;
    }
    return true;
  }

  private emitPaste(out: DecodedKey[]): void {
    if (this.pasteBytes.length === 0) return;
    const content = Buffer.from(this.pasteBytes).toString("utf8");
    this.pasteBytes = [];
    out.push({ s: content, kind: "paste", standalone: false });
  }

  private abortPending(out: DecodedKey[]): void {
    if (!this.pending) return;
    const bytes = this.pending.bytes;
    this.pending = null;
    // Garbage sequence: emit as literal characters, never bytes leaking
    // silently into composer state.
    for (const ch of Buffer.from(bytes).toString("utf8")) {
      out.push({ s: ch, kind: "text", standalone: false });
  }
  }

  private tryCompleteSequence(out: DecodedKey[]): boolean {
    if (!this.pending) return false;
    const bytes = this.pending.bytes;
    const complete = isCompleteSequence(bytes);
    if (complete) {
      this.pending = null;
      if (matchesBytes(bytes, PASTE_START_BYTES)) {
        // Paste block opens: following bytes buffer verbatim until the end
        // marker, across as many stdin chunks as the terminal needs.
        this.inPaste = true;
      } else if (matchesBytes(bytes, PASTE_END_BYTES)) {
        // Stray end marker outside a paste: ignore.
      } else {
        decodeSequenceBytes(bytes, out);
      }
      return true;
    }
    return false;
  }

  private decodeCompleteBytes(bytes: number[], out: DecodedKey[]): void {
    if (bytes.length === 1 && bytes[0] === TerminalKeyDecoder.ESC) {
      out.push({ s: "\u001b", kind: "key", standalone: true });
      return;
    }
    decodeSequenceBytes(bytes, out);
  }

  private sequenceCanContinue(bytes: number[]): boolean {
    return sequenceCanContinue(bytes);
  }
}

/** Is `bytes` a complete, dispatchable sequence? */
const PASTE_START_BYTES = Array.from(Buffer.from("\u001b[200~", "latin1"));
const PASTE_END_BYTES = Array.from(Buffer.from("\u001b[201~", "latin1"));

function matchesBytes(bytes: number[], marker: number[]): boolean {
  return (
    bytes.length === marker.length &&
    marker.every((b, k) => bytes[k] === b)
  );
}
function isCompleteSequence(bytes: number[]): boolean {
  if (bytes.length === 0) return false;
  if (bytes.length === 1) return false; // lone ESC: needs timeout, not completion
  const b1 = bytes[1];
  // CSI: ESC [ … final byte 0x40-0x7E
  if (b1 === 0x5b) {
    if (bytes.length < 3) return false;
    const last = bytes[bytes.length - 1];
    // Parameter bytes 0x30-0x3F and intermediate 0x20-0x2F precede the final.
    for (let k = 2; k < bytes.length - 1; k++) {
      if (bytes[k] < 0x20 || bytes[k] > 0x3f) return false;
    }
    return last >= 0x40 && last <= 0x7e;
  }
  // SS3: ESC O <one byte>
  if (b1 === 0x4f) {
    return bytes.length === 3;
  }
  // ESC + one byte: Alt-modified key (ESC a, ESC \r …)
  return true;
}

/** Can more bytes legitimately extend this partial sequence? */
function sequenceCanContinue(bytes: number[]): boolean {
  if (bytes.length === 0) return false;
  if (bytes.length === 1) return true; // ESC alone: wait for continuation
  const b1 = bytes[1];
  if (b1 === 0x5b) {
    if (bytes.length < 3) return true; // "ESC[" — final byte pending
    const last = bytes[bytes.length - 1];
    if (last >= 0x40 && last <= 0x7e) return false; // final byte already seen
    // Parameter bytes keep the sequence alive; anything else is garbage.
    return bytes[bytes.length - 1] >= 0x20 && bytes[bytes.length - 1] <= 0x3f;
  }
  if (b1 === 0x4f) {
    return bytes.length < 3;
  }
  // Alt-modified key: complete at 2 bytes; longer is garbage.
  return false;
}

/** Decode a complete (non-lone-ESC) sequence into logical keys. */
function decodeSequenceBytes(bytes: number[], out: DecodedKey[]): void {
  const s = Buffer.from(bytes).toString("latin1");
  out.push({ s, kind: "key", standalone: false });
}
