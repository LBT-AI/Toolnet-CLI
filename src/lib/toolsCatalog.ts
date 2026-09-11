import { toolRegistry, type ToolDefinition as RegistryTool } from "./harness/toolRegistry";
import { pluginManager } from "./plugins/pluginManager";
import type { ListItem } from "../tui/renderers/listPanelRenderer";

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: unknown[];
}

export interface ToolInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required: string[];
  source: string;
  status: ListItem["status"];
}

const CATEGORY_RULES: Array<{ matcher: RegExp; category: string }> = [
  { matcher: /^(get_cwd|list_dir|tree|read_file|write_file|edit_file|replace_all|file_exists|apply_patch|patch|git_status|git_diff)$/i, category: "Workspace" },
  { matcher: /^(find_path|grep|grep_search|glob|glob_search)$/i, category: "Search" },
  { matcher: /^(shell|run_command|bash)$/i, category: "Shell" },
  { matcher: /^(web_fetch|web_search|web_crawl|fetch|fetch_web_page|audit_url|audit|browser|browser_action|playwright)$/i, category: "Web" },
  { matcher: /^(spawn_subagent|delegate_task|save_plan)$/i, category: "Agent" },
  { matcher: /^(create_artifact|update_artifact)$/i, category: "Artifacts" },
];

export function classifyTool(name: string): string {
  for (const rule of CATEGORY_RULES) {
    if (rule.matcher.test(name)) return rule.category;
  }
  return "MCP";
}

/**
 * Project a canonical registry entry into the UI view model.
 *
 * The registry is the single definition source, so the catalog never grows a
 * schema of its own — it only re-shapes metadata the model already sees.
 */
function fromRegistry(def: RegistryTool): ToolInfo {
  const params = (def.parameters ?? {}) as {
    properties?: Record<string, ToolParameter>;
    required?: unknown;
  };
  return {
    id: def.name,
    name: def.name,
    category: def.category || classifyTool(def.name),
    description: def.description || "",
    parameters: params.properties || {},
    required: Array.isArray(params.required) ? (params.required as string[]) : [],
    source: "local",
    status: "enabled",
  };
}

/** Plugin tools still arrive as OpenAI-style function schemas. */
function fromProviderSchema(raw: unknown, source: string): ToolInfo | null {
  const fn = (raw as { function?: { name?: string; description?: string; parameters?: { properties?: Record<string, ToolParameter>; required?: unknown } } })?.function;
  if (!fn?.name) return null;
  const params = fn.parameters || {};
  return {
    id: fn.name,
    name: fn.name,
    category: classifyTool(fn.name),
    description: fn.description || "",
    parameters: params.properties || {},
    required: Array.isArray(params.required) ? (params.required as string[]) : [],
    source,
    status: "enabled",
  };
}

export function getAllTools(): ToolInfo[] {
  const seen = new Set<string>();
  const tools: ToolInfo[] = [];

  // Canonical local tools only: aliases (bash/run_command/grep_search/glob_search)
  // stay dispatchable but are never surfaced as a separate tool definition.
  for (const def of toolRegistry.list()) {
    if (def.aliasOf || seen.has(def.name)) continue;
    seen.add(def.name);
    tools.push(fromRegistry(def));
  }

  for (const raw of pluginManager.getRegisteredTools()) {
    const info = fromProviderSchema(raw, "plugin");
    if (info && !seen.has(info.name)) {
      seen.add(info.name);
      tools.push(info);
    }
  }

  tools.sort((a, b) => {
    const cat = a.category.localeCompare(b.category);
    return cat !== 0 ? cat : a.name.localeCompare(b.name);
  });
  return tools;
}

export function getToolById(id: string): ToolInfo | null {
  if (!id) return null;
  const wanted = id.toLowerCase().replace(/^\/tools\s*/, "").trim();
  return getAllTools().find((t) => t.name.toLowerCase() === wanted) || null;
}

export function filterTools(items: ToolInfo[], query: string): ToolInfo[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q)
  );
}

export function toToolListItems(tools: ToolInfo[]): ListItem[] {
  return tools.map((t) => ({
    id: t.name,
    title: t.name,
    subtitle: t.category,
    description: t.category === "MCP" ? `${t.description}${t.source === "plugin" ? "" : " (MCP)"}` : t.description,
    status: t.status,
  }));
}

export function getToolListItems(query?: string): ListItem[] {
  return toToolListItems(filterTools(getAllTools(), query || ""));
}