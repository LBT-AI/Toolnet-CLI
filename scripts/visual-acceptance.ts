/**
 * Task 6 — visual acceptance harness (no new test framework weight).
 *
 * Drives the REAL `buildFrame()` byte stream through a minimal VT row tracker
 * (same approach as viewportRender.integration.test.ts) at the three canonical
 * acceptance sizes, then checks the Task 6 invariants on the painted rows:
 *
 *   - no literal `**` / `***` / backticks in transcript prose
 *   - no `??` garbage (lone surrogates / non-UTF-8 rendering)
 *   - tables render as grids/cards bounded to the viewport, with a hint row
 *   - headings render without `#`, bullets without `-`/`*` markers leaks
 *   - ONE status system: delegated header badge + context status row
 *   - footer at the bottom row; composer divider above it (no shift)
 *
 * Run: bun scripts/visual-acceptance.ts   (exit 0 = all sizes PASS)
 */
import { buildFrame } from "../src/tui/app";
import { tuiState } from "../src/tui/state";
import { createChatViewport } from "../src/tui/viewport";
import { isUnicodeCapable } from "../src/term";
import { resetInputState } from "../src/tui/input/inputHandler";
import { messageQueue } from "../src/lib/messageQueue";
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
      if (frame[i + 1] !== "[") { i += 2; continue; }
      let j = i + 2;
      let params = "";
      while (j < frame.length && !(frame[j] >= "@" && frame[j] <= "~")) { params += frame[j]; j += 1; }
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
          row = 0; col = 0;
        }
      } else if (final === "K") {
        const p = params === "" ? 0 : parseInt(params, 10);
        if (p === 0) for (let c = col; c < cols; c++) grid[row][c] = " ";
      }
      i = j;
      continue;
    }
    if (ch === "\r") { col = 0; i += 1; continue; }
    if (ch === "\n") { if (row < rows - 1) row += 1; i += 1; continue; }
    const cp = frame.codePointAt(i)!;
    if (col < cols) grid[row][col] = String.fromCodePoint(cp);
    col += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return grid.map((r) => r.join("").replace(/\s+$/, ""));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

// ── Fixture transcript exercising every Task 6 concern at once ──
const REPORT_ROWS = Array.from({ length: 14 }, (_, i) => `| cmd${i} | info | run step ${i} |`).join("\n");
const TRANSCRIPT: Msg[] = [
  { role: "user", id: "u1", content: "Audit the commands and summarize" } as Msg,
  {
    role: "assistant",
    id: "a1",
    content: [
      "## Audit Result",
      "",
      "All **12 commands** verified and ***healthy*** — see `toolnet.json`.",
      "",
      "| COMMAND | TYPE | ARGUMENTS |",
      "| --- | --- | --- |",
      REPORT_ROWS,
      "",
      "---",
      "",
      "- **Exploring your codebase** — finding files",
      "- Finished: my_var_name intact, glob `*.ts` untouched",
      "",
      "```ts",
      "const answer = 42; // keyword-only highlight",
      "```",
      "Kết quả kiểm tra hoàn tất.",
    ].join("\n"),
  } as Msg,
];

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

interface Check { name: string; pass: boolean; detail?: string }

