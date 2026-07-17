import * as vscode from "vscode";

import {
  formatCompletionLabel,
  getCompletionKind,
  type ConflictWorkState,
  EMPTY_CONFLICT_WORK_STATE,
} from "./conflictCompletion";
import { compareConflicts, compareFiles } from "./conflictCompare";
import type {
  ConflictStore,
  ConflictStoreChangeListener,
  ConflictStoreDisposable,
} from "./conflictStore";
import {
  extractConflictPreview,
  extractConflictPreviewFromLines,
  formatConflictPreviewTooltip,
} from "./conflictPreview";
import { isLockFilePath } from "./conflictFilter";
import { hasLocatedConflicts, isGitOnlyUnresolved } from "./conflictPredicates";
import {
  formatGitOnlyConflictLabel,
  formatLocatedConflictLabel,
} from "./conflictFileDecorations";
import { formatMergeProgressLabel, getMergeProgress } from "./mergeProgress";
import type {
  ConflictBlock,
  ConflictFile,
  ConflictSnapshot,
} from "./types";

export const CONFLICT_TREE_GO_TO_COMMAND = "conflictResolver.goToConflict";
export const CONFLICT_TREE_ACCEPT_CURRENT_COMMAND =
  "conflictResolver.acceptCurrentConflict";
export const CONFLICT_TREE_ACCEPT_INCOMING_COMMAND =
  "conflictResolver.acceptIncomingConflict";
export const CONFLICT_TREE_ACCEPT_BOTH_COMMAND =
  "conflictResolver.acceptBothConflict";
export const CONFLICT_TREE_OPEN_DIFF_COMMAND =
  "conflictResolver.openConflictDiff";
export const CONFLICT_TREE_OPEN_MERGE_EDITOR_COMMAND =
  "conflictResolver.openMergeEditorForFile";

type ConflictTreeItemButton = {
  iconPath?: vscode.ThemeIcon;
  tooltip: string;
  command: vscode.Command;
};

type ThemeIconFactory = (id: string) => vscode.ThemeIcon;

export type ConflictTreeCommandArguments = {
  uri: string;
  conflictId: string;
};

export type ConflictTreeGroupKey = "located" | "gitOnly";

type ConflictTreeItemBase = vscode.TreeItem & {
  id: string;
  kind:
    | "group"
    | "file"
    | "conflict"
    | "progress"
    | "completion";
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue: string;
  buttons?: ConflictTreeItemButton[];
};

export type ConflictTreeGroupItem = ConflictTreeItemBase & {
  kind: "group";
  groupKey: ConflictTreeGroupKey;
  label: string;
};

export type ConflictTreeFileItem = ConflictTreeItemBase & {
  kind: "file";
  groupKey: "located" | "gitOnly";
  label: string;
  uri: string;
  relativePath: string;
  conflictCount: number;
  gitUnmerged: boolean;
  resourceUri?: vscode.Uri;
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
  checked?: boolean;
};

export type ConflictTreeProgressItem = ConflictTreeItemBase & {
  kind: "progress";
  label: string;
};

export type ConflictTreeCompletionItem = ConflictTreeItemBase & {
  kind: "completion";
  label: string;
};

export type ConflictTreeItem =
  | ConflictTreeGroupItem
  | ConflictTreeFileItem
  | ConflictTreeConflictItem
  | ConflictTreeProgressItem
  | ConflictTreeCompletionItem;

export type ConflictTreeTextProvider = (uri: string) => string | undefined;

type ConflictTreeProviderOptions = {
  getFileText?: ConflictTreeTextProvider;
  createThemeIcon?: ThemeIconFactory;
  /**
   * Wall-clock used by the stale badge. Defaults to Date.now. Tests
   * inject a fixed clock so generatedAt can stay at a tiny sentinel
   * without the badge flipping into stale mode.
   */
  now?: () => number;
};

export type ConflictTreeSelection = ReadonlySet<string>;

export type ConflictTreeFilterMode = "all" | "source" | "lock";

function createConflictCommandArguments(
  uri: string,
  conflictId: string,
): ConflictTreeCommandArguments {
  return { uri, conflictId };
}

