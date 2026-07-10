import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildWorkspaceConflictOrder,
  findWorkspaceConflictIndexAtOrBefore,
  getWorkspaceConflictFileCount,
} from "../conflictWorkspaceOrder";
import type { ConflictSnapshot } from "../types";

function createSnapshot(files: ConflictSnapshot["files"]): ConflictSnapshot {
  return {
    files,
    locatedCount: files.reduce(
      (count, file) => count + file.locatedConflicts.length,
      0,
    ),
    gitOnlyCount: 0,
    generatedAt: 1,
  };
}

describe("conflictWorkspaceOrder", () => {
  it("orders conflicts by file path and start line", () => {
    const aUri = pathToFileURL("/repo/a.ts").toString();
    const bUri = pathToFileURL("/repo/b.ts").toString();
    const order = buildWorkspaceConflictOrder(
      createSnapshot([
        {
          uri: bUri,
          repositoryRoot: "/repo",
          relativePath: "b.ts",
          gitUnmerged: true,
          locatedConflicts: [
            {
              id: "b-1",
              startLine: 20,
              separatorLine: 22,
              endLine: 24,
              oursRange: { startLine: 21, endLine: 21 },
              theirsRange: { startLine: 23, endLine: 23 },
            },
          ],
        },
        {
          uri: aUri,
          repositoryRoot: "/repo",
          relativePath: "a.ts",
          gitUnmerged: true,
          locatedConflicts: [
            {
              id: "a-2",
              startLine: 10,
              separatorLine: 12,
              endLine: 14,
              oursRange: { startLine: 11, endLine: 11 },
              theirsRange: { startLine: 13, endLine: 13 },
            },
            {
              id: "a-1",
              startLine: 2,
              separatorLine: 4,
              endLine: 6,
              oursRange: { startLine: 3, endLine: 3 },
              theirsRange: { startLine: 5, endLine: 5 },
            },
          ],
        },
      ]),
    );

    expect(order.map((item) => item.conflictId)).toEqual(["a-1", "a-2", "b-1"]);
    expect(getWorkspaceConflictFileCount(createSnapshot([
      {
        uri: aUri,
        repositoryRoot: "/repo",
        relativePath: "a.ts",
        gitUnmerged: true,
        locatedConflicts: [
          {
            id: "a-1",
            startLine: 2,
            separatorLine: 4,
            endLine: 6,
            oursRange: { startLine: 3, endLine: 3 },
            theirsRange: { startLine: 5, endLine: 5 },
          },
        ],
      },
      {
        uri: bUri,
        repositoryRoot: "/repo",
        relativePath: "b.ts",
        gitUnmerged: true,
        locatedConflicts: [
          {
            id: "b-1",
            startLine: 20,
            separatorLine: 22,
            endLine: 24,
            oursRange: { startLine: 21, endLine: 21 },
            theirsRange: { startLine: 23, endLine: 23 },
          },
        ],
      },
    ]))).toBe(2);
    expect(findWorkspaceConflictIndexAtOrBefore(order, aUri, 11)).toBe(1);
    expect(findWorkspaceConflictIndexAtOrBefore(order, bUri, 0)).toBe(-1);
  });
});
