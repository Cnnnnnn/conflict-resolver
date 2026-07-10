import { basename } from "node:path";

const LOCK_FILE_BASENAMES = new Set<string>([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Cargo.lock",
  "Pipfile.lock",
  "poetry.lock",
  "Gemfile.lock",
]);

export function isLockFilePath(filePath: string): boolean {
  return LOCK_FILE_BASENAMES.has(basename(filePath));
}

export type ConflictFilterMode = "all" | "source" | "lock";

export type ConflictFilterOptions = {
  includeLockFiles: boolean;
  mode?: ConflictFilterMode;
};

export type ConflictFilter = {
  isIncluded(filePath: string): boolean;
  matchesMode(filePath: string): boolean;
};

export function createConflictFilter(
  options: ConflictFilterOptions,
): ConflictFilter {
  const mode = options.mode ?? "all";
  return {
    isIncluded(filePath: string): boolean {
      if (!options.includeLockFiles && isLockFilePath(filePath)) {
        return false;
      }
      return true;
    },
    matchesMode(filePath: string): boolean {
      if (mode === "all") {
        return true;
      }
      const lock = isLockFilePath(filePath);
      if (mode === "lock") {
        return lock;
      }
      return !lock;
    },
  };
}