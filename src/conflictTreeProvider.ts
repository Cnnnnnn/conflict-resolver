import type * as vscode from "vscode";

import {
  formatCompletionLabel,
  getCompletionKind,
  type ConflictWorkState,
  EMPTY_CONFLICT_WORK_STATE,
} from "./conflictCompletion";
import type {
  ConflictStore,
  ConflictStoreChangeListener,
  ConflictStoreDisposable,
} from "./conflictStore";
import { formatConflictPreviewTooltip, extractConflictPreview } from "./conflictPreview";
import type { MergeRequestConflictService } from "./mergeRequestConflictService";
import {
  formatGitOnlyConflictLabel,
  formatLocatedConflictLabel,
} from "./conflictFileDecorations";
import { formatMergeProgressLabel, getMergeProgress } from "./mergeProgress";
import type {
  ConflictBlock,
  ConflictFile,
  ConflictSnapshot,
  MergeRequestConflict,
  RemoteMergeRequestSnapshot,
} from "./types";

const COLLAPSE_NONE = 0;
const COLLAPSE_COLLAPSED = 1;
const COLLAPSE_EXPANDED = 2;

export const CONFLICT_TREE_GO_TO_COMMAND = "conflictResolver.goToConflict";
export const CONFLICT_TREE_ACCEPT_CURRENT_COMMAND =
  "conflictResolver.acceptCurrentConflict";
export const CONFLICT_TREE_ACCEPT_INCOMING_COMMAND =
  "conflictResolver.acceptIncomingConflict";
export const CONFLICT_TREE_OPEN_MERGE_EDITOR_COMMAND =
  "conflictResolver.openMergeEditorForFile";

type ConflictTreeItemButton = {
  iconPath?: vscode.ThemeIcon;
  tooltip: string;
  command: vscode.Command;
};

type ThemeIconFactory = (id: string) => vscode.ThemeIcon;
export const CONFLICT_TREE_OPEN_MR_COMMAND = "conflictResolver.openMergeRequest";
export const CONFLICT_TREE_FETCH_MR_TARGET_COMMAND =
  "conflictResolver.fetchMrTargetBranch";
export const CONFLICT_TREE_PREVIEW_MR_MERGE_COMMAND =
  "conflictResolver.previewMrMerge";
export const CONFLICT_TREE_OPEN_MR_CONFLICTS_COMMAND =
  "conflictResolver.openMrConflicts";

export type ConflictTreeCommandArguments = {
  uri: string;
  conflictId: string;
};

export type ConflictTreeOpenMrArguments = {
  webUrl: string;
};

export type ConflictTreeMrActionArguments = {
  iid: number;
  webUrl: string;
  targetBranch: string;
  sourceBranch: string;
  hasConflicts: boolean;
};

export type ConflictTreeGroupKey = "located" | "gitOnly" | "remoteMR";

