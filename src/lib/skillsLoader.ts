import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type SkillSource = "workspace" | "global" | "toolnet";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  filepath?: string;
  version?: string;
  category?: string;
  tags?: string[];
  capabilities?: string[];
  instructions?: string;
  instructionsLoaded?: boolean;
  enabled: boolean;
  isOfflineCache?: boolean;
}

export function getToolnetMcpUrl(): string {
  return process.env.TOOLNET_SKILLS_MCP_URL || "https://skills.toolnet.tech/mcp";
}

// Memory cache for metadata
let memoryRemoteSkillsCache: SkillInfo[] | null = null;
let memoryRemoteCacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function clearSkillsMemoryCache(): void {
  memoryRemoteSkillsCache = null;
  memoryRemoteCacheTime = 0;
}

function getToolnetCliDir(): string {
  const dir = process.env.DATA_DIR || process.env.TOOLNETCLI_CONFIG_DIR || path.join(os.homedir(), ".toolnet-cli");
  return dir;
}

function getCacheDir(): string {
  const cDir = path.join(getToolnetCliDir(), "cache");
  if (!fs.existsSync(cDir)) {
    try {
      fs.mkdirSync(cDir, { recursive: true });
    } catch {}
  }
  return cDir;
}

function getMetaCacheFile(): string {
  return path.join(getCacheDir(), "skills-meta.json");
}

function getSkillContentCacheDir(): string {
  const dir = path.join(getCacheDir(), "skills");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}

function getSkillsStateFile(): string {
  return path.join(getToolnetCliDir(), "skills-state.json");
}

export function loadDisabledSkills(): Set<string> {
  const file = getSkillsStateFile();
  if (!fs.existsSync(file)) return new Set();

  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.disabled)) {
      return new Set(data.disabled);
    }
  } catch {}
  return new Set();
}

export function saveDisabledSkills(disabled: Set<string>): void {
  const file = getSkillsStateFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }

  try {
    const data = { disabled: Array.from(disabled) };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

export function toggleSkillEnabled(id: string, explicitEnabled?: boolean): boolean {
  if (!id) return false;
  const disabled = loadDisabledSkills();
  const normId = id.toLowerCase().trim();

  const currentlyDisabled = disabled.has(normId);
  const nextEnabled = explicitEnabled !== undefined ? explicitEnabled : currentlyDisabled;

  if (nextEnabled) {
    disabled.delete(normId);
  } else {
    disabled.add(normId);
  }

  saveDisabledSkills(disabled);
  return nextEnabled;
}

/**
 * Parses YAML frontmatter and markdown instructions from a SKILL.md content string.
 */
export function parseSkillFile(
  content: string,
  filepath: string,
  source: SkillSource = "workspace"
): SkillInfo {
  let defaultName = path.basename(path.dirname(filepath));
  if (
    !defaultName ||
    defaultName === "." ||
    defaultName === "/" ||
    defaultName.endsWith("skills")
  ) {
    defaultName = path.basename(filepath, path.extname(filepath));
  }

  let name = defaultName;
  let description = "";
  let version: string | undefined;
  let category: string | undefined;
  let tags: string[] = [];
  let capabilities: string[] = [];
  let instructions = content.trim();

  let customId: string | undefined;

  // Match YAML frontmatter enclosed in --- at start of content
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  if (match) {
    const yamlBlock = match[1];
    instructions = match[2].trim();

    // ID
    const idMatch = yamlBlock.match(/^id:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m);
    if (idMatch) {
      customId = (idMatch[1] || idMatch[2] || idMatch[3]).trim();
    }

    // Name
    const nameMatch = yamlBlock.match(/^name:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m);
    if (nameMatch) {
      name = (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
    }

    // Description
    const descMatch = yamlBlock.match(/^description:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m);
    if (descMatch) {
      description = (descMatch[1] || descMatch[2] || descMatch[3]).trim();
    }

    // Version
    const verMatch = yamlBlock.match(/^version:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m);
    if (verMatch) {
      version = (verMatch[1] || verMatch[2] || verMatch[3]).trim();
    }

    // Category
    const catMatch = yamlBlock.match(/^category:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m);
    if (catMatch) {
      category = (catMatch[1] || catMatch[2] || catMatch[3]).trim();
    }

    // Tags
    const tagsMatch = yamlBlock.match(/^tags:\s*\n((?:\s*-\s*[^\r\n]+\r?\n?)+)/m);
    if (tagsMatch) {
      tags = tagsMatch[1]
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter((t) => t.length > 0);
    }
  }

  const rawId = customId || defaultName;
  const id = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");

  return {
    id,
    name,
    description,
    source,
    filepath,
    version,
    category,
    tags,
    capabilities,
    instructions,
    instructionsLoaded: true,
    enabled: true,
  };
}

function scanDirForSkillFiles(dirPath: string): string[] {
  const skillFiles: string[] = [];
  if (!fs.existsSync(dirPath)) return skillFiles;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        skillFiles.push(...scanDirForSkillFiles(fullPath));
      } else if (
        entry.isFile() &&
        (entry.name.toLowerCase() === "skill.md" || entry.name.toLowerCase().endsWith(".skill.md"))
      ) {
        skillFiles.push(fullPath);
      }
    }
  } catch {}
  return skillFiles;
}

