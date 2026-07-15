import type { ConflictBlock, ConflictFile } from "./types";

/**
 * Single source of truth for ordering ConflictFile entries (by relative path,
 * then URI). Previously duplicated across conflictStore, conflictTreeProvider
 * and conflictWorkspaceOrder, which drifted (one copy dropped the endLine check).
 */
export function compareFiles(left: ConflictFile, right: ConflictFile): number {
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

/**
 * Single source of truth for ordering ConflictBlock entries. Compares startLine,
 * then endLine, then id so the ordering is stable regardless of which copy was used.
 */
export function compareConflicts(left: ConflictBlock, right: ConflictBlock): number {
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }

  if (left.endLine !== right.endLine) {
    return left.endLine - right.endLine;
  }

  if (left.id < right.id) {
    return -1;
  }

  if (left.id > right.id) {
    return 1;
  }

  return 0;
}
