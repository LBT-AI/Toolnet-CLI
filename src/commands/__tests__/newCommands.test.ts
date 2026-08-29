import { describe, it, expect } from "bun:test";
import { searchCommand } from "../search";
import { policyCommand } from "../policy";
import { exportCommand } from "../export";
import fs from "node:fs";
import path from "node:path";

describe("New Interactive Commands", () => {
  it("searchCommand finds matching turns and formats snippets", async () => {
    const messages = [
      { role: "user", content: "Can you implement binary search in typescript?" },
      { role: "assistant", content: "Sure, here is binary search: function binarySearch() {}" },
      { role: "user", content: "Now write tests for it" },
    ];
    const out: string[] = [];

    const ctx: any = {
      getMessages: () => messages,
      addMessage: (_role: string, text: string) => out.push(text),
    };

    await searchCommand.handler(["binary", "search"], ctx);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("Found **2** match(es)");
    expect(out[0]).toContain("Turn #1");
    expect(out[0]).toContain("Turn #2");
  });

  it("searchCommand reports when no matches found", async () => {
    const messages = [{ role: "user", content: "Hello world" }];
    const out: string[] = [];
    const ctx: any = {
      getMessages: () => messages,
      addMessage: (_role: string, text: string) => out.push(text),
    };

    await searchCommand.handler(["nonexistent_query"], ctx);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("No matches found");
  });

  it("policyCommand displays sandbox mode and policy status", async () => {
    const out: string[] = [];
    const ctx: any = {
      addMessage: (_role: string, text: string) => out.push(text),
    };

    await policyCommand.handler(["show"], ctx);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("Workspace Security Policy");
    expect(out[0]).toContain("Sandbox Mode");
  });

  it("exportCommand exports markdown, html, and json formats", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "test_export_"));
    const mdFile = path.join(tmpDir, "test.md");
    const htmlFile = path.join(tmpDir, "test.html");
    const jsonFile = path.join(tmpDir, "test.json");

    const messages = [
      { role: "user", content: "Test prompt" },
      { role: "assistant", content: "Test response" },
    ];

    const ctx: any = {
      getMessages: () => messages,
      getCurrentSessionId: () => "sess_test",
      addMessage: () => {},
    };

    try {
      await exportCommand.handler(["markdown", mdFile], ctx);
      expect(fs.existsSync(mdFile)).toBe(true);
      expect(fs.readFileSync(mdFile, "utf8")).toContain("Test prompt");

      await exportCommand.handler(["html", htmlFile], ctx);
      expect(fs.existsSync(htmlFile)).toBe(true);
      expect(fs.readFileSync(htmlFile, "utf8")).toContain("<html");

      await exportCommand.handler(["json", jsonFile], ctx);
      expect(fs.existsSync(jsonFile)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
      expect(parsed.messages.length).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
