export type SCMProviderType = "github" | "gitlab";

export interface SCMRepoInfo {
  owner: string;
  repo: string;
  provider: SCMProviderType;
  defaultBranch?: string;
  rawRemoteUrl?: string;
}

export interface SCMPullRequest {
  id: string | number;
  number: number;
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  state: "open" | "closed" | "merged";
  diff?: string;
  url: string;
  filesChanged?: number;
}

export interface SCMIssue {
  id: string | number;
  number: number;
  title: string;
  body: string;
  author: string;
  state: "open" | "closed";
  url: string;
  labels?: string[];
}

export interface SCMProvider {
  readonly providerType: SCMProviderType;
  parseUrl(url: string): { type: "pr" | "issue"; repo: SCMRepoInfo; number: number } | null;
  getRepoInfo(remoteUrl?: string): Promise<SCMRepoInfo>;
  getPullRequest(repo: SCMRepoInfo, prNumberOrUrl: string | number): Promise<SCMPullRequest>;
  getIssue(repo: SCMRepoInfo, issueNumberOrUrl: string | number): Promise<SCMIssue>;
  getDiff(repo: SCMRepoInfo, prNumber: string | number): Promise<string>;
}