/**
 * Loads Workspace local skills: <workspace>/.agents/skills/{name}/SKILL.md
 */
export function loadWorkspaceSkills(baseDir: string = process.cwd()): SkillInfo[] {
  const workspaceDirs = [
    path.join(baseDir, ".agents", "skills"),
    path.join(baseDir, ".toolnet", "skills"),
  ];

  const skillsMap = new Map<string, SkillInfo>();
  for (const dir of workspaceDirs) {
    const files = scanDirForSkillFiles(dir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const skill = parseSkillFile(content, file, "workspace");
        if (skill && skill.id && !skillsMap.has(skill.id)) {
          skillsMap.set(skill.id, skill);
        }
      } catch {}
    }
  }
  return Array.from(skillsMap.values());
}

/**
 * Loads Global local skills: ~/.toolnet-cli/skills/{name}/SKILL.md
 */
export function loadGlobalLocalSkills(): SkillInfo[] {
  const homeDir = os.homedir();
  const globalDirs = [
    path.join(homeDir, ".toolnet-cli", "skills"),
    path.join(homeDir, ".toolnet", "skills"),
    ...(process.env.DATA_DIR ? [path.join(process.env.DATA_DIR, "skills")] : []),
  ];

  const skillsMap = new Map<string, SkillInfo>();
  for (const dir of globalDirs) {
    const files = scanDirForSkillFiles(dir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const skill = parseSkillFile(content, file, "global");
        if (skill && skill.id && !skillsMap.has(skill.id)) {
          skillsMap.set(skill.id, skill);
        }
      } catch {}
    }
  }
  return Array.from(skillsMap.values());
}

/**
 * Performs JSON-RPC call over MCP HTTP protocol with timeout and retry.
 */
async function callMcpEndpoint(
  method: string,
  params: Record<string, any>,
  timeoutMs: number = 6000,
  maxRetries: number = 2
): Promise<any> {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: method,
      arguments: params,
    },
  };

  let lastError: Error | null = null;
  const mcpUrl = getToolnetMcpUrl();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      if (json.error) {
        throw new Error(`MCP JSON-RPC error: ${json.error.message || JSON.stringify(json.error)}`);
      }

      return json.result;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 300));
      }
    }
  }

  throw lastError || new Error("MCP call failed");
}

function readCachedRemoteMeta(): SkillInfo[] {
  const metaFile = getMetaCacheFile();
  if (!fs.existsSync(metaFile)) return [];

  try {
    const raw = fs.readFileSync(metaFile, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.skills)) {
      return data.skills.map((s: any) => ({
        ...s,
        source: "toolnet" as SkillSource,
        isOfflineCache: true,
      }));
    }
  } catch {}
  return [];
}

