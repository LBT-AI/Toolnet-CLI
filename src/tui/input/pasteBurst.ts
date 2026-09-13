/**
 * Paste-burst detection for terminals without bracketed paste mode.
 *
 * When a terminal does not wrap pastes in `\x1b[200~ … \x1b[201~`, a paste
 * arrives as a rapid burst of plain bytes. Replayed per-keystroke, that burst
 * would trigger hotkeys mid-stream, submit on embedded newlines, and mangle
 * multi-byte characters. This state machine recognizes such bursts by arrival
 * density and coalesces them into a single logical paste:
 *
 *   idle → accumulating → (flush | timeout) → idle
 *
 * `flush()` may emit a `paste` chunk (burst confirmed) or a `text` chunk
 * (ordinary typing replayed verbatim). No timers: time is supplied by the
 * caller's chunk arrival timestamps, which keeps the machine deterministic
 * and testable.
 */

export const DEFAULT_PASTE_BURST_GAP_MS = 45; // slower than human typing bursts, faster than pastes
export const DEFAULT_PASTE_BURST_MIN_CHARS = 12; // below this a burst is just fast typing

export interface PasteBurstChunk {
  type: "text" | "paste";
  content: string;
}

interface PendingChunk {
  content: string;
  /** True if this chunk arrived within the burst window of its predecessor. */
  linked: boolean;
}

export class PasteBurstDetector {
  private pending: PendingChunk[] = [];
  private lastArrival = 0;

  constructor(
    private readonly maxGapMs: number = DEFAULT_PASTE_BURST_GAP_MS,
    private readonly minBurstChars: number = DEFAULT_PASTE_BURST_MIN_CHARS,
  ) {}

  /**
   * Feed one raw input chunk with its arrival timestamp (ms). Returns any
   * groups finalized by this arrival — normally the previous group, when the
   * gap to it exceeded the burst window (ordinary typing replays one chunk
   * per arrival with no added latency). Call `flush()` only when the stream
   * goes quiet to emit the trailing group.
   */
  accept(content: string, arrivalMs: number): PasteBurstChunk[] {
    if (!content) return [];
    const out: PasteBurstChunk[] = [];
    if (this.pending.length > 0 && arrivalMs - this.lastArrival > this.maxGapMs) {
      out.push(...this.emitPendingGroup());
    }
    const linked = this.pending.length > 0 && arrivalMs - this.lastArrival <= this.maxGapMs;
    this.pending.push({ content, linked });
    this.lastArrival = arrivalMs;
    return out;
  }

  /** Emit buffered chunks: a confirmed burst becomes one `paste` chunk. */
  flush(): PasteBurstChunk[] {
    const chunks: PasteBurstChunk[] = [];
    let group: PendingChunk[] = [];

    const emitGroup = () => {
      if (group.length === 0) return;
      const text = group.map((c) => c.content).join("");
      // A group longer than one chunk exists only because its members arrived
      // inside the burst window; below the size threshold it is fast typing.
      if (group.length > 1 && text.length >= this.minBurstChars) {
        chunks.push({ type: "paste", content: text });
      } else {
        chunks.push({ type: "text", content: text });
      }
      group = [];
    };

    for (const chunk of this.pending) {
      if (group.length > 0 && !chunk.linked) {
        emitGroup();
      }
      group.push(chunk);
    }
    emitGroup();

    this.pending = [];
    this.lastArrival = 0;
    return chunks;
  }

  private emitPendingGroup(): PasteBurstChunk[] {
    const chunks = this.flush();
    return chunks;
  }

  reset(): void {
    this.pending = [];
    this.lastArrival = 0;
  }
}
