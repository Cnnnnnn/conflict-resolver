import { describe, expect, it } from "vitest";

import {
  countGitOnlyFiles,
  countLocatedConflicts,
  hasLocatedConflicts,
  isGitOnlyUnresolved,
  isUnresolvedConflictFile,
} from "../conflictPredicates";
import type { ConflictFile, ConflictSnapshot } from "../types";

function file(overrides: Partial<ConflictFile> = {}): ConflictFile {
  return {
    uri: "file:///repo/a.ts",
    repositoryRoot: "/repo",
    relativePath: "a.ts",
    gitUnmerged: false,
    locatedConflicts: [],
    ...overrides,
  };
}

describe("conflictPredicates", () => {
  describe("isGitOnlyUnresolved", () => {
    it("matches git-unmerged files with no located markers", () => {
      expect(
        isGitOnlyUnresolved(file({ gitUnmerged: true, locatedConflicts: [] })),
      ).toBe(true);
    });

    it("matches even when the file has no parseError (structural predicate)", () => {
      // The old definition required parseError !== undefined; the
      // central definition intentionally drops that requirement so
      // the tree, decorations, and merge progress all agree on
      // "git says unresolved + we found nothing inline" without a
      // parser-specific exception.
      expect(
        isGitOnlyUnresolved(
          file({ gitUnmerged: true, locatedConflicts: [], parseError: undefined }),
        ),
      ).toBe(true);
    });

    it("does not match files git considers clean", () => {
      expect(
        isGitOnlyUnresolved(file({ gitUnmerged: false, locatedConflicts: [] })),
      ).toBe(false);
    });

    it("does not match files with located conflicts", () => {
      expect(
        isGitOnlyUnresolved(
          file({ gitUnmerged: true, locatedConflicts: [{ id: "1", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }] }),
        ),
      ).toBe(false);
    });
  });

  describe("hasLocatedConflicts", () => {
    it("returns true when there is at least one located marker", () => {
      expect(
        hasLocatedConflicts(
          file({ locatedConflicts: [{ id: "1", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }] }),
        ),
      ).toBe(true);
    });

    it("returns false when locatedConflicts is empty", () => {
      expect(hasLocatedConflicts(file({ locatedConflicts: [] }))).toBe(false);
    });
  });

  describe("isUnresolvedConflictFile", () => {
    it("covers both git-unmerged and located branches", () => {
      expect(isUnresolvedConflictFile(file({ gitUnmerged: true, locatedConflicts: [] }))).toBe(true);
      expect(
        isUnresolvedConflictFile(
          file({ gitUnmerged: false, locatedConflicts: [{ id: "1", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }] }),
        ),
      ).toBe(true);
    });

    it("returns false for fully clean files", () => {
      expect(isUnresolvedConflictFile(file({ gitUnmerged: false, locatedConflicts: [] }))).toBe(false);
    });
  });

  describe("countLocatedConflicts", () => {
    it("sums locatedConflicts.length across the file list", () => {
      const files = [
        file({ locatedConflicts: [{ id: "a", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }, { id: "b", startLine: 3, separatorLine: 4, endLine: 5, oursRange: { startLine: 3, endLine: 3 }, theirsRange: { startLine: 4, endLine: 4 } }] }),
        file({ locatedConflicts: [{ id: "c", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }] }),
      ];
      expect(countLocatedConflicts(files)).toBe(3);
    });

    it("works against a ConflictSnapshot too", () => {
      const snapshot: ConflictSnapshot = {
        files: [file({ locatedConflicts: [{ id: "x", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }] })],
        generatedAt: 0,
        locatedCount: 0,
        gitOnlyCount: 0,
      };
      expect(countLocatedConflicts(snapshot)).toBe(1);
    });
  });

  describe("countGitOnlyFiles", () => {
    it("counts files that are git-unmerged with zero located markers", () => {
      const files = [
        file({ gitUnmerged: true, locatedConflicts: [] }),
        file({ gitUnmerged: true, locatedConflicts: [] }),
        file({ gitUnmerged: false, locatedConflicts: [] }),
        file({ gitUnmerged: true, locatedConflicts: [{ id: "x", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }] }),
      ];
      expect(countGitOnlyFiles(files)).toBe(2);
    });

    it("agrees with the snapshot's gitOnlyCount for the same input", () => {
      // Locks the invariant that test fixtures (which previously
      // re-inlined the filter) and the snapshot agree on what counts
      // as git-only.
      const files = [
        file({ gitUnmerged: true, locatedConflicts: [] }),
        file({ gitUnmerged: true, locatedConflicts: [{ id: "y", startLine: 0, separatorLine: 1, endLine: 2, oursRange: { startLine: 0, endLine: 0 }, theirsRange: { startLine: 1, endLine: 1 } }] }),
        file({ gitUnmerged: false, locatedConflicts: [] }),
      ];
      const snapshot: ConflictSnapshot = {
        files,
        generatedAt: 0,
        locatedCount: countLocatedConflicts(files),
        gitOnlyCount: countGitOnlyFiles(files),
      };
      expect(snapshot.gitOnlyCount).toBe(1);
      expect(countGitOnlyFiles(snapshot)).toBe(snapshot.gitOnlyCount);
    });
  });
});