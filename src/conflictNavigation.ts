import type { ConflictBlock, ConflictSnapshot } from "./types";

export type ConflictNavigationLocation = { uri: string; line: number };
export type ConflictNavigationStore = {
  getSnapshot(): ConflictSnapshot;
  onDidChange(listener: (snapshot: ConflictSnapshot) => void | Promise<void>): { dispose(): void };
};
export type ConflictNavigationCallbacks = {
  getActiveLocation(): ConflictNavigationLocation | undefined;
  revealConflict(uri: string, conflict: ConflictBlock): void | Promise<void>;
  openMergeEditor(uri: string): void | Promise<void>;
  showMergeEditorFallback(uri: string, error: unknown): void | Promise<void>;
};

export class ConflictNavigation {
  private snapshot: ConflictSnapshot;
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: ConflictNavigationStore, private readonly callbacks: ConflictNavigationCallbacks) {
    this.snapshot = store.getSnapshot();
    this.subscription = store.onDidChange((snapshot) => { this.snapshot = snapshot; });
  }

  dispose(): void { this.subscription.dispose(); }

  async next(): Promise<boolean> {
    return this.navigate(1);
  }

  async previous(): Promise<boolean> {
    return this.navigate(-1);
  }

  async goTo(uri: string, conflictId?: string): Promise<boolean> {
    const file = this.findFile(uri);
    if (file === undefined) return false;
    const conflict = conflictId === undefined ? undefined : file.locatedConflicts.find((item) => item.id === conflictId);
    if (conflict !== undefined) {
      await this.callbacks.revealConflict(file.uri, conflict);
      return true;
    }
    if (file.gitUnmerged && file.locatedConflicts.length === 0) {
      return this.openMergeEditor(file.uri);
    }
    return false;
  }

  private async navigate(direction: 1 | -1): Promise<boolean> {
    const active = this.callbacks.getActiveLocation();
    if (active === undefined) return false;
    const file = this.findFile(active.uri);
    if (file === undefined) return false;
    const conflicts = [...file.locatedConflicts].sort((a, b) => a.startLine - b.startLine);
    const target = direction === 1
      ? conflicts.find((conflict) => conflict.startLine > active.line)
      : [...conflicts].reverse().find((conflict) => conflict.startLine < active.line);
    if (target !== undefined) {
      await this.callbacks.revealConflict(file.uri, target);
      return true;
    }
    if (conflicts.length === 0 && file.gitUnmerged) return this.openMergeEditor(file.uri);
    return false;
  }

  private async openMergeEditor(uri: string): Promise<boolean> {
    try {
      await this.callbacks.openMergeEditor(uri);
      return true;
    } catch (error) {
      await this.callbacks.showMergeEditorFallback(uri, error);
      return false;
    }
  }

  private findFile(uri: string) {
    return this.snapshot.files.find((file) => file.uri === uri);
  }
}
