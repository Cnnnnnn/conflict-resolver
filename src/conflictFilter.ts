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

export type ConflictFilterOptions = {
  includeLockFiles: boolean;
};

export type ConflictFilter = {
  isIncluded(filePath: string): boolean;
};

export function createConflictFilter(
  options: ConflictFilterOptions,
): ConflictFilter {
  return {
    isIncluded(filePath: string): boolean {
      if (options.includeLockFiles) {
        return true;
      }
      return !isLockFilePath(filePath);
    },
  };
}