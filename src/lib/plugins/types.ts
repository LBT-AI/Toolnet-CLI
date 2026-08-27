export const CURRENT_PLUGIN_API_VERSION = 1;

export type PluginCapability =
  | "filesystem.read"
  | "filesystem.write"
  | "shell"
  | "network"
  | "secrets"
  | "scm";

export const ALL_PLUGIN_CAPABILITIES: PluginCapability[] = [
  "filesystem.read",
  "filesystem.write",
  "shell",
  "network",
  "secrets",
  "scm",
];

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  toolnet: {
    apiVersion: number;
    entry: string;
    capabilities?: PluginCapability[];
  };
}

export interface PluginToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  requiredCapabilities?: PluginCapability[];
  execute: (args: any, context: PluginExecutionContext) => Promise<unknown> | unknown;
}

export interface PluginCommandDefinition {
  name: string;
  description: string;
  execute: (args: string[], context: any) => Promise<unknown> | unknown;
}

export interface PluginExecutionContext {
  cwd: string;
  sessionId?: string;
  hasCapability: (cap: PluginCapability) => boolean;
}

export interface PluginApi {
  defineTool: (tool: PluginToolDefinition) => void;
  defineCommand: (cmd: PluginCommandDefinition) => void;
  onAgentStart?: (handler: (context: any) => void) => void;
  onAgentEnd?: (handler: (context: any) => void) => void;
  onToolCall?: (handler: (call: any) => void) => void;
}

export interface InstalledPluginInfo {
  name: string;
  version: string;
  description?: string;
  installPath: string;
  manifest: PluginManifest;
  grantedCapabilities: PluginCapability[];
  enabled: boolean;
  installedAt: number;
  lastError?: string;
}
