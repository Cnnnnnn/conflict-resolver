import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import * as vscode from "vscode";

export type MergeScenarioKind = "merge" | "rebase" | "cherry-pick" | "none";

export type MergeScenario = {
  kind: MergeScenarioKind;
  inProgress: boolean;
  continueCommand?: string;
};

const SCENARIO_LABEL: Record<Exclude<MergeScenarioKind, "none">, string> = {
  merge: "合并",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
};

const SCENARIO_VERB: Record<Exclude<MergeScenarioKind, "none">, string> = {
  merge: "合并中",
  rebase: "rebase 中",
  "cherry-pick": "cherry-pick 中",
};

// VS Code ThemeIcon ids used to distinguish scenarios in the status bar and
// the conflict panel header. Falls back to a generic icon for unsupported
// kinds so the visual cue never disappears entirely.
const SCENARIO_ICON: Record<Exclude<MergeScenarioKind, "none">, string> = {
  merge: "$(git-merge)",
  rebase: "$(history)",
  "cherry-pick": "$(git-cherry-pick)",
};

export async function detectMergeScenario(
  repositoryRoot: string,
  fsAdapter: Pick<typeof fs, "stat"> = fs,
): Promise<MergeScenario> {
  if (!isAbsolute(repositoryRoot)) {
    return { kind: "none", inProgress: false };
  }

  const probes: Array<{ kind: Exclude<MergeScenarioKind, "none">; file: string }> = [
    { kind: "merge", file: ".git/MERGE_HEAD" },
    { kind: "rebase", file: ".git/REBASE_HEAD" },
    { kind: "cherry-pick", file: ".git/CHERRY_PICK_HEAD" },
  ];

  for (const probe of probes) {
    const target = join(repositoryRoot, probe.file);
    try {
      await fsAdapter.stat(target);
      return {
        kind: probe.kind,
        inProgress: true,
        continueCommand: continueCommandFor(probe.kind),
      };
    } catch {
      // not in this scenario
    }
  }

  return { kind: "none", inProgress: false };
}

function continueCommandFor(kind: Exclude<MergeScenarioKind, "none">): string {
  switch (kind) {
    case "merge":
      return "git merge --continue";
    case "rebase":
      return "git rebase --continue";
    case "cherry-pick":
      return "git cherry-pick --continue";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function formatScenarioLabel(scenario: MergeScenario): string | undefined {
  if (!scenario.inProgress || scenario.kind === "none") {
    return undefined;
  }
  return `${SCENARIO_VERB[scenario.kind]}剩余`;
}

export function formatScenarioTitle(scenario: MergeScenario): string | undefined {
  if (!scenario.inProgress || scenario.kind === "none") {
    return undefined;
  }
  return SCENARIO_LABEL[scenario.kind];
}

export function formatScenarioIcon(scenario: MergeScenario): string | undefined {
  if (!scenario.inProgress || scenario.kind === "none") {
    return undefined;
  }
  return SCENARIO_ICON[scenario.kind];
}

export async function runScenarioContinue(
  scenario: MergeScenario,
  repositoryRoot: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  if (!scenario.inProgress || scenario.kind === "none" || scenario.continueCommand === undefined) {
    return { ok: false, message: "当前不在合并状态" };
  }
  if (repositoryRoot === undefined) {
    return { ok: false, message: "未找到 Git 仓库根目录" };
  }

  const terminal = vscode.window.createTerminal({
    cwd: repositoryRoot,
    name: `${SCENARIO_LABEL[scenario.kind]} continue`,
  });
  terminal.show();
  terminal.sendText(scenario.continueCommand);
  return {
    ok: true,
    message: `已在终端执行 ${scenario.continueCommand}`,
  };
}

export function scenarioMatchesFile(
  scenario: MergeScenario,
  filePath: string,
): boolean {
  if (!scenario.inProgress || scenario.kind === "none") {
    return false;
  }
  // The marker files live under repositoryRoot/.git/; any conflicting file is
  // implicitly part of the same scenario by virtue of being in the same repo.
  // This helper is reserved for future repo-bound checks; today we just gate
  // on scenario presence.
  return dirname(filePath).length > 0;
}