import { test, expect, describe, beforeEach } from "bun:test";
import {
  contextEngine,
  estimateTokens,
  estimateMessageTokens,
  estimateTotalTokens,
  getModelContextSpec,
  calculateContextBudget,
  pruneOldToolResults,
  compactMessagesAtomically,
  sessionMemory,
  type ContextMessage,
} from "../../lib/context";

describe("Unified Context Engine", () => {
  beforeEach(() => {
    sessionMemory.reset();
  });

  describe("1. Token & Character Estimator", () => {
    test("estimates tokens accurately for code and English", () => {
      const codeSnippet = 'function add(a: number, b: number): number { return a + b; }';
      const tokens = estimateTokens(codeSnippet);
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThan(30);
    });

    test("estimates tokens with proper weighting for Vietnamese multi-byte text", () => {
      const vnText = "Kiểm tra hệ thống quản lý context và nén bộ nhớ đàm thoại của ToolNet CLI.";
      const tokens = estimateTokens(vnText);
      expect(tokens).toBeGreaterThan(15);
    });

    test("estimates message envelope and tool_calls metadata", () => {
      const msgWithToolCall: ContextMessage = {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "package.json", limit: 50 }),
            },
          },
        ],
      };

      const tokens = estimateMessageTokens(msgWithToolCall);
      expect(tokens).toBeGreaterThan(15); // Envelope + tool_call name + arguments
    });
  });

  describe("2. Model Context Specs & Budgeting", () => {
    test("resolves correct specs for known model families", () => {
      const gpt4o = getModelContextSpec("openai/gpt-4o");
      expect(gpt4o.maxContextTokens).toBe(128000);
      expect(gpt4o.autoCompactThresholdTokens).toBe(96000);

      const claude = getModelContextSpec("anthropic/claude-3-5-sonnet");
      expect(claude.maxContextTokens).toBe(200000);

      const gemini = getModelContextSpec("google/gemini-2.0-flash");
      expect(gemini.maxContextTokens).toBeGreaterThanOrEqual(1000000);

      const fallback = getModelContextSpec("custom-local-llm");
      expect(fallback.maxContextTokens).toBe(32000);
    });

    test("calculates context budget and utilization percentage", () => {
      const messages: ContextMessage[] = [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Hello, write a simple script." },
        { role: "assistant", content: "Here is your script." },
      ];

      const budget = calculateContextBudget(messages, "openai/gpt-4o");
      expect(budget.modelName).toBe("openai/gpt-4o");
      expect(budget.currentEstimatedTokens).toBeGreaterThan(0);
      expect(budget.utilizationPercent).toBeLessThan(5);
      expect(budget.needsCompaction).toBe(false);
      expect(budget.availableTokens).toBeGreaterThan(100000);
    });
  });

  describe("3. Tool Result Pruner", () => {
    test("prunes bulky historical tool outputs while preserving recent tool turns in full", () => {
      const longOutput = "LINE OF LOG DATA\n".repeat(100); // ~1700 chars
      const messages: ContextMessage[] = [
        { role: "user", content: "Check logs" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: "{}" } }],
        },
        {
          role: "tool",
          name: "shell",
          tool_call_id: "c1",
          content: JSON.stringify({ stdout: longOutput, stderr: "", exitCode: 0 }),
        },
        {
          role: "assistant",
          content: "Next tool call",
          tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        {
          role: "tool",
          name: "read_file",
          tool_call_id: "c2",
          content: JSON.stringify({ stdout: longOutput, stderr: "", exitCode: 0 }),
        },
        {
          role: "assistant",
          content: "Active tool call",
          tool_calls: [{ id: "c3", type: "function", function: { name: "get_cwd", arguments: "{}" } }],
        },
        {
          role: "tool",
          name: "get_cwd",
          tool_call_id: "c3",
          content: JSON.stringify({ stdout: "/root/toolnet-cli", stderr: "", exitCode: 0 }),
        },
      ];

      const result = pruneOldToolResults(messages, { keepRecentToolsCount: 1, maxToolResultChars: 200 });
      expect(result.prunedCount).toBe(2);
      expect(result.savedChars).toBeGreaterThan(1000);

      // Tool c1 (old) should be pruned
      const prunedTool1 = result.messages.find((m) => m.tool_call_id === "c1");
      expect(prunedTool1?.pruned).toBe(true);
      expect(prunedTool1?.content).toContain("_pruned");

      // Tool c3 (recent) should remain intact
      const recentTool = result.messages.find((m) => m.tool_call_id === "c3");
      expect(recentTool?.pruned).toBeUndefined();
      expect(recentTool?.content).toContain("/root/toolnet-cli");
    });

    test("always preserves error details when pruning failed tool executions", () => {
      const longError = "Error stack trace line\n".repeat(50);
      const messages: ContextMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c_err", type: "function", function: { name: "shell", arguments: "{}" } }],
        },
        {
          role: "tool",
          name: "shell",
          tool_call_id: "c_err",
          content: JSON.stringify({ stdout: "some output", stderr: longError, exitCode: 1 }),
        },
        // More recent tools to push c_err into history
        { role: "tool", name: "tool2", tool_call_id: "c2", content: "{}" },
        { role: "tool", name: "tool3", tool_call_id: "c3", content: "{}" },
      ];

      const result = pruneOldToolResults(messages, { keepRecentToolsCount: 2, maxToolResultChars: 100 });
      const prunedErr = result.messages.find((m) => m.tool_call_id === "c_err");
      expect(prunedErr?.pruned).toBe(true);
      const parsed = JSON.parse(prunedErr?.content || "{}");
      expect(parsed.exitCode).toBe(1);
      expect(parsed.stderr).toContain("Error stack trace line");
    });
  });

  describe("4. Atomic Compactor & Pair Integrity", () => {
    test("preserves assistant.tool_calls and role:tool pairings atomically without breaking schema", () => {
      const messages: ContextMessage[] = [
        { role: "system", content: "System instructions" },
        // Turn 1
        { role: "user", content: "Goal 1: Read config" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a.json"}' } }],
        },
        { role: "tool", name: "read_file", tool_call_id: "t1", content: JSON.stringify({ stdout: "data a", exitCode: 0 }) },
        { role: "assistant", content: "Finished turn 1" },
        // Turn 2
        { role: "user", content: "Goal 2: Read helper" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t2", type: "function", function: { name: "read_file", arguments: '{"path":"b.json"}' } }],
        },
        { role: "tool", name: "read_file", tool_call_id: "t2", content: JSON.stringify({ stdout: "data b", exitCode: 0 }) },
        { role: "assistant", content: "Finished turn 2" },
        // Turn 3
        { role: "user", content: "Goal 3: Edit config" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t3", type: "function", function: { name: "write_file", arguments: '{"path":"a.json","content":"new"}' } }],
        },
        { role: "tool", name: "write_file", tool_call_id: "t3", content: JSON.stringify({ stdout: "written", exitCode: 0 }) },
        { role: "assistant", content: "Finished turn 3" },
      ];

      const res = compactMessagesAtomically(messages, { force: true, keepRecentCount: 1 });
      expect(res.compacted).toBe(true);

      // Verify system prompt is at index 0
      expect(res.messages[0].role).toBe("system");
      expect(res.messages[0].content).toBe("System instructions");

      // Verify summary message is present
      const summaryMsg = res.messages.find((m) => m.content.includes("[Context Compaction Summary]"));
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.content).toContain("Goal 1: Read config");
      expect(summaryMsg?.content).toContain("read_file");

      // Verify recent turn (Turn 3) is preserved intact with matching tool_calls & tool responses
      const preservedAssistant = res.messages.find((m) => m.tool_calls && m.tool_calls[0].id === "t3");
      const preservedTool = res.messages.find((m) => m.tool_call_id === "t3");
      expect(preservedAssistant).toBeDefined();
      expect(preservedTool).toBeDefined();

      // Ensure no orphaned tool calls from compacted turns remain in raw message array
      const orphanedTool = res.messages.find((m) => m.tool_call_id === "t1");
      expect(orphanedTool).toBeUndefined();
    });
  });

  describe("5. Session Memory Store", () => {
    test("records file accesses, user goals, and generates structured system snippet", () => {
      sessionMemory.recordFileAccess("src/lib/agentTools.ts", "read");
      sessionMemory.recordFileAccess("src/lib/codingAgent.ts", "write");
      sessionMemory.recordUserGoal("Optimize package packaging for production");
      sessionMemory.recordInsight("Identified orphan ContextCache module");

      const snapshot = sessionMemory.getSnapshot();
      expect(snapshot.keyFilesTouched).toContain("src/lib/agentTools.ts");
      expect(snapshot.modifiedFiles).toContain("src/lib/codingAgent.ts");
      expect(snapshot.userGoals).toContain("Optimize package packaging for production");
      expect(snapshot.discoveredInsights).toContain("Identified orphan ContextCache module");

      const promptSnippet = sessionMemory.generateSystemPromptSnippet();
      expect(promptSnippet).toContain("<session_memory>");
      expect(promptSnippet).toContain("Modified Files in Session: src/lib/codingAgent.ts");
      expect(promptSnippet).toContain("Key Files Referenced: src/lib/agentTools.ts");
      expect(promptSnippet).toContain("Identified orphan ContextCache module");
    });
  });

  describe("6. ContextEngine Full Pipeline", () => {
    test("prepareMessagesForApi runs auto-pruning, budgeting, and compaction smoothly", () => {
      const largeContent = "data block\n".repeat(200);
      const messages: ContextMessage[] = [
        { role: "system", content: "You are ToolNet Agent." },
        { role: "user", content: "Task 1" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"file1.ts"}' } }],
        },
        { role: "tool", name: "read_file", tool_call_id: "call_1", content: JSON.stringify({ stdout: largeContent, exitCode: 0 }) },
        { role: "assistant", content: "Done 1" },
        { role: "user", content: "Task 2" },
        { role: "assistant", content: "Done 2" },
      ];

      const prep = contextEngine.prepareMessagesForApi(messages, {
        model: "openai/gpt-4o",
        forceCompact: true,
      });

      expect(prep.compacted).toBe(true);
      expect(prep.budget.currentEstimatedTokens).toBeGreaterThan(0);
      expect(prep.budget.maxContextTokens).toBe(128000);
      expect(prep.messages.length).toBeLessThan(messages.length);
    });
  });
});
