import fs from "node:fs";
import path from "node:path";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  filepath: string;
  instructions: string;
}

/**
 * Parses YAML frontmatter and markdown instructions from a SKILL.md file.
 */
export function parseSkillFile(content: string, filepath: string): SkillInfo {
  let defaultName = path.basename(path.dirname(filepath));
  if (!defaultName || defaultName === "." || defaultName === "/" || defaultName.endsWith("skills")) {
    defaultName = path.basename(filepath, path.extname(filepath));
  }

  let name = defaultName;
  let description = "";
  let instructions = content.trim();

  // Match YAML frontmatter enclosed in --- at start of content
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  if (match) {
    const yamlBlock = match[1];
    instructions = match[2].trim();

    // Extract name field from YAML
    const nameMatch = yamlBlock.match(/^name:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m);
    if (nameMatch) {
      name = (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
    }

    // Extract description field from YAML
    const descMatch = yamlBlock.match(/^description:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m);
    if (descMatch) {
      description = (descMatch[1] || descMatch[2] || descMatch[3]).trim();
    }
  }

  const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");

  return {
    id,
    name,
    description,
    filepath,
    instructions,
  };
}

/**
 * Scans .gemini/skills/, .toolnet/skills/, and cli/skills/ for SKILL.md files.
 * @param baseDir Optional root path to scan from (defaults to process.cwd()).
 */
export function loadLocalSkills(baseDir: string = process.cwd()): SkillInfo[] {
  const searchDirs = [
    path.join(baseDir, ".gemini", "skills"),
    path.join(baseDir, ".toolnet", "skills"),
    path.join(baseDir, "cli", "skills"),
    path.join(baseDir, "skills"),
  ];

  const skillsMap = new Map<string, SkillInfo>();

  function scanDir(dirPath: string): string[] {
    const skillFiles: string[] = [];
    if (!fs.existsSync(dirPath)) return skillFiles;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          skillFiles.push(...scanDir(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
          skillFiles.push(fullPath);
        }
      }
    } catch {
      // Ignore read errors gracefully
    }
    return skillFiles;
  }

  for (const dir of searchDirs) {
    const files = scanDir(dir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const skill = parseSkillFile(content, file);
        if (skill && skill.id && !skillsMap.has(skill.id)) {
          skillsMap.set(skill.id, skill);
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return Array.from(skillsMap.values());
}

/**
 * Retrieves markdown prompt / instructions for a skill by name or ID.
 * @param name Skill name or ID
 * @param baseDir Optional root path to scan from (defaults to process.cwd()).
 */
export function getSkillPrompt(name: string, baseDir: string = process.cwd()): string | null {
  if (!name) return null;
  const skills = loadLocalSkills(baseDir);
  const target = name.toLowerCase().trim();

  const skill = skills.find(
    s => s.id === target ||
         s.name.toLowerCase() === target ||
         s.id.includes(target) ||
         s.name.toLowerCase().includes(target)
  );

  return skill ? skill.instructions : null;
}
