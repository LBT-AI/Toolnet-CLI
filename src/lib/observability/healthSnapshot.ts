/**
 * Health snapshot — read-only, no paid API calls.
 */
import fs from "node:fs";
import { providerRegistry } from "../../core/models/registry";
import { getToolnetSessionsDir } from "../toolnetHome";
import { getVersion } from "../version";

export type HealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface ComponentHealth {
  component: string;
  status: HealthStatus;
  detail?: string;
}

export interface HealthSnapshot {
  at: string;
  version: string;
  components: ComponentHealth[];
  summary: HealthStatus;
}

function rank(s: HealthStatus): number {
  switch (s) {
    case "unavailable": return 3;
    case "degraded": return 2;
    case "unknown": return 1;
    case "healthy": return 0;
  }
}

function worst(statuses: HealthStatus[]): HealthStatus {
  let w: HealthStatus = "healthy";
  for (const s of statuses) if (rank(s) > rank(w)) w = s;
  return w;
}

export function getHealthSnapshot(): HealthSnapshot {
  const components: ComponentHealth[] = [];
  // sessions dir
  try {
    const dir = getToolnetSessionsDir();
    const ok = fs.existsSync(dir);
    if (!ok) {
      try { fs.mkdirSync(dir, { recursive: true }); components.push({ component: "session_store", status: "healthy", detail: `created ${dir}` }); }
      catch { components.push({ component: "session_store", status: "degraded", detail: `not writable: ${dir}` }); }
    } else {
      try { fs.accessSync(dir, fs.constants.W_OK); components.push({ component: "session_store", status: "healthy", detail: dir }); }
      catch { components.push({ component: "session_store", status: "degraded", detail: `not writable: ${dir}` }); }
    }
  } catch (e: any) { components.push({ component: "session_store", status: "unknown", detail: String(e?.message ?? e) }); }

  // provider registry
  try {
    const ids = providerRegistry.ids();
    if (ids.length === 0) components.push({ component: "provider_registry", status: "unknown", detail: "no providers registered" });
    else {
      let anyUnavailable = false, anyDegraded = false;
      for (const id of ids) {
        const h = providerRegistry.healthOf(id).state;
        if (h === "unavailable") anyUnavailable = true;
        else if (h === "degraded") anyDegraded = true;
      }
      if (anyUnavailable) components.push({ component: "provider_registry", status: "unavailable", detail: `${ids.length} provider(s), some unavailable` });
      else if (anyDegraded) components.push({ component: "provider_registry", status: "degraded", detail: `${ids.length} provider(s), some degraded` });
      else components.push({ component: "provider_registry", status: "healthy", detail: `${ids.length} provider(s)` });
    }
  } catch (e: any) { components.push({ component: "provider_registry", status: "unknown", detail: String(e?.message ?? e) }); }

  // Session count from the directory listing only. The snapshot is rendered on
  // interactive paths (doctor, health), so it must not walk every record, and
  // it must not trigger the store's self-healing index rebuild — a read-only
  // probe that writes is a surprising side effect. Deep integrity scanning
  // stays in `toolnet session doctor`, which a user runs deliberately.
  try {
    const entries = fs.readdirSync(getToolnetSessionsDir(), { withFileTypes: true });
    const records = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."));
    components.push({ component: "sessions", status: "healthy", detail: `${records.length} session(s)` });
  } catch (e: any) { components.push({ component: "sessions", status: "unknown", detail: String(e?.message ?? e) }); }

  // mcp / lsp / external harnesses — unknown when not configured, never probes network
  components.push({ component: "mcp", status: "unknown", detail: "not probed (no paid calls)" });
  components.push({ component: "lsp", status: "unknown", detail: "not probed" });
  components.push({ component: "external_harness", status: "unknown", detail: "not probed" });

  const summary = worst(components.map(c => c.status));
  return { at: new Date().toISOString(), version: getVersion(), components, summary };
}
