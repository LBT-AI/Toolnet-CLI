import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { stripAnsi, toWellFormed, transliterateGlyphs } from "../../lib/text";
import { setUnicodeCapable } from "../../term";
import { tuiState } from "../../tui/state";
import {
  formatInlineMarkdown,
  renderMarkdownDivider,
  friendlyToolSummary,
  renderChatMessages,
} from "../../tui/renderers/chatRenderer";
import { renderInputArea } from "../../tui/renderers/statusRenderer";
import {
  renderInlineMarkdown,
  parseHeading,
  renderHeading,
  isHorizontalRule,
  parseBullet,
  normalizeBulletMarker,
  stripTrailingMarker,
  parseMarkdownTable,
  scanMarkdownTables,
  renderResponsiveTable,
  tableNaturalWidth,
  tableToLines,
} from "../markdown";
import type { Msg } from "../../tui/types";

describe("canonical markdown renderer (Task 6)", () => {
  beforeEach(() => setUnicodeCapable(true));
  afterEach(() => setUnicodeCapable(null));

  describe("inline markers", () => {
    test("bold `**text**` renders bold without literal asterisks", () => {
      const out = renderInlineMarkdown("**Kết quả:**");
      expect(out).not.toContain("**");
      expect(stripAnsi(out)).toBe("Kết quả:");
    });

    test("bold+italic `***text***` renders emphasis, never three markers", () => {
      const out = renderInlineMarkdown("***vpsoci***");
      expect(out).not.toContain("***");
      expect(out).not.toContain("**");
      expect(stripAnsi(out)).toBe("vpsoci");
    });

    test("italic `*text*` and `_text_` render emphasis without markers", () => {
      expect(stripAnsi(renderInlineMarkdown("*done*"))).toBe("done");
      expect(renderInlineMarkdown("*done*")).not.toContain("*");
      expect(stripAnsi(renderInlineMarkdown("_done_"))).toBe("done");
      expect(renderInlineMarkdown("_done_")).not.toContain("_");
    });

    test("intraword underscores are identifiers, never emphasis", () => {
      const out = renderInlineMarkdown("read my_var_name and snake_case_id please");
      expect(stripAnsi(out)).toBe("read my_var_name and snake_case_id please");
      expect(out).not.toContain("myvar");
    });

    test("inline code renders the span without backticks", () => {
      const out = renderInlineMarkdown("run `SessionStore` now");
      expect(out).not.toContain("`");
      expect(stripAnsi(out)).toBe("run SessionStore now");
    });

    test("escaped markers stay literal", () => {
      expect(stripAnsi(renderInlineMarkdown("\\*\\*literal\\*\\*"))).toBe("**literal**");
    });

    test("globs, shell, math and regex are never mangled", () => {
      const cases = [
        "build *.ts files",
        'find . -name "*.ts"',
        "2 * 3 = 6",
        "grep -E 'a*b' src",
        "a / b * c",
      ];
      for (const text of cases) {
        expect(stripAnsi(renderInlineMarkdown(text))).toBe(text);
      }
    });

    test("unterminated markers are emitted verbatim, not deleted", () => {
      expect(stripAnsi(renderInlineMarkdown("count ** is wrong"))).toBe("count ** is wrong");
    });

    test("legacy chatRenderer alias keeps the same contract", () => {
      const out = formatInlineMarkdown("Run `npm test` for ***full verification***");
      expect(out).not.toContain("`");
      expect(out).not.toContain("***");
      expect(stripAnsi(out)).toBe("Run npm test for full verification");
    });
  });

  describe("block level", () => {
    test("horizontal rule markers render as a thin divider", () => {
      for (const marker of ["***", "---", "___"]) {
        expect(isHorizontalRule(marker)).toBe(true);
      }
      expect(isHorizontalRule("- item")).toBe(false);
      expect(isHorizontalRule("2 * 3")).toBe(false);
      const divider = renderMarkdownDivider(20);
      expect(stripAnsi(divider)).not.toContain("*");
      expect(stripAnsi(divider)).toContain("─");
    });

    test("headings render hierarchy without `#` glyphs", () => {
      expect(parseHeading("### TESTS")?.level).toBe(3);
      expect(parseHeading("### TESTS")?.text).toBe("TESTS");
      expect(parseHeading("no heading here")).toBeNull();
      const h1 = renderHeading(1, "Title");
      expect(stripAnsi(h1)).toBe("Title");
      expect(h1).not.toContain("#");
    });

    test("star bullets normalize to a real bullet glyph", () => {
      const bullet = parseBullet("* Exploring your codebase");
      expect(bullet?.marker).toBe("*");
      expect(normalizeBulletMarker(bullet!.marker)).toBe("•");
      expect(stripAnsi(parseBullet(bullet!.marker + " x")!.text)).toBe("x");
      // `-` bullets keep their marker: the dash is the ToolNet convention.
      expect(normalizeBulletMarker("-")).toBe("-");
    });
  });

  describe("streaming safety", () => {
    test("a partial trailing marker is suppressed for display only", () => {
      expect(stripTrailingMarker("Kết quả **").text).toBe("Kết quả ");
      expect(stripTrailingMarker("Kết quả **").suppressed).toBe(true);
      expect(stripTrailingMarker("chunk *").text).toBe("chunk ");
      expect(stripTrailingMarker("done").suppressed).toBe(false);
      // Canonical content is untouched — the caller only uses this for display.
      expect(stripTrailingMarker("`` `x`").text).toBe("`` `x");
    });

    test("streaming chunks that split a marker never leak it into the transcript", () => {
      // Streaming accumulates into ONE draft message; every frame re-renders the
      // accumulated text, so each in-flight prefix goes through the renderer.
      const prefixes = ["**", "**hello", "**hello**"];
      const rendered = prefixes.map((prefix) => {
        tuiState.activeAssistantDraft = {
          id: "draft-1",
          runId: "run-1",
          turnId: 1,
          streaming: true,
          responseKey: "resp_test_draft_1",
        };
        const msgs: Msg[] = [{ role: "assistant", id: "draft-1", content: prefix }];
        return renderChatMessages(msgs, 80, "").map((l) => stripAnsi(l)).join("\n");
      });
      tuiState.activeAssistantDraft = null;
      // A lone opener must never reach the screen; the completed pair renders.
      expect(rendered[0]).not.toContain("**");
      expect(rendered[1]).not.toContain("**");
      expect(rendered[2]).toContain("hello");
      expect(rendered[2]).not.toContain("**");
    });
  });

  describe("responsive tables", () => {
    const report = [
      "| COMMAND | TYPE | ARGUMENTS | PICKER | LOCAL | BUSY | OUTPUT | ISSUE |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| help | info | none | yes | yes | yes | transcript | — |",
      "| model | picker | name | yes | yes | no | overlay | — |",
      "| mcp | namespace | sub | yes | no | no | picker | fixed |",
    ].join("\n");

    test("parses a pipe table block and reports its natural width", () => {
      const lines = report.split("\n");
      const parsed = parseMarkdownTable(lines, 0);
      expect(parsed).not.toBeNull();
      expect(parsed!.table.header).toHaveLength(8);
      expect(parsed!.table.rows).toHaveLength(3);
      expect(parsed!.end).toBe(lines.length);
      expect(tableNaturalWidth(parsed!.table)).toBeGreaterThan(52);
    });

    test("a table wider than the terminal renders stacked cards, not a wrapped grid", () => {
      const parsed = parseMarkdownTable(report.split("\n"), 0)!;
      const result = renderResponsiveTable(parsed.table, 52);
      const text = result.lines.map((l) => stripAnsi(l)).join("\n");
      // No border row can be wider than the viewport, and no column strip is
      // broken into one character per line.
      for (const line of result.lines) {
        expect(visibleCellWidth(line)).toBeLessThanOrEqual(52);
      }
      expect(text).toContain("help");
      expect(text).toContain("TYPE: info");
    });

    test("a table that fits renders an aligned grid", () => {
      const small = parseMarkdownTable(
        ["| A | B |", "| --- | --- |", "| 1 | 2 |"],
        0,
      )!;
      expect(tableNaturalWidth(small.table)).toBeLessThanOrEqual(40);
      const result = renderResponsiveTable(small.table, 80);
      expect(result.lines).toHaveLength(3);
      expect(stripAnsi(result.lines[0])).toContain("A");
    });

    test("a long report keeps a summary row and a viewer hint, full data intact", () => {
      const rows = Array.from({ length: 20 }, (_, i) => `| cmd${i} | info | x |`).join("\n");
      const report20 = "| COMMAND | TYPE | ARGUMENTS |\n| --- | --- | --- |\n" + rows;
      const parsed = parseMarkdownTable(report20.split("\n"), 0)!;
      const result = renderResponsiveTable(parsed.table, 120);
      expect(result.viewerHint).not.toBeNull();
      expect(stripAnsi(result.viewerHint!)).toContain("Ctrl+O");
      expect(result.fullLines).toHaveLength(2 + 20);
      expect(tableToLines(parsed.table).join("\n")).toContain("cmd19");
    });

    test("fenced code is never parsed as a table", () => {
      const lines = ["```ts", "| not | a | table |", "| --- | --- | --- |", "```", "| real | table |", "| --- | --- |"];
      const spans = scanMarkdownTables(lines);
      expect(spans.size).toBe(1);
      expect(spans.has(4)).toBe(true);
      expect(spans.get(4)!.table.header).toEqual(["real", "table"]);
    });
  });

  describe("utf-8 / glyph safety", () => {
    test("Vietnamese text survives rendering without replacement characters", () => {
      const msgs: Msg[] = [{ role: "assistant", id: "v1", content: "Kết quả kiểm tra hoàn tất." }];
      const text = renderChatMessages(msgs, 52, "").map((l) => stripAnsi(l)).join("\n");
      expect(text).toContain("Kết quả kiểm tra hoàn tất.");
      expect(text).not.toContain("\uFFFD");
      expect(text).not.toContain("??");
    });

    test("border and status glyphs never become `??`", () => {
      const msgs: Msg[] = [
        { role: "assistant", id: "g1", content: "✓ ◇ ● ─ │ ┌ ┐ └ ┘ glyphs" },
      ];
      const text = renderChatMessages(msgs, 80, "").map((l) => stripAnsi(l)).join("\n");
      expect(text).toContain("✓");
      expect(text).not.toContain("??");
    });

    test("toWellFormed drops lone surrogates so `?` cannot be emitted", () => {
      const loneHigh = "a\uD800b";
      const loneLow = "a\uDC00b";
      const paired = "a\u{1F680}b";
      expect(toWellFormed(loneHigh)).toBe("ab");
      expect(toWellFormed(loneLow)).toBe("ab");
      expect(toWellFormed(paired)).toBe(paired);
    });

    test("ASCII fallback transliterates borders deterministically (no `?`)", () => {
      setUnicodeCapable(false);
      const frame = "╭─ title ─╮\n│ body    │\n╰──────╯ ✓ ● • ↑ ↓ ⇞ ⇟ …";
      const ascii = transliterateGlyphs(frame);
      expect(ascii).not.toContain("?");
      expect(ascii).not.toMatch(/[\u2500-\u25FF\u2190-\u21FF]/);
      expect(ascii).toContain("+");
      expect(ascii).toContain("PgUp");
      expect(ascii).toContain("...");
    });

    test("transliteration leaves ANSI escapes untouched", () => {
      setUnicodeCapable(false);
      const styled = "\x1b[38;2;89;208;255m─\x1b[0m text";
      expect(transliterateGlyphs(styled)).toBe("\x1b[38;2;89;208;255m-\x1b[0m text");
    });
  });

  describe("tool summaries", () => {
    test("GetCwd answers `Workspace /root`, not raw JSON", () => {
      const summary = friendlyToolSummary("get_cwd", {
        result: { workspaceRoot: "/root", currentCwd: "/root" },
      });
      expect(summary).toBe("Workspace /root");
    });

    test("unknown tools keep their real output", () => {
      expect(friendlyToolSummary("shell", { stdout: "ok" })).toBeNull();
      expect(friendlyToolSummary("grep", null)).toBeNull();
    });

    test("the transcript renders the friendly line instead of the JSON payload", () => {
      const msgs: Msg[] = [
        {
          role: "tool",
          id: "t1",
          tool_call_id: "c1",
          name: "get_cwd",
          content: JSON.stringify({ result: { workspaceRoot: "/root" }, exitCode: 0 }),
        },
      ];
      const text = renderChatMessages(msgs, 80, "").map((l) => stripAnsi(l)).join("\n");
      expect(text).toContain("Workspace /root");
      expect(text).not.toContain("workspaceRoot");
    });
  });

  describe("Ctrl+O table viewer wiring", () => {
    test("a summarized report records its full rows as the Ctrl+O target", () => {
      const rows = Array.from({ length: 20 }, (_, i) => `| cmd${i} | info | x |`).join("\n");
      const report20 = `| COMMAND | TYPE | ARGUMENTS |\n| --- | --- | --- |\n${rows}`;
      const msgs: Msg[] = [{ role: "assistant", id: "tbl1", content: report20 }];
      renderChatMessages(msgs, 80, "");

      const target = tuiState.lastDetailViewerTarget;
      expect(target).not.toBeNull();
      expect(target!.title).toBe("Table");
      expect(target!.lines).toHaveLength(22);
      expect(target!.lines.join("\n")).toContain("cmd19");
    });

    test("latestToolOutputForViewer prefers the last summarized table", () => {
      const small = "| A | B |\n| --- | --- |\n| 1 | 2 |";
      const msgs: Msg[] = [{ role: "assistant", id: "tbl2", content: small }];
      renderChatMessages(msgs, 80, "");
      // A table that fits shows no hint; the stale target must be dropped.
      expect(tuiState.latestToolOutputForViewer()).toBeNull();

      const rows = Array.from({ length: 15 }, (_, i) => `| cmd${i} | info | x |`).join("\n");
      const report15 = `| COMMAND | TYPE | ARGUMENTS |\n| --- | --- | --- |\n${rows}`;
      renderChatMessages([{ role: "assistant", id: "tbl3", content: report15 }], 80, "");
      const target = tuiState.latestToolOutputForViewer();
      expect(target).not.toBeNull();
      expect(target!.lines.join("\n")).toContain("cmd14");
    });

    afterEach(() => {
      tuiState.lastDetailViewerTarget = null;
    });
  });

  describe("prompt-box border polish (item 17)", () => {
    test("the divider stays at border tone while typing (no full-width bright rule)", () => {
      // Re-imported locally so the assertion reads against the real constant.
      const { A } = require("../../term");
      const borderSgr = "38;2;34;49;77"; // A.fgBorder #22314D
      const typing = renderInputArea(52, "some draft text", "\x1b[36m");
      expect(typing).toContain(borderSgr);
      expect(typing).not.toContain("\x1b[36m─");
      // The colored `>` prompt is still the focus cue.
      expect(typing).toContain("\x1b[36m");
      expect(stripAnsi(typing)).toContain("> some draft text");
    });
  });
});

function visibleCellWidth(line: string): number {
  return stripAnsi(line).length;
}
