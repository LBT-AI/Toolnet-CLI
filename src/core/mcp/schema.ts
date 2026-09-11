/**
 * Phase 77.17 — MCP schema normalization.
 *
 * A remote MCP server is UNTRUSTED input. Everything it returns is treated as
 * data that must be validated and bounded before it can enter the model
 * context:
 *
 *   - the tool name must be a non-empty string in the provider-legal charset
 *   - the description is truncated to a hard character cap
 *   - `inputSchema` must be object-shaped and within depth/property/byte caps
 *   - `required` is intersected with the declared properties
 *
 * A tool that cannot be normalized is REJECTED (with a reason) rather than
 * passed through half-valid — a malformed schema would otherwise be sent to the
 * model verbatim.
 */

import type { ToolRisk } from "../../lib/harness/toolRegistry";

export const MCP_MAX_DESCRIPTION_CHARS = 1_200;
export const MCP_MAX_SCHEMA_PROPERTIES = 60;
export const MCP_MAX_SCHEMA_DEPTH = 6;
export const MCP_MAX_SCHEMA_BYTES = 24 * 1024;
export const MCP_MAX_NAME_CHARS = 64;

export interface NormalizedMcpTool {
  /** Original tool name as declared by the server. */
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  risk: ToolRisk;
  /** Non-fatal adjustments made during normalization. */
  warnings: string[];
}

export type NormalizeMcpToolResult =
  | { ok: true; value: NormalizedMcpTool }
  | { ok: false; reason: string };

/** Provider-legal and collision-safe tool name. */
function sanitizeToolName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MCP_MAX_NAME_CHARS);
}

/** Maximum nesting depth of a JSON value. */
function depthOf(value: unknown, current = 0): number {
  if (current > MCP_MAX_SCHEMA_DEPTH) return current;
  if (!value || typeof value !== "object") return current;
  let max = current;
  for (const child of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, depthOf(child, current + 1));
  }
  return max;
}

function truncateDescription(description: string): { text: string; truncated: boolean } {
  if (description.length <= MCP_MAX_DESCRIPTION_CHARS) return { text: description, truncated: false };
  return {
    text: `${description.slice(0, MCP_MAX_DESCRIPTION_CHARS)}\n[MCP tool description truncated]`,
    truncated: true,
  };
}

/**
 * Derive a risk tier from MCP annotations when present, then from the tool name.
 *
 * MCP servers may declare `readOnlyHint` / `destructiveHint`; those are hints,
 * but they are strictly better evidence than the name alone. Anything that is
 * not explicitly read-only is treated as mutating so permission asks.
 */
export function deriveMcpToolRisk(name: string, annotations: unknown): ToolRisk {
  const record = annotations && typeof annotations === "object" ? (annotations as Record<string, unknown>) : null;
  if (record?.destructiveHint === true) return "execute";
  if (record?.readOnlyHint === true) return "read";

  const bare = name.startsWith("mcp__") ? name.split("__")[2] || name : name;
  if (/^(read|list|get|inspect|search|find|view|query|fetch|show|describe)/i.test(bare)) return "read";
  return "write";
}

/**
 * Normalize one raw tool definition from `tools/list`.
 * Returns a typed failure instead of throwing so one bad tool never aborts
 * discovery for the whole server.
 */
export function normalizeMcpToolDefinition(raw: unknown): NormalizeMcpToolResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "tool definition is not an object" };
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.name !== "string" || !record.name.trim()) {
    return { ok: false, reason: "tool definition has no name" };
  }

  const name = sanitizeToolName(record.name);
  if (!name) {
    return { ok: false, reason: `tool name '${record.name}' has no usable characters` };
  }

  const warnings: string[] = [];
  if (name !== record.name.trim()) {
    warnings.push(`tool name '${record.name}' sanitized to '${name}'`);
  }

  const rawDescription = typeof record.description === "string" ? record.description : "";
  const description = truncateDescription(rawDescription);
  if (description.truncated) {
    warnings.push(`description truncated to ${MCP_MAX_DESCRIPTION_CHARS} characters`);
  }

  const rawSchema = record.inputSchema;
  if (rawSchema !== undefined && (typeof rawSchema !== "object" || rawSchema === null || Array.isArray(rawSchema))) {
    return { ok: false, reason: `tool '${name}' has a non-object inputSchema` };
  }

  const schemaRecord = (rawSchema as Record<string, unknown> | undefined) ?? {};
  const declaredType = schemaRecord.type;
  if (declaredType !== undefined && declaredType !== "object") {
    return { ok: false, reason: `tool '${name}' inputSchema type must be 'object' (got '${String(declaredType)}')` };
  }

  if (depthOf(schemaRecord) > MCP_MAX_SCHEMA_DEPTH) {
    return { ok: false, reason: `tool '${name}' inputSchema exceeds max depth ${MCP_MAX_SCHEMA_DEPTH}` };
  }

  const rawProperties = schemaRecord.properties;
  let properties: Record<string, unknown> = {};
  if (rawProperties !== undefined) {
    if (typeof rawProperties !== "object" || rawProperties === null || Array.isArray(rawProperties)) {
      return { ok: false, reason: `tool '${name}' inputSchema.properties must be an object` };
    }
    const entries = Object.entries(rawProperties as Record<string, unknown>);
    if (entries.length > MCP_MAX_SCHEMA_PROPERTIES) {
      return {
        ok: false,
        reason: `tool '${name}' declares ${entries.length} properties (limit ${MCP_MAX_SCHEMA_PROPERTIES})`,
      };
    }
    properties = Object.fromEntries(entries);
  }

  const rawRequired = schemaRecord.required;
  let required: string[] = [];
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired)) {
      return { ok: false, reason: `tool '${name}' inputSchema.required must be an array` };
    }
    // Only keep required names that actually exist; a dangling required entry
    // makes providers reject the whole tool schema.
    required = rawRequired.filter((item): item is string => typeof item === "string" && item in properties);
    if (required.length !== rawRequired.length) {
      warnings.push(`dropped required entries that are not declared properties`);
    }
  }

  const parameters = { type: "object" as const, properties, required };

  const bytes = Buffer.byteLength(JSON.stringify(parameters), "utf8");
  if (bytes > MCP_MAX_SCHEMA_BYTES) {
    return { ok: false, reason: `tool '${name}' inputSchema is ${bytes} bytes (limit ${MCP_MAX_SCHEMA_BYTES})` };
  }

  return {
    ok: true,
    value: {
      name,
      description: description.text || `MCP tool '${name}'`,
      parameters,
      risk: deriveMcpToolRisk(name, record.annotations),
      warnings,
    },
  };
}
