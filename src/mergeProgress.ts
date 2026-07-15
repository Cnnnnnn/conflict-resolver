import { isGitOnlyUnresolved } from "./conflictPredicates";
import type { MergeScenario } from "./mergeScenario";
import type { ConflictSnapshot } from "./types";

export type MergeProgress = {
  unmergedFileCount: number;
  locatedConflictCount: number;
  locatedFileCount: number;
  gitOnlyFileCount: number;
  scenario?: MergeScenario;
};

export function getMergeProgress(
  snapshot: ConflictSnapshot,
  scenario?: MergeScenario,
): MergeProgress {
  const unmergedFiles = snapshot.files.filter((file) => file.gitUnmerged);
  const locatedFiles = snapshot.files.filter(
    (file) => file.locatedConflicts.length > 0,
  );
  const gitOnlyFiles = snapshot.files.filter((file) => isGitOnlyUnresolved(file));

  return {
    unmergedFileCount: unmergedFiles.length,
    locatedConflictCount: snapshot.locatedCount,
    locatedFileCount: locatedFiles.length,
    gitOnlyFileCount: gitOnlyFiles.length,
    scenario,
  };
}

export function formatMergeProgressLabel(progress: MergeProgress): string {
  if (
    progress.unmergedFileCount === 0 &&
    progress.locatedConflictCount === 0 &&
    progress.gitOnlyFileCount === 0
  ) {
    return progress.scenario?.inProgress && progress.scenario.kind !== "none"
      ? `${scenarioPrefix(progress.scenario)}：剩余待完成步骤`
      : "无待处理冲突";
  }

  const parts: string[] = [];

  if (progress.scenario?.inProgress && progress.scenario.kind !== "none") {
    parts.push(`${scenarioPrefix(progress.scenario)}剩余`);
  }

  if (progress.unmergedFileCount > 0) {
    parts.push(`${progress.unmergedFileCount} 文件`);
  }

  if (progress.locatedConflictCount > 0) {
    parts.push(`${progress.locatedConflictCount} 处冲突`);
  }

  if (progress.gitOnlyFileCount > 0) {
    parts.push(`${progress.gitOnlyFileCount} 处未知冲突`);
  }

  return parts.join(" · ");
}

function scenarioPrefix(scenario: MergeScenario): string {
  switch (scenario.kind) {
    case "merge":
      return "合并";
    case "rebase":
      return "rebase";
    case "cherry-pick":
      return "cherry-pick";
    default:
      return "";
  }
}
