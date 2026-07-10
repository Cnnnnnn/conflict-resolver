import { canonicalizeConflictUri } from "./conflictScmMenu";
import type { ConflictBlock, ConflictSnapshot } from "./types";

export const ACCEPT_CURRENT_CONFLICT_COMMAND = "merge-conflict.accept.current";
export const ACCEPT_INCOMING_CONFLICT_COMMAND = "merge-conflict.accept.incoming";

export type ConflictResolutionSide = "current" | "incoming";

export type ConflictResolutionCallbacks = {
  revealConflict(uri: string, conflict: ConflictBlock): Promise<void>;
  runCommand(command: string): Promise<void>;
};

function findLocatedConflict(
  snapshot: ConflictSnapshot,
  uri: string,
  conflictId: string,
): { uri: string; conflict: ConflictBlock } | undefined {
  const key = canonicalizeConflictUri(uri);
  const file = snapshot.files.find(
    (candidate) => canonicalizeConflictUri(candidate.uri) === key,
  );
  if (file === undefined) {
    return undefined;
  }

  const conflict = file.locatedConflicts.find((item) => item.id === conflictId);
  if (conflict === undefined) {
    return undefined;
  }

  return { uri: file.uri, conflict };
}

export async function applyConflictResolution(
  snapshot: ConflictSnapshot,
  callbacks: ConflictResolutionCallbacks,
  uri: string,
  conflictId: string,
  side: ConflictResolutionSide,
): Promise<boolean> {
  const located = findLocatedConflict(snapshot, uri, conflictId);
  if (located === undefined) {
    return false;
  }

  await callbacks.revealConflict(located.uri, located.conflict);
  await callbacks.runCommand(
    side === "current"
      ? ACCEPT_CURRENT_CONFLICT_COMMAND
      : ACCEPT_INCOMING_CONFLICT_COMMAND,
  );
  return true;
}

export type BatchResolutionTarget = { uri: string; conflictId: string };

export type BatchResolutionSummary = {
  total: number;
  resolved: number;
  skipped: number;
  failed: number;
};

const TARGET_BATCH_SIZE = 25;

export async function applyBatchConflictResolution(
  snapshot: ConflictSnapshot,
  callbacks: ConflictResolutionCallbacks,
  targets: readonly BatchResolutionTarget[],
  side: ConflictResolutionSide,
): Promise<BatchResolutionSummary> {
  const summary: BatchResolutionSummary = {
    total: targets.length,
    resolved: 0,
    skipped: 0,
    failed: 0,
  };

  for (let index = 0; index < targets.length; index += TARGET_BATCH_SIZE) {
    const batch = targets.slice(index, index + TARGET_BATCH_SIZE);
    for (const target of batch) {
      const ok = await applyConflictResolution(
        snapshot,
        callbacks,
        target.uri,
        target.conflictId,
        side,
      );
      if (ok) {
        summary.resolved += 1;
      } else {
        summary.skipped += 1;
      }
    }
    if (index + TARGET_BATCH_SIZE < targets.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  return summary;
}

export function collectBatchTargets(
  snapshot: ConflictSnapshot,
  scope: BatchResolutionScope,
): BatchResolutionTarget[] {
  const targets: BatchResolutionTarget[] = [];

  for (const file of snapshot.files) {
    if (scope.kind === "file" && file.uri !== scope.fileUri) {
      continue;
    }
    for (const conflict of file.locatedConflicts) {
      targets.push({ uri: file.uri, conflictId: conflict.id });
    }
  }

  return targets;
}

export type BatchResolutionScope =
  | { kind: "all" }
  | { kind: "file"; fileUri: string };

export function formatBatchResolutionMessage(
  side: ConflictResolutionSide,
  summary: BatchResolutionSummary,
): string {
  const sideLabel = side === "current" ? "采用当前" : "采用传入";
  if (summary.failed === 0) {
    return `${sideLabel}：处理 ${summary.resolved}/${summary.total}，跳过 ${summary.skipped}`;
  }
  return `${sideLabel}：处理 ${summary.resolved}/${summary.total}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
}
