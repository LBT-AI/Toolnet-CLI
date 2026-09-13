import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export interface RepoInstruction {
  path: string;
  content: string;
  hash: string;
}

class InstructionCache {
  private cache = new Map<string, RepoInstruction>();

  public getInstructionsForPath(targetPath: string, root: string): RepoInstruction[] {
    const instructions: RepoInstruction[] = [];
    let current = path.dirname(targetPath);
    
    // Traverse upwards to root
    while (current.startsWith(root) && current.length >= root.length) {
      const agentFile = path.join(current, "AGENTS.md");
      if (fs.existsSync(agentFile)) {
        const content = fs.readFileSync(agentFile, "utf-8");
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        
        let cached = this.cache.get(agentFile);
        if (!cached || cached.hash !== hash) {
          cached = { path: agentFile, content, hash };
          this.cache.set(agentFile, cached);
        }
        // Prepend so root comes first, more specific comes later
        instructions.unshift(cached);
      }
      if (current === root) break;
      current = path.dirname(current);
    }
    return instructions;
  }

  public invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }
}

export const instructionCache = new InstructionCache();
