import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { isGreetingOnly, matchGreetingFastPath } from "../greeting";
import { sendMessage } from "../../tui/events/agentWiring";
import { agentEngine } from "../../core/agent/agentEngine";
import { tuiState } from "../../tui/state";
import { getCwdInfo } from "../codingAgent";

const WS = "/root/toolnet-cli";
const EXPECTED = "Hello. I'm ToolNet. What would you like help with in /root/toolnet-cli?";

describe("greeting fast-path matcher", () => {
  for (const input of ["hello", "helo", "hi", "hey", "xin chào", "chào", "chào bạn"]) {
    it(`"${input}" returns the fixed one-line reply`, () => {
      expect(matchGreetingFastPath(input, WS)).toBe(EXPECTED);
    });
  }

  it("normalizes case, surrounding whitespace, and trailing punctuation", () => {
    expect(isGreetingOnly("  HELLO  ")).toBe(true);
    expect(isGreetingOnly("Hi!")).toBe(true);
    expect(isGreetingOnly("Xin Chào.")).toBe(true);
    // NFD-decomposed Vietnamese input still matches.
    expect(isGreetingOnly("xin chào".normalize("NFD"))).toBe(true);
  });

  it("reply is plain: no list, markdown, or emoji", () => {
    const reply = matchGreetingFastPath("hello", WS)!;
    expect(reply).not.toContain("\n");
    expect(reply).not.toMatch(/\*\*|^\s*[-*•]/m);
    expect(reply).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  for (const input of ["hello sửa package.json", "hi check git status", "hello?? fix the build", "helloworld", "hell", "his", "chào, đọc README"]) {
    it(`"${input}" falls through to the agent`, () => {
      expect(matchGreetingFastPath(input, WS)).toBeNull();
    });
  }
});

describe("greeting fast-path in the TUI send path", () => {
  const origSave = tuiState.saveCurrentSession;
  const origRender = tuiState.requestRender;

  afterEach(() => {
    tuiState.saveCurrentSession = origSave;
    tuiState.requestRender = origRender;
  });

  it("answers 'hello' locally with the real workspace and never calls the agent engine", async () => {
    tuiState.saveCurrentSession = () => {};
    tuiState.requestRender = () => {};
    tuiState.messages = [];
    const run = spyOn(agentEngine, "run");
    try {
      await sendMessage("hello");
      expect(run).not.toHaveBeenCalled();
      expect(tuiState.messages).toHaveLength(2);
      expect(tuiState.messages[0]).toMatchObject({
        role: "user",
        content: "hello",
      });
      expect(tuiState.messages[1]).toMatchObject({
        role: "assistant",
        content: `Hello. I'm ToolNet. What would you like help with in ${getCwdInfo().currentCwd}?`,
      });
      expect(tuiState.messages.every((message) => message.id)).toBe(true);
    } finally {
      run.mockRestore();
    }
  });
});
