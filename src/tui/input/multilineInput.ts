export class MultilineInputBuffer {
  private text: string;
  private cursor: number;

  constructor(initialText = "", initialCursor?: number) {
    this.text = initialText;
    this.cursor = initialCursor !== undefined ? initialCursor : initialText.length;
  }

  getText(): string {
    return this.text;
  }

  getCursor(): number {
    return this.cursor;
  }

  setText(newText: string, newCursor?: number): void {
    this.text = newText;
    this.cursor = newCursor !== undefined ? Math.min(newCursor, newText.length) : newText.length;
  }

  clear(): void {
    this.text = "";
    this.cursor = 0;
  }

  insertText(str: string): void {
    this.text = this.text.slice(0, this.cursor) + str + this.text.slice(this.cursor);
    this.cursor += str.length;
  }

  insertNewline(): void {
    this.insertText("\n");
  }

  deleteBackward(): boolean {
    if (this.cursor > 0) {
      this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
      this.cursor--;
      return true;
    }
    return false;
  }

  deleteForward(): boolean {
    if (this.cursor < this.text.length) {
      this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
      return true;
    }
    return false;
  }

  deleteWordBackward(): boolean {
    if (this.cursor <= 0) return false;
    const before = this.text.slice(0, this.cursor);
    const after = this.text.slice(this.cursor);
    const trimmed = before.replace(/\S+\s*$/, "");
    this.text = trimmed + after;
    this.cursor = trimmed.length;
    return true;
  }

  killToEndOfLine(): boolean {
    const newlineIdx = this.text.indexOf("\n", this.cursor);
    if (newlineIdx !== -1) {
      this.text = this.text.slice(0, this.cursor) + this.text.slice(newlineIdx);
    } else {
      this.text = this.text.slice(0, this.cursor);
    }
    return true;
  }

  clearLine(): void {
    this.text = "";
    this.cursor = 0;
  }

  moveLeft(): boolean {
    if (this.cursor > 0) {
      this.cursor--;
      return true;
    }
    return false;
  }

  moveRight(): boolean {
    if (this.cursor < this.text.length) {
      this.cursor++;
      return true;
    }
    return false;
  }

  moveToStartOfLine(): void {
    const lastNewline = this.text.lastIndexOf("\n", this.cursor - 1);
    this.cursor = lastNewline === -1 ? 0 : lastNewline + 1;
  }

  moveToEndOfLine(): void {
    const nextNewline = this.text.indexOf("\n", this.cursor);
    this.cursor = nextNewline === -1 ? this.text.length : nextNewline;
  }

  isMultiline(): boolean {
    return this.text.includes("\n");
  }

  isAtFirstLine(): boolean {
    const lastNewline = this.text.lastIndexOf("\n", this.cursor - 1);
    return lastNewline === -1;
  }

  isAtLastLine(): boolean {
    const nextNewline = this.text.indexOf("\n", this.cursor);
    return nextNewline === -1;
  }

  moveUp(): boolean {
    if (this.isAtFirstLine()) return false;
    const currentLineStart = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
    const colOffset = this.cursor - currentLineStart;
    const prevLineEnd = currentLineStart - 1;
    const prevLineStart = this.text.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const prevLineLen = prevLineEnd - prevLineStart;
    this.cursor = prevLineStart + Math.min(colOffset, prevLineLen);
    return true;
  }

  moveDown(): boolean {
    if (this.isAtLastLine()) return false;
    const currentLineStart = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
    const colOffset = this.cursor - currentLineStart;
    const nextLineStart = this.text.indexOf("\n", this.cursor) + 1;
    const nextLineEnd = this.text.indexOf("\n", nextLineStart);
    const nextLineLen = (nextLineEnd === -1 ? this.text.length : nextLineEnd) - nextLineStart;
    this.cursor = nextLineStart + Math.min(colOffset, nextLineLen);
    return true;
  }
}
