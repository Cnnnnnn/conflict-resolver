import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildScmEditorSlotContext,
  canonicalizeConflictUri,
  findConflictFile,
  formatLocatedConflictMenuLabel,
  getLocatedConflictAtSlot,
  getLocatedConflictCountForResource,
  getMergeConflictMenuContext,
  pickLocatedConflictForResource,
  resolveScmResourceUri,
  shouldShowScmPickConflict,
  sortLocatedConflicts,
  toConflictFileKey,
} from "../conflictScmMenu";
import { countGitOnlyFiles, countLocatedConflicts } from "../conflictPredicates";
import type { ConflictSnapshot } from "../types";

function toUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function createSnapshot(files: ConflictSnapshot["files"]): ConflictSnapshot {
  return {
    files,
    locatedCount: countLocatedConflicts(files),
    gitOnlyCount: countGitOnlyFiles(files),
    generatedAt: 1,
  };
}

const conflictA = {
  id: "a-1",
  startLine: 1,
  separatorLine: 3,
  endLine: 5,
  oursRange: { startLine: 2, endLine: 2 },
  theirsRange: { startLine: 4, endLine: 4 },
};

const conflictB = {
  id: "b-1",
  startLine: 10,
  separatorLine: 12,
  endLine: 14,
  oursRange: { startLine: 11, endLine: 11 },
  theirsRange: { startLine: 13, endLine: 13 },
};

describe("conflictScmMenu", () => {
  it("resolves scm resource uris from strings and resource states", () => {
    const uri = toUri("/repo/package.json");
    expect(resolveScmResourceUri(uri)).toBe(canonicalizeConflictUri(uri));
    expect(resolveScmResourceUri({ resourceUri: { toString: () => uri } })).toBe(
      canonicalizeConflictUri(uri),
    );
  });

  it("matches files by normalized filesystem path", () => {
    const filePath = "/repo/package.json";
    const gitUri = toUri(filePath);
    const snapshot = createSnapshot([
      {
        uri: gitUri,
        repositoryRoot: "/repo",
        relativePath: "package.json",
        gitUnmerged: true,
        locatedConflicts: [conflictA],
      },
    ]);

    expect(toConflictFileKey(gitUri)).toBe(toConflictFileKey(filePath));
    expect(findConflictFile(snapshot, filePath)?.relativePath).toBe("package.json");
  });

  it("builds merge menu context from the snapshot", () => {
    expect(
      getMergeConflictMenuContext(
        createSnapshot([
          {
            uri: toUri("/repo/a.ts"),
            repositoryRoot: "/repo",
            relativePath: "a.ts",
            gitUnmerged: true,
            locatedConflicts: [conflictA, conflictB],
          },
          {
            uri: toUri("/repo/b.ts"),
            repositoryRoot: "/repo",
            relativePath: "b.ts",
            gitUnmerged: true,
            locatedConflicts: [],
            parseError: "unknown",
          },
        ]),
      ),
    ).toEqual({
      hasMergeConflicts: true,
      hasGitOnlyMergeFiles: true,
    });
  });

  it("builds editor slot context from the active editor file instead of repo max", () => {
    const packageUri = toUri("/repo/package.json");
    const snapshot = createSnapshot([
      {
        uri: packageUri,
        repositoryRoot: "/repo",
        relativePath: "package.json",
        gitUnmerged: true,
        locatedConflicts: [conflictA],
      },
      {
        uri: toUri("/repo/pnpm-lock.yaml"),
        repositoryRoot: "/repo",
        relativePath: "pnpm-lock.yaml",
        gitUnmerged: true,
        locatedConflicts: [conflictA, conflictB, conflictA, conflictB, conflictA],
      },
    ]);

    expect(buildScmEditorSlotContext(snapshot, packageUri)).toMatchObject({
      "conflictResolver.scmEditorLocatedCount": 1,
      "conflictResolver.scmEditorSlot1": true,
      "conflictResolver.scmEditorSlot2": false,
    });
    expect(getLocatedConflictCountForResource(snapshot, packageUri)).toBe(1);
  });

  it("prefers quick pick when the scm resource is not the active editor file", () => {
    const packageUri = toUri("/repo/package.json");
    const lockUri = toUri("/repo/pnpm-lock.yaml");
    const snapshot = createSnapshot([
      {
        uri: packageUri,
        repositoryRoot: "/repo",
        relativePath: "package.json",
        gitUnmerged: true,
        locatedConflicts: [conflictA],
      },
      {
        uri: lockUri,
        repositoryRoot: "/repo",
        relativePath: "pnpm-lock.yaml",
        gitUnmerged: true,
        locatedConflicts: [conflictA, conflictB],
      },
    ]);

    expect(shouldShowScmPickConflict(snapshot, packageUri, lockUri)).toBe(true);
    expect(shouldShowScmPickConflict(snapshot, packageUri, packageUri)).toBe(false);
  });

  it("jumps directly when only one conflict exists", async () => {
    const uri = toUri("/repo/package.json");
    const snapshot = createSnapshot([
      {
        uri,
        repositoryRoot: "/repo",
        relativePath: "package.json",
        gitUnmerged: true,
        locatedConflicts: [conflictA],
      },
    ]);
    const goTo = vi.fn().mockResolvedValue(true);
    const showQuickPick = vi.fn();

    await pickLocatedConflictForResource(
      uri,
      snapshot,
      { goTo },
      { showInformationMessage: vi.fn(), showQuickPick },
    );

    expect(goTo).toHaveBeenCalledWith(uri, "a-1");
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it("sorts conflicts and formats submenu labels", () => {
    const file = {
      uri: toUri("/repo/a.ts"),
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [conflictB, conflictA],
    };

    expect(formatLocatedConflictMenuLabel(sortLocatedConflicts(file.locatedConflicts)[0], 0)).toBe(
      "冲突 1 — 第 2 行",
    );
    expect(getLocatedConflictAtSlot(file, 1)?.id).toBe("b-1");
    expect(findConflictFile(createSnapshot([file]), file.uri)?.relativePath).toBe("a.ts");
  });
});