type ConflictTreeItemBase = vscode.TreeItem & {
  id: string;
  kind:
    | "group"
    | "file"
    | "conflict"
    | "remoteMr"
    | "remoteMrAction"
    | "remoteStatus"
    | "progress"
    | "completion";
  collapsibleState: number;
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

export type ConflictTreeRemoteMrItem = ConflictTreeItemBase & {
  kind: "remoteMr";
  label: string;
  webUrl: string;
  mr: MergeRequestConflict;
  command: vscode.Command;
};

export type ConflictTreeRemoteMrActionItem = ConflictTreeItemBase & {
  kind: "remoteMrAction";
  label: string;
  command: vscode.Command;
};

export type ConflictTreeProgressItem = ConflictTreeItemBase & {
  kind: "progress";
  label: string;
};

export type ConflictTreeCompletionItem = ConflictTreeItemBase & {
  kind: "completion";
  label: string;
};

export type ConflictTreeRemoteStatusItem = ConflictTreeItemBase & {
  kind: "remoteStatus";
  label: string;
};

export type ConflictTreeItem =
  | ConflictTreeGroupItem
  | ConflictTreeFileItem
  | ConflictTreeConflictItem
  | ConflictTreeRemoteMrItem
  | ConflictTreeRemoteMrActionItem
  | ConflictTreeProgressItem
  | ConflictTreeCompletionItem
  | ConflictTreeRemoteStatusItem;

export type ConflictTreeTextProvider = (uri: string) => string | undefined;

type ConflictTreeProviderOptions = {
  getFileText?: ConflictTreeTextProvider;
  createThemeIcon?: ThemeIconFactory;
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
type RemoteMrStore = Pick<MergeRequestConflictService, "getSnapshot" | "onDidChange">;

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
    .filter(
      (file) =>
        file.gitUnmerged &&
        file.locatedConflicts.length === 0 &&
        file.parseError !== undefined,
    )
    .sort(compareFiles);
}

function createGroupItem(
  groupKey: ConflictTreeGroupKey,
  count: number,
): ConflictTreeGroupItem {
  const labels: Record<ConflictTreeGroupKey, string> = {
    located: `可定位冲突：${count}`,
    gitOnly: `Git 未解决但位置未知：${count}`,
    remoteMR: "远程 MR",
  };

  return {
    id: `group:${groupKey}`,
    kind: "group",
    groupKey,
    contextValue: `conflictTreeGroup:${groupKey}`,
    label: labels[groupKey],
    collapsibleState: COLLAPSE_EXPANDED,
  };
}

function createFileItem(
  file: ConflictFile,
  groupKey: "located" | "gitOnly",
  createThemeIcon?: ThemeIconFactory,
): ConflictTreeFileItem {
  const conflictCount = file.locatedConflicts.length;
  const item: ConflictTreeFileItem = {
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
      groupKey === "located"
        ? formatLocatedConflictLabel(conflictCount)
        : formatGitOnlyConflictLabel(),
    tooltip:
      groupKey === "located"
        ? file.gitUnmerged
          ? `${file.relativePath}\n${formatLocatedConflictLabel(conflictCount)}\nGit 状态未解决`
          : `${file.relativePath}\n${formatLocatedConflictLabel(conflictCount)}`
        : `${file.relativePath}\n${formatGitOnlyConflictLabel()}`,
    collapsibleState:
      groupKey === "located" ? COLLAPSE_COLLAPSED : COLLAPSE_NONE,
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
    description: buildConflictDescription(conflict, fileText),
    tooltip: formatConflictPreviewTooltip(file.relativePath, conflict, fileText),
    command: {
      command: CONFLICT_TREE_GO_TO_COMMAND,
      title: "Go to conflict",
      arguments: [args],
    },
    buttons: [
      createAcceptCurrentButton(file.uri, conflict.id, createThemeIcon),
      createAcceptIncomingButton(file.uri, conflict.id, createThemeIcon),
    ],
    collapsibleState: COLLAPSE_NONE,
    checked,
  };
  return item;
}

function buildConflictDescription(
  conflict: ConflictBlock,
  fileText: string | undefined,
): string {
  const header = `第 ${conflict.startLine + 1} 行`;
  if (fileText === undefined) {
    return header;
  }
  const preview = extractConflictPreview(fileText, conflict);
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

function formatMrLabel(mr: MergeRequestConflict): string {
  return `!${mr.iid} ${mr.sourceBranch} → ${mr.targetBranch}`;
}

function formatMrDescription(mr: MergeRequestConflict): string {
  return mr.hasConflicts ? "存在合并冲突" : "无合并冲突";
}

function createRemoteMrItem(mr: MergeRequestConflict): ConflictTreeRemoteMrItem {
  return {
    id: `remoteMr:${mr.iid}`,
    kind: "remoteMr",
    contextValue: "conflictTreeRemoteMr",
    label: formatMrLabel(mr),
    webUrl: mr.webUrl,
    mr,
    description: formatMrDescription(mr),
    tooltip: `${mr.title}\n${formatMrDescription(mr)}`,
    command: {
      command: CONFLICT_TREE_OPEN_MR_COMMAND,
      title: "Open merge request",
      arguments: [{ webUrl: mr.webUrl } satisfies ConflictTreeOpenMrArguments],
    },
    collapsibleState: COLLAPSE_COLLAPSED,
  };
}

function createMrActionArguments(mr: MergeRequestConflict): ConflictTreeMrActionArguments {
  return {
    iid: mr.iid,
    webUrl: mr.webUrl,
    targetBranch: mr.targetBranch,
    sourceBranch: mr.sourceBranch,
    hasConflicts: mr.hasConflicts,
  };
}

function createRemoteMrActionItems(
  mr: MergeRequestConflict,
): ConflictTreeRemoteMrActionItem[] {
  const args = createMrActionArguments(mr);
  const items: ConflictTreeRemoteMrActionItem[] = [
    {
      id: `remoteMrAction:${mr.iid}:fetch`,
      kind: "remoteMrAction",
      contextValue: "conflictTreeRemoteMrAction",
      label: `获取目标分支 origin/${mr.targetBranch}`,
      command: {
        command: CONFLICT_TREE_FETCH_MR_TARGET_COMMAND,
        title: "Fetch MR target branch",
        arguments: [args],
      },
      collapsibleState: COLLAPSE_NONE,
    },
    {
      id: `remoteMrAction:${mr.iid}:preview`,
      kind: "remoteMrAction",
      contextValue: "conflictTreeRemoteMrAction",
      label: "本地预演合并",
      command: {
        command: CONFLICT_TREE_PREVIEW_MR_MERGE_COMMAND,
        title: "Preview MR merge",
        arguments: [args],
      },
      collapsibleState: COLLAPSE_NONE,
    },
    {
      id: `remoteMrAction:${mr.iid}:open`,
      kind: "remoteMrAction",
      contextValue: "conflictTreeRemoteMrAction",
      label: "打开 MR 页面",
      command: {
        command: CONFLICT_TREE_OPEN_MR_COMMAND,
        title: "Open merge request",
        arguments: [{ webUrl: mr.webUrl } satisfies ConflictTreeOpenMrArguments],
      },
      collapsibleState: COLLAPSE_NONE,
    },
  ];

  if (mr.hasConflicts) {
    items.splice(2, 0, {
      id: `remoteMrAction:${mr.iid}:conflicts`,
      kind: "remoteMrAction",
      contextValue: "conflictTreeRemoteMrAction",
      label: "在 GitLab 解决冲突",
      command: {
        command: CONFLICT_TREE_OPEN_MR_CONFLICTS_COMMAND,
        title: "Open MR conflicts page",
        arguments: [args],
      },
      collapsibleState: COLLAPSE_NONE,
    });
  }

  return items;
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
    collapsibleState: COLLAPSE_NONE,
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
    collapsibleState: COLLAPSE_NONE,
  };
}

function formatRemoteError(error: NonNullable<RemoteMergeRequestSnapshot["error"]>): string {
  switch (error) {
    case "not-found":
      return "未找到当前分支 MR";
    case "unauthorized":
      return "无法连接 GitLab：Token 或权限不足";
    case "network":
      return "无法连接 GitLab";
    case "invalid-response":
      return "无法连接 GitLab：响应格式错误";
    case "detached-head":
      return "当前处于 detached HEAD，无法查询 MR";
    case "not-configured":
      return "未配置 GitLab 远程仓库";
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

function createRemoteStatusItem(
  snapshot: RemoteMergeRequestSnapshot,
): ConflictTreeRemoteStatusItem {
  const label =
    snapshot.error === undefined
      ? "未找到当前分支 MR"
      : formatRemoteError(snapshot.error);

  return {
    id: `remoteStatus:${snapshot.error ?? "empty"}`,
    kind: "remoteStatus",
    contextValue: "conflictTreeRemoteStatus",
    label,
    collapsibleState: COLLAPSE_NONE,
  };
}

function shouldShowRemoteGroup(snapshot: RemoteMergeRequestSnapshot): boolean {
  return snapshot.error !== "not-configured";
}

export class ConflictTreeProvider
  implements vscode.TreeDataProvider<ConflictTreeItem>, vscode.Disposable
{
  private snapshot: ConflictSnapshot;
  private remoteSnapshot: RemoteMergeRequestSnapshot;
  private workState: ConflictWorkState = EMPTY_CONFLICT_WORK_STATE;
  private filterMode: ConflictTreeFilterMode = "all";
  private readonly selection = new Set<string>();
  private readonly changeEmitter = new SimpleEmitter<
    ConflictTreeItem | undefined
  >();
  private readonly storeSubscription: ConflictStoreDisposable;
  private readonly remoteSubscription?: ConflictStoreDisposable;
  private readonly getFileText?: ConflictTreeTextProvider;
  private readonly createThemeIcon?: ThemeIconFactory;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly store: ConflictTreeStore,
    remoteStore?: RemoteMrStore,
    private readonly parseUri?: (uri: string) => vscode.Uri,
    options?: ConflictTreeProviderOptions,
  ) {
    this.getFileText = options?.getFileText;
    this.createThemeIcon = options?.createThemeIcon;
    this.snapshot = store.getSnapshot();
    this.remoteSnapshot = remoteStore?.getSnapshot() ?? {
      repositoryRoot: "",
      branch: "",
      mergeRequests: [],
      error: "not-configured",
      generatedAt: 0,
    };
    this.storeSubscription = store.onDidChange(this.handleStoreChange);
    if (remoteStore !== undefined) {
      this.remoteSubscription = remoteStore.onDidChange(this.handleRemoteChange);
    }
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.remoteSubscription?.dispose();
    this.changeEmitter.dispose();
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
    const lock = relativePath.endsWith("pnpm-lock.yaml") ||
      relativePath.endsWith("package-lock.json") ||
      relativePath.endsWith("yarn.lock") ||
      relativePath.endsWith("Cargo.lock") ||
      relativePath.endsWith("composer.lock") ||
      relativePath.endsWith("Gemfile.lock") ||
      relativePath.endsWith("Pipfile.lock") ||
      relativePath.endsWith("poetry.lock");
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
        createGroupItem("located", locatedCount),
        createGroupItem("gitOnly", gitOnlyFiles.length),
      ];

      if (shouldShowRemoteGroup(this.remoteSnapshot)) {
        groups.push(createGroupItem("remoteMR", this.remoteSnapshot.mergeRequests.length));
      }

      return [...items, ...groups];
    }

    if (element.kind === "remoteMr") {
      return createRemoteMrActionItems(element.mr);
    }

    if (element.kind === "group") {
      if (element.groupKey === "remoteMR") {
        if (this.remoteSnapshot.mergeRequests.length > 0) {
          return [...this.remoteSnapshot.mergeRequests]
            .sort((left, right) => left.iid - right.iid)
            .map(createRemoteMrItem);
        }
        return [createRemoteStatusItem(this.remoteSnapshot)];
      }

      const files =
        element.groupKey === "located"
          ? getLocatedFiles(this.snapshot).filter((file) =>
              this.fileMatchesFilter(file.relativePath),
            )
          : element.groupKey === "gitOnly"
            ? getGitOnlyFiles(this.snapshot).filter((file) =>
                this.fileMatchesFilter(file.relativePath),
              )
            : [];

      return files.map((file) =>
        createFileItem(file, element.groupKey as "located" | "gitOnly", this.createThemeIcon),
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

      return [...file.locatedConflicts]
        .sort(compareConflicts)
        .map((conflict, index) =>
          createConflictItem(
            file,
            conflict,
            index + 1,
            this.getFileText?.(file.uri),
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

  private readonly handleRemoteChange = (snapshot: RemoteMergeRequestSnapshot): void => {
    this.remoteSnapshot = snapshot;
    this.changeEmitter.fire(undefined);
  };
}
