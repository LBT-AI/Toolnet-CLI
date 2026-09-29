import { test, expect } from "bun:test";
import { syncTranscriptPreservingReasoning } from "../events/agentWiring";

test("transcript reconciliation bug corrupts tool_call_id mapping on out-of-order partial results", () => {
  const currentMsgs = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-cwd", type: "function", function: { name: "get_cwd", arguments: "{}" } },
        { id: "call-browser", type: "function", function: { name: "browser", arguments: "{}" } },
        { id: "call-file", type: "function", function: { name: "read_file", arguments: "{}" } }
      ]
    },
    { role: "tool", tool_call_id: "call-browser", name: "browser", content: "Playwright error", durationMs: 50 },
    { role: "tool", tool_call_id: "call-cwd", name: "get_cwd", content: "/root" },
  ];

  const engineMsgs = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-cwd", type: "function", function: { name: "get_cwd", arguments: "{}" } },
        { id: "call-browser", type: "function", function: { name: "browser", arguments: "{}" } },
        { id: "call-file", type: "function", function: { name: "read_file", arguments: "{}" } }
      ]
    },
    { role: "tool", tool_call_id: "call-cwd", name: "get_cwd", content: "/root" },
    { role: "tool", tool_call_id: "call-browser", name: "browser", content: "Playwright error" },
    { role: "tool", tool_call_id: "call-file", name: "read_file", content: "File content" }
  ];

  const merged = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);
  const toolMsgs = merged.filter(m => m.role === "tool");
  
  expect(toolMsgs.length).toBe(3);
  expect(toolMsgs[0].tool_call_id).toBe("call-cwd");
  expect(toolMsgs[1].tool_call_id).toBe("call-browser");
  expect(toolMsgs[2].tool_call_id).toBe("call-file");
  expect(toolMsgs[1].durationMs).toBe(50);
});

test("same tool name different callId", () => {
  const currentMsgs = [
    { role: "tool", tool_call_id: "read-2", name: "read_file", content: "CONTENT_B" },
    { role: "tool", tool_call_id: "read-1", name: "read_file", content: "CONTENT_A" },
  ];
  const engineMsgs = [
    { role: "tool", tool_call_id: "read-1", name: "read_file", content: "CONTENT_A" },
    { role: "tool", tool_call_id: "read-2", name: "read_file", content: "CONTENT_B" }
  ];
  const merged = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);
  expect(merged.length).toBe(2);
  expect(merged[0].content).toBe("CONTENT_A");
  expect(merged[1].content).toBe("CONTENT_B");
});

test("duplicate result control", () => {
  const currentMsgs = [
    { role: "tool", tool_call_id: "A", name: "A", content: "Result" },
    { role: "tool", tool_call_id: "A", name: "A", content: "Result" }
  ];
  const engineMsgs = [
    { role: "tool", tool_call_id: "A", name: "A", content: "Result" }
  ];
  const merged = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);
  expect(merged.length).toBe(1); // deterministic dedupe
});

test("unknown callId control", () => {
  const currentMsgs = [
    { role: "tool", tool_call_id: "UNKNOWN", name: "unknown", content: "Result" }
  ];
  const engineMsgs = [
    { role: "tool", tool_call_id: "KNOWN", name: "known", content: "Result" }
  ];
  const merged = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);
  expect(merged.length).toBe(2);
  // UNKNOWN appears before KNOWN because it didn't match and was pushed early
  expect(merged[0].tool_call_id).toBe("UNKNOWN");
  expect(merged[1].tool_call_id).toBe("KNOWN");
});

test("cross-turn delayed result", () => {
  const currentMsgs = [
    { role: "tool", tool_call_id: "call-A", name: "A", content: "Result A" },
    { role: "tool", tool_call_id: "call-B", name: "B", content: "Result B" }
  ];
  // B is from current turn, A is delayed from previous turn
  const engineMsgs = [
    { role: "tool", tool_call_id: "call-B", name: "B", content: "Result B" }
  ];
  const merged = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);
  expect(merged.length).toBe(2);
  // It shouldn't merge A and B together.
  expect(merged[0].tool_call_id).toBe("call-A");
  expect(merged[1].tool_call_id).toBe("call-B");
});
