import { fileURLToPath, pathToFileURL } from "node:url";

import type { ConflictSnapshot } from "./types";

export type StatusBarDisposable = {
  dispose(): void;
};

export type StatusBarItemAdapter = {
  text: string;
  show(): void;
  hide(): void;
  dispose(): void;
};

export type StatusBarAdapter = {
  createStatusBarItem(): StatusBarItemAdapter;
};

export type StatusBarStore = {
  getSnapshot(): ConflictSnapshot;
  onDidChange(listener: (snapshot: ConflictSnapshot) => void | Promise<void>): StatusBarDisposable;
};

export type ActiveFileSource = {
  getActiveUri(): string | undefined;
  onDidChangeActiveUri(listener: (uri: string | undefined) => void): StatusBarDisposable;
};

export type StatusBarState =
  | {
      kind: "located";
      text: string;
      activeFileConflictCount: number;
      totalLocatedConflictCount: number;
      uri: string;
    }
  | {
      kind: "git-only";
      text: "Git 未解决，位置未知";
      uri: string;
    };

export type ConflictStatusBarOptions = {
  activeFile: ActiveFileSource;
  statusBar: StatusBarAdapter;
  store: StatusBarStore;
};

const GIT_ONLY_TEXT = "Git 未解决，位置未知";

function canonicalizeUri(uri: string): string {
  try {
    if (new URL(uri).protocol !== "file:") {
      return uri;
    }

    return pathToFileURL(fileURLToPath(uri)).toString();
  } catch {
    return uri;
  }
}

export function getStatusBarState(
  snapshot: ConflictSnapshot,
  activeUri: string | undefined,
): StatusBarState | undefined {
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

  if (activeFile.locatedConflicts.length > 0) {
    return {
      kind: "located",
      text: `冲突 ${activeFile.locatedConflicts.length}/${snapshot.locatedCount}`,
      activeFileConflictCount: activeFile.locatedConflicts.length,
      totalLocatedConflictCount: snapshot.locatedCount,
      uri: activeFile.uri,
    };
  }

  if (activeFile.gitUnmerged) {
    return {
      kind: "git-only",
      text: GIT_ONLY_TEXT,
      uri: activeFile.uri,
    };
  }

  return undefined;
}

export class ConflictStatusBar {
  private readonly item: StatusBarItemAdapter;
  private readonly subscriptions: StatusBarDisposable[];
  private activeUri: string | undefined;

  constructor(private readonly options: ConflictStatusBarOptions) {
    this.item = options.statusBar.createStatusBarItem();
    this.activeUri = options.activeFile.getActiveUri();
    this.subscriptions = [
      options.store.onDidChange((snapshot) => {
        this.render(snapshot, this.activeUri);
      }),
      options.activeFile.onDidChangeActiveUri((uri) => {
        this.activeUri = uri;
        this.render(this.options.store.getSnapshot(), uri);
      }),
    ];

    this.render(options.store.getSnapshot(), this.activeUri);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }

    this.item.dispose();
  }

  private render(
    snapshot: ConflictSnapshot,
    activeUri: string | undefined,
  ): void {
    const state = getStatusBarState(snapshot, activeUri);

    if (state === undefined) {
      this.item.hide();
      return;
    }

    this.item.text = state.text;
    this.item.show();
  }
}
