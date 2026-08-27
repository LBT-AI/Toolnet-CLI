import { test, it, expect, describe } from "bun:test";
import { GitHubProvider } from "../../lib/scm/github";
import { GitLabProvider } from "../../lib/scm/gitlab";
import { getSCMProvider, parseSCMUrl } from "../../lib/scm";

describe("P4.9 & P4.10 — SCM Abstraction & GitHub/GitLab Adapters", () => {
  const gh = new GitHubProvider();
  const gl = new GitLabProvider();

  it("19. GitHub PR URL parsing extracts repository and PR number", () => {
    const parsed = gh.parseUrl("https://github.com/facebook/react/pull/24000");
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("pr");
    expect(parsed?.repo.owner).toBe("facebook");
    expect(parsed?.repo.repo).toBe("react");
    expect(parsed?.repo.provider).toBe("github");
    expect(parsed?.number).toBe(24000);
  });

  it("20. GitHub Issue URL parsing extracts repository and Issue number", () => {
    const parsed = gh.parseUrl("https://github.com/oven-sh/bun/issues/1234");
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("issue");
    expect(parsed?.repo.owner).toBe("oven-sh");
    expect(parsed?.repo.repo).toBe("bun");
    expect(parsed?.repo.provider).toBe("github");
    expect(parsed?.number).toBe(1234);
  });

  it("GitLab MR and Issue URL parsing", () => {
    const mr = gl.parseUrl("https://gitlab.com/gitlab-org/gitlab/-/merge_requests/9876");
    expect(mr).not.toBeNull();
    expect(mr?.type).toBe("pr");
    expect(mr?.repo.owner).toBe("gitlab-org");
    expect(mr?.repo.repo).toBe("gitlab");
    expect(mr?.repo.provider).toBe("gitlab");
    expect(mr?.number).toBe(9876);

    const issue = gl.parseUrl("https://gitlab.com/gitlab-org/gitlab/-/issues/5432");
    expect(issue).not.toBeNull();
    expect(issue?.type).toBe("issue");
    expect(issue?.number).toBe(5432);
  });

  it("21. SCM adapter abstraction resolves appropriate provider", () => {
    const ghProv = getSCMProvider("https://github.com/owner/repo");
    expect(ghProv.providerType).toBe("github");

    const glProv = getSCMProvider("https://gitlab.com/owner/repo");
    expect(glProv.providerType).toBe("gitlab");

    const parsedGh = parseSCMUrl("https://github.com/owner/repo/pull/1");
    expect(parsedGh?.provider.providerType).toBe("github");

    const parsedGl = parseSCMUrl("https://gitlab.com/owner/repo/-/merge_requests/2");
    expect(parsedGl?.provider.providerType).toBe("gitlab");
  });
});
