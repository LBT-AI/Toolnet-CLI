/**
 * Composer Document — a segmented draft buffer.
 *
 * THE problem this solves: a 365-line paste must occupy ONE short token in the
 * composer (`[365 lines pasted #1]`) instead of 365 rendered rows — while the
 * model still receives all 365 lines on submit.
 *
 * The representation is therefore explicit and two-layered:
 *
 *   segments  → what the composer SHOWS and EDITS (text runs + atomic blocks)
 *   content   → what submit SENDS (the serialized, untouched paste text)
 *
 * A paste block is a single logical unit: the caret can sit only at its
 * boundaries (never inside), Backspace/Delete remove it whole, and the block's
 * real text never appears in the display string. Nothing here rewrites the
 * buffer into a placeholder and tries to recover it later.
 *
 * All indices are UTF-16 code-unit offsets into the DISPLAY string, matching
 * the rest of the composer/layout pipeline (which maps `cursorPos` over
 * `inputBuffer`).
 */

/** A collapsed paste is one atomic block with stable identity. */
export interface PastedBlock {
  /** Stable, per-draft monotonic id (never changes on re-render). */
  id: number;
  /** The untouched pasted text — what submit serializes. */
  content: string;
  /** Number of lines the content spans (shown in the token). */
  lineCount: number;
  /** Number of UTF-16 code units in the content. */
  charCount: number;
}

export type ComposerSegment =
  | { kind: "text"; text: string }
  | { kind: "paste"; block: PastedBlock };

/**
 * Collapse thresholds. A paste is collapsed when EITHER bound is crossed:
 *  - a multi-line paste shorter than 5 lines stays inline (ordinary snippet),
 *  - a single gigantic line is collapsed by the character bound so it cannot
 *    blow the layout horizontally.
 */
export const PASTE_COLLAPSE_MIN_LINES = 5;
export const PASTE_COLLAPSE_MIN_CHARS = 400;

/** Line count of a text blob (`""` is zero lines). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

/** Should this paste be collapsed into a token? */
export function shouldCollapsePaste(lineCount: number, charCount: number): boolean {
  return lineCount >= PASTE_COLLAPSE_MIN_LINES || charCount >= PASTE_COLLAPSE_MIN_CHARS;
}

/** The short token rendered in place of the paste (and cleared on delete). */
export function pastePlaceholder(block: Pick<PastedBlock, "id" | "lineCount">): string {
  const unit = block.lineCount === 1 ? "line" : "lines";
  return `[${block.lineCount} ${unit} pasted #${block.id}]`;
}

export interface InsertPasteResult {
  collapsed: boolean;
  id?: number;
  lineCount: number;
  charCount: number;
}

/**
 * A complete, restorable draft. Used where a draft must be parked and brought
 * back verbatim (prompt-history navigation) — restoring the DISPLAY string
 * would turn a paste token back into literal text and lose the real content.
 */
export interface ComposerDraftSnapshot {
  segments: ComposerSegment[];
  cursor: number;
  nextPasteId: number;
}

interface SegmentSpan {
  index: number;
  start: number;
  end: number;
}

export class ComposerDocument {
  private segments: ComposerSegment[] = [];
  private cursor = 0;
  private nextPasteId = 1;

  constructor(initialText = "", initialCursor?: number) {
    if (initialText.length > 0) {
      this.segments = [{ kind: "text", text: initialText }];
    }
    this.cursor = initialCursor !== undefined
      ? Math.max(0, Math.min(initialCursor, initialText.length))
      : initialText.length;
  }

  // ── Read surface ─────────────────────────────────────────────────────────

  /** The DISPLAY string: text runs plus each paste token. */
  getText(): string {
    let out = "";
    for (const segment of this.segments) {
      out += segment.kind === "text" ? segment.text : pastePlaceholder(segment.block);
    }
    return out;
  }

  /** What submit must send: the original text with real paste content. */
  getContent(): string {
    let out = "";
    for (const segment of this.segments) {
      out += segment.kind === "text" ? segment.text : segment.block.content;
    }
    return out;
  }

  getCursor(): number {
    return this.cursor;
  }

  /** Segments, for renderers/tests that need block spans. */
  getSegments(): readonly ComposerSegment[] {
    return this.segments;
  }

