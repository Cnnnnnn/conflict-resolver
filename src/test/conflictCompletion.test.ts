import { describe, expect, it } from "vitest";

import {
  EMPTY_CONFLICT_WORK_STATE,
  formatCompletionLabel,
  formatLocatedClearedNotification,
  getCompletionKind,
  shouldNotifyLocatedConflictsCleared,
  updateConflictWorkState,
} from "../conflictCompletion";
import type { ConflictSnapshot } from "../types";

function snapshot(
  files: ConflictSnapshot["files"],
  overrides?: Partial<ConflictSnapshot>,
): ConflictSnapshot {
  return {
    files,
    locatedCount: files.reduce((count, file) => count + file.locatedConflicts.length, 0),
    gitOnlyCount: files.filter(
      (file) => file.gitUnmerged && file.locatedConflicts.length === 0,
    ).length,
    generatedAt: 1,
    ...overrides,
  };
}

describe("conflictCompletion", () => {
  it("tracks prior merge work", () => {
    const active = snapshot([
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
    ]);

    expect(updateConflictWorkState(EMPTY_CONFLICT_WORK_STATE, active)).toEqual({
      hadLocatedConflicts: true,
      hadUnmergedFiles: true,
    });
  });

  it("shows markers-cleared completion while git index is still unmerged", () => {
    const cleared = snapshot(
      [
        {
          uri: "file:///repo/a.ts",
          repositoryRoot: "/repo",
          relativePath: "a.ts",
          gitUnmerged: true,
          locatedConflicts: [],
        },
      ],
      { gitOnlyCount: 0, locatedCount: 0 },
    );
    const state = { hadLocatedConflicts: true, hadUnmergedFiles: true };

    expect(getCompletionKind(cleared, state)).toBe("markers-cleared");
    expect(formatCompletionLabel("markers-cleared", cleared)).toBe(
      "✓ 冲突标记已处理 · 剩余 1 个文件待 git add（命令面板: Conflict Resolver: Stage All Resolved）",
    );
  });

  it("shows all-resolved completion when git is clean", () => {
    const done = snapshot([]);
    const state = { hadLocatedConflicts: true, hadUnmergedFiles: true };

    expect(getCompletionKind(done, state)).toBe("all-resolved");
    expect(formatCompletionLabel("all-resolved", done)).toBe("✓ 合并冲突已全部处理完毕");
  });

  it("notifies when located conflicts drop to zero", () => {
    const before = snapshot([
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
    ]);
    const after = snapshot(
      [
        {
          uri: "file:///repo/a.ts",
          repositoryRoot: "/repo",
          relativePath: "a.ts",
          gitUnmerged: true,
          locatedConflicts: [],
        },
      ],
      { gitOnlyCount: 0, locatedCount: 0 },
    );

    expect(shouldNotifyLocatedConflictsCleared(before, after)).toBe(true);
    expect(formatLocatedClearedNotification(after)).toContain("git add");
  });
});
