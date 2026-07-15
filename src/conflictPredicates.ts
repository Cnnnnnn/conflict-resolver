import type { ConflictFile } from "./types";

/**
 * A file reported as git-unmerged (still in the index as conflicted), with no
 * located conflict markers and a parse error set. This means we know it is
 * unresolved but cannot show inline navigation for it — the user must open the
 * Merge Editor. Previously this combination was re-derived in 5+ places.
 */
export function isGitOnlyUnresolved(file: ConflictFile): boolean {
  return (
    file.gitUnmerged &&
    file.locatedConflicts.length === 0 &&
    file.parseError !== undefined
  );
}

/**
 * A git-unmerged file whose markers have been fully resolved (no located
 * conflicts and no parse error). Such files should be omitted from the view once
 * the merge state is cleaned up.
 */
export function isResolvedGitFile(file: ConflictFile): boolean {
  return (
    file.gitUnmerged &&
    file.locatedConflicts.length === 0 &&
    file.parseError === undefined
  );
}
