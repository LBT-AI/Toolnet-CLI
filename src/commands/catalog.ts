/**
 * Phase 80 §8 — `/catalog`, the read-only Model Catalog view in the TUI.
 *
 * The TUI is a CONSUMER here: it reads the canonical ModelCatalog,
 * ProviderRegistry and ProviderHealth through the shared `buildCatalogRows`
 * projection. It never constructs a provider, never performs network I/O, and
 * never writes config.
 *
 * Selection reuses the same path `/model <id>` uses (`ctx.setModel`), so the
 * catalog view cannot become a second place that mutates model state.
 */

import {
  CAPABILITY_KEYS,
  buildCatalogRows,
  currentSettings,
  getRoutingConfig,
  priceLabel,
  providerRegistry,
  triState,
  type CapabilityKey,
  type CatalogFilter,
} from "../core/models";
import type { Command, CommandContext } from "./index";

const MAX_ROWS = 40;

export function parseCatalogArgs(args: string[]): { filter: CatalogFilter; use?: string; error?: string } {
  const filter: CatalogFilter = {};
  let use: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider" || arg === "--from") {
      filter.provider = args[++i];
    } else if (arg === "--capability" || arg === "--cap") {
      const value = args[++i] as CapabilityKey;
      if (!CAPABILITY_KEYS.includes(value)) {
        return { filter, error: `Unknown capability '${value}'. Known: ${CAPABILITY_KEYS.join(", ")}.` };
      }
      filter.capability = value;
    } else if (arg === "--free") {
      filter.pricing = "free";
    } else if (arg === "--paid") {
      filter.pricing = "paid";
    } else if (arg === "--use") {
      use = args[++i];
    } else if (!arg.startsWith("--")) {
      filter.search = filter.search ? `${filter.search} ${arg}` : arg;
    }
  }

  return { filter, use };
}

export function renderCatalogLines(options: {
  filter?: CatalogFilter;
  profile?: string;
  policy?: string;
} = {}): string[] {
  const view = buildCatalogRows({ filter: options.filter });
  const lines: string[] = [];

  const profile = options.profile ?? "auto";
  const policy = options.policy ?? "priority";
  lines.push(`Model catalog — profile=${profile} policy=${policy}`);
  lines.push(
    `Filters: ${describeFilter(view.filter)}   (showing ${view.rows.length}/${view.totalBeforeFilter})`,
  );

  if (view.rows.length === 0) {
    lines.push("");
    lines.push(
      view.totalBeforeFilter === 0
        ? "Catalog is empty. Run `toolnet models refresh` to discover models."
        : "No model matches the current filters.",
    );
    return lines;
  }

  lines.push("");
  lines.push(
    pad("MODEL", 40) + pad("PROVIDER", 14) + pad("CONTEXT", 9) + pad("TOOLS", 6) + pad("REASON", 7) + pad("VISION", 7) + pad("PRICE", 12) + "HEALTH",
  );
  lines.push("─".repeat(104));

  for (const row of view.rows.slice(0, MAX_ROWS)) {
    lines.push(
      pad(row.apiModelId, 40) +
        pad(row.providerId, 14) +
        pad(row.contextWindow ? String(row.contextWindow) : "—", 9) +
        pad(triState(row.capabilities.tools), 6) +
        pad(triState(row.capabilities.reasoning), 7) +
        pad(triState(row.capabilities.vision), 7) +
        pad(priceLabel(row.pricing), 12) +
        row.health,
    );
  }

  if (view.rows.length > MAX_ROWS) {
    lines.push(`… ${view.rows.length - MAX_ROWS} more (narrow with a search term or --provider)`);
  }

  lines.push("");
  lines.push("Price is USD per 1M tokens (input/output); `—` means the provider declared no pricing.");
  lines.push("Capabilities are tri-state: unknown is never shown as yes.");
  return lines;
}

export const catalogCommand: Command = {
  name: "catalog",
  aliases: ["catalog-models"],
  description: "Browse the model catalog (capabilities, context, price, health)",
  usage: "/catalog [--provider <id>] [--capability <name>] [--free|--paid] [--use <model>] [search]",
  async handler(args: string[], ctx: CommandContext) {
    const { filter, use, error } = parseCatalogArgs(args);
    if (error) {
      ctx.addMessage("assistant", error);
      return;
    }

    // Selection goes through the SAME path as `/model <id>`.
    if (use) {
      ctx.setModel(use);
      ctx.addMessage("assistant", `Model set to: ${use}`);
      return;
    }

    let profile = "auto";
    let policy = "priority";
    try {
      const config = getRoutingConfig();
      profile = config.profile;
      policy = config.policy;
    } catch {
      try {
        const settings = currentSettings();
        profile = settings.profile;
        policy = settings.policy;
      } catch {}
    }

    // Touch the registry so any lazily-registered provider is present.
    void providerRegistry.size();

    ctx.addMessage("assistant", renderCatalogLines({ filter, profile, policy }).join("\n"));
  },
};

function describeFilter(filter: CatalogFilter): string {
  const parts: string[] = [];
  if (filter.provider) parts.push(`provider=${filter.provider}`);
  if (filter.capability) parts.push(`capability=${filter.capability}`);
  if (filter.pricing) parts.push(`pricing=${filter.pricing}`);
  if (filter.search) parts.push(`search="${filter.search}"`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

function pad(value: string, width: number): string {
  const text = value.length > width - 1 ? `${value.slice(0, width - 2)}…` : value;
  return text.padEnd(width, " ");
}
