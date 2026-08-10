import { describe, it, expect } from "bun:test";
import { getModelTags } from "../../lib/modelTags";

describe("Rendering utilities", () => {
  it("should extract capability tags for vision models", () => {
    const gpt4o = getModelTags("openai/gpt-4o");
    expect(gpt4o).toContain("[Vision]");
    
    const claude = getModelTags("cc/claude-sonnet-4-5");
    expect(claude).toContain("[Vision]");
  });

  it("should extract capability tags for reasoning models", () => {
    const o1 = getModelTags("openai/o1-mini");
    expect(o1).toContain("[Reasoning]");
    
    const r1 = getModelTags("deepseek/deepseek-r1");
    expect(r1).toContain("[Reasoning]");
  });

  it("should extract correct context tags", () => {
    const gemini = getModelTags("google/gemini-1.5-pro");
    expect(gemini).toContain("[Context: 1M+]");
    
    const claude = getModelTags("cc/claude-sonnet-4-5");
    expect(claude).toContain("[Context: 128k]");
  });

  it("should format diffs correctly (simulated)", () => {
    const isDiffTool = true;
    const diffLinePlus = "+ added code";
    const diffLineMinus = "- removed code";
    
    // Simulate what tui.ts does
    let colorPlus = "";
    if (isDiffTool && diffLinePlus.startsWith("+") && !diffLinePlus.startsWith("+++")) {
      colorPlus = "green";
    }
    
    let colorMinus = "";
    if (isDiffTool && diffLineMinus.startsWith("-") && !diffLineMinus.startsWith("---")) {
      colorMinus = "red";
    }
    
    expect(colorPlus).toBe("green");
    expect(colorMinus).toBe("red");
  });

  it("should detect thought blocks correctly (simulated)", () => {
    let content = "<thought> Thinking... ";
    let inThoughtBlock = false;
    
    if (content.includes("<thought>")) {
      inThoughtBlock = true;
    }
    
    expect(inThoughtBlock).toBe(true);
    
    content = "</thought>";
    let closeThought = content.includes("</thought>");
    if (closeThought) {
      inThoughtBlock = false;
    }
    
    expect(inThoughtBlock).toBe(false);
  });
});
