import { toConflictFileKey } from "./conflictScmMenu";
import type { ConflictSnapshot } from "./types";
import {
  buildWorkspaceConflictOrder,
  findWorkspaceConflictIndexAtOrBefore,
  getWorkspaceConflictFileCount,
} from "./conflictWorkspaceOrder";
import { formatMergeProgressLabel, getMergeProgress } from "./mergeProgress";

export type StatusBarDisposable = {
  dispose(): void;
};

export type StatusBarItemAdapter = {
  text: string;
  tooltip?: string;
  command?: string;
  show(): void;
  hide(): void;
  dispose(): void;
};

export type StatusBarAdapter = {
  createStatusBarItem(priority?: number): StatusBarItemAdapter;
};

export type StatusBarStore = {
  getSnapshot(): ConflictSnapshot;
  onDidChange(listener: (snapshot: ConflictSnapshot) => void | Promise<void>): StatusBarDisposable;
};

export type ActiveFileSource = {
  getActiveUri(): string | undefined;
  getActiveLine(): number | undefined;
  onDidChangeActiveUri(listener: (uri: string | undefined) => void): StatusBarDisposable;
};

export type StatusBarState =
  | {
      kind: "located";
      text: string;
      tooltip: string;
      activeFileConflictCount: number;
      totalLocatedConflictCount: number;
      uri: string;
    }
  | {
      kind: "git-only";
      text: "Git 未解决，位置未知";
      tooltip: string;
      uri: string;
    };

export type ConflictStatusBarOptions = {
  activeFile: ActiveFileSource;
  statusBar: StatusBarAdapter;
  store: StatusBarStore;
};

const GIT_ONLY_TEXT = "Git 未解决，位置未知";
const PREVIOUS_CONFLICT_COMMAND = "conflictResolver.previousConflict";
const NEXT_CONFLICT_COMMAND = "conflictResolver.nextConflict";

function canonicalizeUri(uri: string): string {
  return toConflictFileKey(uri);
}

export function shouldShowConflictNavigation(snapshot: ConflictSnapshot): boolean {
  return snapshot.locatedCount > 0;
}

function buildLocatedStatusBarState(
  snapshot: ConflictSnapshot,
  activeUri: string | undefined,
  activeLine: number | undefined,
): StatusBarState {
  const progressLabel = formatMergeProgressLabel(getMergeProgress(snapshot));
  const order = buildWorkspaceConflictOrder(snapshot);
  const fileCount = getWorkspaceConflictFileCount(snapshot);
  const canonicalActiveUri = activeUri === undefined ? undefined : canonicalizeUri(activeUri);
  const activeFile =
    canonicalActiveUri === undefined
      ? undefined
      : snapshot.files.find((file) => canonicalizeUri(file.uri) === canonicalActiveUri);
  const currentIndex =
    activeUri === undefined || activeLine === undefined
      ? -1
      : findWorkspaceConflictIndexAtOrBefore(order, activeUri, activeLine);
  const text =
    currentIndex >= 0
      ? `冲突 ${currentIndex + 1}/${order.length} · ${fileCount} 文件`
      : activeFile !== undefined && activeFile.locatedConflicts.length > 0
        ? `冲突 · ${activeFile.locatedConflicts.length} 处`
        : `共 ${snapshot.locatedCount} 处冲突 · ${fileCount} 文件`;
  const tooltipPath = activeFile?.relativePath ?? progressLabel;

  return {
    kind: "located",
    text,
    tooltip: `${progressLabel}\n${tooltipPath}`,
    activeFileConflictCount: activeFile?.locatedConflicts.length ?? 0,
    totalLocatedConflictCount: snapshot.locatedCount,
    uri: activeFile?.uri ?? order[0]?.uri ?? activeUri ?? "",
  };
}

export function getStatusBarState(
  snapshot: ConflictSnapshot,
  activeUri: string | undefined,
  activeLine: number | undefined,
): StatusBarState | undefined {
  if (snapshot.locatedCount > 0) {
    return buildLocatedStatusBarState(snapshot, activeUri, activeLine);
  }

  if (activeUri === undefined) {
    return undefined;
  }

  const canonicalActiveUri = canonicalizeUri(activeUri);
  const activeFile = snapshot.files.find(
    (file) => canonicalizeUri(file.uri) === canonicalActiveUri,
  );

  if (activeFile === undefined) {
    return undefined;
  }

  const progressLabel = formatMergeProgressLabel(getMergeProgress(snapshot));

  if (activeFile.gitUnmerged) {
    return {
      kind: "git-only",
      text: GIT_ONLY_TEXT,
      tooltip: `${progressLabel}\n${activeFile.relativePath}`,
      uri: activeFile.uri,
    };
  }

  return undefined;
}

export class ConflictStatusBar {
  private readonly prevItem: StatusBarItemAdapter;
  private readonly labelItem: StatusBarItemAdapter;
  private readonly nextItem: StatusBarItemAdapter;
  private readonly subscriptions: StatusBarDisposable[];
  private activeUri: string | undefined;
  private activeLine: number | undefined;

  constructor(private readonly options: ConflictStatusBarOptions) {
    // VS Code left-aligned status bar: a larger priority places the item further left.
    this.prevItem = options.statusBar.createStatusBarItem(102);
    this.labelItem = options.statusBar.createStatusBarItem(101);
    this.nextItem = options.statusBar.createStatusBarItem(100);
    this.prevItem.text = "$(chevron-left)";
    this.prevItem.command = PREVIOUS_CONFLICT_COMMAND;
    this.prevItem.tooltip = "上一个冲突";
    this.nextItem.text = "$(chevron-right)";
    this.nextItem.command = NEXT_CONFLICT_COMMAND;
    this.nextItem.tooltip = "下一个冲突";
    this.activeUri = options.activeFile.getActiveUri();
    this.activeLine = options.activeFile.getActiveLine();
    this.subscriptions = [
      options.store.onDidChange((snapshot) => {
        this.render(snapshot, this.activeUri, this.activeLine);
      }),
      options.activeFile.onDidChangeActiveUri((uri) => {
        this.activeUri = uri;
        this.activeLine = options.activeFile.getActiveLine();
        this.render(this.options.store.getSnapshot(), uri, this.activeLine);
      }),
    ];

    this.render(options.store.getSnapshot(), this.activeUri, this.activeLine);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }

    this.prevItem.dispose();
    this.labelItem.dispose();
    this.nextItem.dispose();
  }

  private render(
    snapshot: ConflictSnapshot,
    activeUri: string | undefined,
    activeLine: number | undefined,
  ): void {
    const state = getStatusBarState(snapshot, activeUri, activeLine);
    const showNavigation = shouldShowConflictNavigation(snapshot);

    if (!showNavigation && state === undefined) {
      this.prevItem.hide();
      this.labelItem.hide();
      this.nextItem.hide();
      return;
    }

    if (showNavigation) {
      this.prevItem.show();
      this.nextItem.show();
    } else {
      this.prevItem.hide();
      this.nextItem.hide();
    }

    if (state === undefined) {
      this.labelItem.hide();
      return;
    }

    this.labelItem.text = state.text;
    this.labelItem.tooltip = state.tooltip;
    this.labelItem.show();
  }
}
