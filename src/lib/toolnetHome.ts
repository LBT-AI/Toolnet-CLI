/**
 * Canonical ToolNet Global User-Data Directory — Layer 4 Phase 3
 *
 * ALL global ToolNet state lives under ONE canonical root:
 *
 *   ~/.toolnetcli/
 *     config.json
 *     providers.json
 *     cli-keys.json      (mode 0600)
 *     auth_token         (mode 0600)
 *     sessions/
 *     cache/
 *     audit/
 *     plugins/
 *       registry.json
 *     telemetry/
 *     recovery/
 *     skills-state.json
 *
 * Override: TOOLNETCLI_CONFIG_DIR redirects the canonical root everywhere
 * (config, sessions, cache, audit, plugins — one override, one root).
 *
 * Legacy global dirs (migrated once, then never recreated by production):
 *   ~/.toolnet-cli/  → audit/, cache/, skills
 *   ~/.toolnet/      → plugins/, telemetry/, recovery/, auth_token
 *   ~/.toolnetapi/   → config.json, cli-keys.json (existing migration)
 *
 * PROJECT-LOCAL <workspace>/.toolnet is INTENTIONAL and untouched:
 * plan.md, permissions.json (policyEngine), personas.json, mcp.json,
 * skills/, index/ are project state — never migrated into HOME.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Canonical global root: $TOOLNETCLI_CONFIG_DIR or ~/.toolnetcli. */
export function getToolnetHome(): string {
  if (process.env.TOOLNETCLI_CONFIG_DIR) {
    return process.env.TOOLNETCLI_CONFIG_DIR;
  }
  // Resolve HOME manually: os.homedir() on Linux/CI may ignore HOME overrides
  // (bun caches the passwd entry), while tests and sandboxed installs rely on
  // HOME redirection. FALLBACK keeps non-unix behavior intact.
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".toolnetcli");
}

export function getToolnetConfigPath(): string {
  return path.join(getToolnetHome(), "config.json");
}

export function getToolnetProvidersPath(): string {
  return path.join(getToolnetHome(), "providers.json");
}

export function getToolnetKeysPath(): string {
  return path.join(getToolnetHome(), "cli-keys.json");
}

export function getToolnetSessionsDir(): string {
  return path.join(getToolnetHome(), "sessions");
}

export function getToolnetCacheDir(): string {
  return path.join(getToolnetHome(), "cache");
}

export function getToolnetAuditDir(): string {
  if (process.env.TOOLNET_AUDIT_DIR) return process.env.TOOLNET_AUDIT_DIR;
  return path.join(getToolnetHome(), "audit");
}

export function getToolnetPluginsDir(): string {
  return path.join(getToolnetHome(), "plugins");
}

export function getToolnetPluginRegistryPath(): string {
  return path.join(getToolnetPluginsDir(), "registry.json");
}

export function getToolnetTelemetryDir(): string {
  return path.join(getToolnetHome(), "telemetry");
}

export function getToolnetRecoveryDir(): string {
  return path.join(getToolnetHome(), "recovery");
}

export function getToolnetSkillsStatePath(): string {
  return path.join(getToolnetHome(), "skills-state.json");
}

export function getToolnetAuthTokenPath(): string {
  return path.join(getToolnetHome(), "auth_token");
}

/** Ensures a directory exists with user-only permissions. */
export function ensureToolnetDir(dir: string, mode: number = 0o700): string {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode });
    }
  } catch {}
  return dir;
}

// ── Legacy directories ─────────────────────────────────────────────────────

/** Legacy audit/cache/skills home (Phase ≤2). HOME resolved dynamically for tests. */
function legacyToolnetCliDir(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".toolnet-cli");
}

/** Legacy plugins/telemetry/recovery/auth home (Phase ≤2). */
function legacyToolnetDir(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".toolnet");
}

/**
 * Legacy metadata manifest written after a successful migration so repeated
 * startups don't rescan/re-migrate and don't recreate legacy dirs (test 33).
 */
const MIGRATION_MARKER = "legacy-migration.completed.json";

function markerPath(): string {
  return path.join(getToolnetHome(), MIGRATION_MARKER);
}

function readMarker(): { completedAt: string; moved: string[] } | null {
  try {
    const raw = fs.readFileSync(markerPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.moved)) return parsed;
  } catch {}
  return null;
}

