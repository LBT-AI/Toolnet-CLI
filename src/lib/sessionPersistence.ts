import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface SessionMessage {
  role: string;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  [key: string]: any;
}

export interface SavedSession {
  sessionId: string;
  messages: SessionMessage[];
  metadata?: Record<string, any>;
  updatedAt: string;
}

export function getSessionsDir(): string {
  if (process.env.TOOLNETCLI_SESSIONS_DIR) {
    return process.env.TOOLNETCLI_SESSIONS_DIR;
  }
  if (process.env.TOOLNETAPI_SESSIONS_DIR) {
    return process.env.TOOLNETAPI_SESSIONS_DIR;
  }
  if (process.env.DATA_DIR) {
    return path.join(process.env.DATA_DIR, "sessions");
  }
  return path.join(os.homedir(), ".toolnetcli", "sessions");
}

export function formatExitMessage(sessionId?: string, hasContent = false): string {
  if (hasContent && sessionId && !sessionId.startsWith("turbo-") && !sessionId.startsWith("temp-")) {
    return `\n\x1b[32mSession saved.\x1b[0m\n\nResume with:\n\x1b[1m\x1b[36mtoolnet resume ${sessionId}\x1b[0m\n\nGoodbye!\n`;
  }
  return "Goodbye!\n";
}

export function saveSession(sessionId: string, messages: any[], metadata?: any): void {
  if (!sessionId) return;
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const formattedMessages: SessionMessage[] = (messages || []).map(msg => {
    const item: SessionMessage = {
      role: msg.role || "user",
      content: msg.content ?? "",
    };
    if (msg.tool_calls !== undefined) item.tool_calls = msg.tool_calls;
    if (msg.tool_call_id !== undefined) item.tool_call_id = msg.tool_call_id;
    if (msg.name !== undefined) item.name = msg.name;
    return item;
  });

  const existing = loadSession(sessionId);
  const now = new Date().toISOString();
  const sessionMetadata = {
    workspace: process.cwd(),
    createdAt: existing?.metadata?.createdAt || now,
    ...(existing?.metadata || {}),
    ...(metadata || {}),
  };

  const sessionData: SavedSession = {
    sessionId,
    messages: formattedMessages,
    metadata: sessionMetadata,
    updatedAt: now,
  };

  const filePath = path.join(sessionsDir, `${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), "utf8");

  if (!sessionId.startsWith("turbo-") && !sessionId.startsWith("temp-")) {
    const lastSessionFile = path.join(sessionsDir, "last_session.txt");
    fs.writeFileSync(lastSessionFile, sessionId.trim(), "utf8");
  }
}

export function loadSession(sessionId: string): SavedSession | null {
  if (!sessionId) return null;
  const cleanId = sessionId.endsWith(".json") ? sessionId.slice(0, -5) : sessionId;
  const sessionsDir = getSessionsDir();
  let filePath = path.join(sessionsDir, `${cleanId}.json`);

  if (!fs.existsSync(filePath)) {
    // Check legacy ~/.toolnetapi/sessions fallback
    const legacyPath = path.join(os.homedir(), ".toolnetapi", "sessions", `${cleanId}.json`);
    if (fs.existsSync(legacyPath)) {
      filePath = legacyPath;
    } else {
      return null;
    }
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      sessionId: data.sessionId || cleanId,
      messages: Array.isArray(data.messages) ? data.messages : [],
      metadata: data.metadata || {},
      updatedAt: data.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function getLastSessionId(): string | null {
  const sessionsDir = getSessionsDir();
  const lastSessionFile = path.join(sessionsDir, "last_session.txt");

  if (fs.existsSync(lastSessionFile)) {
    try {
      const id = fs.readFileSync(lastSessionFile, "utf8").trim();
      if (id) {
        const sessionPath = path.join(sessionsDir, `${id}.json`);
        if (fs.existsSync(sessionPath)) {
          return id;
        }
      }
    } catch {}
  }

  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const files = fs.readdirSync(sessionsDir);
    const sessionFiles = files.filter(f => f.endsWith(".json"));
    if (sessionFiles.length === 0) return null;

    let newestId: string | null = null;
    let newestMtime = 0;

    for (const file of sessionFiles) {
      const filePath = path.join(sessionsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newestId = file.slice(0, -5);
      }
    }

    return newestId;
  } catch {
    return null;
  }
}

export function parseSessionArgs(argv: string[]): { resume: boolean; sessionId?: string } {
  let resume = false;
  let sessionId: string | undefined = undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "resume") {
      resume = true;
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        sessionId = argv[i + 1];
        i++;
      }
    } else if (arg === "--resume" || arg === "-r") {
      resume = true;
    } else if ((arg === "--session" || arg === "-s") && i + 1 < argv.length) {
      sessionId = argv[i + 1];
      i++;
    } else if (arg.startsWith("--session=")) {
      sessionId = arg.slice(arg.indexOf("=") + 1);
    }
  }

  return { resume, sessionId };
}

export function listAllSessions(): SavedSession[] {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];
  try {
    const files = fs.readdirSync(sessionsDir).filter(
      f => f.endsWith(".json") && !f.startsWith("turbo-") && !f.startsWith("temp-")
    );
    const list: SavedSession[] = [];
    for (const file of files) {
      const loaded = loadSession(file);
      if (loaded && !loaded.sessionId.startsWith("turbo-") && !loaded.sessionId.startsWith("temp-")) {
        list.push(loaded);
      }
    }
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return list;
  } catch {
    return [];
  }
}

export function deleteSessionFile(sessionId: string): boolean {
  if (!sessionId) return false;
  const cleanId = sessionId.endsWith(".json") ? sessionId.slice(0, -5) : sessionId;
  const sessionsDir = getSessionsDir();
  const filePath = path.join(sessionsDir, `${cleanId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      const lastSessionFile = path.join(sessionsDir, "last_session.txt");
      if (fs.existsSync(lastSessionFile)) {
        const lastId = fs.readFileSync(lastSessionFile, "utf8").trim();
        if (lastId === cleanId) {
          try { fs.unlinkSync(lastSessionFile); } catch {}
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function renameSessionFile(sessionId: string, newName: string): boolean {
  const loaded = loadSession(sessionId);
  if (!loaded) return false;
  loaded.metadata = loaded.metadata || {};
  loaded.metadata.name = newName;
  saveSession(loaded.sessionId, loaded.messages, loaded.metadata);
  return true;
}

export function createNewSession(name?: string): SavedSession {
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  const sessionId = `sess_${Date.now()}_${randomSuffix}`;
  const metadata: Record<string, any> = {};
  if (name) metadata.name = name;
  saveSession(sessionId, [], metadata);
  return {
    sessionId,
    messages: [],
    metadata,
    updatedAt: new Date().toISOString()
  };
}
