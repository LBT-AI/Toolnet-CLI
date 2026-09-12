/**
 * Phase 79 §15/§16 — `toolnet models`, `toolnet model`, `toolnet providers`.
 *
 * Formatting only. Every fact printed here comes from the canonical layer
 * (`ProviderRegistry`, `ModelCatalog`, `ModelRouter`); this module never
 * constructs a provider, never fetches a model list itself, and never prints a
 * credential — only the *name* of the env var that holds a key and whether one
 * resolved.
 *
 * Capability rendering is deliberately tri-state: `yes` / `no` / `unknown`.
 * A capability the provider did not declare is printed as `unknown`, never
 * promoted to `yes`.
 */

import { getAppConfig, updateAppConfig } from "../lib/appConfig";
import {
  ROUTING_PROFILES,
  ROUTING_PROFILE_NAMES,
  addFallback,
  bootstrapProviderRegistry,
  currentSettings,
  describeProfile,
  getRoutingConfig,
  modelCatalog,
  modelRouter,
  parseModelRef,
  persistRoutingConfig,
  providerRegistry,
  refreshAllProviders,
  refreshProvider,
  removeFallback,
  resetPersistedRouting,
  setCachedProviderModels,
  type ModelDefinition,
  type ProviderDefinition,
} from "../core/models";

export interface ModelsCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: ModelsCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const MODELS_CLI_USAGE = `ToolNet models — provider registry, model catalog and routing

USAGE:
  toolnet providers [list|status] [--json]
                                    List registered providers with status, models,
                                    health and whether a key is present.
  toolnet models [--provider <id>] [--json]
                                    List catalog models with capabilities,
                                    context window, status and price.
  toolnet models refresh [<provider>]
                                    Refresh model metadata from providers.
                                    A failing provider keeps its previous models.
  toolnet model                     Show the current default model.
  toolnet model <provider/model>    Validate a reference and show its resolution.
  toolnet model set <provider/model>
                                    Persist it as the default model.
  toolnet routing [show] [--json]   Show the active routing profile, policy and fallbacks.
  toolnet routing profiles          List every routing profile with its weights.
  toolnet routing profile <name>    Persist the default routing profile.
  toolnet routing model <provider/model>
                                    Persist the default model.
  toolnet routing fallback add <provider/model>
  toolnet routing fallback remove <provider/model>
  toolnet routing reset             Restore default routing settings.

NOTES:
  · Model references are 'provider/model'; the model part may itself contain
    slashes (e.g. openrouter/anthropic/claude-sonnet).
  · Secrets are never printed — only env var names and presence.`;

export interface ModelsCliDeps {
  io?: ModelsCliIO;
}

/** Ensure the registry reflects current config before any read. */
function ensureRegistry(): void {
  try {
    bootstrapProviderRegistry();
  } catch {
    // A malformed config must not break the CLI; the registry stays as-is.
  }
}

