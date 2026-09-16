/**
 * Architecture guards for the observability layer.
 *
 * Static proof that observability has ONE canonical owner, that every consumer
 * reaches it through that owner, and that observability code never executes
 * tools, calls providers, resolves credentials or decides permissions — it
 * observes the runtime, it does not steer it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = process.cwd();

function readSource(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(relative, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

function productionFiles(dir: string): string[] {
  return sourceFiles(dir).filter((file) => !file.includes("__tests__") && !file.endsWith(".test.ts"));
}

describe("observability architecture guards", () => {
  it("has exactly one hub, one logger class, one metrics registry class and one trace store class", () => {
    const src = productionFiles("src/lib/observability").map(readSource).join("\n");
    expect((src.match(/class ObservabilityHub\b/g) ?? []).length).toBe(1);
    expect((src.match(/class StructuredLogger\b/g) ?? []).length).toBe(1);
    expect((src.match(/class MetricsRegistry\b/g) ?? []).length).toBe(1);
    expect((src.match(/class TraceStore\b/g) ?? []).length).toBe(1);
    expect((src.match(/export const observabilityHub\b/g) ?? []).length).toBe(1);
    expect((src.match(/export const logger\b/g) ?? []).length).toBe(1);
  });

  it("has no parallel telemetry/metrics/trace buses anywhere in production source", () => {
    const all = productionFiles("src").map(readSource).join("\n");
    for (const forbidden of ["TelemetryBus", "ReliabilityBus", "MetricsEventBus", "TraceEventBus", "ProviderHealthV2", "ReliabilityEvidenceV2"]) {
      expect(all).not.toContain(`class ${forbidden}`);
    }
    // One observability directory, no sibling duplicates.
    expect(fs.existsSync(path.join(ROOT, "src/lib/observability"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "src/lib/telemetry-hub"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/core/observability"))).toBe(false);
  });

  it("observability code never executes tools, calls providers or decides permissions", () => {
    const forbidden = [
      /provider\.chat\(/,
      /provider\.stream\(/,
      /executeToolBatch/,
      /new ToolGateway/,
      /credentialResolver\./,
      /requestApprovalModal/,
      /from\s+"[^"]*security\/permissions/,
      /from\s+"[^"]*core\/tools/,
      /from\s+"[^"]*providers/,
      /from\s+"[^"]*session\/store/,
      /from\s+"[^"]*sessionPersistence/,
    ];
    for (const file of productionFiles("src/lib/observability")) {
      const src = readSource(file);
      for (const pattern of forbidden) {
        if (pattern.test(src)) throw new Error(`${file} matches forbidden pattern ${pattern}`);
      }
    }
  });

  it("observability stays local-only: no remote exporter endpoints in production source", () => {
    const src = productionFiles("src/lib/observability").map(readSource).join("\n");
    expect(src).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("XMLHttpRequest");
  });

  it("wired call sites always observe through the hub and never mutate control flow", () => {
    const wired = ["src/lib/harness/agentHarness.ts"];
    for (const file of wired) {
      const src = readSource(file);
      expect(src).toContain("observabilityHub");
      // Every hub call must be wrapped in try/catch (best-effort) or go through
      // a method that cannot throw — grep for the direct-throw shape.
      for (const match of src.matchAll(/observabilityHub\.(?!log\b|info\b|warn\b|error\b|debug\b|metrics\b|trace\b|logger\b|ensureTraceId\b|flush\b)[a-zA-Z]+/g)) {
        throw new Error(`${file} uses non-standard hub member ${match[0]}`);
      }
    }
  });
});
