import type { ConflictSnapshot } from "./types";

export type ConflictWorkState = {
  hadLocatedConflicts: boolean;
  hadUnmergedFiles: boolean;
};

export const EMPTY_CONFLICT_WORK_STATE: ConflictWorkState = {
  hadLocatedConflicts: false,
  hadUnmergedFiles: false,
};

export type CompletionKind = "none" | "markers-cleared" | "all-resolved";

export function updateConflictWorkState(
  state: ConflictWorkState,
  snapshot: ConflictSnapshot,
): ConflictWorkState {
  return {
    hadLocatedConflicts:
      state.hadLocatedConflicts || snapshot.locatedCount > 0,
    hadUnmergedFiles:
      state.hadUnmergedFiles ||
      snapshot.files.some((file) => file.gitUnmerged),
  };
}

export function getCompletionKind(
  snapshot: ConflictSnapshot,
  state: ConflictWorkState,
): CompletionKind {
  if (snapshot.locatedCount > 0 || snapshot.gitOnlyCount > 0) {
    return "none";
  }

  if (!state.hadLocatedConflicts && !state.hadUnmergedFiles) {
    return "none";
  }

  const unmergedCount = snapshot.files.filter((file) => file.gitUnmerged).length;
  if (unmergedCount > 0) {
    return "markers-cleared";
  }

  return "all-resolved";
}

export function formatCompletionLabel(
  kind: CompletionKind,
  snapshot: ConflictSnapshot,
): string | undefined {
  switch (kind) {
    case "markers-cleared": {
      const unmergedCount = snapshot.files.filter((file) => file.gitUnmerged).length;
      return `✓ 冲突标记已处理 · 剩余 ${unmergedCount} 个文件待 git add（命令面板: Conflict Resolver: Stage All Resolved）`;
    }
    case "all-resolved":
      return "✓ 合并冲突已全部处理完毕";
    case "none":
      return undefined;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function shouldNotifyLocatedConflictsCleared(
  previous: ConflictSnapshot,
  current: ConflictSnapshot,
): boolean {
  return previous.locatedCount > 0 && current.locatedCount === 0;
}

export function formatLocatedClearedNotification(snapshot: ConflictSnapshot): string {
  if (snapshot.gitOnlyCount > 0) {
    return `可定位冲突已全部处理，仍有 ${snapshot.gitOnlyCount} 个未知冲突文件`;
  }

  const unmergedCount = snapshot.files.filter((file) => file.gitUnmerged).length;
  if (unmergedCount > 0) {
    return `冲突标记已全部清除，请对 ${unmergedCount} 个文件执行 git add 完成合并`;
  }

  return "所有可定位冲突已处理完毕！";
}
