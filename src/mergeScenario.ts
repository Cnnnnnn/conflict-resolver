import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import * as vscode from "vscode";

// Same ceiling as gitRepositoryService so a stuck --continue cannot pin the
// UI; the child is killed on timeout and the call rejects.
const SCENARIO_CONTINUE_TIMEOUT_MS = 30_000;

type ScenarioCommandResult = { stdout: string; stderr: string };
export type ScenarioCommandRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<ScenarioCommandResult>;

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
  options: { silent?: boolean; runCommand?: ScenarioCommandRunner } = {},
): Promise<{ ok: boolean; message: string }> {
  if (!scenario.inProgress || scenario.kind === "none" || scenario.continueCommand === undefined) {
    return { ok: false, message: "当前不在合并状态" };
  }
  if (repositoryRoot === undefined) {
    return { ok: false, message: "未找到 Git 仓库根目录" };
  }

  // Terminal mode keeps the user able to inspect / interact with the command;
  // silent mode runs git directly and shows a notification with the outcome.
  if (!options.silent) {
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

  return runScenarioContinueSilent(
    scenario,
    repositoryRoot,
    options.runCommand ?? defaultScenarioCommandRunner,
  );
}

async function runScenarioContinueSilent(
  scenario: MergeScenario,
  repositoryRoot: string,
  runCommand: ScenarioCommandRunner,
): Promise<{ ok: boolean; message: string }> {
  if (scenario.continueCommand === undefined) {
    return { ok: false, message: "当前不在合并状态" };
  }
  // The continueCommand stores the full `git <verb> --continue`; we only
  // need the verb + arguments, so drop the leading "git " when invoking
  // execFile.
  const commandTail = scenario.continueCommand.replace(/^git\s+/, "");
  const args = commandTail.split(/\s+/).filter((part) => part.length > 0);

  try {
    const { stdout, stderr } = await runCommand(args, repositoryRoot);
    const summary = stdout.trim() || stderr.trim() || "已执行";
    const label = scenario.kind === "none" ? "" : SCENARIO_LABEL[scenario.kind];
    return { ok: true, message: `${label} continue: ${summary}` };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `${scenario.continueCommand} 失败：${message}`,
    };
  }
}

async function defaultScenarioCommandRunner(
  args: readonly string[],
  cwd: string,
): Promise<ScenarioCommandResult> {
  return new Promise<ScenarioCommandResult>((resolveFn, rejectFn) => {
    execFile(
      "git",
      args,
      { cwd, timeout: SCENARIO_CONTINUE_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectFn(error);
          return;
        }
        const toText = (value: string | Buffer): string =>
          typeof value === "string" ? value : String(value);
        resolveFn({
          stdout: toText(stdout),
          stderr: toText(stderr),
        });
      },
    );
  });
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