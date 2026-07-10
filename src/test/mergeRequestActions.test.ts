import { describe, expect, it, vi } from "vitest";

import {
  buildMrConflictsUrl,
  fetchMrTargetBranch,
  formatMergePreviewMessage,
  previewMrMerge,
} from "../mergeRequestActions";

describe("mergeRequestActions", () => {
  it("builds the GitLab conflicts page url", () => {
    expect(
      buildMrConflictsUrl("https://gitlab.com/group/project/-/merge_requests/123/"),
    ).toBe("https://gitlab.com/group/project/-/merge_requests/123/-/conflicts");
  });

  it("fetches the mr target branch through git", async () => {
    const git = {
      getDefaultRemote: vi.fn().mockResolvedValue("origin"),
      fetchRemoteBranch: vi.fn().mockResolvedValue(undefined),
      previewMergeWithRemoteBranch: vi.fn(),
    };

    await expect(
      fetchMrTargetBranch(git, "/repo", { targetBranch: "main" }),
    ).resolves.toEqual({
      ok: true,
      message: "已获取 origin/main",
    });
    expect(git.fetchRemoteBranch).toHaveBeenCalledWith("/repo", "origin", "main");
  });

  it("formats merge preview results", () => {
    expect(
      formatMergePreviewMessage({
        ok: true,
        conflictCount: 2,
        output: "CONFLICT",
        targetRef: "origin/main",
      }),
    ).toBe("预演合并 origin/main：预计 2 个文件冲突");

    expect(
      formatMergePreviewMessage({
        ok: true,
        conflictCount: 0,
        output: "",
        targetRef: "origin/main",
      }),
    ).toBe("预演合并 origin/main：预计无冲突");
  });

  it("delegates preview merge to git", async () => {
    const git = {
      getDefaultRemote: vi.fn().mockResolvedValue("origin"),
      fetchRemoteBranch: vi.fn(),
      previewMergeWithRemoteBranch: vi.fn().mockResolvedValue({
        ok: true,
        conflictCount: 0,
        output: "",
        targetRef: "origin/dev",
      }),
    };

    await expect(
      previewMrMerge(git, "/repo", { targetBranch: "dev" }),
    ).resolves.toMatchObject({
      ok: true,
      targetRef: "origin/dev",
    });
  });
});
