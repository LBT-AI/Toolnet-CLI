/**
 * PHASE 7 — terminal + text matrix (deterministic, no provider/network).
 *
 * Renders the REAL `buildFrame()` and the REAL renderers at the three canonical
 * acceptance sizes (52x20, 80x24, 120x30) and checks the text-integrity
 * invariants that Phase 1–6 hardened:
 *
 *   - Vietnamese UTF-8 survives the renderer and the input pipeline
 *   - emoji / wide (CJK) glyphs are never mangled into `?` / U+FFFD / lone
 *     surrogates, and never overflow the chat column
 *   - a long multi-line paste collapses to an atomic composer token that stays
 *     inside the terminal width
 *   - the composer caret stays inside the viewport for very long lines
 *   - mobile IME (Vietnamese) round-trips through the REAL key decoder at both
 *     byte-fragmented and burst frame boundaries
 *   - chrome invariants: one footer line, composer visible, no literal markdown
 *     markers leaking into prose
 *
 * Run: bun scripts/phase7-terminal-matrix.ts   (exit 0 = all sizes PASS)
 */
import { buildFrame } from "../src/tui/app";
import { tuiState } from "../src/tui/state";
import { createChatViewport } from "../src/tui/viewport";
import { resetInputState, handleKey, handlePaste } from "../src/tui/input/inputHandler";
import { TerminalKeyDecoder, decodedKeyBytes } from "../src/tui/input/keyDecoder";
import { renderChatMessages } from "../src/tui/renderers/chatRenderer";
import { stripAnsi, visibleWidth, computeLayoutGeometry } from "../src/tui/layout";
import { messageQueue } from "../src/lib/messageQueue";
import { A } from "../src/term";
import type { Msg } from "../src/tui/types";

// ── Minimal VT row tracker (kept in sync with viewportRender.integration) ──
function paint(frame: string, cols: number, rows: number): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => new Array(cols).fill(" "));
  let row = 0;
  let col = 0;
  let i = 0;
  while (i < frame.length) {
    const ch = frame[i];
    if (ch === "\x1b") {
      if (frame[i + 1] !== "[") {
        i += 2;
        continue;
      }
      let j = i + 2;
      let params = "";
      while (j < frame.length && !(frame[j] >= "@" && frame[j] <= "~")) {
        params += frame[j];
        j += 1;
      }
      const final = frame[j];
      j += 1;
      if (final === "H") {
        const [rr, cc] = params.split(";");
        const r = rr ? parseInt(rr, 10) : 1;
        const c = cc ? parseInt(cc, 10) : 1;
        row = Math.max(0, Math.min(rows - 1, r - 1));
        col = Math.max(0, Math.min(cols - 1, c - 1));
      } else if (final === "J") {
        const p = params === "" ? 0 : parseInt(params, 10);
        if (p === 0) {
          for (let c = col; c < cols; c++) grid[row][c] = " ";
          for (let r = row + 1; r < rows; r++) grid[r] = new Array(cols).fill(" ");
        } else if (p === 2 || p === 3) {
          for (let r = 0; r < rows; r++) grid[r] = new Array(cols).fill(" ");
          row = 0;
          col = 0;
        }
      } else if (final === "K") {
        const p = params === "" ? 0 : parseInt(params, 10);
        if (p === 0) for (let c = col; c < cols; c++) grid[row][c] = " ";
      }
      i = j;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      if (row < rows - 1) row += 1;
      i += 1;
      continue;
    }
    const cp = frame.codePointAt(i)!;
    if (col < cols) grid[row][col] = String.fromCodePoint(cp);
    col += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return grid.map((r) => r.join("").replace(/\s+$/, ""));
}

function resetForPaint(): void {
  resetInputState();
  tuiState.clearMessages();
  tuiState.chatViewport = createChatViewport();
  tuiState.activeAssistantDraft = null;
  tuiState.activeToolActivity = null;
  tuiState.activeReasoningDraft = null;
  tuiState.isStreaming = false;
  tuiState.statusText = "";
  tuiState.elapsedDisplay = "";
  tuiState.spinnerIdx = 0;
  tuiState.inputBuffer = "";
  tuiState.cursorPos = 0;
  tuiState.lastTableViewerTarget = null;
  messageQueue.clear();
}

function setSize(cols: number, rows: number): void {
  (process.stdout as any).columns = cols;
  (process.stdout as any).rows = rows;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Drive a UTF-8 string through the REAL decoder in `chunkSize`-byte chunks. */
function typeThroughPipeline(str: string, chunkSize: number): string {
  resetInputState();
  const decoder = new TerminalKeyDecoder();
  const bytes = Buffer.from(str, "utf8");
  let now = 0;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    now += 5;
    for (const key of decoder.feed(bytes.subarray(i, i + chunkSize), now)) {
      handleKey(decodedKeyBytes(key), { renderAll: () => {} });
    }
  }
  for (const key of decoder.flush()) handleKey(decodedKeyBytes(key), { renderAll: () => {} });
  return tuiState.inputBuffer;
}

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const VI_TRANSCRIPT: Msg[] = [
  { role: "user", id: "u-vi", content: "Kiểm tra cấu hình rồi sửa lỗi đường dẫn." } as Msg,
  {
    role: "assistant",
    id: "a-vi",
    content: [
      "## Kết quả kiểm tra",
      "",
      "Tôi đã kiểm tra xong — người dùng có thể chỉnh sửa trực tiếp.",
      "",
      "- Đường dẫn cấu hình đã được sửa",
      "- Kiểm tra tiếng Việt: đường, người, chỉnh sửa, tôi đang làm việc",
    ].join("\n"),
  } as Msg,
];

