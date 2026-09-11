/**
 * Phase 77.23 — Sample plugin: format after write.
 *
 * Opt-in only. Copy this file into `<workspace>/.toolnet/plugins/` and add it to
 * `.toolnet/plugins.json`:
 *
 *   { "plugins": ["./plugins/format-after-write.ts"] }
 *
 * Behaviour:
 *   - hooks `file.afterWrite`;
 *   - runs the formatter the project ALREADY has (prettier or biome, resolved
 *     from `node_modules/.bin` or PATH);
 *   - never installs anything;
 *   - never fails the tool call — a missing/slow/broken formatter is reported as
 *     a warning and the write stands.
 *
 * This is a `file.afterWrite` hook, which is transform-class: it may adjust the
 * reported result but cannot veto the write (correct — the file is already on
 * disk by the time it runs).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FORMATTABLE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".css", ".scss", ".md", ".yaml", ".yml",
]);

/** Resolve a formatter binary from the workspace, then PATH. Returns null if absent. */
function findFormatter(workspaceRoot: string, name: string): string | null {
  const local = path.join(workspaceRoot, "node_modules", ".bin", name);
  if (fs.existsSync(local)) return local;

  const probe = spawnSync(name, ["--version"], { stdio: "ignore" });
  return probe.error ? null : name;
}

/** Choose the formatter this project actually uses. */
function resolveProjectFormatter(workspaceRoot: string): { bin: string; label: string } | null {
  const manifestPath = path.join(workspaceRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return null;

  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }

  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };

  // Prefer the project's declared tooling; biomes wins only if prettier is absent.
  const order = "@biomejs/biome" in deps ? ["biome", "prettier"] : ["prettier", "biome"];
  for (const candidate of order) {
    const bin = findFormatter(workspaceRoot, candidate);
    if (bin) return { bin, label: candidate };
  }
  return null;
}

export default {
  id: "format-after-write",
  name: "Format after write",
  version: "1.0.0",

  setup(ctx: {
    workspaceRoot: string;
    logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void };
    registerHook: (
      name: string,
      handler: (invocation: { input: unknown; output: unknown }) => unknown,
    ) => void;
  }) {
    ctx.registerHook("file.afterWrite", (invocation) => {
      const payload = (invocation.output ?? {}) as { path?: string; tool?: string };
      const target = payload.path;
      if (typeof target !== "string" || !target) return;

      // Only touch files the project's formatter understands.
      if (!FORMATTABLE.has(path.extname(target).toLowerCase())) return;

      const formatter = resolveProjectFormatter(ctx.workspaceRoot);
      if (!formatter) {
        ctx.logger.info("no project formatter found — skipping", { path: target });
        return;
      }

      const absolute = path.isAbsolute(target) ? target : path.resolve(ctx.workspaceRoot, target);
      if (!fs.existsSync(absolute)) return;

      const result = spawnSync(formatter.bin, ["--write", absolute], {
        cwd: ctx.workspaceRoot,
        encoding: "utf8",
        timeout: 10_000,
      });

      // A formatter problem must never turn a successful write into a failure.
      if (result.error) {
        ctx.logger.warn(`${formatter.label} could not run`, { path: target, error: result.error.message });
        return;
      }
      if (result.status !== 0) {
        ctx.logger.warn(`${formatter.label} exited ${result.status}`, {
          path: target,
          stderr: String(result.stderr ?? "").slice(0, 500),
        });
      }
    });
  },

  dispose() {
    // Nothing held: each invocation spawns and exits. Kept explicit so the
    // lifecycle contract is visible in the example.
  },
};
