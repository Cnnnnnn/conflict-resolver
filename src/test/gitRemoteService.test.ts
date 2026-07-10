import { describe, expect, it, vi } from "vitest";

import {
  GitRemoteService,
  parseGitLabRemoteUrl,
  type GitCommandRunner,
} from "../gitRemoteService";

describe("parseGitLabRemoteUrl", () => {
  it("parses GitLab.com HTTPS remotes", () => {
    expect(parseGitLabRemoteUrl("https://gitlab.com/group/project.git")).toEqual({
      host: "gitlab.com",
      protocol: "https",
      projectPath: "group/project",
    });
  });

  it("parses self-managed HTTPS remotes without .git suffix", () => {
    expect(
      parseGitLabRemoteUrl("https://gitlab.example.com/group/subgroup/project"),
    ).toEqual({
      host: "gitlab.example.com",
      protocol: "https",
      projectPath: "group/subgroup/project",
    });
  });

  it("parses SSH colon remotes", () => {
    expect(parseGitLabRemoteUrl("git@gitlab.com:group/project.git")).toEqual({
      host: "gitlab.com",
      protocol: "https",
      projectPath: "group/project",
    });
  });

  it("parses SSH URL remotes", () => {
    expect(parseGitLabRemoteUrl("ssh://git@gitlab.corp.com/group/project.git")).toEqual({
      host: "gitlab.corp.com",
      protocol: "https",
      projectPath: "group/project",
    });
  });

  it("URL-decodes nested group path segments", () => {
    expect(
      parseGitLabRemoteUrl("https://gitlab.com/group%2Fsubgroup/project.git"),
    ).toEqual({
      host: "gitlab.com",
      protocol: "https",
      projectPath: "group/subgroup/project",
    });
  });

  it("rejects non-GitLab remotes", () => {
    expect(parseGitLabRemoteUrl("https://github.com/org/repo.git")).toEqual({
      host: "github.com",
      protocol: "https",
      projectPath: "org/repo",
    });
  });
});

describe("GitRemoteService", () => {
  it("returns GitLab context for a valid origin remote and branch", async () => {
    const runGit: GitCommandRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "https://gitlab.com/group/project.git\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "feature/login\n", stderr: "" });

    const service = new GitRemoteService({ runGit });

    await expect(service.getContext("/repo")).resolves.toEqual({
      host: "gitlab.com",
      protocol: "https",
      projectPath: "group/project",
      branch: "feature/login",
    });

    expect(runGit).toHaveBeenNthCalledWith(1, ["-C", "/repo", "remote", "get-url", "origin"]);
    expect(runGit).toHaveBeenNthCalledWith(2, ["-C", "/repo", "branch", "--show-current"]);
  });

  it("returns undefined for malformed remotes", async () => {
    const runGit: GitCommandRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "not-a-remote\n", stderr: "" });

    const service = new GitRemoteService({ runGit });

    await expect(service.getContext("/repo")).resolves.toBeUndefined();
  });

  it("returns detached-head when branch is empty", async () => {
    const runGit: GitCommandRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "git@gitlab.com:group/project.git\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "\n", stderr: "" });

    const service = new GitRemoteService({ runGit });

    await expect(service.getContext("/repo")).resolves.toEqual({ error: "detached-head" });
  });

  it("returns undefined when origin remote is missing", async () => {
    const runGit: GitCommandRunner = vi.fn().mockRejectedValue(new Error("no origin"));

    const service = new GitRemoteService({ runGit });

    await expect(service.getContext("/repo")).resolves.toBeUndefined();
  });
});
