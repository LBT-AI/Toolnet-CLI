import { detectRepositoryProfile, type RepositoryProfile } from "./profile";
import { repoMap, type RepoMapNode } from "./map";
import { instructionCache, type RepoInstruction } from "./instructions";
import { analyzeChangeImpact, type ChangeImpact } from "./changeImpact";

export interface CompactRepoContext {
  profile: RepositoryProfile;
  instructions: RepoInstruction[];
  mapNodes: RepoMapNode[];
}

export class RepositoryIntelligence {
  private static instance: RepositoryIntelligence;
  
  private constructor() {}

  public static getInstance(): RepositoryIntelligence {
    if (!RepositoryIntelligence.instance) {
      RepositoryIntelligence.instance = new RepositoryIntelligence();
    }
    return RepositoryIntelligence.instance;
  }

  public async getCompactContext(cwd: string): Promise<CompactRepoContext> {
    const profile = detectRepositoryProfile(cwd);
    const mapNodes = await repoMap.buildMap(profile.root, 100); // bounded to 100 source files
    const instructions = instructionCache.getInstructionsForPath(cwd, profile.root);

    return {
      profile,
      instructions,
      mapNodes,
    };
  }

  public async determineChangeImpact(prompt: string, profileOrCwd: string | RepositoryProfile): Promise<ChangeImpact> {
    const profile = typeof profileOrCwd === "string" ? detectRepositoryProfile(profileOrCwd) : profileOrCwd;
    return analyzeChangeImpact(prompt, profile);
  }
}

export const repositoryIntelligence = RepositoryIntelligence.getInstance();