function tri(value: boolean | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

/** Only declared-true capabilities; unknown is simply not claimed. */
function declaredCapabilities(model: ModelDefinition): string {
  const keys = Object.entries(model.capabilities)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  return keys.length > 0 ? keys.join(",") : "—";
}

function priceLabel(model: ModelDefinition): string {
  const input = model.pricing?.input;
  const output = model.pricing?.output;
  if (input === undefined && output === undefined) return "—";
  const fmt = (value: number | undefined) => (value === undefined ? "?" : String(value));
  return `${fmt(input)}+${fmt(output)}`;
}

function providerLine(provider: ProviderDefinition): string {
  const auth = provider.authentication?.apiKeyEnv
    ? `${provider.authentication.apiKeyEnv}:${provider.authentication.hasApiKey ? "set" : "unset"}`
    : "none";
  return [
    provider.id,
    `kind=${provider.kind}`,
    `status=${provider.status}`,
    `models=${provider.models.length}`,
    `health=${provider.health.state}`,
    `auth=${auth}`,
    `priority=${provider.priority}`,
    provider.enabled ? "enabled" : "disabled",
  ].join("  ");
}

function jsonPayload(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Structured, secret-free diagnostics for one provider. */
function providerDiagnostics(provider: ProviderDefinition) {
  return {
    id: provider.id,
    type: provider.kind,
    status: provider.status,
    enabled: provider.enabled,
    priority: provider.priority,
    auth: provider.authentication?.apiKeyEnv
      ? { envVar: provider.authentication.apiKeyEnv, configured: Boolean(provider.authentication.hasApiKey) }
      : null,
    health: {
      state: provider.health.state,
      requests: provider.health.requestCount,
      successes: provider.health.successCount,
      failures: provider.health.failureCount,
      consecutiveFailures: provider.health.consecutiveFailures,
      latencyMs: provider.health.latencyMs,
    },
    modelCount: provider.models.length,
  };
}

export async function runModelsCli(args: string[], deps: ModelsCliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo;
  const json = args.includes("--json");
  const help = args.includes("--help") || args.includes("-h");

  const positional = args.filter((arg) => !arg.startsWith("--"));
  const group = (positional[0] ?? "").toLowerCase();

  if (help) {
    io.out(MODELS_CLI_USAGE);
    return 0;
  }

  switch (group) {
    case "providers":
    case "providers-list":
      return listProviders(io, json, positional[1]);
    case "models":
      return listModels(io, json, args, positional);
    case "model":
      return handleModel(io, json, positional);
    case "routing":
      return handleRouting(io, json, positional);
    default:
      io.err(`Unknown models subcommand: ${group || "(none)"}`);
      io.err(MODELS_CLI_USAGE);
      return 1;
  }
}

// ── providers ───────────────────────────────────────────────────────────────

function listProviders(io: ModelsCliIO, json: boolean, sub: string | undefined): number {
  ensureRegistry();
  const providers = providerRegistry.list();

  if (sub && sub !== "list" && sub !== "status") {
    const single = providerRegistry.get(sub);
    if (!single) {
      io.err(`No provider registered with id '${sub}'.`);
      return 1;
    }
    io.out(json ? jsonPayload(providerDiagnostics(single)) : providerLine(single));
    return 0;
  }

  if (providers.length === 0) {
    io.out("No providers registered. Configure one with `toolnet provider add`.");
    return 0;
  }

  if (json) {
    io.out(jsonPayload(providers.map(providerDiagnostics)));
    return 0;
  }

  io.out(`Providers (${providers.length})`);
  io.out("─".repeat(60));
  for (const provider of providers) {
    io.out(`  ${providerLine(provider)}`);
    if (provider.health.lastError) io.out(`      last error: ${provider.health.lastError}`);
  }
  return 0;
}

// ── models ──────────────────────────────────────────────────────────────────

async function listModels(
  io: ModelsCliIO,
  json: boolean,
  args: string[],
  positional: string[],
): Promise<number> {
  ensureRegistry();

  if (positional[1]?.toLowerCase() === "refresh") {
    return refresh(args, positional, io, json);
  }

  const providerFilter = flagValue(args, "--provider");
  let models = modelCatalog.list();
  if (providerFilter) {
    models = modelCatalog.listByProvider(providerFilter.toLowerCase());
    if (models.length === 0 && !providerRegistry.has(providerFilter)) {
      io.err(`No provider registered with id '${providerFilter}'.`);
      return 1;
    }
  }

  if (models.length === 0) {
    io.out("No models in the catalog. Run `toolnet models refresh` to discover them.");
    return 0;
  }

  models = models.slice().sort((a, b) => a.providerId.localeCompare(b.providerId) || a.apiModelId.localeCompare(b.apiModelId));

  if (json) {
    io.out(
      jsonPayload(
        models.map((model) => ({
          id: model.id,
          provider: model.providerId,
          model: model.apiModelId,
          displayName: model.displayName,
          capabilities: model.capabilities,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          status: model.status,
          pricing: model.pricing ?? null,
        })),
      ),
    );
    return 0;
  }

  io.out(`Models (${models.length})`);
  io.out("─".repeat(118));
  io.out(
    pad("PROVIDER", 14) + pad("MODEL", 46) + pad("CAPABILITIES", 40) + pad("CONTEXT", 10) + "STATUS",
  );
  for (const model of models) {
    io.out(
      pad(model.providerId, 14) +
        pad(model.apiModelId, 46) +
        pad(declaredCapabilities(model), 40) +
        pad(model.contextWindow ? String(model.contextWindow) : "—", 10) +
        model.status,
    );
  }
  io.out("");
  io.out("Prices are USD per 1M tokens (input+output). `—` means the provider did not declare it.");
  return 0;
}

async function refresh(
  args: string[],
  positional: string[],
  io: ModelsCliIO,
  json: boolean,
): Promise<number> {
  const target = positional[2]?.toLowerCase();

  if (target === "--all") {
    io.err("Usage: toolnet models refresh [<provider>]");
    return 1;
  }
  void args;

  const results = target
    ? [await refreshProvider(target)]
    : await refreshAllProviders();

  // Phase 80.6 — persist discovery so the next CLI invocation does not need the
  // network. Provider-isolated: each success writes only its own entry, and a
  // failure leaves every other provider's cached models intact.
  for (const result of results) {
    if (!result.ok) continue;
    try {
      setCachedProviderModels(result.providerId, modelCatalog.listByProvider(result.providerId));
    } catch {
      // A cache write failure must never fail the refresh itself.
    }
  }

  if (results.length === 0) {
    io.out("No enabled providers to refresh.");
    return 0;
  }

  if (json) {
    io.out(jsonPayload(results));
  } else {
    for (const result of results) {
      if (result.ok) {
        io.out(`${result.providerId}: refreshed ${result.modelCount} model(s)`);
      } else {
        io.err(
          `${result.providerId}: refresh failed [${result.errorClass}] ${result.error ?? ""}` +
            (result.preservedPrevious ? " (previous models preserved)" : ""),
        );
      }
    }
  }

  const failed = results.filter((result) => !result.ok);
  // A refresh that fails everywhere is still not a crash — but it is non-zero.
  return failed.length === results.length ? 1 : 0;
}

// ── model ───────────────────────────────────────────────────────────────────

function handleModel(io: ModelsCliIO, json: boolean, positional: string[]): number {
  ensureRegistry();
  const action = positional[1]?.toLowerCase();

  if (!action) {
    const current = getAppConfig().defaultModel || "(not set)";
    io.out(json ? jsonPayload({ defaultModel: getAppConfig().defaultModel || null }) : `Current model: ${current}`);
    return 0;
  }

  const isSet = action === "set";
  const reference = isSet ? positional[2] : positional[1];

  if (!reference) {
    io.err(isSet ? "Usage: toolnet model set <provider/model>" : "Usage: toolnet model <provider/model>");
    return 1;
  }

  let resolved;
  try {
    resolved = modelRouter.resolve({ model: reference, policy: "explicit" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`Could not resolve '${reference}': ${message}`);
    return 1;
  }

  if (isSet) {
    updateAppConfig({ defaultModel: resolved.model.id });
  }

  const caps = resolved.model.capabilities;
  const detail = {
    requested: reference,
    resolved: resolved.model.id,
    provider: {
      id: resolved.provider.id,
      kind: resolved.provider.kind,
      status: resolved.provider.status,
      health: resolved.provider.health.state,
    },
    model: resolved.model.apiModelId,
    displayName: resolved.model.displayName,
    contextWindow: resolved.model.contextWindow ?? null,
    maxOutputTokens: resolved.model.maxOutputTokens ?? null,
    capabilities: {
      tools: tri(caps.tools),
      nativeToolCalls: tri(caps.nativeToolCalls),
      streaming: tri(caps.streaming),
      reasoning: tri(caps.reasoning),
      vision: tri(caps.vision),
      structuredOutput: tri(caps.structuredOutput),
      jsonMode: tri(caps.jsonMode),
      embeddings: tri(caps.embeddings),
      imageGeneration: tri(caps.imageGeneration),
    },
    pricing: resolved.model.pricing ?? null,
    routingReason: resolved.routingReason,
  };

  if (json) {
    io.out(jsonPayload(detail));
  } else {
    io.out(`Model:        ${detail.resolved}${isSet ? "  (saved as default)" : ""}`);
    io.out(`Provider:     ${detail.provider.id} (kind=${detail.provider.kind}, status=${detail.provider.status}, health=${detail.provider.health})`);
    io.out(`Context:      ${detail.contextWindow ?? "—"}   max output: ${detail.maxOutputTokens ?? "—"}`);
    io.out(
      `Capabilities: tools=${detail.capabilities.tools} nativeToolCalls=${detail.capabilities.nativeToolCalls} ` +
        `reasoning=${detail.capabilities.reasoning} streaming=${detail.capabilities.streaming} vision=${detail.capabilities.vision}`,
    );
    io.out(
      `Pricing:      ${
        detail.pricing
          ? `${detail.pricing.input ?? "?"}/${detail.pricing.output ?? "?"} USD per 1M in/out`
          : "not declared"
      }`,
    );
    io.out(`Routing:      ${detail.routingReason}`);
  }

  return 0;
}

// ── routing ─────────────────────────────────────────────────────────────────

function showRouting(io: ModelsCliIO, json: boolean): number {
  ensureRegistry();
  const config = getRoutingConfig();
  const resolvedFallbacks = config.fallback.map((reference) => sanitizeReference(reference));

  const payload = {
    ...config,
    fallback: resolvedFallbacks,
    persisted: safeSettings(),
  };
  if (json) {
    io.out(jsonPayload(payload));
    return 0;
  }
  io.out(`Routing profile:    ${config.profile}`);
  io.out(`Routing policy:     ${config.policy}`);
  io.out(`Max attempts:       ${config.maxAttempts}`);
  io.out(`Fallback chain:     ${resolvedFallbacks.length > 0 ? resolvedFallbacks.join(" → ") : "(none)"}`);
  io.out(`Excluded providers: ${config.excludedProviders.length > 0 ? config.excludedProviders.join(", ") : "(none)"}`);
  io.out("");
  io.out("Profiles: " + ROUTING_PROFILE_NAMES.join(", "));
  return 0;
}

function sanitizeReference(reference: string): string {
  try {
    return parseModelRef(reference, { knownProviders: providerRegistry.ids() }).raw;
  } catch {
    return `${reference} (invalid)`;
  }
}

function safeSettings() {
  try {
    return currentSettings();
  } catch {
    return null;
  }
}

/**
 * `toolnet routing …` — persist routing settings into the canonical config.
 * Every mutation is validated before it is written; an invalid value never
 * reaches the config file.
 */
function handleRouting(io: ModelsCliIO, json: boolean, positional: string[]): number {
  const action = (positional[1] ?? "show").toLowerCase();

  switch (action) {
    case "show":
      return showRouting(io, json);

    case "profiles": {
      const entries = ROUTING_PROFILE_NAMES.map((name) => {
        const profile = ROUTING_PROFILES[name];
        return { id: profile.id, label: profile.label, ranking: profile.ranking, policy: profile.policy, description: profile.description, weights: profile.weights };
      });
      if (json) {
        io.out(jsonPayload(entries));
        return 0;
      }
      for (const entry of entries) io.out(describeProfile(ROUTING_PROFILES[entry.id]));
      return 0;
    }

    case "profile": {
      const name = positional[2];
      if (!name) {
        io.err(`Usage: toolnet routing profile <name>`);
        io.err(`Profiles: ${ROUTING_PROFILE_NAMES.join(", ")}`);
        return 1;
      }
      const result = persistRoutingConfig({ profile: name });
      return reportMutation(io, json, result, `Default routing profile set to '${name}'.`);
    }

    case "model": {
      const reference = positional[2];
      if (!reference) {
        io.err("Usage: toolnet routing model <provider/model>");
        return 1;
      }
      return setDefaultModel(io, json, reference);
    }

    case "fallback": {
      const op = (positional[2] ?? "").toLowerCase();
      const reference = positional[3];
      if ((op !== "add" && op !== "remove") || !reference) {
        io.err("Usage: toolnet routing fallback <add|remove> <provider/model>");
        return 1;
      }
      const result = op === "add" ? addFallback(reference) : removeFallback(reference);
      return reportMutation(io, json, result, `Fallback ${op === "add" ? "added" : "removed"}: ${reference}`);
    }

    case "reset": {
      const settings = resetPersistedRouting();
      if (json) {
        io.out(jsonPayload(settings));
        return 0;
      }
      io.out("Routing settings reset to defaults.");
      return 0;
    }

    default:
      io.err(`Unknown routing subcommand: ${action}`);
      io.err(MODELS_CLI_USAGE);
      return 1;
  }
}

function setDefaultModel(io: ModelsCliIO, json: boolean, reference: string): number {
  ensureRegistry();
  let resolved;
  try {
    resolved = modelRouter.resolve({ model: reference, policy: "explicit" });
  } catch (error) {
    io.err(`Could not resolve '${reference}': ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  updateAppConfig({ defaultModel: resolved.model.id });
  if (json) {
    io.out(jsonPayload({ defaultModel: resolved.model.id }));
    return 0;
  }
  io.out(`Default model set to '${resolved.model.id}'.`);
  return 0;
}

function reportMutation(
  io: ModelsCliIO,
  json: boolean,
  result: { ok: true; settings: unknown } | { ok: false; errors: string[] },
  successMessage: string,
): number {
  if (!result.ok) {
    for (const error of result.errors) io.err(error);
    return 1;
  }
  if (json) {
    io.out(jsonPayload(result.settings));
    return 0;
  }
  io.out(successMessage);
  return 0;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function pad(value: string, width: number): string {
  const text = value.length > width - 2 ? `${value.slice(0, width - 3)}…` : value;
  return text.padEnd(width, " ");
}
