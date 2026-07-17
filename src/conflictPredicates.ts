/**
 * Single source of truth for "what does it mean for a conflict file
 * to be in state X". Centralizing these predicates here means the
 * tree view, decorations, navigation, scm menu, and merge progress
 * all agree on the same definition; the tests in
 * conflictPredicates.test.ts lock the current behavior so a future
 * change can't silently drift one of them.
 *
 * Definitions are deliberately **structural** (no parseError in the
 * matrix). parseError is information about *why* a file is in a
 * state, not a different state by itself — a git-unmerged file with
 * zero located conflicts is still unresolved regardless of why the
 * parser couldn't read markers.
 */
import type { ConflictFile, ConflictSnapshot } from "./types";

/**
 * A file that git still reports as unresolved, with no inline conflict
 * markers we can navigate to. Such files must be opened via the Merge
 * Editor; the tree puts them under the "Git 未解决但位置未知" group.
 */
export function isGitOnlyUnresolved(file: ConflictFile): boolean {
  return file.gitUnmerged && file.locatedConflicts.length === 0;
}

/**
 * A file with at least one located conflict marker. Drives the
 * "可定位冲突" group, the badge count, and the chevron navigation.
 */
export function hasLocatedConflicts(file: ConflictFile): boolean {
  return file.locatedConflicts.length > 0;
}

/**
 * Convenience predicate covering every "the file is still somewhere
 * in the unresolved state" branch — git-unmerged OR has located
 * markers. Used by the merge progress bar.
 */
export function isUnresolvedConflictFile(file: ConflictFile): boolean {
  return file.gitUnmerged || file.locatedConflicts.length > 0;
}

function isSnapshot(
  source: ConflictSnapshot | readonly ConflictFile[],
): source is ConflictSnapshot {
  return !Array.isArray(source);
}

/**
 * Total located conflict count across a snapshot or file array.
 * Convenience for callers that previously re-derived
 * `snapshot.locatedCount` from the file list.
 */
export function countLocatedConflicts(
  source: ConflictSnapshot | readonly ConflictFile[],
): number {
  const files = isSnapshot(source) ? source.files : source;
  let total = 0;
  for (const file of files) {
    total += file.locatedConflicts.length;
  }
  return total;
}

/**
 * Count of files git reports as unmerged but the parser produced no
 * located conflicts for. Matches the `gitOnlyCount` field on the
 * snapshot, kept here as a single definition so test fixtures stop
 * re-inlining `files.filter((f) => f.gitUnmerged && f.locatedConflicts.length === 0)`.
 */
export function countGitOnlyFiles(
  source: ConflictSnapshot | readonly ConflictFile[],
): number {
  const files = isSnapshot(source) ? source.files : source;
  let total = 0;
  for (const file of files) {
    if (isGitOnlyUnresolved(file)) {
      total += 1;
    }
  }
  return total;
}