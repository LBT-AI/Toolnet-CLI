import { describe, test, expect } from "bun:test";
import { compactMessages, estimateMessageChars, type Msg } from "../../lib/compaction";

describe("Context Compaction & Memory Management", () => {
  test("estimateMessageChars correctly measures character count of messages", () => {
    const msgs: Msg[] = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Response string" }
    ];
    const len = estimateMessageChars(msgs);
    expect(len).toBe("Hello world".length + "Response string".length);
  });

  test("compactMessages skips compaction when below threshold", () => {
    const msgs: Msg[] = [
      { role: "user", content: "Short message" },
      { role: "assistant", content: "Short reply" }
    ];
    const res = compactMessages(msgs, { force: false, thresholdChars: 10000 });
    expect(res.compacted).toBe(false);
    expect(res.messages.length).toBe(2);
  });

  test("compactMessages forces compaction when force=true and creates structured summary", () => {
    const msgs: Msg[] = [
      { role: "system", content: "System prompt 1" },
      { role: "user", content: "Initial user request: Fix login bug in auth.ts" },
      { role: "assistant", content: "Analyzing auth.ts...", tool_calls: [{ function: { name: "read_file", arguments: JSON.stringify({ path: "auth.ts" }) } }] },
      { role: "tool", content: "file content..." },
      { role: "user", content: "Now fix issue 2 in user.ts" },
      { role: "assistant", content: "Modifying user.ts...", tool_calls: [{ function: { name: "edit_file", arguments: JSON.stringify({ path: "user.ts" }) } }] },
      { role: "user", content: "Recent question 1" },
      { role: "assistant", content: "Recent answer 1" },
      { role: "user", content: "Recent question 2" },
      { role: "assistant", content: "Recent answer 2" },
      { role: "user", content: "Recent question 3" },
      { role: "assistant", content: "Recent answer 3" }
    ];

    const res = compactMessages(msgs, { force: true, keepRecentCount: 6 });
    expect(res.compacted).toBe(true);
    expect(res.newCount).toBeLessThan(msgs.length);

    const summaryMsg = res.messages.find(m => m.content.includes("[Context Compaction Summary]"));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content).toContain("read_file");
    expect(summaryMsg?.content).toContain("auth.ts");
    expect(summaryMsg?.content).toContain("user.ts");
  });
});
