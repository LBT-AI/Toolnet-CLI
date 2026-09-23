/**
 * Collapsed-paste composer regression.
 *
 * A long paste must be ONE atomic token in the composer (`[365 lines pasted #1]`)
 * while the model still receives every line. These tests pin the data model
 * (text runs + pasted blocks), atomic editing, serialization, draft cleanup,
 * transcript compaction and the 52x20 mobile render.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ComposerDocument,
  PASTE_COLLAPSE_MIN_CHARS,
  PASTE_COLLAPSE_MIN_LINES,
  countLines,
  pastePlaceholder,
  shouldCollapsePaste,
} from "../input/composerDocument";
import { MultilineInputBuffer } from "../input/multilineInput";
import {
  handleKey,
  handlePaste,
  getInputState,
  setInputState,
  resetInputState,
} from "../input/inputHandler";
import { renderInputArea } from "../renderers/statusRenderer";
import {
  renderChatMessages,
  renderChatMessagesWithMetadata,
  shouldCollapseTranscriptMessage,
} from "../renderers/chatRenderer";
import { computeLayoutGeometry, COMPOSER_MAX_BUFFER_LINES, stripAnsi } from "../layout";
import { tuiState } from "../state";

const ARROW_LEFT = Buffer.from("\u001b[D", "latin1");
const ARROW_RIGHT = Buffer.from("\u001b[C", "latin1");
const BACKSPACE = Buffer.from("\u007f", "latin1");
const DELETE = Buffer.from("\u001b[3~", "latin1");
const ENTER = Buffer.from("\r", "latin1");
const CTRL_U = Buffer.from("\u0015", "latin1");

function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

describe("paste collapse thresholds", () => {
  test("small multi-line paste stays inline", () => {
    expect(shouldCollapsePaste(2, 30)).toBe(false);
    const buffer = new MultilineInputBuffer();
    const result = buffer.insertPaste("a\nb");
    expect(result.collapsed).toBe(false);
    expect(buffer.getText()).toBe("a\nb");
    expect(buffer.getContent()).toBe("a\nb");
  });

  test("line threshold collapses a multi-line paste", () => {
    expect(PASTE_COLLAPSE_MIN_LINES).toBeGreaterThan(1);
    expect(shouldCollapsePaste(PASTE_COLLAPSE_MIN_LINES, 10)).toBe(true);
  });

  test("a single very long line collapses by character threshold", () => {
    const long = "x".repeat(PASTE_COLLAPSE_MIN_CHARS);
    expect(shouldCollapsePaste(1, long.length)).toBe(true);
    const buffer = new MultilineInputBuffer();
    buffer.insertPaste(long);
    expect(buffer.getText()).toBe("[1 line pasted #1]");
    expect(buffer.getContent()).toBe(long);
  });
});

describe("ComposerDocument — segmented draft", () => {
  test("collapses a 365-line paste into one token with the right count", () => {
    const doc = new ComposerDocument();
    const content = lines(365);
    const result = doc.insertPaste(content);

    expect(result.collapsed).toBe(true);
    expect(countLines(content)).toBe(365);
    expect(doc.getText()).toBe("[365 lines pasted #1]");
    expect(doc.getText().length).toBeLessThan(40);
    // Full content is preserved verbatim for submission.
    expect(doc.getContent()).toBe(content);
  });

  test("token ids are stable across re-reads (no reset on rerender)", () => {
    const doc = new ComposerDocument();
    doc.insertPaste(lines(10));
    const first = doc.getText();
    const firstId = doc.getPasteBlocks()[0].id;
    // Rendering repeatedly must not mutate identity.
    for (let i = 0; i < 5; i++) expect(doc.getText()).toBe(first);
    expect(doc.getPasteBlocks()[0].id).toBe(firstId);
    expect(firstId).toBe(1);
  });

  test("typed text + paste + typed text serializes in order", () => {
    const doc = new ComposerDocument();
    doc.insertText("hãy kiểm tra:\n");
    doc.insertPaste(lines(365));
    doc.insertText("\nrồi sửa lỗi");

    expect(doc.getText()).toBe("hãy kiểm tra:\n[365 lines pasted #1]\nrồi sửa lỗi");
    expect(doc.getContent()).toBe(`hãy kiểm tra:\n${lines(365)}\nrồi sửa lỗi`);
  });

  test("multiple blocks keep independent content and increasing ids", () => {
    const doc = new ComposerDocument();
    doc.insertPaste(lines(120, "a"));
    doc.insertText(" abc ");
    doc.insertPaste(lines(200, "b"));

    expect(doc.getText()).toBe("[120 lines pasted #1] abc [200 lines pasted #2]");
    const blocks = doc.getPasteBlocks();
    expect(blocks.map((b) => b.id)).toEqual([1, 2]);
    expect(blocks.map((b) => b.lineCount)).toEqual([120, 200]);
    expect(blocks[0].content).toBe(lines(120, "a"));
    expect(blocks[1].content).toBe(lines(200, "b"));

    const serialized = doc.getContent();
    expect(serialized).toBe(`${lines(120, "a")} abc ${lines(200, "b")}`);
    expect(serialized).not.toContain("pasted #");
  });

  test("Backspace right after a token deletes the whole block in one press", () => {
    const doc = new ComposerDocument();
    doc.insertText("hello ");
    doc.insertPaste(lines(365));
    expect(doc.getText()).toBe("hello [365 lines pasted #1]");

    expect(doc.deleteBackward()).toBe(true);
    expect(doc.getText()).toBe("hello ");
    expect(doc.getContent()).toBe("hello ");
    expect(doc.getPasteBlocks()).toHaveLength(0);
  });

  test("Delete in front of a token deletes the whole block", () => {
    const doc = new ComposerDocument();
    doc.insertPaste(lines(365));
    doc.insertText("tail");
    doc.moveLeft();
    doc.moveLeft();
    doc.moveLeft();
    doc.moveLeft();
    // Caret now sits right before "tail" — move to the block boundary.
    doc.moveToStartOfLine();
    expect(doc.deleteForward()).toBe(true);
    expect(doc.getText()).toBe("tail");
    expect(doc.getContent()).toBe("tail");
  });

  test("Left/Right treat a block as one logical unit", () => {
    const doc = new ComposerDocument();
    doc.insertText("ab");
    doc.insertPaste(lines(20));
    doc.insertText("cd");
    expect(doc.getText()).toBe("ab[20 lines pasted #1]cd");

    const tokenLen = pastePlaceholder({ id: 1, lineCount: 20 }).length;
    const afterBlock = 2 + tokenLen;

    // Caret at the end steps through "cd", stops just after the block, then
    // one more Left jumps over the ENTIRE token.
    doc.moveToEndOfLine();
    expect(doc.getCursor()).toBe(afterBlock + 2);
    doc.moveLeft();
    expect(doc.getCursor()).toBe(afterBlock + 1);
    doc.moveLeft();
    expect(doc.getCursor()).toBe(afterBlock);
    doc.moveLeft();
    expect(doc.getCursor()).toBe(2);
    doc.moveRight();
    expect(doc.getCursor()).toBe(afterBlock);

    // From just after the block, Left lands at the block start.
    const doc2 = new ComposerDocument();
    doc2.insertText("ab");
    doc2.insertPaste(lines(20));
    expect(doc2.getCursor()).toBe(afterBlock);
    doc2.moveLeft();
    expect(doc2.getCursor()).toBe(2);

    // Right from the block start jumps to just after the block.
    doc2.moveRight();
    expect(doc2.getCursor()).toBe(afterBlock);
  });

  test("deleting block #2 leaves block #1 intact", () => {
    const doc = new ComposerDocument();
    doc.insertPaste(lines(100, "a"));
    doc.insertText(" abc ");
    doc.insertPaste(lines(200, "b"));
    // Caret is after #2 → one Backspace removes #2 only.
    doc.deleteBackward();
    expect(doc.getText()).toBe("[100 lines pasted #1] abc ");
    const blocks = doc.getPasteBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe(lines(100, "a"));
  });

  test("clear releases all block state and resets ids for the next draft", () => {
    const doc = new ComposerDocument();
    doc.insertPaste(lines(100));
    doc.insertPaste(lines(200));
    expect(doc.getPasteBlocks()).toHaveLength(2);

    doc.clear();
    expect(doc.getText()).toBe("");
    expect(doc.getContent()).toBe("");
    expect(doc.getPasteBlocks()).toHaveLength(0);

    doc.insertPaste(lines(50));
    expect(doc.getText()).toBe("[50 lines pasted #1]");
  });

  test("whitespace and newlines are preserved exactly", () => {
    const content = "  indented\n\tTAB\n\n\ntrailing   \n";
    const doc = new ComposerDocument();
    doc.insertPaste(content);
    expect(doc.getContent()).toBe(content);
  });
});

describe("composer — input handler integration", () => {
  let sent: string[];

  beforeEach(() => {
    resetInputState();
    sent = [];
    tuiState.appState = "ready";
    tuiState.isStreaming = false;
    tuiState.promptHistory = [];
    tuiState.historyIndex = -1;
  });

  afterEach(() => {
    tuiState.appState = "boot";
    resetInputState();
  });

  const callbacks = () => ({
    renderAll: () => {},
    sendMessage: (text: string) => sent.push(text),
    exitApp: () => {},
    openModelPicker: async () => {},
  });

  test("a large paste shows a token but submits the full original content", () => {
    const content = lines(365);
    handlePaste(content, callbacks());

    expect(getInputState().buffer).toBe("[365 lines pasted #1]");

    handleKey(ENTER, callbacks());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(content);
    expect(sent[0]).not.toContain("lines pasted");
    // Draft is clean after submit — no blocks leak into the next message.
    expect(getInputState().buffer).toBe("");
  });

  test("typed text around a paste is submitted in order", () => {
    const content = lines(20);
    handleKey(Buffer.from("Fix: "), callbacks());
    handlePaste(content, callbacks());
    handleKey(Buffer.from(" then test"), callbacks());
    expect(getInputState().buffer).toBe("Fix: [20 lines pasted #1] then test");

    handleKey(ENTER, callbacks());
    expect(sent[0]).toBe(`Fix: ${content} then test`);
  });

  test("two pastes in one message keep separate content", () => {
    handlePaste(lines(100, "first"), callbacks());
    handleKey(Buffer.from(" middle "), callbacks());
    handlePaste(lines(150, "second"), callbacks());
    expect(getInputState().buffer).toBe("[100 lines pasted #1] middle [150 lines pasted #2]");

    handleKey(ENTER, callbacks());
    expect(sent[0]).toBe(`${lines(100, "first")} middle ${lines(150, "second")}`);
  });

  test("Backspace removes a pasted token atomically through the handler", () => {
    handlePaste(lines(365), callbacks());
    expect(getInputState().buffer).toBe("[365 lines pasted #1]");

    handleKey(BACKSPACE, callbacks());
    expect(getInputState().buffer).toBe("");

    handleKey(ENTER, callbacks());
    expect(sent).toHaveLength(0); // nothing left to submit
  });

  test("Delete removes a pasted token atomically through the handler", () => {
    handleKey(Buffer.from("ab"), callbacks());
    handlePaste(lines(365), callbacks());
    handleKey(ARROW_LEFT, callbacks()); // jump over the block
    expect(getInputState().cursor).toBe(2);
    handleKey(DELETE, callbacks());
    expect(getInputState().buffer).toBe("ab");
  });

  test("Ctrl+U clears the draft and releases the block", () => {
    handlePaste(lines(365), callbacks());
    handleKey(CTRL_U, callbacks());
    expect(getInputState().buffer).toBe("");
    handleKey(ENTER, callbacks());
    expect(sent).toHaveLength(0);
  });

  test("a small paste is not collapsed and still submits verbatim", () => {
    const content = "line 1\nline 2";
    handlePaste(content, callbacks());
    expect(getInputState().buffer).toBe(content);
    handleKey(ENTER, callbacks());
    expect(sent[0]).toBe(content);
  });

  test("prompt history keeps the full original content, not the token", () => {
    const content = lines(30);
    handlePaste(content, callbacks());
    handleKey(ENTER, callbacks());
    expect(tuiState.promptHistory[tuiState.promptHistory.length - 1]).toBe(content);
  });
});

describe("composer — mobile 52x20 render", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.appState = "ready";
  });

  afterEach(() => {
    tuiState.appState = "boot";
    resetInputState();
  });

  test("365-line paste occupies one composer row, never hundreds", () => {
    handlePaste(lines(365), { renderAll: () => {} });

    const buffer = getInputState().buffer;
    expect(buffer).toBe("[365 lines pasted #1]");
    expect(buffer.split("\n")).toHaveLength(1);

    const area = stripAnsi(renderInputArea(52, buffer, "\u001b[36m"));
    const rows = area.split("\r\n").filter((row) => row.trim().length > 0);
    // divider + the single token line
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(area).toContain("[365 lines pasted #1]");

    const layout = computeLayoutGeometry(52, 20, 0, 2, getInputState().cursor, false, 1, buffer);
    expect(layout.inputRows).toBeLessThanOrEqual(COMPOSER_MAX_BUFFER_LINES + 1);
    expect(layout.cursorRow).toBeLessThan(layout.footerRow);
  });

  test("a long token wraps as one logical unit instead of exploding the layout", () => {
    handlePaste(lines(100000), { renderAll: () => {} });
    const buffer = getInputState().buffer;
    expect(buffer).toBe("[100000 lines pasted #1]");
    const area = stripAnsi(renderInputArea(52, buffer, "\u001b[36m"));
    expect(area.split("\r\n").filter((row) => row.trim().length > 0).length).toBeLessThanOrEqual(2);
  });
});

describe("transcript — collapsed user message, full content retained", () => {
  test("a long user prompt renders compact but keeps its content in state", () => {
    const content = lines(365);
    expect(shouldCollapseTranscriptMessage(content)).toBe(true);

    const messages = [{ role: "user", content }];
    const rendered = renderChatMessages(messages as any, 80, "\u001b[36m");
    const text = stripAnsi(rendered.join("\n"));
    expect(text).toContain("[365 lines pasted]");
    expect(text).not.toContain("line 300");
    // The stored message is untouched — the model still gets every line.
    expect(messages[0].content).toBe(content);

    const withMeta = renderChatMessagesWithMetadata(messages as any, 80, "\u001b[36m");
    expect(withMeta.lines.length).toBeLessThan(6);
    expect(withMeta.lines.map(stripAnsi).join("\n")).toContain("line 1");
  });

  test("ordinary messages are never collapsed", () => {
    expect(shouldCollapseTranscriptMessage("hello there")).toBe(false);
    const rendered = renderChatMessages([{ role: "user", content: "hello there" }] as any, 80, "\u001b[36m");
    expect(stripAnsi(rendered.join("\n"))).toContain("hello there");
  });
});
