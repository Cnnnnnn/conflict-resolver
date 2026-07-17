import { describe, expect, it } from "vitest";

import { filterConflictCommands } from "../conflictCommandPalette";
import type { ConflictSnapshot } from "../types";

const emptySnapshot: ConflictSnapshot = {
  files: [],
  generatedAt: 0,
  locatedCount: 0,
  gitOnlyCount: 0,
};

const locatedSnapshot: ConflictSnapshot = {
  files: [
    {
      uri: "file:///repo/a.ts",
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [
        {
          id: "a-1",
          startLine: 1,
          separatorLine: 2,
          endLine: 3,
          oursRange: { startLine: 2, endLine: 2 },
          theirsRange: { startLine: 3, endLine: 3 },
        },
      ],
    },
  ],
  generatedAt: 1,
  locatedCount: 1,
  gitOnlyCount: 0,
};

describe("filterConflictCommands", () => {
  it("returns all visible commands when no query is given", () => {
    const result = filterConflictCommands({
      context: {
        snapshot: emptySnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    expect(result.length).toBeGreaterThan(5);
    expect(result.every((entry) => entry.score === 0)).toBe(true);
  });

  it("hides navigation commands when there are no located conflicts", () => {
    const result = filterConflictCommands({
      context: {
        snapshot: emptySnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    expect(result.find((entry) => entry.command === "conflictResolver.nextConflict")).toBeUndefined();
  });

  it("shows navigation commands when there are located conflicts", () => {
    const result = filterConflictCommands({
      context: {
        snapshot: locatedSnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    expect(result.find((entry) => entry.command === "conflictResolver.nextConflict")).toBeDefined();
    expect(result.find((entry) => entry.command === "conflictResolver.previousFile")).toBeDefined();
  });

  it("hides scenario commands when not in a merge scenario", () => {
    const result = filterConflictCommands({
      context: {
        snapshot: locatedSnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    expect(result.find((entry) => entry.command === "conflictResolver.continueScenario")).toBeUndefined();
  });

  it("shows stageAllResolved when markersCleared", () => {
    const result = filterConflictCommands({
      context: {
        snapshot: emptySnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: true,
      },
    });
    expect(result.find((entry) => entry.command === "conflictResolver.stageAllResolved")).toBeDefined();
  });

  it("fuzzy-matches by Chinese label substring", () => {
    const result = filterConflictCommands({
      query: "下一",
      context: {
        snapshot: locatedSnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    const commands = result.map((entry) => entry.command);
    expect(commands).toContain("conflictResolver.nextConflict");
    expect(commands).toContain("conflictResolver.nextFile");
  });

  it("fuzzy-matches by alias (subsequence)", () => {
    const result = filterConflictCommands({
      query: "und",
      context: {
        snapshot: locatedSnapshot,
        hasUndo: true,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    expect(result[0]?.command).toBe("conflictResolver.undoLastAccept");
  });

  it("ranks batch-accept commands above others for the 采用 query", () => {
    const result = filterConflictCommands({
      query: "采用",
      context: {
        snapshot: emptySnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    const commands = result.map((entry) => entry.command);
    // Both batch accept commands match; they should both be in the result
    // and outrank anything else that only matched via fuzzy-subsequence.
    expect(commands).toContain("conflictResolver.batchAcceptCurrent");
    expect(commands).toContain("conflictResolver.batchAcceptIncoming");
    expect(commands).not.toContain("conflictResolver.batchAcceptBoth");
    expect(commands.length).toBe(2);
  });

  it("hides undo commands when hasUndo is false", () => {
    const result = filterConflictCommands({
      context: {
        snapshot: locatedSnapshot,
        hasUndo: false,
        scenarioInProgress: false,
        markersCleared: false,
      },
    });
    expect(result.find((entry) => entry.command === "conflictResolver.undoLastAccept")).toBeUndefined();
  });

  describe("cr namespace prefix", () => {
    const locatedContext = {
      snapshot: locatedSnapshot,
      hasUndo: false,
      scenarioInProgress: false,
      markersCleared: false,
    };

    it("treats bare `cr` as listing everything visible", () => {
      const bare = filterConflictCommands({ context: locatedContext });
      const crOnly = filterConflictCommands({ query: "cr", context: locatedContext });
      expect(crOnly.map((entry) => entry.command)).toEqual(
        bare.map((entry) => entry.command),
      );
    });

    it("strips `cr ` prefix before matching", () => {
      const nextDirect = filterConflictCommands({ query: "下一", context: locatedContext });
      const nextCr = filterConflictCommands({ query: "cr 下一", context: locatedContext });
      expect(nextCr.map((entry) => entry.command)).toEqual(
        nextDirect.map((entry) => entry.command),
      );
    });

    it("case-insensitive prefix match", () => {
      const upper = filterConflictCommands({ query: "CR next", context: locatedContext });
      const lower = filterConflictCommands({ query: "cr next", context: locatedContext });
      expect(upper.map((entry) => entry.command)).toEqual(
        lower.map((entry) => entry.command),
      );
      expect(upper[0]?.command).toBe("conflictResolver.nextConflict");
    });

    it("does not strip `cr` mid-query", () => {
      // "across" still fuzzy-matches `cr` subsequence; `cr` as a
      // prefix is the namespace signal, not every occurrence.
      const result = filterConflictCommands({ query: "across", context: locatedContext });
      expect(result.length).toBe(0);
    });
  });
});