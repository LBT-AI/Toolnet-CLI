import fs from "node:fs";
import path from "node:path";
import { type PluginManifest, CURRENT_PLUGIN_API_VERSION, ALL_PLUGIN_CAPABILITIES, type PluginCapability } from "./types";

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  error?: string;
  errorCode?: "INVALID_JSON" | "MISSING_FIELDS" | "PLUGIN_API_VERSION_INCOMPATIBLE" | "INVALID_CAPABILITIES";
}

export function validatePluginManifest(raw: any): ManifestValidationResult {
  if (!raw || typeof raw !== "object") {
    return { valid: false, error: "Manifest must be a JSON object", errorCode: "INVALID_JSON" };
  }

  if (!raw.name || typeof raw.name !== "string" || !raw.version || typeof raw.version !== "string") {
    return { valid: false, error: "Manifest missing required 'name' or 'version'", errorCode: "MISSING_FIELDS" };
  }

  if (!raw.toolnet || typeof raw.toolnet !== "object") {
    return { valid: false, error: "Manifest missing 'toolnet' configuration block", errorCode: "MISSING_FIELDS" };
  }

  const { apiVersion, entry, capabilities } = raw.toolnet;

  if (typeof apiVersion !== "number") {
    return { valid: false, error: "Manifest missing 'toolnet.apiVersion' number", errorCode: "MISSING_FIELDS" };
  }

  if (apiVersion !== CURRENT_PLUGIN_API_VERSION) {
    return {
      valid: false,
      error: `PLUGIN_API_VERSION_INCOMPATIBLE: Plugin '${raw.name}' requires apiVersion ${apiVersion}, but ToolNet supports apiVersion ${CURRENT_PLUGIN_API_VERSION}`,
      errorCode: "PLUGIN_API_VERSION_INCOMPATIBLE",
    };
  }

  if (!entry || typeof entry !== "string") {
    return { valid: false, error: "Manifest missing 'toolnet.entry' file path", errorCode: "MISSING_FIELDS" };
  }

  const validatedCapabilities: PluginCapability[] = [];
  if (capabilities) {
    if (!Array.isArray(capabilities)) {
      return { valid: false, error: "Capabilities must be an array of capability strings", errorCode: "INVALID_CAPABILITIES" };
    }
    for (const cap of capabilities) {
      if (!ALL_PLUGIN_CAPABILITIES.includes(cap)) {
        return {
          valid: false,
          error: `Unknown capability '${cap}'. Valid capabilities: ${ALL_PLUGIN_CAPABILITIES.join(", ")}`,
          errorCode: "INVALID_CAPABILITIES",
        };
      }
      validatedCapabilities.push(cap);
    }
  }

  const manifest: PluginManifest = {
    name: raw.name,
    version: raw.version,
    description: raw.description,
    author: raw.author,
    toolnet: {
      apiVersion,
      entry,
      capabilities: validatedCapabilities,
    },
  };

  return { valid: true, manifest };
}

export function loadPluginManifestFromDir(pluginDir: string): ManifestValidationResult {
  const manifestPath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return { valid: false, error: `package.json not found in ${pluginDir}`, errorCode: "MISSING_FIELDS" };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return validatePluginManifest(raw);
  } catch (err: any) {
    return { valid: false, error: `Failed to parse package.json: ${err.message}`, errorCode: "INVALID_JSON" };
  }
}
