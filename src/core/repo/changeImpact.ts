import type { RepositoryProfile } from "./profile";

export interface ChangeImpact {
  primaryFiles: string[];
  relatedFiles: string[];
  tests: string[];
  configs: string[];
  risk: "low" | "medium" | "high";
}

export interface ChangePlan {
  goal: string;
  filesToInspect: string[];
  filesLikelyToChange: string[];
  verificationSteps: string[];
  risk: "low" | "medium" | "high";
  constraints: string[];
}

export function analyzeChangeImpact(prompt: string, profile: RepositoryProfile): ChangeImpact {
  const p = prompt.toLowerCase();
  
  const impact: ChangeImpact = {
    primaryFiles: [],
    relatedFiles: [],
    tests: [],
    configs: [],
    risk: "low"
  };

  // Very rudimentary extraction of paths mentioned in prompt
  const paths = [...prompt.matchAll(/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/g)].map(m => m[0]);
  impact.primaryFiles = [...new Set(paths)];

  if (p.includes("config") || p.includes("package.json") || p.includes("cargo.toml")) {
    impact.configs.push("package.json");
    impact.risk = "high";
  }

  if (p.includes("refactor") || p.includes("api") || p.includes("interface")) {
    impact.risk = "high";
  } else if (p.includes("fix") || p.includes("bug")) {
    impact.risk = "medium";
  }

  if (profile.testRoots.length > 0) {
    impact.tests = profile.testRoots;
  }

  return impact;
}

export function createChangePlan(prompt: string, impact: ChangeImpact): ChangePlan {
  const verificationSteps: string[] = [];
  if (impact.risk === "high" || impact.configs.length > 0) {
    verificationSteps.push("Full suite tests");
    verificationSteps.push("Typecheck");
  } else if (impact.risk === "medium") {
    verificationSteps.push("Targeted tests");
  }

  return {
    goal: prompt.split("\n")[0].substring(0, 100), // First line as goal
    filesToInspect: impact.primaryFiles,
    filesLikelyToChange: impact.primaryFiles,
    verificationSteps,
    risk: impact.risk,
    constraints: []
  };
}
