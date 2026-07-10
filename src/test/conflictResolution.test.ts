import { describe, expect, it, vi } from "vitest";

import {
  ACCEPT_CURRENT_CONFLICT_COMMAND,
  ACCEPT_INCOMING_CONFLICT_COMMAND,
  applyConflictResolution,
} from "../conflictResolution";
import type { ConflictSnapshot } from "../types";

const conflict = {
  id: "a",
  startLine: 1,
  separatorLine: 2,
  endLine: 3,
  oursRange: { startLine: 2, endLine: 2 },
  theirsRange: { startLine: 3, endLine: 3 },
};

const snapshot: ConflictSnapshot = {
  files: [
    {
      uri: "file:///repo/a.ts",
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [conflict],
    },
  ],
  locatedCount: 1,
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
