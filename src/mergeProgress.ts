import type { ConflictSnapshot } from "./types";

export type MergeProgress = {
  unmergedFileCount: number;
  locatedConflictCount: number;
  locatedFileCount: number;
  gitOnlyFileCount: number;
};

export function getMergeProgress(snapshot: ConflictSnapshot): MergeProgress {
  const unmergedFiles = snapshot.files.filter((file) => file.gitUnmerged);
  const locatedFiles = snapshot.files.filter(
    (file) => file.locatedConflicts.length > 0,
  );
  const gitOnlyFiles = snapshot.files.filter(
    (file) =>
      file.gitUnmerged &&
      file.locatedConflicts.length === 0 &&
      file.parseError !== undefined,
  );

  return {
    unmergedFileCount: unmergedFiles.length,
    locatedConflictCount: snapshot.locatedCount,
    locatedFileCount: locatedFiles.length,
    gitOnlyFileCount: gitOnlyFiles.length,
  };
}

export function formatMergeProgressLabel(progress: MergeProgress): string {
  if (
    progress.unmergedFileCount === 0 &&
    progress.locatedConflictCount === 0 &&
    progress.gitOnlyFileCount === 0
  ) {
    return "无待处理冲突";
  }

  const parts: string[] = [];

  if (progress.unmergedFileCount > 0) {
    parts.push(`剩余 ${progress.unmergedFileCount} 文件`);
  }

  if (progress.locatedConflictCount > 0) {
    parts.push(`${progress.locatedConflictCount} 处冲突`);
  }

  if (progress.gitOnlyFileCount > 0) {
    parts.push(`${progress.gitOnlyFileCount} 处未知冲突`);
  }

  return parts.join(" · ");
}
