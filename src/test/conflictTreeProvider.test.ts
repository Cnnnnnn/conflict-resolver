import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CONFLICT_TREE_GO_TO_COMMAND,
  CONFLICT_TREE_OPEN_MR_COMMAND,
  ConflictTreeProvider,
  type ConflictTreeFileItem,
  type ConflictTreeGroupItem,
  type ConflictTreeRemoteMrItem,
} from "../conflictTreeProvider";
import type { ConflictSnapshot, RemoteMergeRequestSnapshot } from "../types";

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

class FakeRemoteMrStore {
  private readonly listeners = new Set<(snapshot: RemoteMergeRequestSnapshot) => unknown>();
  private snapshot: RemoteMergeRequestSnapshot;

  constructor(snapshot: RemoteMergeRequestSnapshot) {
    this.snapshot = snapshot;
  }

  getSnapshot(): RemoteMergeRequestSnapshot {
    return this.snapshot;
  }

  onDidChange(listener: (snapshot: RemoteMergeRequestSnapshot) => unknown) {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async emit(snapshot: RemoteMergeRequestSnapshot): Promise<void> {
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
    expect(rootItems[0].label).toBe("剩余 3 文件 · 3 处冲突 · 2 处未知冲突");
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

  it("renders remote MR items sorted by IID with open-url command payloads", async () => {
    const store = new FakeConflictStore(createSnapshot([]));
    const remoteStore = new FakeRemoteMrStore({
      repositoryRoot: "/repo",
      branch: "feature/login",
      generatedAt: 1,
      mergeRequests: [
        {
          iid: 123,
          title: "Login flow",
          webUrl: "https://gitlab.com/group/project/-/merge_requests/123",
          sourceBranch: "feature/login",
          targetBranch: "main",
          hasConflicts: true,
        },
        {
          iid: 45,
          title: "Earlier MR",
          webUrl: "https://gitlab.com/group/project/-/merge_requests/45",
          sourceBranch: "feature/login",
          targetBranch: "main",
          hasConflicts: false,
        },
      ],
    });

    const provider = new ConflictTreeProvider(store, remoteStore);
    const rootItems = await provider.getChildren();
    expect(rootItems).toHaveLength(3);

    const remoteGroup = rootItems[2] as ConflictTreeGroupItem;
    expect(remoteGroup.label).toBe("远程 MR");

    const remoteItems = await provider.getChildren(remoteGroup);
    expect(remoteItems.map((item) => item.label)).toEqual([
      "!45 feature/login → main",
      "!123 feature/login → main",
    ]);
    expect(remoteItems.map((item) => item.description)).toEqual([
      "无合并冲突",
      "存在合并冲突",
    ]);

    const firstMr = remoteItems[0] as ConflictTreeRemoteMrItem;
    expect(firstMr.command).toEqual({
      command: CONFLICT_TREE_OPEN_MR_COMMAND,
      title: "Open merge request",
      arguments: [{ webUrl: "https://gitlab.com/group/project/-/merge_requests/45" }],
    });

    const mrActions = await provider.getChildren(firstMr);
    expect(mrActions.map((item) => item.label)).toEqual([
      "获取目标分支 origin/main",
      "本地预演合并",
      "打开 MR 页面",
    ]);

    const conflictMr = remoteItems[1] as ConflictTreeRemoteMrItem;
    const conflictActions = await provider.getChildren(conflictMr);
    expect(conflictActions.map((item) => item.label)).toContain("在 GitLab 解决冲突");
  });

  it("shows remote status messages for empty and error snapshots", async () => {
    const store = new FakeConflictStore(createSnapshot([]));
    const remoteStore = new FakeRemoteMrStore({
      repositoryRoot: "/repo",
      branch: "feature/login",
      generatedAt: 1,
      mergeRequests: [],
      error: "not-found",
    });

    const provider = new ConflictTreeProvider(store, remoteStore);
    const remoteGroup = (await provider.getChildren()).at(-1) as ConflictTreeGroupItem;
    const statusItems = await provider.getChildren(remoteGroup);

    expect(statusItems).toHaveLength(1);
    expect(statusItems[0].label).toBe("未找到当前分支 MR");
  });

  it("hides the remote group when GitLab is not configured", async () => {
    const store = new FakeConflictStore(createSnapshot([]));
    const remoteStore = new FakeRemoteMrStore({
      repositoryRoot: "/repo",
      branch: "",
      generatedAt: 1,
      mergeRequests: [],
      error: "not-configured",
    });

    const provider = new ConflictTreeProvider(store, remoteStore);
    const rootItems = await provider.getChildren();

    expect(rootItems).toHaveLength(2);
    expect(rootItems.map((item) => item.label)).toEqual([
      "可定位冲突：0",
      "Git 未解决但位置未知：0",
    ]);
  });
});
