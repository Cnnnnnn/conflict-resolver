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