function auditScreen(painted: string[]): Check[] {
  const text = painted.join("\n");
  const visible = stripAnsi(text);
  const checks: Check[] = [];
  // 1. No raw emphasis markers or backticks anywhere on the painted screen.
  checks.push({ name: "no literal '**'", pass: !visible.includes("**") });
  checks.push({ name: "no literal '***'", pass: !visible.includes("***") });
  checks.push({ name: "no backticks in prose", pass: !visible.includes("`") });

  // 2. No replacement-character garbage.
  checks.push({ name: "no '?' garbage", pass: !visible.includes("??") && !visible.includes("\uFFFD") });

  // 3. Headings by weight, not '#' — the big fixture tail-pins and may scroll
  // the heading off-screen, so only assert when it is actually painted.
  checks.push({
    name: "heading painted without '#'",
    pass: !visible.includes("Audit") || (!visible.includes("#") && visible.includes("Audit Result")),
  });
  // Bullets: star/plus markers are normalized to the glyph bag ('- ' is the
  // designed hyphen marker, pinned by longRunningToolUx §11). In ASCII mode the
  // glyph bag itself transliterates • to '*' — the traditional ASCII bullet —
  // so accept that form there; '+' is never a legitimate marker in either mode.
  const unicode = isUnicodeCapable();
  const bulletLeak = unicode ? /^\s*[*+]\s/m : /^\s*\+\s/m;
  checks.push({ name: `no raw bullet leak (${unicode ? "unicode" : "ascii"})`, pass: !bulletLeak.test(visible) });

  // 4. Table reduced to cards/hint, bounded by the viewport width.
  const tableRows = painted.filter((l) => l.includes("cmd") && l.includes("info"));
  const hintRow = painted.find((l) => l.includes("Ctrl+O"));
  checks.push({
    name: "table summarized + Ctrl+O hint",
    pass: tableRows.length > 0 && tableRows.length < 14 && Boolean(hintRow),
    detail: `${tableRows.length} table rows painted`,
  });

  // 5. Content integrity: the transcript keeps the intro; the message tail
  // (Kết quả, my_var_name, …) lives in the Ctrl+O detail viewer under the
  // long-result policy.
  checks.push({
    name: "painted 'toolnet.json' (when intro visible)",
    pass: !visible.includes("All ") || visible.includes("toolnet.json"),
  });
  const detail = tuiState.lastDetailViewerTarget;
  checks.push({
    name: "message tail relocated to detail viewer",
    pass: Boolean(detail && detail.lines.join("\n").includes("Kết quả kiểm tra hoàn tất.") && detail.lines.join("\n").includes("my_var_name")),
  });

  // 6. Chrome: divider + prompt + exactly ONE footer/status line at the bottom
  // (footer rows are below the composer divider; hint rows above it don't
  // count).
  checks.push({ name: "prompt placeholder painted", pass: visible.includes("Enter a coding task") });
  const dividerRows = painted.filter((l) => l.replace(/─/g, "").trim() === "" && l.includes("─"));
  const lastDivider = painted.lastIndexOf(dividerRows[dividerRows.length - 1] ?? "");
  const footerish = painted.slice(lastDivider < 0 ? 0 : lastDivider).filter((l) => / · /.test(l));
  checks.push({ name: "exactly ONE footer line", pass: footerish.length === 1, detail: `${footerish.length} rows below divider` });
  // No permanent hint rows under the composer (shortcuts live in /help).
  checks.push({ name: "no permanent shortcut hints", pass: !/for history|for help|to change/.test(visible) });

  // 7. Color density: transcript prose is ivory + cool metadata, NOT an
  // orange/yellow syntax dump. Count warm SGR runs in painted rows.
  const warmRuns = (text.match(/\x1b\[38;2;255;159;90m/g) ?? []).length + (text.match(/\x1b\[38;2;245;185;66m/g) ?? []).length;
  const totalRuns = (text.match(/\x1b\[38;2;/g) ?? []).length;
  checks.push({
    name: "warm color density low",
    pass: warmRuns / Math.max(1, totalRuns) < 0.2,
    detail: `${warmRuns}/${totalRuns} warm SGR runs`,
  });
  // Inline code/path metadata must NOT carry the warm peach/yellow tone.
  checks.push({ name: "no peach/yellow on backtick rows", pass: !painted.some((l) => l.includes("toolnet.json") && /\x1b\[38;2;(255;159;90|245;185;66)m/.test(l)) });

  // 8. Long-result policy: the 14-row table fixture must be compacted to a
  // summary + Ctrl+O row, never a full transcript flood, and the full content
  // must be handed to the detail viewer.
  const summaryRow = painted.find((l) => l.includes("Ctrl+O"));
  checks.push({ name: "long result compacted + Ctrl+O", pass: Boolean(summaryRow) });
  checks.push({ name: "detail viewer target recorded", pass: Boolean(tuiState.lastDetailViewerTarget && tuiState.lastDetailViewerTarget.lines.length >= 15) });

  return checks;
}

const SIZES: Array<[number, number]> = [[52, 20], [80, 24], [120, 30]];
let failed = 0;

// Short fixture: heading + every bullet marker style, always fits on screen so
// the heading/bullet invariants are visually verified at every size.
const HEADING_FIXTURE: Msg[] = [
  { role: "assistant", id: "h1", content: "## Audit Result\n\n- **Exploring** — hyphen marker\n* star marker\n+ plus marker" } as Msg,
];

for (const [cols, rows] of SIZES) {
  resetForPaint();
  setSize(cols, rows);
  tuiState.replaceMessages(HEADING_FIXTURE);
  const painted = paint(buildFrame(), cols, rows);
  const visible = stripAnsi(painted.join("\n"));
  const unicode = isUnicodeCapable();
  const ok = visible.includes("Audit Result") && !visible.includes("#")
    && !(/^\s*\+\s/m.test(visible))
    && (unicode
      ? (visible.match(/•/g)?.length ?? 0) >= 2
      : /^\s*\*\s/m.test(visible)); // • transliterates to '*' in ASCII mode
  failed += ok ? 0 : 1;
  console.log(`\n=== heading/bullets ${cols}x${rows} — ${ok ? "PASS" : "FAIL"} ===`);
  if (!ok) painted.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}|${l}`));
}

for (const [cols, rows] of SIZES) {
  resetForPaint();
  setSize(cols, rows);
  tuiState.replaceMessages(TRANSCRIPT);
  const painted = paint(buildFrame(), cols, rows);
  const checks = auditScreen(painted);
  const sizeFailed = checks.filter((c) => !c.pass);
  failed += sizeFailed.length;

  console.log(`\n=== ${cols}x${rows} — ${sizeFailed.length === 0 ? "PASS" : "FAIL"} ===`);
  for (const c of checks) {
    console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  }
  if (sizeFailed.length > 0) {
    console.log("  --- painted rows ---");
    painted.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}|${l}`));
  }
}

// Streaming draft pass (52x20): partial markers must never flash.
resetForPaint();
setSize(52, 20);
tuiState.replaceMessages([{ role: "assistant", id: "draft", content: "**Exploring" } as Msg]);
tuiState.activeAssistantDraft = { id: "draft", runId: "run", turnId: 1, streaming: true };
const streamPainted = paint(buildFrame(), 52, 20);
const streamText = stripAnsi(streamPainted.join("\n"));
const streamOk = !streamText.includes("**");
console.log(`\n=== streaming partial-marker suppression (52x20) — ${streamOk ? "PASS" : "FAIL"} ===`);
if (!streamOk) {
  streamPainted.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}|${l}`));
  failed += 1;
}

console.log(`\n${failed === 0 ? "ALL SIZES PASS" : `${failed} check(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
