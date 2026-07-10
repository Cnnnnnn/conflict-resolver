import { describe, expect, it, vi } from "vitest";
import { ConflictDecorationManager } from "../conflictDecorations";
import type { ConflictSnapshot } from "../types";

describe("ConflictDecorationManager", () => {
  it("applies located ranges and clears editors absent from the snapshot", () => {
    const first = { uri: "file:///a", setStartLineDecorations: vi.fn(), setOverviewDecorations: vi.fn() };
    const second = { uri: "file:///b", setStartLineDecorations: vi.fn(), setOverviewDecorations: vi.fn() };
    const manager = new ConflictDecorationManager({ getEditors: () => [first, second] });
    const snapshot: ConflictSnapshot = { generatedAt: 0, locatedCount: 1, gitOnlyCount: 0, files: [{ uri: "file:///a", repositoryRoot: "/", relativePath: "a", gitUnmerged: true, locatedConflicts: [{ id: "1", startLine: 4, separatorLine: 5, endLine: 6, oursRange: { startLine: 4, endLine: 4 }, theirsRange: { startLine: 6, endLine: 6 } }] }] };
    manager.update(snapshot);
    expect(first.setStartLineDecorations).toHaveBeenCalledWith([{ startLine: 4, endLine: 4 }]);
    expect(second.setOverviewDecorations).toHaveBeenCalledWith([]);
  });
});
