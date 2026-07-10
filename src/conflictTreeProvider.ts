import type * as vscode from "vscode";

import type {
  ConflictStore,
  ConflictStoreChangeListener,
  ConflictStoreDisposable,
} from "./conflictStore";
import type { ConflictBlock, ConflictFile, ConflictSnapshot } from "./types";

const COLLAPSE_NONE = 0;
const COLLAPSE_COLLAPSED = 1;
const COLLAPSE_EXPANDED = 2;

export const CONFLICT_TREE_GO_TO_COMMAND = "conflictResolver.goToConflict";

export type ConflictTreeCommandArguments = {
  uri: string;
  conflictId: string;
};

export type ConflictTreeGroupKey = "located" | "gitOnly";

type ConflictTreeItemBase = vscode.TreeItem & {
  id: string;
  kind: "group" | "file" | "conflict";
  collapsibleState: number;
  contextValue: string;
};

export type ConflictTreeGroupItem = ConflictTreeItemBase & {
  kind: "group";
  groupKey: ConflictTreeGroupKey;
  label: string;
};

export type ConflictTreeFileItem = ConflictTreeItemBase & {
  kind: "file";
  groupKey: ConflictTreeGroupKey;
  label: string;
  uri: string;
  relativePath: string;
  conflictCount: number;
  gitUnmerged: boolean;
};

export type ConflictTreeConflictItem = ConflictTreeItemBase & {
  kind: "conflict";
  label: string;
  uri: string;
  conflictId: string;
  conflictIndex: number;
  startLine: number;
  endLine: number;
  command: vscode.Command;
};

export type ConflictTreeItem =
  | ConflictTreeGroupItem
  | ConflictTreeFileItem
  | ConflictTreeConflictItem;

type ConflictTreeStore = Pick<ConflictStore, "getSnapshot" | "onDidChange">;

class SimpleEmitter<T> implements vscode.Disposable {
  private readonly listeners = new Set<(event: T) => unknown>();

  readonly event = ((listener: (event: T) => unknown) => {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }) as vscode.Event<T>;

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function compareFiles(left: ConflictFile, right: ConflictFile): number {
  if (left.relativePath < right.relativePath) {
    return -1;
  }

  if (left.relativePath > right.relativePath) {
    return 1;
  }

  if (left.uri < right.uri) {
    return -1;
  }

  if (left.uri > right.uri) {
    return 1;
  }

  return 0;
}

function compareConflicts(left: ConflictBlock, right: ConflictBlock): number {
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }

  if (left.endLine !== right.endLine) {
    return left.endLine - right.endLine;
  }

  if (left.id < right.id) {
    return -1;
  }

  if (left.id > right.id) {
    return 1;
  }

  return 0;
}

function getLocatedFiles(snapshot: ConflictSnapshot): ConflictFile[] {
  return [...snapshot.files]
    .filter((file) => file.locatedConflicts.length > 0)
    .sort(compareFiles);
}

function getGitOnlyFiles(snapshot: ConflictSnapshot): ConflictFile[] {
  return [...snapshot.files]
    .filter((file) => file.gitUnmerged && file.locatedConflicts.length === 0)
    .sort(compareFiles);
}

function createGroupItem(
  groupKey: ConflictTreeGroupKey,
  count: number,
): ConflictTreeGroupItem {
  return {
    id: `group:${groupKey}`,
    kind: "group",
    groupKey,
    contextValue: `conflictTreeGroup:${groupKey}`,
    label:
      groupKey === "located"
        ? `可定位冲突：${count}`
        : `Git 未解决但位置未知：${count}`,
    collapsibleState: COLLAPSE_EXPANDED,
  };
}

function createFileItem(
  file: ConflictFile,
  groupKey: ConflictTreeGroupKey,
): ConflictTreeFileItem {
  const conflictCount = file.locatedConflicts.length;

  return {
    id: `file:${groupKey}:${file.uri}`,
    kind: "file",
    groupKey,
    contextValue: `conflictTreeFile:${groupKey}`,
    label: file.relativePath,
    uri: file.uri,
    relativePath: file.relativePath,
    conflictCount,
    gitUnmerged: file.gitUnmerged,
    description:
      groupKey === "located" ? String(conflictCount) : "Git 状态未解决",
    tooltip:
      groupKey === "located"
        ? file.gitUnmerged
          ? `${file.relativePath}\n${conflictCount} 个可定位冲突\nGit 状态未解决`
          : `${file.relativePath}\n${conflictCount} 个可定位冲突`
        : `${file.relativePath}\nGit 状态未解决`,
    collapsibleState:
      groupKey === "located" ? COLLAPSE_COLLAPSED : COLLAPSE_NONE,
  };
}

function createConflictItem(
  file: ConflictFile,
  conflict: ConflictBlock,
  conflictIndex: number,
): ConflictTreeConflictItem {
  return {
    id: `conflict:${file.uri}:${conflict.id}`,
    kind: "conflict",
    contextValue: "conflictTreeConflict",
    label: `冲突 ${conflictIndex}`,
    uri: file.uri,
    conflictId: conflict.id,
    conflictIndex,
    startLine: conflict.startLine,
    endLine: conflict.endLine,
    description: `第 ${conflict.startLine + 1} 行`,
    tooltip: `${file.relativePath}\n第 ${conflict.startLine + 1} 行到第 ${conflict.endLine + 1} 行`,
    command: {
      command: CONFLICT_TREE_GO_TO_COMMAND,
      title: "Go to conflict",
      arguments: [
        {
          uri: file.uri,
          conflictId: conflict.id,
        } satisfies ConflictTreeCommandArguments,
      ],
    },
    collapsibleState: COLLAPSE_NONE,
  };
}

export class ConflictTreeProvider
  implements vscode.TreeDataProvider<ConflictTreeItem>, vscode.Disposable
{
  private snapshot: ConflictSnapshot;
  private readonly changeEmitter = new SimpleEmitter<
    ConflictTreeItem | undefined
  >();
  private readonly storeSubscription: ConflictStoreDisposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly store: ConflictTreeStore) {
    this.snapshot = store.getSnapshot();
    this.storeSubscription = store.onDidChange(this.handleStoreChange);
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
  }

  getTreeItem(element: ConflictTreeItem): ConflictTreeItem {
    return element;
  }

  async getChildren(element?: ConflictTreeItem): Promise<ConflictTreeItem[]> {
    if (element === undefined) {
      const locatedFiles = getLocatedFiles(this.snapshot);
      const gitOnlyFiles = getGitOnlyFiles(this.snapshot);
      const locatedCount = locatedFiles.reduce(
        (count, file) => count + file.locatedConflicts.length,
        0,
      );

      return [
        createGroupItem("located", locatedCount),
        createGroupItem("gitOnly", gitOnlyFiles.length),
      ];
    }

    if (element.kind === "group") {
      const files =
        element.groupKey === "located"
          ? getLocatedFiles(this.snapshot)
          : getGitOnlyFiles(this.snapshot);

      return files.map((file) => createFileItem(file, element.groupKey));
    }

    if (element.kind === "file" && element.groupKey === "located") {
      const file = this.snapshot.files.find((candidate) => candidate.uri === element.uri);
      if (file === undefined) {
        return [];
      }

      return [...file.locatedConflicts]
        .sort(compareConflicts)
        .map((conflict, index) => createConflictItem(file, conflict, index + 1));
    }

    return [];
  }

  private readonly handleStoreChange: ConflictStoreChangeListener = (snapshot) => {
    this.snapshot = snapshot;
    this.changeEmitter.fire(undefined);
  };
}