  /** Every collapsed paste currently held by the draft. */
  getPasteBlocks(): PastedBlock[] {
    return this.segments
      .filter((segment): segment is { kind: "paste"; block: PastedBlock } => segment.kind === "paste")
      .map((segment) => segment.block);
  }

  hasCollapsedPaste(): boolean {
    return this.segments.some((segment) => segment.kind === "paste");
  }

  getLength(): number {
    return this.getText().length;
  }

  // ── Whole-document mutations ─────────────────────────────────────────────

  /**
   * Replace the draft with plain text. Used by history recall / programmatic
   * seeding; it never invents blocks (only a real paste event collapses).
   */
  setText(newText: string, newCursor?: number): void {
    this.segments = newText.length > 0 ? [{ kind: "text", text: newText }] : [];
    this.nextPasteId = 1;
    this.cursor = newCursor !== undefined
      ? Math.max(0, Math.min(newCursor, newText.length))
      : newText.length;
  }

  /** Drop the draft AND release every held paste block. */
  clear(): void {
    this.segments = [];
    this.cursor = 0;
    this.nextPasteId = 1;
  }

  /** Park the whole draft (segments + blocks + caret + id counter). */
  snapshot(): ComposerDraftSnapshot {
    return {
      segments: this.segments.map((segment) =>
        segment.kind === "text"
          ? { kind: "text", text: segment.text }
          : { kind: "paste", block: { ...segment.block } },
      ),
      cursor: this.cursor,
      nextPasteId: this.nextPasteId,
    };
  }