function createAcceptCurrentButton(
  uri: string,
  conflictId: string,
  createThemeIcon?: ThemeIconFactory,
): ConflictTreeItemButton {
  return {
    iconPath: createThemeIcon?.("arrow-left"),
    tooltip: "采用当前",
    command: {
      command: CONFLICT_TREE_ACCEPT_CURRENT_COMMAND,
      title: "采用当前",
      arguments: [createConflictCommandArguments(uri, conflictId)],
    },
  };
}

function createAcceptIncomingButton(
  uri: string,
  conflictId: string,
  createThemeIcon?: ThemeIconFactory,
): ConflictTreeItemButton {
  return {
    iconPath: createThemeIcon?.("arrow-right"),
    tooltip: "采用传入",
    command: {
      command: CONFLICT_TREE_ACCEPT_INCOMING_COMMAND,
      title: "采用传入",
      arguments: [createConflictCommandArguments(uri, conflictId)],
    },
  };
}

function createOpenDiffButton(
  uri: string,
  conflictId: string,
  createThemeIcon?: ThemeIconFactory,
): ConflictTreeItemButton {
  return {
    iconPath: createThemeIcon?.("diff"),
    tooltip: "对比当前 vs 传入",
    command: {
      command: CONFLICT_TREE_OPEN_DIFF_COMMAND,
      title: "Open conflict diff",
      arguments: [{ uri, conflictId } satisfies ConflictTreeCommandArguments],
    },
  };
}

function createAcceptBothButton(
  uri: string,
  conflictId: string,
  createThemeIcon?: ThemeIconFactory,
): ConflictTreeItemButton {
  return {
    iconPath: createThemeIcon?.("git-compare"),
    tooltip: "保留双方",
    command: {
      command: CONFLICT_TREE_ACCEPT_BOTH_COMMAND,
      title: "保留双方",
      arguments: [createConflictCommandArguments(uri, conflictId)],
    },
  };
}

function createOpenMergeEditorButton(
  uri: string,
  createThemeIcon?: ThemeIconFactory,
): ConflictTreeItemButton {
  return {
    iconPath: createThemeIcon?.("git-merge"),
    tooltip: "打开 Merge Editor",
    command: {
      command: CONFLICT_TREE_OPEN_MERGE_EDITOR_COMMAND,
      title: "打开 Merge Editor",
      arguments: [{ uri }],
    },
  };
}

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

function getLocatedFiles(snapshot: ConflictSnapshot): ConflictFile[] {
  return [...snapshot.files]
    .filter((file) => hasLocatedConflicts(file))
    .sort(compareFiles);
}

function getGitOnlyFiles(snapshot: ConflictSnapshot): ConflictFile[] {
  return [...snapshot.files]
    .filter((file) => isGitOnlyUnresolved(file))
    .sort(compareFiles);
}

// Stale badge threshold: after this many ms since snapshot.generatedAt
// the tree header flips into "stale" mode. Picked to match what feels
// like "the panel is showing data that's no longer current"; 60s is
// long enough to survive a brief idle moment but short enough that a
// real editing session will trigger it.
const STALE_THRESHOLD_MS = 60_000;

export type TreeFreshness = {
  description: string;
  stale: boolean;
};

export function formatTreeFreshness(
  generatedAt: number,
  now: number = Date.now(),
): TreeFreshness {
  if (generatedAt === 0) {
    return { description: "", stale: false };
  }
  const deltaMs = Math.max(0, now - generatedAt);
  if (deltaMs < 1_500) {
    return { description: "刚刚", stale: false };
  }
  const seconds = Math.floor(deltaMs / 1000);
  const description = seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
  return { description, stale: deltaMs >= STALE_THRESHOLD_MS };
}

function createGroupItem(
  groupKey: ConflictTreeGroupKey,
  count: number,
  freshness: TreeFreshness,
): ConflictTreeGroupItem {
  const labels: Record<ConflictTreeGroupKey, string> = {
    located: `可定位冲突：${count}`,
    gitOnly: `Git 未解决但位置未知：${count}`,
  };
  const stalePrefix = freshness.stale ? "$(clock) " : "";
  return {
    id: `group:${groupKey}`,
    kind: "group",
    groupKey,
    contextValue: `conflictTreeGroup:${groupKey}`,
    label: `${stalePrefix}${labels[groupKey]}`,
    description: freshness.description,
    tooltip: freshness.stale
      ? `${labels[groupKey]}\n${freshness.description} — 按 Ctrl+Shift+R 重新扫描`
      : labels[groupKey],
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
  };
}

