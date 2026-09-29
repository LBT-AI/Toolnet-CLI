/**
 * Phase 8 — release secret scan.
 *
 * Scans every TRACKED file (what a release would actually ship) for
 * high-confidence credential shapes and reports only `path:line:category`
 * (plus a placeholder hint) — the matched value is NEVER printed.
 *
 * Exit 0 = clean; exit 1 = at least one non-placeholder high-confidence hit.
 *
 * Run: bun scripts/phase8-secret-scan.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

interface Rule {
  category: string;
  regex: RegExp;
  confidence: "high" | "low";
}

const RULES: Rule[] = [
  { category: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g, confidence: "high" },
  { category: "openai-key", regex: /\bsk-[A-Za-z0-9]{20,}/g, confidence: "high" },
  { category: "github-pat", regex: /github_pat_[A-Za-z0-9_]{20,}/g, confidence: "high" },
  { category: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, confidence: "high" },
  { category: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g, confidence: "high" },
  { category: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, confidence: "high" },
  { category: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, confidence: "high" },
  { category: "stripe-live-key", regex: /\b[rs]k_live_[A-Za-z0-9]{20,}/g, confidence: "high" },
  { category: "private-key-block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, confidence: "high" },
  { category: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, confidence: "high" },
  {
    category: "assigned-secret",
    regex: /(api[_-]?key|secret|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["'][^"'\s]{16,}["']/gi,
    confidence: "low",
  },
];

const PLACEHOLDER = /(example|sample|dummy|fake|placeholder|your[-_ ]|xxxx|0000|1234|redacted|changeme|\*{4,}|<[^>]+>|test|abcde|abcdefgh|123456|0123456)/i;
const SKIP_PATH = /(^|\/)(node_modules|dist|dist-bin)\//;
/** Test/fixture sources legitimately hold fake credentials to test redaction. */
const FIXTURE_PATH = /(__tests__|\/tests?\/|\.test\.|\.spec\.|fixtures?\/|\/helpers\/)/;
/** Redaction regex definitions reference key shapes without containing one. */
const PATTERN_LINE = /(REDACTED|\.replace\(|new RegExp\(|PRIVATE KEY\(\?:|BEGIN \(\?:|-----END )/;

interface Hit {
  file: string;
  line: number;
  category: string;
  confidence: "high" | "low";
  placeholder: boolean;
  context: "source" | "fixture" | "pattern";
}

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

const hits: Hit[] = [];

for (const file of trackedFiles()) {
  if (SKIP_PATH.test(file)) continue;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    continue;
  }
  if (isBinary(buf)) continue;
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      const m = rule.regex.exec(line);
      if (!m) continue;
      const fixture = FIXTURE_PATH.test(file);
      const pattern = PATTERN_LINE.test(line);
      hits.push({
        file,
        line: i + 1,
        category: rule.category,
        confidence: rule.confidence,
        placeholder: PLACEHOLDER.test(m[0]),
        context: fixture ? "fixture" : pattern ? "pattern" : "source",
      });
      break; // one category per line is enough for a path:line report
    }
  }
}

const high = hits.filter((h) => h.confidence === "high");
const low = hits.filter((h) => h.confidence === "low");
const benign = (h: Hit) => h.placeholder || h.context !== "source";
const actionable = high.filter((h) => !benign(h));
const suspiciousLow = low.filter((h) => !benign(h));

console.log(`Scanned ${trackedFiles().length} tracked files.`);
console.log(
  `High-confidence credential shapes: ${high.length} (actionable in non-test source: ${actionable.length}; fixture: ${high.filter((h) => h.context === "fixture").length}; redaction-pattern: ${high.filter((h) => h.context === "pattern").length})`
);
console.log(
  `Low-confidence 'assigned secret' shapes: ${low.length} (actionable in non-test source: ${suspiciousLow.length})`
);

const report = (title: string, list: Hit[]) => {
  if (list.length === 0) return;
  console.log(`\n${title}:`);
  for (const h of list) {
    // path + line + category + context ONLY — never the matched value.
    console.log(`  ${h.file}:${h.line}  [${h.confidence}/${h.context}] ${h.category}`);
  }
};

report("Fixture hits (test/fixture sources — expected)", high.filter((h) => h.context === "fixture"));
report("Redaction-pattern hits (policy definitions — expected)", high.filter((h) => h.context === "pattern"));
report("ACTIONABLE high-confidence hits (non-test source)", actionable);
report("ACTIONABLE low-confidence hits (non-test source)", suspiciousLow);

if (actionable.length === 0 && suspiciousLow.length === 0) {
  console.log("\nRESULT: CLEAN — no non-test-source credentials in tracked files.");
  process.exit(0);
}

console.log(
  `\nRESULT: ${actionable.length + suspiciousLow.length} ACTIONABLE HIT(S) — rotate/remove before release (see paths above; values intentionally not printed).`
);
process.exit(1);