function writeMarker(moved: string[]): void {
  try {
    fs.writeFileSync(
      markerPath(),
      JSON.stringify({ completedAt: new Date().toISOString(), moved }, null, 2),
      { mode: 0o600 }
    );
  } catch {}
}

export interface MigrationResult {
  performed: boolean;
  moved: string[];
  /** Non-empty legacy dirs that still hold unknown files (kept, warned). */
  preservedUnknown: string[];
  warnings: string[];
}

function copyFileAtomic(src: string, dest: string): boolean {
  try {
    if (!fs.existsSync(src)) return false;
    if (fs.existsSync(dest)) {
      // Canonical wins when it already exists and is newer or same age.
      const srcStat = fs.statSync(src);
      const destStat = fs.statSync(dest);
      if (destStat.mtimeMs >= srcStat.mtimeMs) return false;
    }
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(src, tmp);
    // Preserve source permissions (hardened below for sensitive files).
    try {
      fs.chmodSync(tmp, fs.statSync(src).mode & 0o777);
    } catch {}
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

function copyDirMerge(srcDir: string, destDir: string): { moved: number; kept: number } {
  let moved = 0;
  let kept = 0;
  try {
    if (!fs.existsSync(srcDir)) return { moved, kept };
    ensureToolnetDir(destDir);
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        const sub = copyDirMerge(src, dest);
        moved += sub.moved;
        kept += sub.kept;
      } else if (entry.isFile()) {
        if (copyFileAtomic(src, dest)) moved++;
        else kept++;
      }
    }
  } catch {}
  return { moved, kept };
}

