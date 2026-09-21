import fs from "node:fs";
import path from "node:path";
import { getLspManager } from "../lsp/manager";
import crypto from "node:crypto";

export interface RepoMapNode {
  filePath: string;
  language: string;
  symbols: string[];
  size: number;
  hash: string;
}

export class BoundedRepoMap {
  private nodes = new Map<string, RepoMapNode>();

  public async buildMap(root: string, maxFiles: number = 100): Promise<RepoMapNode[]> {
    // Only map source roots
    const sourceDirs = ["src", "lib", "packages"].map(d => path.join(root, d)).filter(d => fs.existsSync(d));
    if (sourceDirs.length === 0) sourceDirs.push(root);

    const files = this.gatherFiles(sourceDirs, maxFiles);
    
    // Attempt LSP enrichment
    const manager = getLspManager({ workspaceRoot: root, cwd: root });
    
    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        if (stat.size > 512 * 1024) continue; // Skip files > 512KB to avoid memory exhaustion
        if (this.nodes.has(f)) {
          const cached = this.nodes.get(f)!;
          if (cached.size === stat.size) {
            continue; // rudimentary cache check
          }
        }
        
        const content = fs.readFileSync(f, "utf-8");
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        
        let symbols: string[] = [];
        if (manager.hasActiveClient(f)) {
          try {
            const docSymbols = await manager.documentSymbols(f);
            symbols = docSymbols.filter((s: any) => s.kind == 11 || s.kind == 12 || s.kind == 5 || s.kind == 6 || String(s.kind) === "Function" || String(s.kind) === "Class" || String(s.kind) === "Method").map((s: any) => s.name); // basic function/class/method symbols
          } catch {
            // fallback to simple regex parsing
            symbols = this.fallbackExtractSymbols(content, f);
          }
        } else {
          symbols = this.fallbackExtractSymbols(content, f);
        }
        
        if (this.nodes.size >= 500) {
          const oldestKey = this.nodes.keys().next().value;
          if (oldestKey) this.nodes.delete(oldestKey);
        }

        this.nodes.set(f, {
          filePath: path.relative(root, f),
          language: path.extname(f).slice(1),
          size: Buffer.byteLength(content),
          hash,
          symbols: symbols.slice(0, 10), // Bounded symbols
        });
      } catch {
        // Skip unreadable or concurrently deleted files
      }
    }

    return Array.from(this.nodes.values());
  }

  private fallbackExtractSymbols(content: string, filePath: string): string[] {
    const ext = path.extname(filePath);
    const symbols: string[] = [];
    if (ext === ".ts" || ext === ".js") {
      const matches = content.matchAll(/(?:function|class|const|let|var)\s+([a-zA-Z0-9_]+)/g);
      for (const m of matches) symbols.push(m[1]);
    } else if (ext === ".py") {
      const matches = content.matchAll(/(?:def|class)\s+([a-zA-Z0-9_]+)/g);
      for (const m of matches) symbols.push(m[1]);
    }
    return [...new Set(symbols)].slice(0, 20);
  }

  private gatherFiles(dirs: string[], max: number): string[] {
    const result: string[] = [];
    const queue = [...dirs];
    const visited = new Set<string>();
    while (queue.length > 0 && result.length < max) {
      const dir = queue.shift()!;
      let realDir = dir;
      try {
        realDir = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
      } catch {}
      if (visited.has(realDir)) continue;
      visited.add(realDir);

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "build") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) queue.push(full);
          else if (e.isFile() && this.isSourceFile(e.name)) {
            result.push(full);
            if (result.length >= max) break;
          }
        }
      } catch {
        // ignore read errors
      }
    }
    return result;
  }
  
  private isSourceFile(name: string): boolean {
    return /\.(ts|js|py|rs|go|java|tsx|jsx|c|cpp|h|hpp)$/.test(name);
  }

  public invalidate(filePath: string): void {
    this.nodes.delete(filePath);
  }
}

export const repoMap = new BoundedRepoMap();
