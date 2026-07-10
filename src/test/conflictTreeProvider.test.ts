import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CONFLICT_TREE_GO_TO_COMMAND,
  ConflictTreeProvider,
  type ConflictTreeFileItem,
  type ConflictTreeGroupItem,
} from "../conflictTreeProvider";
import type { ConflictSnapshot } from "../types";

function toUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function createSnapshot(
  files: ConflictSnapshot["files"],
  overrides?: Partial<ConflictSnapshot>,
): ConflictSnapshot {
  return {
    files,
    locatedCount: files.reduce(
      (count, file) => count + file.locatedConflicts.length,
      0,
    ),
    gitOnlyCount: files.filter(
      (file) => file.gitUnmerged && file.locatedConflicts.length === 0,
    ).length,
    generatedAt: 1,
    ...overrides,
  };
}

class FakeConflictStore {
  private readonly listeners = new Set<(snapshot: ConflictSnapshot) => unknown>();
  private snapshot: ConflictSnapshot;

  constructor(snapshot: ConflictSnapshot) {
    this.snapshot = snapshot;
  }

  getSnapshot(): ConflictSnapshot {
    return this.snapshot;
  }

  onDidChange(listener: (snapshot: ConflictSnapshot) => unknown) {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async emit(snapshot: ConflictSnapshot): Promise<void> {
    this.snapshot = snapshot;

    for (const listener of [...this.listeners]) {
      await listener(snapshot);
    }
  }
}

describe("ConflictTreeProvider", () => {
  it("renders deterministic groups, files, and conflict command payloads", async () => {
    const store = new FakeConflictStore(
      createSnapshot([
        {
          uri: toUri("/repo/src/z.ts"),
          repositoryRoot: "/repo",
          relativePath: "src/z.ts",
          gitUnmerged: true,
          locatedConflicts: [
            {
              id: "z-late",
              startLine: 10,
              separatorLine: 12,
              endLine: 14,
              oursRange: { startLine: 11, endLine: 11 },
              theirsRange: { startLine: 13, endLine: 13 },
            },
            {
              id: "z-early",
              startLine: 2,
              separatorLine: 4,
              endLine: 6,
              oursRange: { startLine: 3, endLine: 3 },
              theirsRange: { startLine: 5, endLine: 5 },
            },
          ],
        },
        {
          uri: toUri("/repo/config.json"),
          repositoryRoot: "/repo",
          relativePath: "config.json",
          gitUnmerged: true,
          locatedConflicts: [],
        },
        {
          uri: toUri("/repo/src/a.ts"),
          repositoryRoot: "/repo",
          relativePath: "src/a.ts",
          gitUnmerged: false,
          locatedConflicts: [
            {
              id: "a-only",
              startLine: 4,
              separatorLine: 6,
              endLine: 8,
              oursRange: { startLine: 5, endLine: 5 },
              theirsRange: { startLine: 7, endLine: 7 },
            },
          ],
        },
        {
          uri: toUri("/repo/notes.md"),
          repositoryRoot: "/repo",
          relativePath: "notes.md",
          gitUnmerged: true,
          locatedConflicts: [],
        },
      ]),
    );

    const provider = new ConflictTreeProvider(store);

    const rootItems = await provider.getChildren();
    expect(rootItems).toHaveLength(2);
    expect(rootItems.map((item) => item.label)).toEqual([
      "可定位冲突：3",
      "Git 未解决但位置未知：2",
    ]);

    const [locatedGroup, gitOnlyGroup] = rootItems as ConflictTreeGroupItem[];
    const locatedFiles = await provider.getChildren(locatedGroup);
    expect(locatedFiles.map((item) => item.label)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(locatedFiles.map((item) => (item as ConflictTreeFileItem).description)).toEqual([
      "1",
      "2",
    ]);

    const gitOnlyFiles = await provider.getChildren(gitOnlyGroup);
    expect(gitOnlyFiles.map((item) => item.label)).toEqual([
      "config.json",
      "notes.md",
    ]);
    expect(gitOnlyFiles.map((item) => (item as ConflictTreeFileItem).description)).toEqual([
      "Git 状态未解决",
      "Git 状态未解决",
    ]);

    const zFile = locatedFiles[1] as ConflictTreeFileItem;
    const conflicts = await provider.getChildren(zFile);
    expect(conflicts.map((item) => item.label)).toEqual(["冲突 1", "冲突 2"]);
    expect(conflicts.map((item) => item.description)).toEqual([
      "第 3 行",
      "第 11 行",
    ]);
    expect(conflicts[0].command).toEqual({
      command: CONFLICT_TREE_GO_TO_COMMAND,
      title: "Go to conflict",
      arguments: [
        {
          uri: zFile.uri,
          conflictId: "z-early",
        },
      ],
    });
  });

  it("refreshes the view when the store publishes a new snapshot", async () => {
    const initialSnapshot = createSnapshot([
      {
        uri: toUri("/repo/alpha.ts"),
        repositoryRoot: "/repo",
        relativePath: "alpha.ts",
        gitUnmerged: true,
        locatedConflicts: [],
      },
    ]);
    const updatedSnapshot = createSnapshot([
      {
        uri: toUri("/repo/beta.ts"),
        repositoryRoot: "/repo",
        relativePath: "beta.ts",
        gitUnmerged: false,
        locatedConflicts: [
          {
            id: "beta-1",
            startLine: 1,
            separatorLine: 3,
            endLine: 5,
            oursRange: { startLine: 2, endLine: 2 },
            theirsRange: { startLine: 4, endLine: 4 },
          },
        ],
      },
    ]);
    const store = new FakeConflictStore(initialSnapshot);
    const provider = new ConflictTreeProvider(store);
    const onDidChangeTreeData = vi.fn();

    provider.onDidChangeTreeData(onDidChangeTreeData);
    await store.emit(updatedSnapshot);

    expect(onDidChangeTreeData).toHaveBeenCalledTimes(1);

    const [locatedGroup, gitOnlyGroup] = await provider.getChildren();
    expect(locatedGroup.label).toBe("可定位冲突：1");
    expect(gitOnlyGroup.label).toBe("Git 未解决但位置未知：0");
    expect((await provider.getChildren(locatedGroup as ConflictTreeGroupItem)).map((item) => item.label)).toEqual([
      "beta.ts",
    ]);
    expect(await provider.getChildren(gitOnlyGroup as ConflictTreeGroupItem)).toEqual([]);
  });
});
