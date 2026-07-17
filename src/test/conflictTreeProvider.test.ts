import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CONFLICT_TREE_ACCEPT_CURRENT_COMMAND,
  CONFLICT_TREE_ACCEPT_INCOMING_COMMAND,
  CONFLICT_TREE_ACCEPT_BOTH_COMMAND,
  CONFLICT_TREE_GO_TO_COMMAND,
  ConflictTreeProvider,
  type ConflictTreeConflictItem,
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
          parseError: "Failed to load unmerged file: unknown format",
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
          parseError: "Failed to load unmerged file: unknown format",
        },
      ]),
    );

    const provider = new ConflictTreeProvider(store);

    const rootItems = await provider.getChildren();
    expect(rootItems).toHaveLength(3);
    expect(rootItems[0].label).toBe("3 文件 · 3 处冲突 · 2 处未知冲突");
    expect(rootItems.slice(1).map((item) => item.label)).toEqual([
      "可定位冲突：3",
      "Git 未解决但位置未知：2",
    ]);

    const [, locatedGroup, gitOnlyGroup] = rootItems as [
      unknown,
      ConflictTreeGroupItem,
      ConflictTreeGroupItem,
    ];
    const locatedFiles = await provider.getChildren(locatedGroup);
    expect(locatedFiles.map((item) => item.label)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(locatedFiles.map((item) => (item as ConflictTreeFileItem).description)).toEqual([
      "1个冲突",
      "2个冲突",
    ]);

    const gitOnlyFiles = await provider.getChildren(gitOnlyGroup);
    expect(gitOnlyFiles.map((item) => item.label)).toEqual([
      "config.json",
      "notes.md",
    ]);
    expect(gitOnlyFiles.map((item) => (item as ConflictTreeFileItem).description)).toEqual([
      "未知冲突",
      "未知冲突",
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
    const firstConflict = conflicts[0] as ConflictTreeConflictItem;
    expect(firstConflict.buttons).toHaveLength(4);
    expect(firstConflict.buttons?.[0]?.command).toMatchObject({
      command: CONFLICT_TREE_ACCEPT_CURRENT_COMMAND,
      arguments: [{ uri: zFile.uri, conflictId: "z-early" }],
    });
    expect(firstConflict.buttons?.[1]?.command).toMatchObject({
      command: CONFLICT_TREE_ACCEPT_INCOMING_COMMAND,
      arguments: [{ uri: zFile.uri, conflictId: "z-early" }],
    });
    expect(firstConflict.buttons?.[2]?.command).toMatchObject({
      command: CONFLICT_TREE_ACCEPT_BOTH_COMMAND,
      arguments: [{ uri: zFile.uri, conflictId: "z-early" }],
    });
  });

  it("shows preview tooltip and completion state", async () => {
    const store = new FakeConflictStore(
      createSnapshot(
        [
          {
            uri: toUri("/repo/a.ts"),
            repositoryRoot: "/repo",
            relativePath: "a.ts",
            gitUnmerged: true,
            locatedConflicts: [],
          },
        ],
        { gitOnlyCount: 0, locatedCount: 0 },
      ),
    );
    const provider = new ConflictTreeProvider(store, undefined, {
      getFileText: () => "<<<<<<<\nours\n=======\ntheirs\n>>>>>>>",
    });
    provider.setWorkState({ hadLocatedConflicts: true, hadUnmergedFiles: true });

    const rootItems = await provider.getChildren();
    expect(rootItems[0].label).toBe(
      "✓ 冲突标记已处理 · 剩余 1 个文件待 git add（命令面板: Conflict Resolver: Stage All Resolved）",
    );
    expect(provider.getCompletionMessage()).toBe(
      "✓ 冲突标记已处理 · 剩余 1 个文件待 git add（命令面板: Conflict Resolver: Stage All Resolved）",
    );

    const activeStore = new FakeConflictStore(
      createSnapshot([
        {
          uri: toUri("/repo/a.ts"),
          repositoryRoot: "/repo",
          relativePath: "a.ts",
          gitUnmerged: true,
          locatedConflicts: [
            {
              id: "a",
              startLine: 0,
              separatorLine: 2,
              endLine: 4,
              oursRange: { startLine: 1, endLine: 1 },
              theirsRange: { startLine: 3, endLine: 3 },
            },
          ],
        },
      ]),
    );
    const activeProvider = new ConflictTreeProvider(activeStore, undefined, {
      getFileText: () => "<<<<<<<\nours\n=======\ntheirs\n>>>>>>>",
    });
    const activeRootItems = await activeProvider.getChildren();
    const locatedGroup = activeRootItems.find((item) =>
      String(item.label).startsWith("可定位冲突"),
    ) as ConflictTreeGroupItem;
    const [file] = await activeProvider.getChildren(locatedGroup);
    const [conflictItem] = await activeProvider.getChildren(file as ConflictTreeFileItem);
    expect(String(conflictItem.tooltip)).toContain("ours");
    expect(String(conflictItem.tooltip)).toContain("theirs");
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

    const [locatedGroup, gitOnlyGroup] = (await provider.getChildren()).slice(-2) as [
      ConflictTreeGroupItem,
      ConflictTreeGroupItem,
    ];
    expect(locatedGroup.label).toBe("可定位冲突：1");
    expect(gitOnlyGroup.label).toBe("Git 未解决但位置未知：0");
    expect((await provider.getChildren(locatedGroup as ConflictTreeGroupItem)).map((item) => item.label)).toEqual([
      "beta.ts",
    ]);
    expect(await provider.getChildren(gitOnlyGroup as ConflictTreeGroupItem)).toEqual([]);
  });
});
