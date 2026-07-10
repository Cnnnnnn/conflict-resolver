import { describe, expect, it } from "vitest";
import { getStatusBarState } from "../statusBar";
import type { ConflictSnapshot } from "../types";

const snapshot = (files: ConflictSnapshot["files"]): ConflictSnapshot => ({
  files,
  generatedAt: 0,
  locatedCount: files.reduce((total, file) => total + file.locatedConflicts.length, 0),
  gitOnlyCount: files.filter((file) => file.gitUnmerged && file.locatedConflicts.length === 0).length,
});

describe("getStatusBarState", () => {
  it("shows the current file count against the workspace total", () => {
    const current = {
      uri: "file:///repo/a.ts",
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [
        { id: "a", startLine: 1, separatorLine: 2, endLine: 3, oursRange: { startLine: 2, endLine: 2 }, theirsRange: { startLine: 3, endLine: 3 } },
      ],
    };
    const other = { ...current, uri: "file:///repo/b.ts", relativePath: "b.ts", locatedConflicts: [current.locatedConflicts[0], current.locatedConflicts[0]] };
    expect(getStatusBarState(snapshot([current, other]), current.uri)).toMatchObject({ kind: "located", text: "冲突 1/3" });
  });

  it("shows Git-only state and hides unrelated files", () => {
    const file = { uri: "file:///repo/a.ts", repositoryRoot: "/repo", relativePath: "a.ts", gitUnmerged: true, locatedConflicts: [] };
    const state = getStatusBarState(snapshot([file]), file.uri);
    expect(state).toMatchObject({ kind: "git-only", text: "Git 未解决，位置未知" });
    expect(getStatusBarState(snapshot([file]), "file:///repo/other.ts")).toBeUndefined();
  });
});
