import { execSync } from "node:child_process";
import type { SCMProvider, SCMRepoInfo, SCMPullRequest, SCMIssue } from "./types";
import { getCliKey } from "../keys";

export class GitHubProvider implements SCMProvider {
  readonly providerType = "github" as const;

  private getToken(): string | null {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
    const stored = getCliKey("github");
    if (stored) return stored;
    return null;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": "ToolNet-CLI",
      Accept: "application/vnd.github.v3+json",
    };
    const token = this.getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  parseUrl(url: string): { type: "pr" | "issue"; repo: SCMRepoInfo; number: number } | null {
    const prMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    if (prMatch) {
      return {
        type: "pr",
        repo: { owner: prMatch[1], repo: prMatch[2].replace(/\.git$/, ""), provider: "github" },
        number: parseInt(prMatch[3], 10),
      };
    }

    const issueMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    if (issueMatch) {
      return {
        type: "issue",
        repo: { owner: issueMatch[1], repo: issueMatch[2].replace(/\.git$/, ""), provider: "github" },
        number: parseInt(issueMatch[3], 10),
      };
    }

    return null;
  }

  async getRepoInfo(remoteUrl?: string): Promise<SCMRepoInfo> {
    let url = remoteUrl;
    if (!url) {
      try {
        url = execSync("git remote get-url origin", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      } catch {
        throw new Error("Cannot detect git remote repository. Please provide a full GitHub URL.");
      }
    }

    // Match git@github.com:owner/repo.git or https://github.com/owner/repo(.git)
    const sshMatch = url.match(/github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2], provider: "github", rawRemoteUrl: url };
    }

    const httpMatch = url.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
    if (httpMatch) {
      return { owner: httpMatch[1], repo: httpMatch[2], provider: "github", rawRemoteUrl: url };
    }

    throw new Error(`Unsupported GitHub remote URL: ${url}`);
  }

  async getPullRequest(repo: SCMRepoInfo, prNumberOrUrl: string | number): Promise<SCMPullRequest> {
    let num: number;
    let targetRepo = repo;

    if (typeof prNumberOrUrl === "string" && prNumberOrUrl.startsWith("http")) {
      const parsed = this.parseUrl(prNumberOrUrl);
      if (!parsed || parsed.type !== "pr") {
        throw new Error(`Invalid GitHub PR URL: ${prNumberOrUrl}`);
      }
      targetRepo = parsed.repo;
      num = parsed.number;
    } else {
      num = typeof prNumberOrUrl === "number" ? prNumberOrUrl : parseInt(prNumberOrUrl, 10);
      if (isNaN(num)) throw new Error(`Invalid PR number: ${prNumberOrUrl}`);
    }

    const apiUrl = `https://api.github.com/repos/${targetRepo.owner}/${targetRepo.repo}/pulls/${num}`;
    const res = await fetch(apiUrl, { headers: this.getHeaders() });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`GitHub API error (${res.status}): ${err || res.statusText}`);
    }

    const data = await res.json() as any;
    const diff = await this.getDiff(targetRepo, num).catch(() => "");

    return {
      id: data.id,
      number: data.number,
      title: data.title || "",
      body: data.body || "",
      sourceBranch: data.head?.ref || "",
      targetBranch: data.base?.ref || "",
      author: data.user?.login || "",
      state: data.merged ? "merged" : data.state === "closed" ? "closed" : "open",
      diff,
      url: data.html_url || `https://github.com/${targetRepo.owner}/${targetRepo.repo}/pull/${num}`,
      filesChanged: data.changed_files,
    };
  }

  async getIssue(repo: SCMRepoInfo, issueNumberOrUrl: string | number): Promise<SCMIssue> {
    let num: number;
    let targetRepo = repo;

    if (typeof issueNumberOrUrl === "string" && issueNumberOrUrl.startsWith("http")) {
      const parsed = this.parseUrl(issueNumberOrUrl);
      if (!parsed || parsed.type !== "issue") {
        throw new Error(`Invalid GitHub Issue URL: ${issueNumberOrUrl}`);
      }
      targetRepo = parsed.repo;
      num = parsed.number;
    } else {
      num = typeof issueNumberOrUrl === "number" ? issueNumberOrUrl : parseInt(issueNumberOrUrl, 10);
      if (isNaN(num)) throw new Error(`Invalid Issue number: ${issueNumberOrUrl}`);
    }

    const apiUrl = `https://api.github.com/repos/${targetRepo.owner}/${targetRepo.repo}/issues/${num}`;
    const res = await fetch(apiUrl, { headers: this.getHeaders() });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`GitHub API error (${res.status}): ${err || res.statusText}`);
    }

    const data = await res.json() as any;
    const labels = Array.isArray(data.labels) ? data.labels.map((l: any) => (typeof l === "string" ? l : l.name)) : [];

    return {
      id: data.id,
      number: data.number,
      title: data.title || "",
      body: data.body || "",
      author: data.user?.login || "",
      state: data.state === "closed" ? "closed" : "open",
      url: data.html_url || `https://github.com/${targetRepo.owner}/${targetRepo.repo}/issues/${num}`,
      labels,
    };
  }

  async getDiff(repo: SCMRepoInfo, prNumber: string | number): Promise<string> {
    const num = typeof prNumber === "number" ? prNumber : parseInt(prNumber, 10);
    const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${num}`;
    const headers = {
      ...this.getHeaders(),
      Accept: "application/vnd.github.v3.diff",
    };

    const res = await fetch(apiUrl, { headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch PR diff: ${res.statusText}`);
    }

    return await res.text();
  }
}
