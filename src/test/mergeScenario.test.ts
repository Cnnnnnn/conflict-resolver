import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectMergeScenario,
  formatScenarioLabel,
  formatScenarioTitle,
  runScenarioContinue,
  type MergeScenario,
} from "../mergeScenario";

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp("/tmp/conflict-resolver-scenario-");
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("detectMergeScenario", () => {
  it("returns none when no marker exists", async () => {
    const result = await detectMergeScenario(workDir);
    expect(result).toEqual({ kind: "none", inProgress: false });
  });

  it("detects merge in progress via MERGE_HEAD", async () => {
    await fs.mkdir(join(workDir, ".git"), { recursive: true });
    await fs.writeFile(join(workDir, ".git", "MERGE_HEAD"), "deadbeef");
    const result = await detectMergeScenario(workDir);
    expect(result.kind).toBe("merge");
    expect(result.inProgress).toBe(true);
    expect(result.continueCommand).toBe("git merge --continue");
  });

  it("detects rebase via REBASE_HEAD", async () => {
    await fs.mkdir(join(workDir, ".git"), { recursive: true });
    await fs.writeFile(join(workDir, ".git", "REBASE_HEAD"), "rebase-ref");
    const result = await detectMergeScenario(workDir);
    expect(result.kind).toBe("rebase");
    expect(result.continueCommand).toBe("git rebase --continue");
  });

  it("detects cherry-pick via CHERRY_PICK_HEAD", async () => {
    await fs.mkdir(join(workDir, ".git"), { recursive: true });
    await fs.writeFile(join(workDir, ".git", "CHERRY_PICK_HEAD"), "cherry-ref");
    const result = await detectMergeScenario(workDir);
    expect(result.kind).toBe("cherry-pick");
    expect(result.continueCommand).toBe("git cherry-pick --continue");
  });

  it("rejects non-absolute paths", async () => {
    const result = await detectMergeScenario("relative/path");
    expect(result).toEqual({ kind: "none", inProgress: false });
  });
});

describe("formatScenarioLabel", () => {
  it("returns undefined for non-active scenarios", () => {
    expect(formatScenarioLabel({ kind: "none", inProgress: false })).toBeUndefined();
  });

  it("returns active scenario label", () => {
    const scenario: MergeScenario = {
      kind: "rebase",
      inProgress: true,
      continueCommand: "git rebase --continue",
    };
    expect(formatScenarioLabel(scenario)).toBe("rebase 中剩余");
  });
});

describe("formatScenarioTitle", () => {
  it("returns human title for active scenario", () => {
    expect(
      formatScenarioTitle({ kind: "merge", inProgress: true }),
    ).toBe("合并");
    expect(
      formatScenarioTitle({ kind: "cherry-pick", inProgress: true }),
    ).toBe("cherry-pick");
  });
});

describe("runScenarioContinue", () => {
  it("returns false when scenario is not active", async () => {
    const result = await runScenarioContinue(
      { kind: "none", inProgress: false },
      workDir,
    );
    expect(result.ok).toBe(false);
  });
});