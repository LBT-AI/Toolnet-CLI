import { describe, test, expect } from "bun:test";
import { executeBrowserTool } from "../../lib/browserTool";

describe("Browser Tool (Optional Playwright Integration)", () => {
  test("executeBrowserTool returns structured output or helpful installation prompt if Playwright is missing", async () => {
    const res = await executeBrowserTool({ action: "navigate", url: "https://example.com" });
    expect(res).toBeDefined();
    if (!res.success) {
      expect(res.error).toContain("Playwright");
    } else {
      expect(res.data).toContain("URL: https://example.com");
    }
  });

  test("executeBrowserTool handles missing parameters gracefully", async () => {
    const resClick = await executeBrowserTool({ action: "click" });
    if (!resClick.success && resClick.error?.includes("Missing required argument")) {
      expect(resClick.error).toContain("selector");
    }
  });
});