function createFileItem(
  file: ConflictFile,
  groupKey: "located" | "gitOnly",
  createThemeIcon?: ThemeIconFactory,
  isActive = false,
): ConflictTreeFileItem {
  const conflictCount = file.locatedConflicts.length;
  const baseLabel = file.relativePath;
  const label = isActive ? `$(eye) ${baseLabel}` : baseLabel;
  const item: ConflictTreeFileItem = {
    id: `file:${groupKey}:${file.uri}`,
    kind: "file",
    groupKey,
    contextValue: `conflictTreeFile:${groupKey}`,
    label,
    uri: file.uri,
    relativePath: file.relativePath,
    conflictCount,
    gitUnmerged: file.gitUnmerged,
    description:
      groupKey === "located"
        ? formatLocatedConflictLabel(conflictCount)
        : formatGitOnlyConflictLabel(),
    tooltip:
      groupKey === "located"
        ? file.gitUnmerged
          ? `${file.relativePath}\n${formatLocatedConflictLabel(conflictCount)}\nGit 状态未解决${isActive ? "\n当前打开的文件" : ""}`
          : `${file.relativePath}\n${formatLocatedConflictLabel(conflictCount)}${isActive ? "\n当前打开的文件" : ""}`
        : `${file.relativePath}\n${formatGitOnlyConflictLabel()}${isActive ? "\n当前打开的文件" : ""}`,
    collapsibleState:
      groupKey === "located" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  };

  if (groupKey === "gitOnly") {
    item.buttons = [createOpenMergeEditorButton(file.uri, createThemeIcon)];
  }

  return item;
}

function createConflictItem(
  file: ConflictFile,
  conflict: ConflictBlock,
  conflictIndex: number,
  fileText: string | undefined,
  fileLines: string[] | undefined,
  createThemeIcon?: ThemeIconFactory,
  checked = false,
): ConflictTreeConflictItem {
  const args = createConflictCommandArguments(file.uri, conflict.id);
  const item: ConflictTreeConflictItem = {
    id: `conflict:${file.uri}:${conflict.id}`,
    kind: "conflict",
    contextValue: "conflictTreeConflict",
    label: `冲突 ${conflictIndex}`,
    uri: file.uri,
    conflictId: conflict.id,
    conflictIndex,
    startLine: conflict.startLine,
    endLine: conflict.endLine,
    description: buildConflictDescription(conflict, fileText, fileLines),
    tooltip: formatConflictPreviewTooltip(file.relativePath, conflict, fileText, fileLines),
    command: {
      command: CONFLICT_TREE_GO_TO_COMMAND,
      title: "Go to conflict",
      arguments: [args],
    },
    buttons: [
      createAcceptCurrentButton(file.uri, conflict.id, createThemeIcon),
      createAcceptIncomingButton(file.uri, conflict.id, createThemeIcon),
      createAcceptBothButton(file.uri, conflict.id, createThemeIcon),
      createOpenDiffButton(file.uri, conflict.id, createThemeIcon),
    ],
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    checked,
  };
  return item;
}

function buildConflictDescription(
  conflict: ConflictBlock,
  fileText: string | undefined,
  fileLines: string[] | undefined,
): string {
  const header = `第 ${conflict.startLine + 1} 行`;
  if (fileText === undefined || fileLines === undefined) {
    return header;
  }
  const preview = extractConflictPreviewFromLines(fileLines, conflict);
  const ours = preview.ours.find((line) => line.trim().length > 0) ?? "(空)";
  const theirs = preview.theirs.find((line) => line.trim().length > 0) ?? "(空)";
  return `${header}    ← ${truncate(ours, 32)}  ·  → ${truncate(theirs, 32)}`;
}

function truncate(line: string, max: number): string {
  if (line.length <= max) {
    return line;
  }
  return `${line.slice(0, max - 1)}…`;
}

