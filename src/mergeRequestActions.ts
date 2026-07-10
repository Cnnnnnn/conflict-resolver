import type { MergeRequestConflict } from "./types";

export type MergePreviewResult =
  | {
      ok: true;
      conflictCount: number;
      output: string;
      targetRef: string;
    }
  | {
      ok: false;
      message: string;
    };

export type MergeRequestGitActions = {
  fetchRemoteBranch(
    repositoryRoot: string,
    remote: string,
    branch: string,
  ): Promise<void>;
  previewMergeWithRemoteBranch(
    repositoryRoot: string,
    remote: string,
    targetBranch: string,
  ): Promise<MergePreviewResult>;
  getDefaultRemote(repositoryRoot: string): Promise<string>;
};

export function buildMrConflictsUrl(webUrl: string): string {
  const trimmed = webUrl.replace(/\/+$/u, "");
  return `${trimmed}/-/conflicts`;
}

export async function fetchMrTargetBranch(
  git: MergeRequestGitActions,
  repositoryRoot: string,
  mr: Pick<MergeRequestConflict, "targetBranch">,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  try {
    const remote = await git.getDefaultRemote(repositoryRoot);
    await git.fetchRemoteBranch(repositoryRoot, remote, mr.targetBranch);
    return {
      ok: true,
      message: `已获取 ${remote}/${mr.targetBranch}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function previewMrMerge(
  git: MergeRequestGitActions,
  repositoryRoot: string,
  mr: Pick<MergeRequestConflict, "targetBranch">,
): Promise<MergePreviewResult> {
  const remote = await git.getDefaultRemote(repositoryRoot);
  return git.previewMergeWithRemoteBranch(repositoryRoot, remote, mr.targetBranch);
}

export function formatMergePreviewMessage(result: MergePreviewResult): string {
  if (!result.ok) {
    return result.message;
  }

  if (result.conflictCount === 0) {
    return `预演合并 ${result.targetRef}：预计无冲突`;
  }

  return `预演合并 ${result.targetRef}：预计 ${result.conflictCount} 个文件冲突`;
}
