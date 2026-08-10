import { toolGlob } from "./src/lib/codingAgent";

// Test cases from the bug report
const patterns = [
  "**/gemini",
  "**/gemini/",
  "**/*gemini*",
  "*/gemini",
  ".gemini",
  "**/.gemini",
  "**/node_modules/.bin/*",
];

for (const p of patterns) {
  const res = toolGlob(p, "/root");
  const status = res.success ? "✓" : "✗";
  const preview = res.success
    ? (res.data || "").split("\n")[0]
    : res.error;
  console.log(`${status} pattern="${p}"  → ${preview}`);
}
