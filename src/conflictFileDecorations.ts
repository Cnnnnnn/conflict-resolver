import type { ConflictSnapshot } from "./types";
import { toConflictFileKey } from "./conflictScmMenu";

export type ConflictFileDecoration = {
  badge: string;
  tooltip: string;
  colorId: "badge.foreground";
};

function canonicalizeFileUri(uri: string): string {
  return toConflictFileKey(uri);
}

function formatConflictCount(count: number): string {
  if (count > 99) {
    return "99+";
  }

  return String(count);
}

export function formatLocatedConflictLabel(count: number): string {
  return `${formatConflictCount(count)}个冲突`;
}

export function formatGitOnlyConflictLabel(): string {
  return "未知冲突";
}

function formatConflictBadge(count: number): string {
  if (count > 99) {
    return "99+";
  }

  return `${count}个`;
}

export function buildConflictFileDecorations(
  snapshot: ConflictSnapshot,
): Map<string, ConflictFileDecoration> {
  const decorations = new Map<string, ConflictFileDecoration>();

  for (const file of snapshot.files) {
    const key = canonicalizeFileUri(file.uri);
    const locatedCount = file.locatedConflicts.length;

    if (locatedCount > 0) {
      decorations.set(key, {
        badge: formatConflictBadge(locatedCount),
        tooltip: `${file.relativePath}\n${formatLocatedConflictLabel(locatedCount)}`,
        colorId: "badge.foreground",
      });
      continue;
    }

    if (file.gitUnmerged && file.parseError !== undefined) {
      decorations.set(key, {
        badge: "!",
        tooltip: `${file.relativePath}\n${formatGitOnlyConflictLabel()}`,
        colorId: "badge.foreground",
      });
    }
  }

  return decorations;
}

export function getConflictBadgeCount(snapshot: ConflictSnapshot): number {
  return snapshot.files.filter(
    (file) =>
      file.locatedConflicts.length > 0 ||
      (file.gitUnmerged && file.parseError !== undefined),
  ).length;
}

export class ConflictFileDecorationProvider {
  private decorations = new Map<string, ConflictFileDecoration>();
  private readonly listeners = new Set<(uris: readonly string[] | undefined) => void>();

  readonly onDidChange = (listener: (uris: readonly string[] | undefined) => void) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  update(snapshot: ConflictSnapshot): void {
    this.decorations = buildConflictFileDecorations(snapshot);
    for (const listener of this.listeners) {
      listener(undefined);
    }
  }

  provideFileDecoration(uri: string): ConflictFileDecoration | undefined {
    return this.decorations.get(canonicalizeFileUri(uri));
  }

  dispose(): void {
    this.listeners.clear();
    this.decorations.clear();
  }
}
