import {
  ComposerDocument,
  type ComposerSegment,
  type ComposerDraftSnapshot,
  type InsertPasteResult,
  type PastedBlock,
} from "./composerDocument";

/**
 * Composer edit buffer.
 *
 * Thin, stable facade over `ComposerDocument`: the document owns the segmented
 * draft (text runs + atomic collapsed paste blocks) and this class keeps the
 * long-standing API the input handler, layout and renderers already depend on.
 *
 * `getText()` is the DISPLAY string (paste tokens included) — that is what the
 * renderer draws. `getContent()` is what submit must send. Only a real paste
 * event creates a block, so typed multi-line text is never re-classified.
 */
export class MultilineInputBuffer {
  private readonly doc: ComposerDocument;

  constructor(initialText = "", initialCursor?: number) {
    this.doc = new ComposerDocument(initialText, initialCursor);
  }

  /** The display string (collapsed paste blocks render as short tokens). */
  getText(): string {
    return this.doc.getText();
  }

  /** The full text submit must send — real paste content, never a token. */
  getContent(): string {
    return this.doc.getContent();
  }

  getCursor(): number {
    return this.doc.getCursor();
  }

  /** Segmented view of the draft (text runs + collapsed paste blocks). */
  getSegments(): readonly ComposerSegment[] {
    return this.doc.getSegments();
  }

  /** Collapsed pastes currently held by this draft. */
  getPasteBlocks(): PastedBlock[] {
    return this.doc.getPasteBlocks();
  }

  hasCollapsedPaste(): boolean {
    return this.doc.hasCollapsedPaste();
  }

  setText(newText: string, newCursor?: number): void {
    this.doc.setText(newText, newCursor);
  }

  /** Clear the draft AND release every collapsed paste block it held. */
  clear(): void {
    this.doc.clear();
  }

  /** Park/restore the whole draft so paste blocks survive history navigation. */
  snapshot(): ComposerDraftSnapshot {
    return this.doc.snapshot();
  }

  restore(snapshot: ComposerDraftSnapshot): void {
    this.doc.restore(snapshot);
  }

  insertText(str: string): void {
    this.doc.insertText(str);
  }

  /** Insert a paste; large pastes collapse into one atomic block. */
  insertPaste(content: string): InsertPasteResult {
    return this.doc.insertPaste(content);
  }

  insertNewline(): void {
    this.doc.insertNewline();
  }

  deleteBackward(): boolean {
    return this.doc.deleteBackward();
  }

  deleteForward(): boolean {
    return this.doc.deleteForward();
  }

  deleteWordBackward(): boolean {
    return this.doc.deleteWordBackward();
  }

  killToEndOfLine(): boolean {
    return this.doc.killToEndOfLine();
  }

  clearLine(): void {
    this.doc.clearLine();
  }

  moveLeft(): boolean {
    return this.doc.moveLeft();
  }

  moveRight(): boolean {
    return this.doc.moveRight();
  }

  moveToStartOfLine(): void {
    this.doc.moveToStartOfLine();
  }

  moveToEndOfLine(): void {
    this.doc.moveToEndOfLine();
  }

  isMultiline(): boolean {
    return this.doc.isMultiline();
  }

  isAtFirstLine(): boolean {
    return this.doc.isAtFirstLine();
  }

  isAtLastLine(): boolean {
    return this.doc.isAtLastLine();
  }

  moveUp(): boolean {
    return this.doc.moveUp();
  }

  moveDown(): boolean {
    return this.doc.moveDown();
  }
}
