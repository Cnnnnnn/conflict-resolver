import { describe, expect, it } from "vitest";

import { formatMergeProgressLabel, getMergeProgress } from "../mergeProgress";
import type { ConflictSnapshot } from "../types";

function createSnapshot(files: ConflictSnapshot["files"]): ConflictSnapshot {
  return {
    files,
    locatedCount: files.reduce(
      (count, file) => count + file.locatedConflicts.length,
      0,
    ),
    gitOnlyCount: files.filter(
      (file) => file.gitUnmerged && file.locatedConflicts.length === 0,
    ).length,
    generatedAt: 1,
  };
}

describe("mergeProgress", () => {
  it("summarizes remaining merge work", () => {
    const progress = getMergeProgress(
      createSnapshot([
        {
          uri: "file:///repo/a.ts",
          repositoryRoot: "/repo",
          relativePath: "a.ts",
          gitUnmerged: true,
          locatedConflicts: [
            {
              id: "a",
              startLine: 1,
              separatorLine: 2,
              endLine: 3,
              oursRange: { startLine: 2, endLine: 2 },
              theirsRange: { startLine: 3, endLine: 3 },
            },
          ],
        },
        {
          uri: "file:///repo/b.ts",
          repositoryRoot: "/repo",
          relativePath: "b.ts",
          gitUnmerged: true,
          locatedConflicts: [],
          parseError: "unknown",
        },
      ]),
    );

    expect(progress).toEqual({
      unmergedFileCount: 2,
      locatedConflictCount: 1,
      locatedFileCount: 1,
      gitOnlyFileCount: 1,
    });
    expect(formatMergeProgressLabel(progress)).toBe(
      "2 文件 · 1 处冲突 · 1 处未知冲突",
    );
  });

  it("prepends scenario context when present", () => {
    const progress = getMergeProgress(
      createSnapshot([]),
      { kind: "rebase", inProgress: true, continueCommand: "git rebase --continue" },
    );
    expect(formatMergeProgressLabel(progress)).toBe(
      "rebase：剩余待完成步骤",
    );
  });
});