  /** Bring a parked draft back verbatim (blocks and ids included). */
  restore(snapshot: ComposerDraftSnapshot): void {
    this.segments = snapshot.segments.map((segment) =>
      segment.kind === "text"
        ? { kind: "text", text: segment.text }
        : { kind: "paste", block: { ...segment.block } },
    );
    this.nextPasteId = snapshot.nextPasteId;
    this.cursor = snapshot.cursor;
    this.normalize();
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  insertText(str: string): void {
    if (str.length === 0) return;
    this.insertAt(this.cursor, str);
    this.cursor += str.length;
    this.normalize();
  }

  insertNewline(): void {
    this.insertText("\n");
  }

  /**
   * Insert a paste. Large pastes become one atomic collapsed block; small ones
   * are inserted as ordinary text (so day-to-day copy/paste is unchanged).
   */
  insertPaste(content: string): InsertPasteResult {
    const lineCount = countLines(content);
    const charCount = content.length;
    if (!shouldCollapsePaste(lineCount, charCount)) {
      this.insertText(content);
      return { collapsed: false, lineCount, charCount };
    }

    const block: PastedBlock = {
      id: this.nextPasteId++,
      content,
      lineCount,
      charCount,
    };
    const insertionPoint = this.cursor;
    // A paste is always its own segment: it must never merge into adjacent text
    // (that is what keeps it atomic and independently deletable).
    const { index, offset } = this.locate(insertionPoint);
    const at = this.splitTextAt(index, offset);
    this.segments.splice(at, 0, { kind: "paste", block });
    this.cursor = insertionPoint + pastePlaceholder(block).length;
    this.normalize();
    return { collapsed: true, id: block.id, lineCount, charCount };
  }

  /** Backspace. Deletes a whole paste block when the caret is right after it. */
  deleteBackward(): boolean {
    if (this.cursor <= 0) return false;
    const block = this.blockEndingAt(this.cursor);
    if (block) {
      this.deleteRange(block.start, block.end);
      this.cursor = block.start;
      this.normalize();
      return true;
    }
    this.deleteRange(this.cursor - 1, this.cursor);
    this.cursor -= 1;
    this.normalize();
    return true;
  }

  /** Delete. Deletes a whole paste block when the caret is right before it. */
  deleteForward(): boolean {
    const total = this.getLength();
    if (this.cursor >= total) return false;
    const block = this.blockStartingAt(this.cursor);
    if (block) {
      this.deleteRange(block.start, block.end);
      this.cursor = block.start;
      this.normalize();
      return true;
    }
    this.deleteRange(this.cursor, this.cursor + 1);
    this.normalize();
    return true;
  }

  /** Ctrl+W. Never cuts a paste block in half — deletes it whole. */
  deleteWordBackward(): boolean {
    if (this.cursor <= 0) return false;
    const block = this.blockEndingAt(this.cursor);
    if (block) {
      this.deleteRange(block.start, block.end);
      this.cursor = block.start;
      this.normalize();
      return true;
    }

    const spans = this.spans();
    const hit = this.spanContaining(this.cursor - 1, spans);
    if (!hit) return false;
    const segment = this.segments[hit.index];
    if (segment.kind !== "text") {
      // The caret sits at the start boundary of a block: delete the block.
      this.deleteRange(hit.start, hit.end);
      this.cursor = hit.start;
      this.normalize();
      return true;
    }

    const offset = this.cursor - hit.start;
    const before = segment.text.slice(0, offset);
    const trimmed = before.replace(/\S+\s*$/, "");
    // Clamp to the text segment so word-delete can never reach into a block.
    this.deleteRange(hit.start + trimmed.length, this.cursor);
    this.cursor = hit.start + trimmed.length;
    this.normalize();
    return true;
  }

  /** Ctrl+K. Removes the rest of the display line (whole blocks included). */
  killToEndOfLine(): boolean {
    const display = this.getText();
    const newlineIndex = display.indexOf("\n", this.cursor);
    const end = newlineIndex === -1 ? display.length : newlineIndex;
    if (end === this.cursor) return true;
    this.deleteRange(this.cursor, end);
    this.normalize();
    return true;
  }

  /** Ctrl+U. Clears the draft and releases its paste blocks. */
  clearLine(): void {
    this.clear();
  }

  // ── Cursor movement ──────────────────────────────────────────────────────

  /** Left. A paste block is one logical unit: the caret jumps over it whole. */
  moveLeft(): boolean {
    if (this.cursor <= 0) return false;
    const interior = this.blockInterior(this.cursor - 1);
    this.cursor = interior ? interior.start : this.cursor - 1;
    this.normalize();
    return true;
  }

  /** Right. A paste block is one logical unit: the caret jumps over it whole. */
  moveRight(): boolean {
    const total = this.getLength();
    if (this.cursor >= total) return false;
    const block = this.blockStartingAt(this.cursor);
    this.cursor = block ? block.end : this.cursor + 1;
    this.normalize();
    return true;
  }

  moveToStartOfLine(): void {
    const display = this.getText();
    const lastNewline = display.lastIndexOf("\n", this.cursor - 1);
    this.cursor = lastNewline === -1 ? 0 : lastNewline + 1;
    this.normalize();
  }

  moveToEndOfLine(): void {
    const display = this.getText();
    const nextNewline = display.indexOf("\n", this.cursor);
    this.cursor = nextNewline === -1 ? display.length : nextNewline;
    this.normalize();
  }

  moveUp(): boolean {
    if (this.isAtFirstLine()) return false;
    const text = this.getText();
    const currentLineStart = text.lastIndexOf("\n", this.cursor - 1) + 1;
    const colOffset = this.cursor - currentLineStart;
    const prevLineEnd = currentLineStart - 1;
    const prevLineStart = text.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const prevLineLen = prevLineEnd - prevLineStart;
    this.cursor = prevLineStart + Math.min(colOffset, prevLineLen);
    this.normalize();
    return true;
  }

  moveDown(): boolean {
    if (this.isAtLastLine()) return false;
    const text = this.getText();
    const currentLineStart = text.lastIndexOf("\n", this.cursor - 1) + 1;
    const colOffset = this.cursor - currentLineStart;
    const nextLineStart = text.indexOf("\n", this.cursor) + 1;
    const nextLineEnd = text.indexOf("\n", nextLineStart);
    const nextLineLen = (nextLineEnd === -1 ? text.length : nextLineEnd) - nextLineStart;
    this.cursor = nextLineStart + Math.min(colOffset, nextLineLen);
    this.normalize();
    return true;
  }

  isMultiline(): boolean {
    return this.getText().includes("\n");
  }

  isAtFirstLine(): boolean {
    return this.getText().lastIndexOf("\n", this.cursor - 1) === -1;
  }

  isAtLastLine(): boolean {
    return this.getText().indexOf("\n", this.cursor) === -1;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private spans(): SegmentSpan[] {
    const spans: SegmentSpan[] = [];
    let pos = 0;
    for (let index = 0; index < this.segments.length; index++) {
      const segment = this.segments[index];
      const length = segment.kind === "text" ? segment.text.length : pastePlaceholder(segment.block).length;
      spans.push({ index, start: pos, end: pos + length });
      pos += length;
    }
    return spans;
  }

  /** The segment + offset containing `pos` (boundary → the segment that ends there). */
  private locate(pos: number): { index: number; offset: number } {
    const spans = this.spans();
    if (spans.length === 0) return { index: -1, offset: 0 };
    for (const span of spans) {
      if (pos <= span.end && pos >= span.start) {
        return { index: span.index, offset: pos - span.start };
      }
    }
    const last = spans[spans.length - 1];
    return { index: last.index, offset: last.end - last.start };
  }

  private spanContaining(pos: number, spans: SegmentSpan[]): SegmentSpan | null {
    for (const span of spans) {
      if (pos >= span.start && pos < span.end) return span;
    }
    return null;
  }

  /**
   * Split a text segment so new content can be spliced at `offset` without
   * touching a neighbouring paste block. Returns the segment index to insert
   * at. When the located segment is a paste, the index is before/after it.
   */
  private splitTextAt(index: number, offset: number): number {
    if (index === -1) return 0;
    const segment = this.segments[index];
    if (segment.kind === "paste") {
      // Boundary insert: before the block at offset 0, after it at offset len.
      return offset === 0 ? index : index + 1;
    }
    const before = segment.text.slice(0, offset);
    const after = segment.text.slice(offset);
    const replacement: ComposerSegment[] = [];
    if (before.length > 0) replacement.push({ kind: "text", text: before });
    const insertAt = index + replacement.length;
    if (after.length > 0) replacement.push({ kind: "text", text: after });
    this.segments.splice(index, 1, ...replacement);
    return insertAt;
  }

  private insertAt(pos: number, text: string): void {
    const { index, offset } = this.locate(pos);
    const at = this.splitTextAt(index, offset);
    this.segments.splice(at, 0, { kind: "text", text });
  }

  /**
   * Remove display range [start, end). A paste block overlapped by the range is
   * removed ENTIRELY (never partially) — that is what keeps it atomic.
   */
  private deleteRange(start: number, end: number): void {
    const spans = this.spans();
    const out: ComposerSegment[] = [];
    for (const span of spans) {
      const segment = this.segments[span.index];
      if (span.end <= start || span.start >= end) {
        out.push(segment);
        continue;
      }
      if (segment.kind === "paste") continue;
      const keepLeft = segment.text.slice(0, Math.max(0, start - span.start));
      const keepRight = segment.text.slice(Math.max(0, end - span.start));
      const merged = keepLeft + keepRight;
      if (merged.length > 0) out.push({ kind: "text", text: merged });
    }
    this.segments = out;
    this.normalize();
  }

  private blockEndingAt(pos: number): SegmentSpan | null {
    for (const span of this.spans()) {
      if (this.segments[span.index].kind === "paste" && span.end === pos) return span;
    }
    return null;
  }

  private blockStartingAt(pos: number): SegmentSpan | null {
    for (const span of this.spans()) {
      if (this.segments[span.index].kind === "paste" && span.start === pos) return span;
    }
    return null;
  }

  /** The paste block whose display span strictly contains `pos`, if any. */
  private blockInterior(pos: number): SegmentSpan | null {
    const hit = this.spanContaining(pos, this.spans());
    if (hit && this.segments[hit.index].kind === "paste") return hit;
    return null;
  }

  /** Merge adjacent text runs, drop empties, snap the caret out of block interiors. */
  private normalize(): void {
    const merged: ComposerSegment[] = [];
    for (const segment of this.segments) {
      if (segment.kind === "text") {
        if (segment.text.length === 0) continue;
        const last = merged[merged.length - 1];
        if (last && last.kind === "text") {
          merged[merged.length - 1] = { kind: "text", text: last.text + segment.text };
        } else {
          merged.push(segment);
        }
      } else {
        merged.push(segment);
      }
    }
    this.segments = merged;

    const spans = this.spans();
    if (spans.length === 0) {
      this.cursor = 0;
      return;
    }
    const total = spans[spans.length - 1].end;
    let cursor = Math.max(0, Math.min(this.cursor, total));
    for (const span of spans) {
      if (this.segments[span.index].kind !== "paste") continue;
      if (cursor > span.start && cursor < span.end) {
        cursor = cursor - span.start <= span.end - cursor ? span.start : span.end;
      }
    }
    this.cursor = cursor;
  }
}
