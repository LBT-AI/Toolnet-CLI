/**
 * Bracketed Paste Mode constants and parser for ANSI terminals.
 * Enables terminals to send \x1b[200~ <pasted text> \x1b[201~ when pasting text.
 */

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

export interface PasteChunk {
  type: "text" | "paste";
  content: string;
}

export class BracketedPasteParser {
  private inPaste = false;
  private buffer = "";

  /**
   * Resets internal parser state.
   */
  public reset(): void {
    this.inPaste = false;
    this.buffer = "";
  }

  /**
   * Returns whether the parser is currently inside a paste block.
   */
  public isPasting(): boolean {
    return this.inPaste;
  }

  /**
   * Parse incoming input (Buffer or string) into chunks of plain text and pasted text.
   * Handles bracketed paste sequences (\x1b[200~ ... \x1b[201~) across chunk boundaries.
   */
  public parse(input: Buffer | string): PasteChunk[] {
    const str = typeof input === "string" ? input : input.toString("utf8");
    this.buffer += str;
    const results: PasteChunk[] = [];

    while (this.buffer.length > 0) {
      if (!this.inPaste) {
        const startIdx = this.buffer.indexOf(BRACKETED_PASTE_START);
        if (startIdx === -1) {
          // Check for partial BRACKETED_PASTE_START at the end of buffer
          let partialLen = 0;
          for (let len = BRACKETED_PASTE_START.length - 1; len >= 1; len--) {
            const prefix = BRACKETED_PASTE_START.slice(0, len);
            if (this.buffer.endsWith(prefix)) {
              partialLen = len;
              break;
            }
          }

          if (partialLen > 0) {
            const textContent = this.buffer.slice(0, this.buffer.length - partialLen);
            if (textContent.length > 0) {
              results.push({ type: "text", content: textContent });
            }
            this.buffer = this.buffer.slice(this.buffer.length - partialLen);
          } else {
            results.push({ type: "text", content: this.buffer });
            this.buffer = "";
          }
          break;
        } else {
          if (startIdx > 0) {
            results.push({ type: "text", content: this.buffer.slice(0, startIdx) });
          }
          this.buffer = this.buffer.slice(startIdx + BRACKETED_PASTE_START.length);
          this.inPaste = true;
        }
      } else {
        const endIdx = this.buffer.indexOf(BRACKETED_PASTE_END);
        if (endIdx === -1) {
          // Check for partial BRACKETED_PASTE_END at the end of buffer
          let partialLen = 0;
          for (let len = BRACKETED_PASTE_END.length - 1; len >= 1; len--) {
            const prefix = BRACKETED_PASTE_END.slice(0, len);
            if (this.buffer.endsWith(prefix)) {
              partialLen = len;
              break;
            }
          }

          if (partialLen > 0) {
            const pasteContent = this.buffer.slice(0, this.buffer.length - partialLen);
            if (pasteContent.length > 0) {
              results.push({ type: "paste", content: pasteContent });
            }
            this.buffer = this.buffer.slice(this.buffer.length - partialLen);
          } else {
            if (this.buffer.length > 0) {
              results.push({ type: "paste", content: this.buffer });
              this.buffer = "";
            }
          }
          break;
        } else {
          const pasteContent = this.buffer.slice(0, endIdx);
          if (pasteContent.length > 0) {
            results.push({ type: "paste", content: pasteContent });
          }
          this.buffer = this.buffer.slice(endIdx + BRACKETED_PASTE_END.length);
          this.inPaste = false;
        }
      }
    }

    return results;
  }
}

/**
 * Pure helper function to parse a single string or Buffer for bracketed paste sequences.
 */
export function parseBracketedPaste(input: Buffer | string): PasteChunk[] {
  const parser = new BracketedPasteParser();
  return parser.parse(input);
}

/**
 * Helper function to strip bracketed paste escape tags from a string.
 */
export function stripBracketedPaste(input: string): string {
  return input
    .replaceAll(BRACKETED_PASTE_START, "")
    .replaceAll(BRACKETED_PASTE_END, "");
}
