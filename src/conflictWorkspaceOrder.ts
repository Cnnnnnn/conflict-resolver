import { canonicalizeConflictUri } from "./conflictScmMenu";
import type { ConflictBlock, ConflictFile, ConflictSnapshot } from "./types";

export type WorkspaceConflictRef = {
  uri: string;
  conflictId: string;
  startLine: number;
  relativePath: string;
};

function compareFiles(left: ConflictFile, right: ConflictFile): number {
  if (left.relativePath < right.relativePath) {
    return -1;
  }

  if (left.relativePath > right.relativePath) {
    return 1;
  }

  if (left.uri < right.uri) {
    return -1;
  }

  if (left.uri > right.uri) {
    return 1;
  }

  return 0;
}

function compareConflicts(left: ConflictBlock, right: ConflictBlock): number {
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }

  if (left.id < right.id) {
    return -1;
  }

  if (left.id > right.id) {
    return 1;
  }

  return 0;
}

export function buildWorkspaceConflictOrder(
  snapshot: ConflictSnapshot,
): WorkspaceConflictRef[] {
  const order: WorkspaceConflictRef[] = [];

  for (const file of [...snapshot.files]
    .filter((candidate) => candidate.locatedConflicts.length > 0)
    .sort(compareFiles)) {
    for (const conflict of [...file.locatedConflicts].sort(compareConflicts)) {
      order.push({
        uri: file.uri,
        conflictId: conflict.id,
        startLine: conflict.startLine,
        relativePath: file.relativePath,
      });
    }
  }

  return order;
}

export function getWorkspaceConflictFileCount(
  snapshot: ConflictSnapshot,
): number {
  return snapshot.files.filter((file) => file.locatedConflicts.length > 0).length;
}

export function findWorkspaceConflictIndexAtOrBefore(
  order: readonly WorkspaceConflictRef[],
  uri: string,
  line: number,
): number {
  const key = canonicalizeConflictUri(uri);
  let match = -1;

  for (let index = 0; index < order.length; index++) {
    const item = order[index];
    if (
      canonicalizeConflictUri(item.uri) === key &&
      item.startLine <= line
    ) {
      match = index;
    }
  }

  return match;
}

export function getWorkspaceConflictAt(
  order: readonly WorkspaceConflictRef[],
  index: number,
): WorkspaceConflictRef | undefined {
  return order[index];
}
