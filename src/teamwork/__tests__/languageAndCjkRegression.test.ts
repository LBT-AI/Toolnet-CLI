/**
 * Language Consistency + CJK/Unicode Terminal Width Regression Tests
 *
 * A. Language consistency: the agent must mirror the user's language
 *    (Vietnamese stays Vietnamese, Chinese stays Chinese, English stays
 *    English) and honor an explicit language lock ("trả lời bằng tiếng Việt").
 *
 * B. CJK/Unicode width: renderers must measure terminal cells via visibleWidth
 *    (CJK = 2 cells) so Chinese text never overflows a row, which would make
 *    the terminal soft-wrap and new lines overwrite old messages.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  detectLanguage,
  extractLanguageRequest,
  resolveResponseLanguage,
  getLanguageDirective,
  setResponseLanguage,
  getResponseLanguage,
} from "../../lib/language";
import { visibleWidth, tailByCells, truncateVisible, stripAnsi } from "../../tui/layout";
import { renderChatMessages } from "../../tui/renderers/chatRenderer";
import { renderInputArea, renderFooter, renderWorkingStatus } from "../../tui/renderers/statusRenderer";

// ---------------------------------------------------------------------------
// A. Language consistency
// ---------------------------------------------------------------------------

describe("Language consistency — detection & preference", () => {
  beforeEach(() => setResponseLanguage("auto"));
  afterEach(() => setResponseLanguage("auto"));

  it("1. detects Vietnamese, Chinese and English by heuristic", () => {
    expect(detectLanguage("tôi đang test, bạn thử viết cho tôi 1 file python ngắn")).toBe("vi");
    expect(detectLanguage("当然可以！请告诉我你需要什么")).toBe("zh");
    expect(detectLanguage("please write a quick python script")).toBe("en");
    // unaccented Vietnamese still detected via common words
    expect(detectLanguage("xin chao ban, toi dang test")).toBe("vi");
  });

  it("2. explicit language requests are extracted", () => {
    expect(extractLanguageRequest("bạn trả lời bằng tiếng Việt nhé")).toBe("vi");
    expect(extractLanguageRequest("请用中文回答")).toBe("zh");
    expect(extractLanguageRequest("please answer in english")).toBe("en");
    expect(extractLanguageRequest("tôi đang test code")).toBeNull();
  });

  it("3. resolveResponseLanguage: preference wins, else latest message", () => {
    // locked preference overrides even a Chinese message
    expect(resolveResponseLanguage("当然可以", "vi")).toBe("vi");
    // auto follows the latest message
    expect(resolveResponseLanguage("当然可以！请告诉我", "auto")).toBe("zh");
    expect(resolveResponseLanguage("tôi đang test", "auto")).toBe("vi");
    expect(resolveResponseLanguage("write a quick script", "auto")).toBe("en");
    // explicit request in the message locks it
    expect(resolveResponseLanguage("bạn trả lời bằng tiếng Việt nhé", "auto")).toBe("vi");
  });

  it("4. directive embeds in system prompt", () => {
    const auto = getLanguageDirective("auto");
    expect(auto).toContain("same language as the user's latest message");
    expect(getLanguageDirective("vi")).toContain("Respond in Vietnamese");
    expect(getLanguageDirective("zh")).toContain("Respond in Chinese");
  });

  it("5. module-level preference round-trips", () => {
    setResponseLanguage("vi");
    expect(getResponseLanguage()).toBe("vi");
    setResponseLanguage("auto");
    expect(getResponseLanguage()).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// B. CJK / Unicode terminal width
// ---------------------------------------------------------------------------

describe("CJK/Unicode terminal width", () => {
  it("6. visibleWidth counts CJK as 2 cells, emoji as 2", () => {
    expect(visibleWidth("你好")).toBe(4);
    expect(visibleWidth("hello 世界")).toBe(10);
    expect(visibleWidth("🚀 test")).toBe(7);
    expect(visibleWidth("当然可以！请告诉我")).toBe(18); // 4+4 CJK + full-width ！
  });

  it("7. tailByCells keeps trailing cells without splitting graphemes", () => {
    expect(tailByCells("你好世界", 4)).toBe("世界");
    expect(tailByCells("abcdef", 3)).toBe("def");
    expect(tailByCells("🚀🚀", 2)).toBe("🚀");
  });

  it("8. truncateVisible is cell-safe for CJK", () => {
    expect(visibleWidth(truncateVisible("你好世界你好世界", 8))).toBeLessThanOrEqual(8);
    expect(visibleWidth(truncateVisible("你好世界", 10))).toBe(8); // fits, unchanged
  });

  it("9. chat lines with Chinese never exceed the column budget", () => {
    const msgs = [
      { role: "user" as const, content: "tôi đang test, bạn thử viết cho tôi 1 file python ngắn" },
      { role: "assistant" as const, content: "当然可以！请告诉我你希望这个 Python 文件做什么？" },
    ];
    for (const cols of [40, 50, 60, 80]) {
      const lines = renderChatMessages(msgs, cols, "\x1b[36m");
      for (const line of lines) {
        expect(visibleWidth(line), `line '${stripAnsi(line)}' fits ${cols} cols`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("10. input area with Chinese input never overflows its row", () => {
    const out = renderInputArea(60, "你好世界 test input", "\x1b[36m");
    for (const line of out.split("\r\n")) {
      if (!line.trim()) continue;
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it("11. footer with CJK workspace path fits the row", () => {
    const bar = renderFooter(60, {
      providerName: "ToolNet Gateway",
      currentModel: "alims-intl.llm",
      workspacePath: "/mnt/数据/项目",
    });
    expect(visibleWidth(bar)).toBeLessThanOrEqual(60);
  });

  it("12. working status with CJK text fits the row", () => {
    const line = renderWorkingStatus(60, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 0,
      statusText: "正在执行工具...",
      elapsedDisplay: "1.2s",
      primaryColor: "\x1b[36m",
    });
    expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  it("13. mixed Vietnamese + Chinese messages render as separate blocks", () => {
    const msgs = [
      { role: "user" as const, content: "tôi đang test, bạn thử viết cho tôi 1 file python ngắn" },
      { role: "assistant" as const, content: "当然可以！请告诉我..." },
    ];
    const lines = renderChatMessages(msgs, 80, "\x1b[36m");
    const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    // both message bodies present, each in its own block (separated by blank line)
    expect(plain).toContain("tôi đang test");
    expect(plain).toContain("当然可以");
    expect(plain).toContain("❯");
    expect(plain).toContain("✦");
    // assistant block is visually distinct from the user block (bg highlight)
    const assistantLine = lines.find((l) => l.includes("当然可以"));
    expect(assistantLine).toContain("48;2;22;22;26"); // bgTool
  });
});