function saveCachedRemoteMeta(skills: SkillInfo[]): void {
  const metaFile = getMetaCacheFile();
  try {
    const data = {
      timestamp: Date.now(),
      skills: skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        category: s.category,
        tags: s.tags,
        capabilities: s.capabilities,
      })),
    };
    fs.writeFileSync(metaFile, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

/**
 * Fetches default ToolNet skills metadata from https://skills.toolnet.tech/mcp
 */
export async function fetchRemoteSkillsMetadata(
  forceRefresh: boolean = false
): Promise<{ skills: SkillInfo[]; isOffline: boolean }> {
  if (forceRefresh) {
    memoryRemoteSkillsCache = null;
    memoryRemoteCacheTime = 0;
  } else if (memoryRemoteSkillsCache && Date.now() - memoryRemoteCacheTime < CACHE_TTL_MS) {
    return { skills: memoryRemoteSkillsCache, isOffline: false };
  }

  try {
    const result = await callMcpEndpoint("list_skills", {}, 6000, 2);
    const contentText = result?.content?.[0]?.text;
    if (!contentText) {
      throw new Error("Empty MCP list_skills content");
    }

    const rawList = JSON.parse(contentText);
    if (!Array.isArray(rawList)) {
      throw new Error("Invalid list_skills response format");
    }

    const remoteSkills: SkillInfo[] = rawList.map((item: any) => {
      const id = (item.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
      return {
        id,
        name: item.name || id,
        description: item.description || "",
        source: "toolnet",
        version: item.version,
        category: item.category,
        tags: Array.isArray(item.tags) ? item.tags : [],
        capabilities: Array.isArray(item.capabilities) ? item.capabilities : [],
        instructions: undefined,
        instructionsLoaded: false,
        enabled: true,
        isOfflineCache: false,
      };
    });

    memoryRemoteSkillsCache = remoteSkills;
    memoryRemoteCacheTime = Date.now();
    saveCachedRemoteMeta(remoteSkills);

    return { skills: remoteSkills, isOffline: false };
  } catch {
    // Network / MCP failure -> fallback to disk cache
    const offlineCached = readCachedRemoteMeta();
    if (offlineCached.length > 0) {
      memoryRemoteSkillsCache = offlineCached;
      memoryRemoteCacheTime = Date.now();
      return { skills: offlineCached, isOffline: true };
    }
    return { skills: [], isOffline: true };
  }
}

/**
 * Fetches full markdown instructions of a ToolNet skill on-demand from MCP.
 */
export async function ensureSkillInstructions(skill: SkillInfo): Promise<SkillInfo> {
  // Workspace and global skills already have instructions loaded from file
  if (skill.instructionsLoaded && skill.instructions) {
    return skill;
  }
  if (skill.source !== "toolnet") {
    return skill;
  }

  const cacheDir = getSkillContentCacheDir();
  const cacheFile = path.join(cacheDir, `${skill.id}.md`);

  // Check disk content cache first
  if (fs.existsSync(cacheFile)) {
    try {
      const content = fs.readFileSync(cacheFile, "utf8");
      const parsed = parseSkillFile(content, cacheFile, "toolnet");
      skill.instructions = parsed.instructions;
      skill.instructionsLoaded = true;
      if (parsed.version) skill.version = parsed.version;
      if (parsed.tags && parsed.tags.length > 0) skill.tags = parsed.tags;
      if (parsed.category) skill.category = parsed.category;
      return skill;
    } catch {}
  }

  // Fetch from MCP get_skill
  try {
    const result = await callMcpEndpoint("get_skill", { name: skill.id }, 6000, 2);
    const contentText = result?.content?.[0]?.text;
    if (contentText) {
      const parsed = parseSkillFile(contentText, `${skill.id}.md`, "toolnet");
      skill.instructions = parsed.instructions;
      skill.instructionsLoaded = true;
      if (parsed.version) skill.version = parsed.version;
      if (parsed.tags && parsed.tags.length > 0) skill.tags = parsed.tags;
      if (parsed.category) skill.category = parsed.category;

      try {
        fs.writeFileSync(cacheFile, contentText, "utf8");
      } catch {}
      return skill;
    }
  } catch {}

  // Offline / Error fallback
  skill.instructions = skill.description || "(No instructions available offline)";
  skill.instructionsLoaded = true;
  skill.isOfflineCache = true;
  return skill;
}

/**
 * Loads all resolved skills with strict priority:
 * Workspace > Global > ToolNet
 * Removes duplicates automatically.
 */
export async function loadAllSkills(
  baseDir: string = process.cwd(),
  forceRefreshRemote: boolean = false
): Promise<SkillInfo[]> {
  const disabled = loadDisabledSkills();
  const skillsMap = new Map<string, SkillInfo>();

  // 1. Workspace Skills (highest priority)
  const workspaceSkills = loadWorkspaceSkills(baseDir);
  for (const s of workspaceSkills) {
    skillsMap.set(s.id, {
      ...s,
      enabled: !disabled.has(s.id),
    });
  }

  // 2. Global Local Skills (override toolnet, overridden by workspace)
  const globalSkills = loadGlobalLocalSkills();
  for (const s of globalSkills) {
    if (!skillsMap.has(s.id)) {
      skillsMap.set(s.id, {
        ...s,
        enabled: !disabled.has(s.id),
      });
    }
  }

  // 3. ToolNet Remote Default Skills (lowest priority)
  const remoteResult = await fetchRemoteSkillsMetadata(forceRefreshRemote);
  for (const s of remoteResult.skills) {
    if (!skillsMap.has(s.id)) {
      skillsMap.set(s.id, {
        ...s,
        enabled: !disabled.has(s.id),
        isOfflineCache: remoteResult.isOffline,
      });
    }
  }

  return Array.from(skillsMap.values());
}

/**
 * Synchronously loads resolved skills (using local files and cached remote metadata).
 */
export function loadResolvedSkillsSync(baseDir: string = process.cwd()): SkillInfo[] {
  const disabled = loadDisabledSkills();
  const skillsMap = new Map<string, SkillInfo>();

  // 1. Workspace
  const workspaceSkills = loadWorkspaceSkills(baseDir);
  for (const s of workspaceSkills) {
    skillsMap.set(s.id, {
      ...s,
      enabled: !disabled.has(s.id),
    });
  }

  // 2. Global
  const globalSkills = loadGlobalLocalSkills();
  for (const s of globalSkills) {
    if (!skillsMap.has(s.id)) {
      skillsMap.set(s.id, {
        ...s,
        enabled: !disabled.has(s.id),
      });
    }
  }

  // 3. Cached ToolNet
  const cached = memoryRemoteSkillsCache || readCachedRemoteMeta();
  for (const s of cached) {
    if (!skillsMap.has(s.id)) {
      skillsMap.set(s.id, {
        ...s,
        enabled: !disabled.has(s.id),
      });
    }
  }

  return Array.from(skillsMap.values());
}

/**
 * Backward compatibility helper for local workspace & global skills.
 */
export function loadLocalSkills(baseDir: string = process.cwd()): SkillInfo[] {
  const workspace = loadWorkspaceSkills(baseDir);
  const global = loadGlobalLocalSkills();
  const map = new Map<string, SkillInfo>();
  for (const w of workspace) map.set(w.id, w);
  for (const g of global) if (!map.has(g.id)) map.set(g.id, g);
  return Array.from(map.values());
}

/**
 * Retrieves a skill by name or ID across all sources (resolving instructions if needed).
 */
export async function getSkillById(
  idOrName: string,
  baseDir: string = process.cwd()
): Promise<SkillInfo | null> {
  if (!idOrName) return null;
  const target = idOrName.toLowerCase().trim();
  const all = await loadAllSkills(baseDir);

  const exact = all.find((s) => s.id === target || s.name.toLowerCase() === target);
  if (exact) {
    return await ensureSkillInstructions(exact);
  }

  const partial = all.find(
    (s) => s.id.includes(target) || s.name.toLowerCase().includes(target)
  );
  if (partial) {
    return await ensureSkillInstructions(partial);
  }

  return null;
}

/**
 * Synchronously retrieves a skill by ID/name from local files or cached metadata.
 */
export function getSkillByIdSync(
  idOrName: string,
  baseDir: string = process.cwd()
): SkillInfo | null {
  if (!idOrName) return null;
  const target = idOrName.toLowerCase().trim();
  const all = loadResolvedSkillsSync(baseDir);

  const exact = all.find((s) => s.id === target || s.name.toLowerCase() === target);
  if (exact) return exact;

  const partial = all.find(
    (s) => s.id.includes(target) || s.name.toLowerCase().includes(target)
  );
  return partial || null;
}

/**
 * Retrieves markdown prompt / instructions for a skill by name or ID.
 */
export async function getSkillPrompt(
  name: string,
  baseDir: string = process.cwd()
): Promise<string | null> {
  const skill = await getSkillById(name, baseDir);
  if (!skill || !skill.enabled) return null;
  return skill.instructions || skill.description || null;
}

/**
 * Triggers a force refresh from https://skills.toolnet.tech/mcp
 */
export async function refreshSkillsCache(): Promise<{ count: number; isOffline: boolean }> {
  const result = await fetchRemoteSkillsMetadata(true);
  return {
    count: result.skills.length,
    isOffline: result.isOffline,
  };
}
