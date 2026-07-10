import { describe, expect, it, vi } from "vitest";

import {
  ACCEPT_CURRENT_CONFLICT_COMMAND,
  ACCEPT_INCOMING_CONFLICT_COMMAND,
  applyBatchConflictResolution,
  applyConflictResolution,
  collectBatchTargets,
  formatBatchResolutionMessage,
} from "../conflictResolution";
import type { ConflictBlock, ConflictSnapshot } from "../types";

function makeConflict(id: string, startLine: number): ConflictBlock {
  return {
    id,
    startLine,
    separatorLine: startLine + 1,
    endLine: startLine + 2,
    oursRange: { startLine: startLine + 1, endLine: startLine + 1 },
    theirsRange: { startLine: startLine + 2, endLine: startLine + 2 },
  };
}

const conflict = makeConflict("a", 1);

const snapshot: ConflictSnapshot = {
  files: [
    {
      uri: "file:///repo/a.ts",
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [conflict, makeConflict("b", 10)],
    },
    {
      uri: "file:///repo/b.ts",
      repositoryRoot: "/repo",
      relativePath: "b.ts",
      gitUnmerged: true,
      locatedConflicts: [makeConflict("c", 5)],
    },
  ],
  locatedCount: 3,
  gitOnlyCount: 0,
  generatedAt: 1,
};

describe("applyConflictResolution", () => {
  it("reveals the conflict then runs the built-in accept command", async () => {
    const revealConflict = vi.fn(async () => {});
    const runCommand = vi.fn(async () => {});

    const ok = await applyConflictResolution(
      snapshot,
      { revealConflict, runCommand },
      "file:///repo/a.ts",
      "a",
      "incoming",
    );

    expect(ok).toBe(true);
    expect(revealConflict).toHaveBeenCalledWith("file:///repo/a.ts", conflict);
    expect(runCommand).toHaveBeenCalledWith(ACCEPT_INCOMING_CONFLICT_COMMAND);
  });

  it("accepts current changes", async () => {
    const runCommand = vi.fn(async () => {});

    await applyConflictResolution(
      snapshot,
      { revealConflict: async () => {}, runCommand },
      "file:///repo/a.ts",
      "a",
      "current",
    );

    expect(runCommand).toHaveBeenCalledWith(ACCEPT_CURRENT_CONFLICT_COMMAND);
  });
});

describe("collectBatchTargets", () => {
  it("collects all conflicts when scope is all", () => {
    const targets = collectBatchTargets(snapshot, { kind: "all" });
    expect(targets).toHaveLength(3);
  });

  it("only collects conflicts from the target file when scope is file", () => {
    const targets = collectBatchTargets(snapshot, {
      kind: "file",
      fileUri: "file:///repo/a.ts",
    });
    expect(targets).toEqual([
      { uri: "file:///repo/a.ts", conflictId: "a" },
      { uri: "file:///repo/a.ts", conflictId: "b" },
    ]);
  });
});

describe("applyBatchConflictResolution", () => {
  it("processes all targets and reports a summary", async () => {
    const revealConflict = vi.fn(async () => {});
    const runCommand = vi.fn(async () => {});

    const summary = await applyBatchConflictResolution(
      snapshot,
      { revealConflict, runCommand },
      [
        { uri: "file:///repo/a.ts", conflictId: "a" },
        { uri: "file:///repo/a.ts", conflictId: "b" },
        { uri: "file:///repo/b.ts", conflictId: "c" },
      ],
      "current",
    );

    expect(summary).toEqual({ total: 3, resolved: 3, skipped: 0, failed: 0 });
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(runCommand).toHaveBeenCalledWith(ACCEPT_CURRENT_CONFLICT_COMMAND);
  });

  it("counts missing targets as skipped", async () => {
    const summary = await applyBatchConflictResolution(
      snapshot,
      { revealConflict: async () => {}, runCommand: async () => {} },
      [{ uri: "file:///repo/missing.ts", conflictId: "x" }],
      "incoming",
    );

    expect(summary).toEqual({ total: 1, resolved: 0, skipped: 1, failed: 0 });
  });
});

describe("formatBatchResolutionMessage", () => {
  it("formats success summary", () => {
    expect(
      formatBatchResolutionMessage("current", {
        total: 5,
        resolved: 5,
        skipped: 0,
        failed: 0,
      }),
    ).toContain("处理 5/5");
  });

  it("includes skipped count when present", () => {
    const message = formatBatchResolutionMessage("incoming", {
      total: 5,
      resolved: 4,
      skipped: 1,
      failed: 0,
    });
    expect(message).toContain("处理 4/5");
    expect(message).toContain("跳过 1");
  });
});