function createCompletionItem(
  label: string,
  createThemeIcon?: ThemeIconFactory,
): ConflictTreeCompletionItem {
  return {
    id: "completion:summary",
    kind: "completion",
    contextValue: "conflictTreeCompletion",
    label,
    tooltip: label,
    iconPath: createThemeIcon?.("pass-filled"),
    collapsibleState: vscode.TreeItemCollapsibleState.None,
  };
}

function createProgressItem(snapshot: ConflictSnapshot): ConflictTreeProgressItem | undefined {
  const progress = getMergeProgress(snapshot);
  const label = formatMergeProgressLabel(progress);
  if (label === "无待处理冲突") {
    return undefined;
  }

  return {
    id: "progress:summary",
    kind: "progress",
    contextValue: "conflictTreeProgress",
    label,
    tooltip: "当前合并进度",
    collapsibleState: vscode.TreeItemCollapsibleState.None,
  };
}

export class ConflictTreeProvider
  implements vscode.TreeDataProvider<ConflictTreeItem>, vscode.Disposable
{
  private snapshot: ConflictSnapshot;
  private workState: ConflictWorkState = EMPTY_CONFLICT_WORK_STATE;
  private filterMode: ConflictTreeFilterMode = "all";
  private activeFileUri: string | undefined;
  private readonly selection = new Set<string>();
  private readonly changeEmitter = new SimpleEmitter<
    ConflictTreeItem | undefined
  >();
  private readonly storeSubscription: ConflictStoreDisposable;
  private readonly getFileText?: ConflictTreeTextProvider;
  private readonly createThemeIcon?: ThemeIconFactory;
  private readonly freshnessTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly store: ConflictTreeStore,
    private readonly parseUri?: (uri: string) => vscode.Uri,
    options?: ConflictTreeProviderOptions,
  ) {
    this.getFileText = options?.getFileText;
    this.createThemeIcon = options?.createThemeIcon;
    this.now = options?.now ?? (() => Date.now());
    this.snapshot = store.getSnapshot();
    this.storeSubscription = store.onDidChange(this.handleStoreChange);
    // Re-emit every 5s so the "刚刚 / N秒前 / 已过时" badge on the group
    // header visibly ages; firing an undefined element triggers VS Code
    // to re-fetch getTreeItem/getChildren without us rebuilding state.
    this.freshnessTimer = setInterval(() => {
      this.changeEmitter.fire(undefined);
    }, 5_000);
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
    if (this.freshnessTimer !== undefined) {
      clearInterval(this.freshnessTimer);
    }
  }

  setWorkState(state: ConflictWorkState): void {
    this.workState = state;
    this.changeEmitter.fire(undefined);
  }

  setFilterMode(mode: ConflictTreeFilterMode): void {
    if (this.filterMode === mode) {
      return;
    }
    this.filterMode = mode;
    this.selection.clear();
    this.changeEmitter.fire(undefined);
  }

  getFilterMode(): ConflictTreeFilterMode {
    return this.filterMode;
  }

  setActiveFileUri(uri: string | undefined): void {
    if (this.activeFileUri === uri) {
      return;
    }
    this.activeFileUri = uri;
    this.changeEmitter.fire(undefined);
  }

  getActiveFileUri(): string | undefined {
    return this.activeFileUri;
  }

  private isActiveFile(uri: string): boolean {
    return this.activeFileUri !== undefined && this.activeFileUri === uri;
  }

  getSelection(): ConflictTreeSelection {
    return new Set(this.selection);
  }

  toggleSelection(item: ConflictTreeConflictItem): void {
    const key = `${item.uri}::${item.conflictId}`;
    if (this.selection.has(key)) {
      this.selection.delete(key);
    } else {
      this.selection.add(key);
    }
    this.changeEmitter.fire(item);
  }

  selectAll(): void {
    for (const file of this.snapshot.files) {
      if (!this.fileMatchesFilter(file.relativePath)) {
        continue;
      }
      for (const conflict of file.locatedConflicts) {
        this.selection.add(`${file.uri}::${conflict.id}`);
      }
    }
    this.changeEmitter.fire(undefined);
  }

  selectFile(uri: string): void {
    const file = this.snapshot.files.find((candidate) => candidate.uri === uri);
    if (file === undefined) {
      return;
    }
    for (const conflict of file.locatedConflicts) {
      this.selection.add(`${file.uri}::${conflict.id}`);
    }
    this.changeEmitter.fire(undefined);
  }

  clearSelection(): void {
    if (this.selection.size === 0) {
      return;
    }
    this.selection.clear();
    this.changeEmitter.fire(undefined);
  }

  private fileMatchesFilter(relativePath: string): boolean {
    const lock = isLockFilePath(relativePath);
    if (this.filterMode === "all") {
      return true;
    }
    if (this.filterMode === "lock") {
      return lock;
    }
    return !lock;
  }

  getCompletionMessage(): string | undefined {
    return formatCompletionLabel(getCompletionKind(this.snapshot, this.workState), this.snapshot);
  }

  getTreeItem(element: ConflictTreeItem): ConflictTreeItem {
    if (element.kind === "conflict") {
      return {
        ...element,
        checked: this.selection.has(`${element.uri}::${element.conflictId}`),
      };
    }

    if (element.kind === "file" && this.parseUri !== undefined) {
      return {
        ...element,
        resourceUri: this.parseUri(element.uri),
      };
    }

    return element;
  }

  async getChildren(element?: ConflictTreeItem): Promise<ConflictTreeItem[]> {
    if (element === undefined) {
      const locatedFiles = getLocatedFiles(this.snapshot).filter((file) =>
        this.fileMatchesFilter(file.relativePath),
      );
      const gitOnlyFiles = getGitOnlyFiles(this.snapshot).filter((file) =>
        this.fileMatchesFilter(file.relativePath),
      );
      const locatedCount = locatedFiles
        .reduce((count, file) => count + file.locatedConflicts.length, 0);

      const items: ConflictTreeItem[] = [];
      const completionLabel = formatCompletionLabel(
        getCompletionKind(this.snapshot, this.workState),
        this.snapshot,
      );
      if (completionLabel !== undefined) {
        items.push(createCompletionItem(completionLabel, this.createThemeIcon));
      } else {
        const progressItem = createProgressItem(this.snapshot);
        if (progressItem !== undefined) {
          items.push(progressItem);
        }
      }

      const groups: ConflictTreeGroupItem[] = [
        createGroupItem("located", locatedCount, formatTreeFreshness(this.snapshot.generatedAt, this.now())),
        createGroupItem("gitOnly", gitOnlyFiles.length, formatTreeFreshness(this.snapshot.generatedAt, this.now())),
      ];

      return [...items, ...groups];
    }

    if (element.kind === "group") {
      const files =
        element.groupKey === "located"
          ? getLocatedFiles(this.snapshot).filter((file) =>
              this.fileMatchesFilter(file.relativePath),
            )
          : getGitOnlyFiles(this.snapshot).filter((file) =>
              this.fileMatchesFilter(file.relativePath),
            );

      return files.map((file) =>
        createFileItem(
          file,
          element.groupKey,
          this.createThemeIcon,
          this.isActiveFile(file.uri),
        ),
      );
    }

    if (element.kind === "file" && element.groupKey === "located") {
      const file = this.snapshot.files.find((candidate) => candidate.uri === element.uri);
      if (file === undefined) {
        return [];
      }

      if (!this.fileMatchesFilter(file.relativePath)) {
        return [];
      }

      // Read and split the file text once for this file instead of re-reading
      // and re-splitting the entire document for every conflict (was
      // O(conflicts × file lines)).
      const fileText = this.getFileText?.(file.uri);
      const fileLines =
        fileText === undefined ? undefined : fileText.split(/\r?\n/);

      return [...file.locatedConflicts]
        .sort(compareConflicts)
        .map((conflict, index) =>
          createConflictItem(
            file,
            conflict,
            index + 1,
            fileText,
            fileLines,
            this.createThemeIcon,
            this.selection.has(`${file.uri}::${conflict.id}`),
          ),
        );
    }

    return [];
  }

  private readonly handleStoreChange: ConflictStoreChangeListener = (snapshot) => {
    this.snapshot = snapshot;
    this.changeEmitter.fire(undefined);
  };
}
