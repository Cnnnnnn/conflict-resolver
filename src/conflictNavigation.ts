import type { ConflictBlock, ConflictSnapshot } from "./types";
import { canonicalizeConflictUri } from "./conflictScmMenu";
import {
  buildWorkspaceConflictOrder,
  findWorkspaceConflictIndexAtOrBefore,
  getWorkspaceConflictAt,
} from "./conflictWorkspaceOrder";

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

export type ConflictHistoryRef = { uri: string; conflictId?: string };

const HISTORY_LIMIT = 30;

export class ConflictNavigation {
  private snapshot: ConflictSnapshot;
  private readonly subscription: { dispose(): void };
  private readonly history: ConflictHistoryRef[] = [];

  constructor(private readonly store: ConflictNavigationStore, private readonly callbacks: ConflictNavigationCallbacks) {
    this.snapshot = store.getSnapshot();
    this.subscription = store.onDidChange((snapshot) => { this.snapshot = snapshot; });
  }

  dispose(): void { this.subscription.dispose(); }

  getHistorySize(): number {
    return this.history.length;
  }

  async next(): Promise<boolean> {
    return this.navigateWorkspace(1);
  }

  async previous(): Promise<boolean> {
    return this.navigateWorkspace(-1);
  }

  async nextInFile(): Promise<boolean> {
    return this.navigateInFile(1);
  }

  async previousInFile(): Promise<boolean> {
    return this.navigateInFile(-1);
  }

  async goTo(uri: string, conflictId?: string): Promise<boolean> {
    const file = this.findFile(uri);
    if (file === undefined) return false;
    const conflict = conflictId === undefined ? undefined : file.locatedConflicts.find((item) => item.id === conflictId);
    if (conflict !== undefined) {
      this.pushHistory();
      await this.callbacks.revealConflict(file.uri, conflict);
      return true;
    }
    if (file.gitUnmerged && file.locatedConflicts.length === 0) {
      this.pushHistory();
      return this.openMergeEditor(file.uri);
    }
    return false;
  }

  async back(): Promise<boolean> {
    while (this.history.length > 0) {
      const previous = this.history.pop();
      if (previous === undefined) {
        break;
      }
      const active = this.callbacks.getActiveLocation();
      const target = await this.goToSilent(previous.uri, previous.conflictId);
      if (target) {
        if (active !== undefined) {
          this.history.push({ uri: active.uri });
        }
        return true;
      }
    }
    return false;
  }

  private async goToSilent(uri: string, conflictId?: string): Promise<boolean> {
    const file = this.findFile(uri);
    if (file === undefined) return false;
    if (conflictId !== undefined) {
      const conflict = file.locatedConflicts.find((item) => item.id === conflictId);
      if (conflict !== undefined) {
        await this.callbacks.revealConflict(file.uri, conflict);
        return true;
      }
    }
    if (file.locatedConflicts.length > 0) {
      await this.callbacks.revealConflict(file.uri, file.locatedConflicts[0]);
      return true;
    }
    if (file.gitUnmerged) {
      return this.openMergeEditor(file.uri);
    }
    return false;
  }

  private pushHistory(): void {
    const active = this.callbacks.getActiveLocation();
    if (active === undefined) {
      return;
    }
    const last = this.history[this.history.length - 1];
    if (last !== undefined && last.uri === active.uri) {
      return;
    }
    this.history.push({ uri: active.uri });
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }
  }

  async goToAfter(uri: string, line: number): Promise<boolean> {
    const order = buildWorkspaceConflictOrder(this.snapshot);
    if (order.length === 0) {
      return false;
    }
    const active = this.callbacks.getActiveLocation();
    const refUri = active?.uri ?? uri;
    const refLine = active?.line ?? line;
    const currentIndex = findWorkspaceConflictIndexAtOrBefore(order, refUri, refLine);
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    for (let index = startIndex; index < order.length; index += 1) {
      const target = getWorkspaceConflictAt(order, index);
      if (target === undefined) {
        continue;
      }
      if (await this.goTo(target.uri, target.conflictId)) {
        return true;
      }
    }
    return false;
  }

  private async navigateWorkspace(direction: 1 | -1): Promise<boolean> {
    const order = buildWorkspaceConflictOrder(this.snapshot);
    if (order.length === 0) {
      return this.navigateGitOnlyFallback(direction);
    }

    const active = this.callbacks.getActiveLocation();
    if (active === undefined) {
      const target = getWorkspaceConflictAt(order, direction === 1 ? 0 : order.length - 1);
      return target === undefined ? false : this.goTo(target.uri, target.conflictId);
    }

    const currentIndex = findWorkspaceConflictIndexAtOrBefore(
      order,
      active.uri,
      active.line,
    );
    const targetIndex = direction === 1 ? currentIndex + 1 : currentIndex - 1;
    const target = getWorkspaceConflictAt(order, targetIndex);
    if (target === undefined) {
      return false;
    }

    return this.goTo(target.uri, target.conflictId);
  }

  private async navigateGitOnlyFallback(direction: 1 | -1): Promise<boolean> {
    const active = this.callbacks.getActiveLocation();
    if (active === undefined) {
      return false;
    }

    const file = this.findFile(active.uri);
    if (file === undefined || !file.gitUnmerged || file.locatedConflicts.length > 0) {
      return false;
    }

    return direction === 1 ? this.openMergeEditor(file.uri) : false;
  }

  private async navigateInFile(direction: 1 | -1): Promise<boolean> {
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
    const key = canonicalizeConflictUri(uri);
    return this.snapshot.files.find(
      (file) => canonicalizeConflictUri(file.uri) === key,
    );
  }
}
