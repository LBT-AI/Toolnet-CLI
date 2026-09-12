/**
 * Phase 79 §6 — Canonical model reference parsing.
 *
 * The whole point of this module is that `split("/")` is WRONG. OpenRouter
 * model ids contain slashes:
 *
 *   openrouter/anthropic/claude-sonnet
 *     → provider = "openrouter", model = "anthropic/claude-sonnet"
 *
 * So qualification is decided by whether the FIRST segment is a provider we
 * actually know about, never by counting slashes. When it is not, the entire
 * string is a provider-native model id (which may legitimately contain slashes).
 */

import { InvalidModelReferenceError } from "./errors";
import type { ModelRef } from "./types";

export interface ParseModelRefOptions {
  /**
   * Provider ids that may qualify a reference. Matching is case-insensitive.
   * Omit to parse unqualified references only.
   */
  knownProviders?: Iterable<string>;
  /**
   * Provider assumed when the reference is unqualified and the caller has a
   * default (e.g. the active provider).
   */
  defaultProvider?: string;
}

const WHITESPACE = /\s/;

/**
 * Parse a `provider/model` reference.
 *
 * @throws InvalidModelReferenceError for empty, whitespace-bearing, or
 *         slash-malformed input.
 */
export function parseModelRef(input: string, options: ParseModelRefOptions = {}): ModelRef {
  if (typeof input !== "string") {
    throw new InvalidModelReferenceError(String(input), "a model reference must be a string");
  }

  const raw = input.trim();
  if (!raw) {
    throw new InvalidModelReferenceError(input, "reference is empty");
  }
  if (WHITESPACE.test(raw)) {
    throw new InvalidModelReferenceError(raw, "reference must not contain whitespace");
  }
  if (raw.startsWith("/")) {
    throw new InvalidModelReferenceError(raw, "reference must not start with '/'");
  }
  if (raw.endsWith("/")) {
    throw new InvalidModelReferenceError(raw, "reference must not end with '/'");
  }
  if (raw.includes("//")) {
    throw new InvalidModelReferenceError(raw, "reference must not contain empty segments");
  }

  const separator = raw.indexOf("/");
  const known = normalizeProviderSet(options.knownProviders);

  if (separator === -1) {
    // Unqualified bare model id.
    return {
      raw,
      providerId: options.defaultProvider ? options.defaultProvider.toLowerCase() : undefined,
      modelId: raw,
    };
  }

  const first = raw.slice(0, separator);
  const rest = raw.slice(separator + 1);

  // Qualified ONLY when the first segment names a provider we know.
  if (known.has(first.toLowerCase())) {
    if (!rest) {
      throw new InvalidModelReferenceError(raw, "provider qualifier has no model");
    }
    return { raw, providerId: first.toLowerCase(), modelId: rest };
  }

  // Not a known provider → the whole string is a provider-native model id.
  return {
    raw,
    providerId: options.defaultProvider ? options.defaultProvider.toLowerCase() : undefined,
    modelId: raw,
  };
}

/** Non-throwing variant for validation paths. */
export function tryParseModelRef(
  input: string,
  options: ParseModelRefOptions = {},
): { ok: true; ref: ModelRef } | { ok: false; error: InvalidModelReferenceError } {
  try {
    return { ok: true, ref: parseModelRef(input, options) };
  } catch (error) {
    if (error instanceof InvalidModelReferenceError) return { ok: false, error };
    throw error;
  }
}

/** Canonical id for a provider-native model id. */
export function formatModelRef(providerId: string, apiModelId: string): string {
  return `${providerId.toLowerCase()}/${apiModelId}`;
}

export function isQualified(ref: ModelRef): boolean {
  return Boolean(ref.providerId);
}

function normalizeProviderSet(providers?: Iterable<string>): Set<string> {
  const set = new Set<string>();
  if (!providers) return set;
  for (const id of providers) {
    if (typeof id === "string" && id.trim()) set.add(id.trim().toLowerCase());
  }
  return set;
}
