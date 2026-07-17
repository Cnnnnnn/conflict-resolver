import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildConflictFileDecorations,
  ConflictFileDecorationProvider,
  getConflictBadgeCount,
} from "../conflictFileDecorations";
import { toConflictFileKey } from "../conflictScmMenu";
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

describe("buildConflictFileDecorations", () => {
  it("shows plain numeric badges like SCM section counts", () => {
    const decorations = buildConflictFileDecorations(
      createSnapshot([
        {
          uri: toUri("/repo/package.json"),
          repositoryRoot: "/repo",
          relativePath: "package.json",
          gitUnmerged: true,
          locatedConflicts: [
            {
              id: "a",
              startLine: 1,
              separatorLine: 3,
              endLine: 5,
              oursRange: { startLine: 2, endLine: 2 },
              theirsRange: { startLine: 4, endLine: 4 },
            },
            {
              id: "b",
              startLine: 10,
              separatorLine: 12,
              endLine: 14,
              oursRange: { startLine: 11, endLine: 11 },
              theirsRange: { startLine: 13, endLine: 13 },
            },
          ],
        },
        {
          uri: toUri("/repo/pnpm-lock.yaml"),
          repositoryRoot: "/repo",
          relativePath: "pnpm-lock.yaml",
          gitUnmerged: true,
          locatedConflicts: [],
          parseError: "invalid conflict marker order at line 0",
        },
      ]),
    );

    expect(decorations.get(toConflictFileKey(toUri("/repo/package.json")))).toEqual({
      badge: "2个",
      tooltip: "package.json\n2个冲突",
      colorId: "badge.foreground",
    });
    expect(decorations.get(toConflictFileKey(toUri("/repo/pnpm-lock.yaml")))).toEqual({
      badge: "!",
      tooltip: "pnpm-lock.yaml\n未知冲突",
      colorId: "badge.foreground",
    });
  });

  it("caps large conflict counts at 99+", () => {
    const locatedConflicts = Array.from({ length: 120 }, (_, index) => ({
      id: `c-${index}`,
      startLine: index * 10,
      separatorLine: index * 10 + 1,
      endLine: index * 10 + 2,
      oursRange: { startLine: index * 10, endLine: index * 10 },
      theirsRange: { startLine: index * 10 + 2, endLine: index * 10 + 2 },
    }));

    const decorations = buildConflictFileDecorations(
      createSnapshot([
        {
          uri: toUri("/repo/big.ts"),
          repositoryRoot: "/repo",
          relativePath: "big.ts",
          gitUnmerged: true,
          locatedConflicts,
        },
      ]),
    );

    expect(decorations.get(toConflictFileKey(toUri("/repo/big.ts")))?.badge).toBe("99+");
  });
});

describe("getConflictBadgeCount", () => {
  it("counts conflict files for the view badge", () => {
    expect(
      getConflictBadgeCount(
        createSnapshot([
          {
            uri: toUri("/repo/a.ts"),
            repositoryRoot: "/repo",
            relativePath: "a.ts",
            gitUnmerged: true,
            locatedConflicts: [
              {
                id: "a",
                startLine: 1,
                separatorLine: 3,
                endLine: 5,
                oursRange: { startLine: 2, endLine: 2 },
                theirsRange: { startLine: 4, endLine: 4 },
              },
              {
                id: "b",
                startLine: 10,
                separatorLine: 12,
                endLine: 14,
                oursRange: { startLine: 11, endLine: 11 },
                theirsRange: { startLine: 13, endLine: 13 },
              },
            ],
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
    ).toBe(2);
  });
});

describe("ConflictFileDecorationProvider", () => {
  it("notifies listeners when the snapshot changes", () => {
    const provider = new ConflictFileDecorationProvider();
    const listener = vi.fn();

    provider.onDidChange(listener);
    provider.update(createSnapshot([]));

    expect(listener).toHaveBeenCalledWith(undefined);
    expect(provider.provideFileDecoration(toUri("/repo/package.json"))).toBeUndefined();
  });
});
