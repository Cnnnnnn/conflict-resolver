import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import type { ConflictBlock, ConflictFile, ConflictSnapshot } from "./types";

export type ScmConflictPickItem = {
  label: string;
  description?: string;
  conflictId: string;
};

export type ScmConflictPickUi = {
  showInformationMessage(message: string): PromiseLike<unknown>;
  showQuickPick<T extends ScmConflictPickItem>(
    items: readonly T[],
    options: { title: string; placeHolder: string },
  ): PromiseLike<T | undefined>;
};

export type ScmConflictNavigation = {
  goTo(uri: string, conflictId: string): PromiseLike<boolean>;
};

export function canonicalizeConflictUri(uri: string): string {
  try {
    if (new URL(uri).protocol !== "file:") {
      return uri;
    }

    return pathToFileURL(fileURLToPath(uri)).toString();
  } catch {
    return uri;
  }
}

export function toConflictFileKey(uri: string): string {
  if (uri.length > 0 && !uri.includes("://")) {
    return resolve(uri);
  }

  try {
    if (new URL(uri).protocol === "file:") {
      return resolve(fileURLToPath(uri));
    }
  } catch {
    // ponytail: non-file URIs fall through to best-effort normalization
  }

  try {
    return resolve(fileURLToPath(canonicalizeConflictUri(uri)));
  } catch {
    return uri;
  }
}

export function hasLocatedConflictMarkers(text: string): boolean {
  return /^(<<<<<<<(?: .+)?|=======|>>>>>>>(?: .+)?)$/m.test(text);
}

export function resolveScmResourceUri(resource: unknown): string | undefined {
  if (typeof resource === "string") {
    return canonicalizeConflictUri(resource);
  }

  if (typeof resource === "object" && resource !== null && "resourceUri" in resource) {
    const { resourceUri } = resource as { resourceUri: unknown };
    if (typeof resourceUri === "string") {
      return canonicalizeConflictUri(resourceUri);
    }

    if (
      typeof resourceUri === "object" &&
      resourceUri !== null &&
      "toString" in resourceUri &&
      typeof resourceUri.toString === "function"
    ) {
      return canonicalizeConflictUri(resourceUri.toString());
    }
  }

  if (
    typeof resource === "object" &&
    resource !== null &&
    "toString" in resource &&
    typeof resource.toString === "function" &&
    resource.toString !== Object.prototype.toString
  ) {
    return canonicalizeConflictUri(resource.toString());
  }

  return undefined;
}

export function findConflictFile(
  snapshot: ConflictSnapshot,
  uri: string,
): ConflictFile | undefined {
  const key = toConflictFileKey(canonicalizeConflictUri(uri));
  return snapshot.files.find(
    (file) => toConflictFileKey(canonicalizeConflictUri(file.uri)) === key,
  );
}

export function sortLocatedConflicts(
  conflicts: readonly ConflictBlock[],
): ConflictBlock[] {
  return [...conflicts].sort((left, right) => {
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function formatLocatedConflictMenuLabel(
  conflict: ConflictBlock,
  index: number,
): string {
  return `冲突 ${index + 1} — 第 ${conflict.startLine + 1} 行`;
}

export function buildLocatedConflictPickItems(
  file: ConflictFile,
): ScmConflictPickItem[] {
  return sortLocatedConflicts(file.locatedConflicts).map((conflict, index) => ({
    label: formatLocatedConflictMenuLabel(conflict, index),
    description: file.relativePath,
    conflictId: conflict.id,
  }));
}

export const SCM_LOCATED_SLOT_COUNT = 20;

export function getLocatedConflictAtSlot(
  file: ConflictFile,
  slotIndex: number,
): ConflictBlock | undefined {
  return sortLocatedConflicts(file.locatedConflicts)[slotIndex];
}

export function getMergeConflictMenuContext(snapshot: ConflictSnapshot): {
  hasMergeConflicts: boolean;
  hasGitOnlyMergeFiles: boolean;
} {
  return {
    hasMergeConflicts: snapshot.files.length > 0,
    hasGitOnlyMergeFiles: snapshot.files.some(
      (file) =>
        file.gitUnmerged &&
        file.locatedConflicts.length === 0 &&
        file.parseError !== undefined,
    ),
  };
}

export function buildScmEditorSlotContext(
  snapshot: ConflictSnapshot,
  editorUri: string | undefined,
): Record<string, boolean | number | string> {
  const editorPath =
    editorUri === undefined
      ? ""
      : fileURLToPath(vscodeLikeUriToUrl(editorUri));
  const file =
    editorUri === undefined ? undefined : findConflictFile(snapshot, editorUri);
  const locatedCount = file?.locatedConflicts.length ?? 0;
  const gitOnly =
    file !== undefined &&
    file.gitUnmerged &&
    file.locatedConflicts.length === 0 &&
    file.parseError !== undefined;

  const context: Record<string, boolean | number | string> = {
    "conflictResolver.scmEditorResourcePath": editorPath,
    "conflictResolver.scmEditorLocatedCount": locatedCount,
    "conflictResolver.scmEditorHasLocatedConflicts": locatedCount > 0,
    "conflictResolver.scmEditorGitOnly": gitOnly,
  };

  for (let slot = 1; slot <= SCM_LOCATED_SLOT_COUNT; slot++) {
    context[`conflictResolver.scmEditorSlot${slot}`] = locatedCount >= slot;
  }

  return context;
}

function vscodeLikeUriToUrl(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    return pathToFileURL(uri);
  }
}

export function getLocatedConflictCountForResource(
  snapshot: ConflictSnapshot,
  resource: unknown,
): number {
  const uri = resolveScmResourceUri(resource);
  if (uri === undefined) {
    return 0;
  }

  return findConflictFile(snapshot, uri)?.locatedConflicts.length ?? 0;
}

export async function pickLocatedConflictForResource(
  resource: unknown,
  snapshot: ConflictSnapshot,
  navigation: ScmConflictNavigation,
  ui: ScmConflictPickUi,
): Promise<boolean> {
  const uri = resolveScmResourceUri(resource);
  if (uri === undefined) {
    return false;
  }

  const file = findConflictFile(snapshot, uri);
  if (file === undefined || file.locatedConflicts.length === 0) {
    await ui.showInformationMessage("当前文件没有可定位冲突");
    return false;
  }

  const items = buildLocatedConflictPickItems(file);
  if (items.length === 1) {
    return navigation.goTo(file.uri, items[0].conflictId);
  }

  const selected = await ui.showQuickPick(items, {
    title: file.relativePath,
    placeHolder: "选择要跳转的冲突位置",
  });
  if (selected === undefined) {
    return false;
  }

  return navigation.goTo(file.uri, selected.conflictId);
}

export function shouldShowScmPickConflict(
  snapshot: ConflictSnapshot,
  resource: unknown,
  editorUri: string | undefined,
): boolean {
  const resourceUri = resolveScmResourceUri(resource);
  if (resourceUri === undefined) {
    return false;
  }

  const count = getLocatedConflictCountForResource(snapshot, resource);
  if (count === 0) {
    return false;
  }

  if (editorUri === undefined) {
    return true;
  }

  return canonicalizeConflictUri(resourceUri) !== canonicalizeConflictUri(editorUri);
}
