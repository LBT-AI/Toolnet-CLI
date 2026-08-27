import { execSync } from "node:child_process";
import type { SCMProvider, SCMRepoInfo, SCMPullRequest, SCMIssue } from "./types";
import { getCliKey } from "../keys";

export class GitLabProvider implements SCMProvider {
  readonly providerType = "gitlab" as const;

  private getToken(): string | null {
    if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN;
    if (process.env.GL_TOKEN) return process.env.GL_TOKEN;
    const stored = getCliKey("gitlab");
    if (stored) return stored;
    return null;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": "ToolNet-CLI",
      Accept: "application/json",
    };
    const token = this.getToken();
    if (token) {
      headers["PRIVATE-TOKEN"] = token;
    }
    return headers;
  }

  parseUrl(url: string): { type: "pr" | "issue"; repo: SCMRepoInfo; number: number } | null {
    const mrMatch = url.match(/gitlab\.com\/([^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)/i);
    if (mrMatch) {
      return {
        type: "pr",
        repo: { owner: mrMatch[1], repo: mrMatch[2].replace(/\.git$/, ""), provider: "gitlab" },
        number: parseInt(mrMatch[3], 10),
      };
    }

    const issueMatch = url.match(/gitlab\.com\/([^/]+)\/([^/]+)\/-\/issues\/(\d+)/i);
    if (issueMatch) {
      return {
        type: "issue",
        repo: { owner: issueMatch[1], repo: issueMatch[2].replace(/\.git$/, ""), provider: "gitlab" },
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
        throw new Error("Cannot detect git remote repository. Please provide a full GitLab URL.");
      }
    }

    const sshMatch = url.match(/gitlab\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2], provider: "gitlab", rawRemoteUrl: url };
    }

    const httpMatch = url.match(/gitlab\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
    if (httpMatch) {
      return { owner: httpMatch[1], repo: httpMatch[2], provider: "gitlab", rawRemoteUrl: url };
    }

    throw new Error(`Unsupported GitLab remote URL: ${url}`);
  }

  async getPullRequest(repo: SCMRepoInfo, prNumberOrUrl: string | number): Promise<SCMPullRequest> {
    let num: number;
    let targetRepo = repo;

    if (typeof prNumberOrUrl === "string" && prNumberOrUrl.startsWith("http")) {
      const parsed = this.parseUrl(prNumberOrUrl);
      if (!parsed || parsed.type !== "pr") {
        throw new Error(`Invalid GitLab MR URL: ${prNumberOrUrl}`);
      }
      targetRepo = parsed.repo;
      num = parsed.number;
    } else {
      num = typeof prNumberOrUrl === "number" ? prNumberOrUrl : parseInt(prNumberOrUrl, 10);
      if (isNaN(num)) throw new Error(`Invalid MR number: ${prNumberOrUrl}`);
    }

    const projectPath = encodeURIComponent(`${targetRepo.owner}/${targetRepo.repo}`);
    const apiUrl = `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests/${num}`;
    const res = await fetch(apiUrl, { headers: this.getHeaders() });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`GitLab API error (${res.status}): ${err || res.statusText}`);
    }

    const data = await res.json() as any;
    const diff = await this.getDiff(targetRepo, num).catch(() => "");

    return {
      id: data.id,
      number: data.iid,
      title: data.title || "",
      body: data.description || "",
      sourceBranch: data.source_branch || "",
      targetBranch: data.target_branch || "",
      author: data.author?.username || "",
      state: data.state === "merged" ? "merged" : data.state === "closed" ? "closed" : "open",
      diff,
      url: data.web_url || `https://gitlab.com/${targetRepo.owner}/${targetRepo.repo}/-/merge_requests/${num}`,
      filesChanged: data.changes_count ? parseInt(data.changes_count, 10) : undefined,
    };
  }

  async getIssue(repo: SCMRepoInfo, issueNumberOrUrl: string | number): Promise<SCMIssue> {
    let num: number;
    let targetRepo = repo;

    if (typeof issueNumberOrUrl === "string" && issueNumberOrUrl.startsWith("http")) {
      const parsed = this.parseUrl(issueNumberOrUrl);
      if (!parsed || parsed.type !== "issue") {
        throw new Error(`Invalid GitLab Issue URL: ${issueNumberOrUrl}`);
      }
      targetRepo = parsed.repo;
      num = parsed.number;
    } else {
      num = typeof issueNumberOrUrl === "number" ? issueNumberOrUrl : parseInt(issueNumberOrUrl, 10);
      if (isNaN(num)) throw new Error(`Invalid Issue number: ${issueNumberOrUrl}`);
    }

    const projectPath = encodeURIComponent(`${targetRepo.owner}/${targetRepo.repo}`);
    const apiUrl = `https://gitlab.com/api/v4/projects/${projectPath}/issues/${num}`;
    const res = await fetch(apiUrl, { headers: this.getHeaders() });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`GitLab API error (${res.status}): ${err || res.statusText}`);
    }

    const data = await res.json() as any;

    return {
      id: data.id,
      number: data.iid,
      title: data.title || "",
      body: data.description || "",
      author: data.author?.username || "",
      state: data.state === "closed" ? "closed" : "open",
      url: data.web_url || `https://gitlab.com/${targetRepo.owner}/${targetRepo.repo}/-/issues/${num}`,
      labels: Array.isArray(data.labels) ? data.labels : [],
    };
  }

  async getDiff(repo: SCMRepoInfo, prNumber: string | number): Promise<string> {
    const num = typeof prNumber === "number" ? prNumber : parseInt(prNumber, 10);
    const projectPath = encodeURIComponent(`${repo.owner}/${repo.repo}`);
    const apiUrl = `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests/${num}/raw_diffs`;

    const res = await fetch(apiUrl, { headers: this.getHeaders() });
    if (!res.ok) {
      // Fallback to changes endpoint
      const changesUrl = `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests/${num}/changes`;
      const changesRes = await fetch(changesUrl, { headers: this.getHeaders() });
      if (changesRes.ok) {
        const changesData = await changesRes.json() as any;
        const diffs = (changesData.changes || []).map((c: any) => `--- a/${c.old_path}\n+++ b/${c.new_path}\n${c.diff}`).join("\n");
        return diffs;
      }
      throw new Error(`Failed to fetch GitLab MR diff: ${res.statusText}`);
    }

    return await res.text();
  }
}
