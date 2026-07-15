import { canonicalizeConflictUri } from "./conflictScmMenu";
import type { ConflictBlock, ConflictSnapshot } from "./types";

export const ACCEPT_CURRENT_CONFLICT_COMMAND = "merge-conflict.accept.current";
export const ACCEPT_INCOMING_CONFLICT_COMMAND = "merge-conflict.accept.incoming";
export const ACCEPT_BOTH_CONFLICT_COMMAND = "merge-conflict.accept.both";

export type ConflictResolutionSide = "current" | "incoming" | "both";

export type ConflictResolutionCallbacks = {
  revealConflict(uri: string, conflict: ConflictBlock): Promise<void>;
  runCommand(command: string): Promise<void>;
  /**
   * Optional text-based fallback used when the built-in `merge-conflict.accept.*`
   * command is unavailable (e.g. the built-in Merge Conflict support is disabled
   * in Cursor). It must remove the conflict markers for `conflict` and keep the
   * chosen side, returning true if the edit was applied.
   */
  resolveByText?(uri: string, conflict: ConflictBlock, side: ConflictResolutionSide): Promise<boolean>;
  /**
   * When false, the text fallback is used directly instead of the built-in
   * accept command. Defaults to true.
   */
  preferBuiltinCommand?: boolean;
  /** When side is `both`, use built-in `merge-conflict.accept.both`. Defaults to false. */
  builtinBothAvailable?: boolean;
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

function commandForSide(side: ConflictResolutionSide): string {
  switch (side) {
    case "current":
      return ACCEPT_CURRENT_CONFLICT_COMMAND;
    case "incoming":
      return ACCEPT_INCOMING_CONFLICT_COMMAND;
    case "both":
      return ACCEPT_BOTH_CONFLICT_COMMAND;
    default: {
      const _exhaustive: never = side;
      return _exhaustive;
    }
  }
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

  const preferBuiltin = callbacks.preferBuiltinCommand ?? true;
  const useBuiltin =
    preferBuiltin &&
    (side !== "both" || (callbacks.builtinBothAvailable ?? false));

  if (callbacks.resolveByText !== undefined && !useBuiltin) {
    const ok = await callbacks.resolveByText(located.uri, located.conflict, side);
    if (!ok && preferBuiltin && side !== "both") {
      await callbacks.runCommand(commandForSide(side));
    }
    return true;
  }

  await callbacks.runCommand(commandForSide(side));
  return true;
}

/**
 * Remove the conflict markers for `conflict` from `text` and keep the chosen
 * side. Pure and testable; the caller applies the resulting text via a document
 * edit. Works on both `\n` and `\r\n` line endings (line strings keep their
 * trailing `\r` so rejoining is lossless).
 */
export function resolveConflictToText(
  text: string,
  conflict: ConflictBlock,
  side: ConflictResolutionSide,
): string {
  const lines = text.split("\n");
  const startLine = conflict.startLine;
  const endLine = conflict.endLine;
  const ours = lines.slice(conflict.oursRange.startLine, conflict.oursRange.endLine + 1);
  const theirs = lines.slice(conflict.theirsRange.startLine, conflict.theirsRange.endLine + 1);
  const kept =
    side === "current" ? ours : side === "incoming" ? theirs : [...ours, ...theirs];
  const before = lines.slice(0, startLine);
  const after = lines.slice(endLine + 1);
  return [...before, ...kept, ...after].join("\n");
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
  const sideLabel =
    side === "current" ? "采用当前" : side === "incoming" ? "采用传入" : "保留双方";
  if (summary.failed === 0) {
    return `${sideLabel}：处理 ${summary.resolved}/${summary.total}，跳过 ${summary.skipped}`;
  }
  return `${sideLabel}：处理 ${summary.resolved}/${summary.total}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
}
