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
    const resolvedRoot = path.resolve(root);
    let current = path.resolve(path.dirname(targetPath));

    const isInsideOrEqual = (dir: string) => dir === resolvedRoot || dir.startsWith(resolvedRoot + path.sep);

    // Traverse upwards to root
    while (isInsideOrEqual(current)) {
      const candidates = ["AGENTS.md", "AGENT.md", path.join(".toolnet", "instructions.md")];
      for (const candidate of candidates) {
        const agentFile = path.join(current, candidate);
        if (fs.existsSync(agentFile)) {
          try {
            const content = fs.readFileSync(agentFile, "utf-8");
            const hash = crypto.createHash("sha256").update(content).digest("hex");

            let cached = this.cache.get(agentFile);
            if (!cached || cached.hash !== hash) {
              cached = { path: agentFile, content, hash };
              this.cache.set(agentFile, cached);
            }
            // Prepend so root comes first, more specific comes later
            instructions.unshift(cached);
          } catch {}
          break; // Use the first matching instruction file in this directory
        }
      }
      if (current === resolvedRoot) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return instructions;
  }

  public invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }
}

export const instructionCache = new InstructionCache();
