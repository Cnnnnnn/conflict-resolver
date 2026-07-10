import { describe, expect, it } from "vitest";

import { createConflictFilter, isLockFilePath } from "../conflictFilter";

describe("conflictFilter", () => {
  it("recognises common lock file basenames", () => {
    expect(isLockFilePath("pnpm-lock.yaml")).toBe(true);
    expect(isLockFilePath("package-lock.json")).toBe(true);
    expect(isLockFilePath("yarn.lock")).toBe(true);
    expect(isLockFilePath("Cargo.lock")).toBe(true);
    expect(isLockFilePath("nested/Cargo.lock")).toBe(true);
  });

  it("ignores non-lock basenames", () => {
    expect(isLockFilePath("package.json")).toBe(false);
    expect(isLockFilePath("README.md")).toBe(false);
  });

  it("skips lock files when includeLockFiles is false", () => {
    const filter = createConflictFilter({ includeLockFiles: false });
    expect(filter.isIncluded("pnpm-lock.yaml")).toBe(false);
    expect(filter.isIncluded("src/index.ts")).toBe(true);
  });

  it("includes lock files when enabled", () => {
    const filter = createConflictFilter({ includeLockFiles: true });
    expect(filter.isIncluded("pnpm-lock.yaml")).toBe(true);
  });
});