const EMOJI_MSGS: Msg[] = [
  { role: "user", id: "u-emoji", content: "Kiểm tra trạng thái ✅" } as Msg,
  {
    role: "assistant",
    id: "a-emoji",
    content: "Đã hoàn tất ✅ 🚀 — kiểm tra bảng 📊 中文测试 😀 và tiếp tục.",
  } as Msg,
];

const LONG_PASTE = Array.from({ length: 40 }, (_, i) => `dòng ${i}: đường dẫn rất dài cần kiểm tra 😀`).join("\n");

function runSize(cols: number, rows: number): Check[] {
  const checks: Check[] = [];
  const layout = computeLayoutGeometry(cols, rows, 0, 2, 0, false, 1, "");
  const chatCols = layout.chatCols;

  // ── 1. Vietnamese transcript through the real frame ──────────────────────
  resetForPaint();
  setSize(cols, rows);
  tuiState.replaceMessages(VI_TRANSCRIPT);
  const painted = paint(buildFrame(), cols, rows);
  const visible = stripAnsi(painted.join("\n"));
  checks.push({ name: "Vietnamese heading painted without '#'", pass: visible.includes("Kết quả kiểm tra") && !visible.includes("#") });
  // Distinctive Vietnamese tokens survive line-wrapping at every width…
  const viTokens = ["người", "chỉnh sửa", "Đường dẫn", "kiểm tra"];
  checks.push({
    name: "Vietnamese tokens intact in painted frame",
    pass: viTokens.every((t) => visible.includes(t)),
    detail: viTokens.filter((t) => !visible.includes(t)).join(", ") || undefined,
  });
  // …and the renderer reconstructs the FULL sentence when wrapped lines are
  // re-joined (proves wrapping, not truncation).
  const rejoined = renderChatMessages(VI_TRANSCRIPT, chatCols, A.fgCyan)
    .map((l) => stripAnsi(l))
    .join(" ")
    .replace(/\s+/g, " ");
  checks.push({
    name: "full Vietnamese sentence reconstructs after wrap",
    pass: rejoined.includes("người dùng có thể chỉnh sửa trực tiếp") && rejoined.includes("Đường dẫn cấu hình đã được sửa"),
  });
  checks.push({ name: "no '??' / U+FFFD garbage", pass: !visible.includes("??") && !visible.includes("\uFFFD") });
  checks.push({ name: "no lone surrogate", pass: !LONE_SURROGATE.test(visible) });
  checks.push({ name: "no literal markdown markers", pass: !visible.includes("**") && !visible.includes("`") });
  checks.push({ name: "composer prompt painted", pass: visible.includes("Enter a coding task") });

  // ── 2. Emoji / wide glyphs bounded to the chat column ────────────────────
  resetForPaint();
  setSize(cols, rows);
  const emojiLines = renderChatMessages(EMOJI_MSGS, chatCols, A.fgCyan).map((l) => stripAnsi(l));
  const emojiText = emojiLines.join("\n");
  const emojiOverflow = emojiLines.filter((l) => visibleWidth(l) > chatCols);
  checks.push({
    name: "emoji/CJK within chat width",
    pass: emojiOverflow.length === 0,
    detail: `${emojiOverflow.length} overflow line(s)`,
  });
  checks.push({ name: "emoji preserved (not '?')", pass: emojiText.includes("✅") && emojiText.includes("🚀") && emojiText.includes("😀") && emojiText.includes("中文测试") });
  checks.push({ name: "emoji text has no replacement char", pass: !emojiText.includes("\uFFFD") && !LONE_SURROGATE.test(emojiText) });

  // ── 3. Long multi-line paste collapses to an atomic token ────────────────
  resetForPaint();
  setSize(cols, rows);
  handlePaste(LONG_PASTE, { renderAll: () => {} });
  const collapsed = tuiState.inputBuffer;
  checks.push({
    name: "long paste collapsed to a token",
    pass: /lines pasted #\d+/.test(collapsed),
    detail: collapsed.slice(0, 40),
  });
  const pastePainted = paint(buildFrame(), cols, rows);
  const pasteRow = pastePainted.find((l) => l.includes("lines pasted"));
  checks.push({
    name: "collapsed paste within terminal width",
    pass: Boolean(pasteRow) && visibleWidth(stripAnsi(pasteRow!)) <= cols,
  });

  // ── 4. IME round-trip (real decoder) + long-line caret geometry ──────────
  const fragmented = typeThroughPipeline("bạn ơi", 1);
  const burst = typeThroughPipeline("tiếng Việt đường", 4096);
  checks.push({ name: "IME fragmented (1-byte) Vietnamese round-trip", pass: fragmented === "bạn ơi", detail: JSON.stringify(fragmented) });
  checks.push({ name: "IME burst Vietnamese round-trip", pass: burst === "tiếng Việt đường", detail: JSON.stringify(burst) });

  const long = "đường ".repeat(40);
  const caret = computeLayoutGeometry(cols, rows, 0, 2, long.length, false, 1, long);
  checks.push({
    name: "long-line caret stays inside viewport",
    pass: caret.cursorCol >= 0 && caret.cursorCol < cols && caret.cursorRow >= 0 && caret.cursorRow < rows,
  });

  return checks;
}

const SIZES: Array<[number, number]> = [
  [52, 20],
  [80, 24],
  [120, 30],
];

let failed = 0;
for (const [cols, rows] of SIZES) {
  const checks = runSize(cols, rows);
  const bad = checks.filter((c) => !c.pass);
  failed += bad.length;
  console.log(`\n=== ${cols}x${rows} — ${bad.length === 0 ? "PASS" : "FAIL"} ===`);
  for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
}

console.log(`\n${failed === 0 ? "ALL SIZES PASS" : `${failed} check(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
