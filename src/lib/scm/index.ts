import type { SCMProvider, SCMRepoInfo, SCMPullRequest, SCMIssue } from "./types";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";

export * from "./types";
export * from "./github";
export * from "./gitlab";

const githubProvider = new GitHubProvider();
const gitlabProvider = new GitLabProvider();

export function getSCMProvider(target?: string | SCMRepoInfo): SCMProvider {
  if (typeof target === "string") {
    if (target.includes("gitlab.com")) return gitlabProvider;
    if (target.includes("github.com")) return githubProvider;
  } else if (target && typeof target === "object") {
    if (target.provider === "gitlab") return gitlabProvider;
    return githubProvider;
  }

  // Auto-detect based on current git remote
  try {
    const info = githubProvider.parseUrl(target || "");
    if (info) {
      return info.repo.provider === "gitlab" ? gitlabProvider : githubProvider;
    }
  } catch {}

  return githubProvider;
}

export function parseSCMUrl(url: string): { provider: SCMProvider; type: "pr" | "issue"; repo: SCMRepoInfo; number: number } | null {
  if (url.includes("gitlab.com")) {
    const res = gitlabProvider.parseUrl(url);
    if (res) return { provider: gitlabProvider, ...res };
  }
  const ghRes = githubProvider.parseUrl(url);
  if (ghRes) return { provider: githubProvider, ...ghRes };
  return null;
}

export async function handlePrReviewCommand(prTarget: string, options: { model?: string; json?: boolean } = {}): Promise<void> {
  let provider: SCMProvider;
  let repo: SCMRepoInfo;
  let prNumber: number | string;

  if (prTarget.startsWith("http")) {
    const parsed = parseSCMUrl(prTarget);
    if (!parsed || parsed.type !== "pr") {
      throw new Error(`Invalid PR/MR URL: ${prTarget}`);
    }
    provider = parsed.provider;
    repo = parsed.repo;
    prNumber = parsed.number;
  } else {
    provider = getSCMProvider();
    repo = await provider.getRepoInfo();
    prNumber = parseInt(prTarget, 10);
    if (isNaN(prNumber as number)) {
      throw new Error(`Invalid PR number: ${prTarget}`);
    }
  }

  console.log(`\x1b[36mFetching PR #${prNumber} from ${repo.owner}/${repo.repo} (${provider.providerType})...\x1b[0m`);
  const pr = await provider.getPullRequest(repo, prNumber);

  console.log(`\x1b[1mPR #${pr.number}: ${pr.title}\x1b[0m (Author: @${pr.author}, State: ${pr.state})`);
  console.log(`Branch: ${pr.sourceBranch} → ${pr.targetBranch}`);
  if (pr.filesChanged !== undefined) console.log(`Files changed: ${pr.filesChanged}`);
  console.log(`\n\x1b[33mRunning code review agent...\x1b[0m\n`);

  const reviewPrompt = `You are performing a comprehensive code review on Pull Request #${pr.number}: "${pr.title}".
Author: @${pr.author}
Branch: ${pr.sourceBranch} -> ${pr.targetBranch}

Description:
${pr.body || "(No description provided)"}

Diff:
\`\`\`diff
${pr.diff ? pr.diff.slice(0, 50000) : "(No diff content)"}
\`\`\`

Please provide:
1. Executive Summary of changes
2. Potential Bugs, Security Risks, or Edge Cases
3. Architecture & Code Quality feedback
4. Actionable suggestions for improvement
`;

  const { runNonInteractive } = await import("../nonInteractive");
  await runNonInteractive({
    prompt: reviewPrompt,
    json: options.json,
    model: options.model,
  });
}

export async function handleIssueCommand(issueTarget: string, options: { model?: string; json?: boolean } = {}): Promise<void> {
  let provider: SCMProvider;
  let repo: SCMRepoInfo;
  let issueNumber: number | string;

  if (issueTarget.startsWith("http")) {
    const parsed = parseSCMUrl(issueTarget);
    if (!parsed || parsed.type !== "issue") {
      throw new Error(`Invalid Issue URL: ${issueTarget}`);
    }
    provider = parsed.provider;
    repo = parsed.repo;
    issueNumber = parsed.number;
  } else {
    provider = getSCMProvider();
    repo = await provider.getRepoInfo();
    issueNumber = parseInt(issueTarget, 10);
    if (isNaN(issueNumber as number)) {
      throw new Error(`Invalid Issue number: ${issueTarget}`);
    }
  }

  console.log(`\x1b[36mFetching Issue #${issueNumber} from ${repo.owner}/${repo.repo} (${provider.providerType})...\x1b[0m`);
  const issue = await provider.getIssue(repo, issueNumber);

  console.log(`\x1b[1mIssue #${issue.number}: ${issue.title}\x1b[0m (Author: @${issue.author}, State: ${issue.state})`);
  if (issue.labels && issue.labels.length > 0) console.log(`Labels: ${issue.labels.join(", ")}`);
  console.log(`\n\x1b[33mInspecting issue and proposing solution...\x1b[0m\n`);

  const taskPrompt = `The user requested solving Issue #${issue.number}: "${issue.title}".
Author: @${issue.author}
Status: ${issue.state}

Description:
${issue.body || "(No description provided)"}

Please analyze the codebase, identify root causes or required components, and propose/implement the solution.`;

  const { runNonInteractive } = await import("../nonInteractive");
  await runNonInteractive({
    prompt: taskPrompt,
    json: options.json,
    model: options.model,
  });
}
