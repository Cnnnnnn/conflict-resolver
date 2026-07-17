import { describe, expect, it } from "vitest";
import {
  ConflictStatusBar,
  getStatusBarState,
  type StatusBarItemAdapter,
} from "../statusBar";
import type { ConflictSnapshot } from "../types";

const snapshot = (files: ConflictSnapshot["files"]): ConflictSnapshot => ({
  files,
  generatedAt: 0,
  locatedCount: files.reduce((total, file) => total + file.locatedConflicts.length, 0),
  gitOnlyCount: files.filter((file) => file.gitUnmerged && file.locatedConflicts.length === 0).length,
});

describe("getStatusBarState", () => {
  it("shows workspace conflict position and file count", () => {
    const current = {
      uri: "file:///repo/a.ts",
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [
        { id: "a", startLine: 1, separatorLine: 2, endLine: 3, oursRange: { startLine: 2, endLine: 2 }, theirsRange: { startLine: 3, endLine: 3 } },
      ],
    };
    const other = { ...current, uri: "file:///repo/b.ts", relativePath: "b.ts", locatedConflicts: [current.locatedConflicts[0], current.locatedConflicts[0]] };
    expect(getStatusBarState(snapshot([current, other]), current.uri, 1)).toMatchObject({
      kind: "located",
      text: "冲突 1/3 · 2 文件",
    });
  });

  it("shows workspace summary when viewing a non-conflict file", () => {
    const conflictFile = {
      uri: "file:///repo/a.ts",
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [
        { id: "a", startLine: 1, separatorLine: 2, endLine: 3, oursRange: { startLine: 2, endLine: 2 }, theirsRange: { startLine: 3, endLine: 3 } },
      ],
    };
    const cleanFile = { ...conflictFile, uri: "file:///repo/clean.ts", relativePath: "clean.ts", gitUnmerged: false, locatedConflicts: [] };
    expect(getStatusBarState(snapshot([conflictFile, cleanFile]), cleanFile.uri, 0)).toMatchObject({
      kind: "located",
      text: "共 1 处冲突 · 1 文件",
    });
  });

  it("shows Git-only state and hides unrelated files", () => {
    const file = { uri: "file:///repo/a.ts", repositoryRoot: "/repo", relativePath: "a.ts", gitUnmerged: true, locatedConflicts: [] };
    const state = getStatusBarState(snapshot([file]), file.uri, 0);
    expect(state).toMatchObject({ kind: "git-only", text: "Git 未解决，位置未知" });
    expect(getStatusBarState(snapshot([file]), "file:///repo/other.ts", 0)).toBeUndefined();
  });

  it("prefixes the label with the scenario icon when provided", () => {
    const file = {
      uri: "file:///repo/a.ts",
      repositoryRoot: "/repo",
      relativePath: "a.ts",
      gitUnmerged: true,
      locatedConflicts: [
        { id: "a", startLine: 1, separatorLine: 2, endLine: 3, oursRange: { startLine: 2, endLine: 2 }, theirsRange: { startLine: 3, endLine: 3 } },
      ],
    };
    const state = getStatusBarState(snapshot([file]), file.uri, 1, "$(git-merge)");
    expect(state).toMatchObject({
      kind: "located",
      text: "$(git-merge) 冲突 1/1 · 1 文件",
    });
  });

  it("prefixes the Git-only label with the scenario icon when provided", () => {
    const file = { uri: "file:///repo/a.ts", repositoryRoot: "/repo", relativePath: "a.ts", gitUnmerged: true, locatedConflicts: [] };
    const state = getStatusBarState(snapshot([file]), file.uri, 0, "$(history)");
    expect(state).toMatchObject({
      kind: "git-only",
      text: "$(history) Git 未解决，位置未知",
    });
  });
});

describe("ConflictStatusBar label command", () => {
  type AdapterItem = StatusBarItemAdapter & { text: string; command: string | undefined; tooltip: string | undefined; visible: boolean };

  function makeItem(): AdapterItem {
    let item: AdapterItem;
    return item = {
      text: "",
      command: undefined,
      tooltip: undefined,
      visible: false,
      show() {
        this.visible = true;
      },
      hide() {
        this.visible = false;
      },
      dispose() {
        item.visible = false;
      },
    };
  }

  function makeAdapter() {
    const items: AdapterItem[] = [];
    return {
      items,
      createStatusBarItem(): AdapterItem {
        const item = makeItem();
        items.push(item);
        return item;
      },
    };
  }

  function makeStore(getSnapshotValue: ConflictSnapshot) {
    return {
      getSnapshot: () => getSnapshotValue,
      onDidChange: (listener: (snapshot: ConflictSnapshot) => void) => {
        listener(getSnapshotValue);
        return { dispose: () => undefined };
      },
    };
  }

  function makeActiveFile(uri?: string) {
    return {
      getActiveUri: () => uri,
      getActiveLine: () => 1,
      onDidChangeActiveUri: () => ({ dispose: () => undefined }),
    };
  }

  const conflictFile = {
    uri: "file:///repo/a.ts",
    repositoryRoot: "/repo",
    relativePath: "a.ts",
    gitUnmerged: true,
    locatedConflicts: [
      { id: "a", startLine: 1, separatorLine: 2, endLine: 3, oursRange: { startLine: 2, endLine: 2 }, theirsRange: { startLine: 3, endLine: 3 } },
    ],
  };
  const gitOnlyFile = { ...conflictFile, locatedConflicts: [] };

  it("uses the default resolver to attach a command to the label", () => {
    const adapter = makeAdapter();
    const bar = new ConflictStatusBar({
      statusBar: adapter,
      store: makeStore(snapshot([conflictFile])),
      activeFile: makeActiveFile(conflictFile.uri),
    });
    const label = adapter.items[1]!;
    expect(label.command).toBe("conflictResolver.nextConflict");
    bar.dispose();
  });

  it("opens panel for located conflicts when viewing an unrelated file", () => {
    const adapter = makeAdapter();
    const bar = new ConflictStatusBar({
      statusBar: adapter,
      store: makeStore(snapshot([conflictFile])),
      activeFile: makeActiveFile("file:///repo/other.ts"),
    });
    expect(adapter.items[1]!.command).toBe("conflictResolver.openPanel");
    bar.dispose();
  });

  it("uses rescanCurrentFile for git-only labels", () => {
    const adapter = makeAdapter();
    const bar = new ConflictStatusBar({
      statusBar: adapter,
      store: makeStore(snapshot([gitOnlyFile])),
      activeFile: makeActiveFile(gitOnlyFile.uri),
    });
    const label = adapter.items[1]!;
    expect(label.command).toBe("conflictResolver.rescanCurrentFile");
    bar.dispose();
  });

  it("refreshCommand re-evaluates the resolver", () => {
    const adapter = makeAdapter();
    const stageAll = "conflictResolver.stageAllResolved";
    const continueScenario = "conflictResolver.continueScenario";
    let pick: string | undefined = stageAll;
    const bar = new ConflictStatusBar({
      statusBar: adapter,
      store: makeStore(snapshot([conflictFile])),
      activeFile: makeActiveFile(),
      resolveCommand: () => pick,
    });
    expect(adapter.items[1]!.command).toBe(stageAll);
    pick = continueScenario;
    bar.refreshCommand();
    expect(adapter.items[1]!.command).toBe(continueScenario);
    bar.dispose();
  });
});