/** Removes a directory tree ONLY when it contains nothing but migrated content. */
function removeDirIfEmptyOrMigrated(dir: string, migratedRelNames: Set<string>): boolean {
  try {
    if (!fs.existsSync(dir)) return true;
    const entries = fs.readdirSync(dir);
    // Any entry not part of the known migrated set → keep the dir.
    for (const e of entries) {
      if (!migratedRelNames.has(e)) return false;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Sensitive files that must be (re)hardened to mode 0600. */
const SENSITIVE_FILE_NAMES = new Set([
  "cli-keys.json",
  "auth_token",
  "cli-secret",
  "credentials.json",
]);

function hardenPermissions(home: string): void {
  try {
    // Home root user-only.
    try { fs.chmodSync(home, 0o700); } catch {}
    for (const sub of ["sessions", "audit", "plugins", "cache"]) {
      const p = path.join(home, sub);
      if (fs.existsSync(p)) {
        try { fs.chmodSync(p, 0o700); } catch {}
      }
    }
    for (const name of SENSITIVE_FILE_NAMES) {
      const p = path.join(home, name);
      if (fs.existsSync(p)) {
        try { fs.chmodSync(p, 0o600); } catch {}
      }
    }
  } catch {}
}

let migrationDone = false;

/**
 * One-time, idempotent legacy migration. Safe to call on every startup:
 * after the first successful pass the marker short-circuits further work.
 *
 * Guarantees:
 *  - never overwrites a NEWER canonical file (canonical-newer-wins),
 *  - never deletes unknown legacy files (kept + warning),
 *  - preserves file permissions, hardens sensitive files to 0600,
 *  - failure is non-fatal (CLI continues with canonical dirs).
 */
export function migrateLegacyToolnetState(): MigrationResult {
  const result: MigrationResult = { performed: false, moved: [], preservedUnknown: [], warnings: [] };
  if (migrationDone) return result;

  const home = getToolnetHome();
  const alreadyDone = readMarker();

  const legacyCli = legacyToolnetCliDir();
  const legacyToolnet = legacyToolnetDir();

  // Fresh install guard: nothing to migrate if no legacy dir exists.
  const hasLegacyCli = fs.existsSync(legacyCli);
  const hasLegacyToolnet = fs.existsSync(legacyToolnet);
  if (!hasLegacyCli && !hasLegacyToolnet) {
    migrationDone = true;
    return result;
  }

  // If migration already completed before, only ensure marker exists.
  if (alreadyDone) {
    migrationDone = true;
    return result;
  }

  result.performed = true;
  const migratedTopLevel = new Set<string>();

  // ── ~/.toolnet-cli/audit → ~/.toolnetcli/audit ──────────────────────────
  const cliAudit = path.join(legacyCli, "audit");
  if (fs.existsSync(cliAudit)) {
    const { moved } = copyDirMerge(cliAudit, getToolnetAuditDir());
    if (moved > 0) result.moved.push("audit");
    migratedTopLevel.add("audit");
  }

  // ── ~/.toolnet-cli/cache → ~/.toolnetcli/cache ──────────────────────────
  // Cache policy: merge file-wise, canonical-newer-wins; stale entries that
  // fail schema checks are simply files like any other — consumers validate
  // and invalidate on parse errors (deterministic, non-critical data).
  const cliCache = path.join(legacyCli, "cache");
  if (fs.existsSync(cliCache)) {
    const { moved } = copyDirMerge(cliCache, getToolnetCacheDir());
    if (moved > 0) result.moved.push("cache");
    migratedTopLevel.add("cache");
  }

  // ── ~/.toolnet-cli/skills-state.json + skills cache ─────────────────────
  const cliSkillsState = path.join(legacyCli, "skills-state.json");
  if (fs.existsSync(cliSkillsState) && copyFileAtomic(cliSkillsState, getToolnetSkillsStatePath())) {
    result.moved.push("skills-state.json");
  }
  const cliSkills = path.join(legacyCli, "skills");
  if (fs.existsSync(cliSkills)) {
    const { moved } = copyDirMerge(cliSkills, path.join(getToolnetCacheDir(), "skills"));
    if (moved > 0) result.moved.push("skills");
    migratedTopLevel.add("skills");
  }

  // ── ~/.toolnet/plugins → ~/.toolnetcli/plugins ──────────────────────────
  const legacyPlugins = path.join(legacyToolnet, "plugins");
  if (fs.existsSync(legacyPlugins)) {
    const { moved } = copyDirMerge(legacyPlugins, getToolnetPluginsDir());
    if (moved > 0) result.moved.push("plugins");
    migratedTopLevel.add("plugins");
  }

  // ── ~/.toolnet/telemetry + recovery + auth_token ────────────────────────
  const legacyTelemetry = path.join(legacyToolnet, "telemetry");
  if (fs.existsSync(legacyTelemetry)) {
    const { moved } = copyDirMerge(legacyTelemetry, getToolnetTelemetryDir());
    if (moved > 0) result.moved.push("telemetry");
    migratedTopLevel.add("telemetry");
  }
  const legacyRecovery = path.join(legacyToolnet, "recovery");
  if (fs.existsSync(legacyRecovery)) {
    const { moved } = copyDirMerge(legacyRecovery, getToolnetRecoveryDir());
    if (moved > 0) result.moved.push("recovery");
    migratedTopLevel.add("recovery");
  }
  const legacyToken = path.join(legacyToolnet, "auth_token");
  if (fs.existsSync(legacyToken) && copyFileAtomic(legacyToken, getToolnetAuthTokenPath())) {
    result.moved.push("auth_token");
    migratedTopLevel.add("auth_token");
  }

  // ── Hardening ────────────────────────────────────────────────────────────
  ensureToolnetDir(home);
  hardenPermissions(home);

  // ── Cleanup of legacy dirs ───────────────────────────────────────────────
  // Only remove when the dir holds nothing beyond migrated known content.
  const cliRemoved = removeDirIfEmptyOrMigrated(legacyCli, migratedTopLevel);
  if (!cliRemoved && fs.existsSync(legacyCli)) {
    result.preservedUnknown.push(legacyCli);
    result.warnings.push(`Legacy dir kept (unknown files present): ${legacyCli}`);
  }
  const tnRemoved = removeDirIfEmptyOrMigrated(legacyToolnet, migratedTopLevel);
  if (!tnRemoved && fs.existsSync(legacyToolnet)) {
    result.preservedUnknown.push(legacyToolnet);
    result.warnings.push(`Legacy dir kept (unknown files present): ${legacyToolnet}`);
  }

  writeMarker(result.moved);
  migrationDone = true;
  return result;
}

/** Test helper: reset the in-process migration latch (marker file intact). */
export function resetMigrationLatchForTests(): void {
  migrationDone = false;
}

/** Test helper: clear the on-disk migration marker. */
export function clearMigrationMarkerForTests(): void {
  try { fs.rmSync(markerPath(), { force: true }); } catch {}
}
