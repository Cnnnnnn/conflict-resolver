/**
 * Static command registry + fuzzy filter for the Conflict Resolver QuickPick.
 *
 * The registry lives in source (not package.json) so the picker can be
 * exercised without spinning up VS Code, and so command visibility can
 * depend on runtime state (e.g. hasLocatedConflicts, markersCleared)
 * rather than a static `when` clause. Keeping the predicate next to the
 * command also means tests can lock the filter behavior in one place.
 */
import type { ConflictSnapshot } from "./types";

export type CommandVisibilityContext = {
  snapshot: ConflictSnapshot;
  hasUndo: boolean;
  scenarioInProgress: boolean;
  markersCleared: boolean;
};

export type ConflictPaletteEntry = {
  command: string;
  label: string;
  detail?: string;
  group: "navigation" | "accept" | "panel" | "scenario" | "undo" | "settings";
  /** Returning false hides the entry from the picker. */
  isVisible(context: CommandVisibilityContext): boolean;
  /** Free-text keywords that should boost this entry during fuzzy search. */
  aliases?: readonly string[];
};

const VISIBLE_WHEN_HAS_LOCATED = ({ snapshot }: CommandVisibilityContext): boolean =>
  snapshot.locatedCount > 0;

const VISIBLE_ALWAYS = (): boolean => true;

const VISIBLE_WHEN_UNDO = ({ hasUndo }: CommandVisibilityContext): boolean => hasUndo;

const VISIBLE_WHEN_SCENARIO = ({ scenarioInProgress }: CommandVisibilityContext): boolean =>
  scenarioInProgress;

const VISIBLE_WHEN_MARKERS_CLEARED = ({ markersCleared }: CommandVisibilityContext): boolean =>
  markersCleared;

export const CONFLICT_PALETTE_COMMANDS: readonly ConflictPaletteEntry[] = [
  // Navigation
  {
    command: "conflictResolver.nextConflict",
    label: "下一个冲突",
    detail: "Alt+]",
    group: "navigation",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
    aliases: ["next", "forward", "advance"],
  },
  {
    command: "conflictResolver.previousConflict",
    label: "上一个冲突",
    detail: "Alt+[",
    group: "navigation",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
    aliases: ["prev", "back"],
  },
  {
    command: "conflictResolver.nextConflictInFile",
    label: "文件内下一个冲突",
    group: "navigation",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
  },
  {
    command: "conflictResolver.previousConflictInFile",
    label: "文件内上一个冲突",
    group: "navigation",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
  },
  {
    command: "conflictResolver.nextFile",
    label: "下一个冲突文件",
    detail: "Alt+Shift+]",
    group: "navigation",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
    aliases: ["next file"],
  },
  {
    command: "conflictResolver.previousFile",
    label: "上一个冲突文件",
    detail: "Alt+Shift+[",
    group: "navigation",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
    aliases: ["prev file"],
  },
  {
    command: "conflictResolver.firstConflictInActiveFile",
    label: "跳到当前文件首个冲突",
    detail: "Alt+Shift+F",
    group: "navigation",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
  },
  // Panel / search
  {
    command: "conflictResolver.openPanel",
    label: "打开冲突面板",
    group: "panel",
    isVisible: VISIBLE_ALWAYS,
  },
  {
    command: "conflictResolver.treeSearch",
    label: "搜索冲突",
    detail: "Ctrl+Shift+F",
    group: "panel",
    isVisible: VISIBLE_ALWAYS,
    aliases: ["search", "filter"],
  },
  {
    command: "conflictResolver.treeSelectAll",
    label: "全选当前文件冲突",
    group: "panel",
    isVisible: VISIBLE_WHEN_HAS_LOCATED,
  },
  {
    command: "conflictResolver.treeClearSelection",
    label: "清空选择",
    group: "panel",
    isVisible: VISIBLE_ALWAYS,
  },
  // Accept (batch)
  {
    command: "conflictResolver.batchAcceptCurrent",
    label: "采用当前(批量)",
    group: "accept",
    isVisible: VISIBLE_ALWAYS,
    aliases: ["accept current", "ours"],
  },
  {
    command: "conflictResolver.batchAcceptIncoming",
    label: "采用传入(批量)",
    group: "accept",
    isVisible: VISIBLE_ALWAYS,
    aliases: ["accept incoming", "theirs"],
  },
  {
    command: "conflictResolver.batchAcceptBoth",
    label: "保留双方(批量)",
    group: "accept",
    isVisible: VISIBLE_ALWAYS,
    aliases: ["accept both", "keep"],
  },
  // Scenario
  {
    command: "conflictResolver.continueScenario",
    label: "继续 merge / rebase / cherry-pick",
    group: "scenario",
    isVisible: VISIBLE_WHEN_SCENARIO,
  },
  {
    command: "conflictResolver.stageAllResolved",
    label: "Stage All 已解决文件",
    group: "scenario",
    isVisible: VISIBLE_WHEN_MARKERS_CLEARED,
    aliases: ["stage", "git add"],
  },
  // Undo
  {
    command: "conflictResolver.undoLastAccept",
    label: "撤销最近一次采纳",
    detail: "Ctrl+Shift+U",
    group: "undo",
    isVisible: VISIBLE_WHEN_UNDO,
    aliases: ["undo", "rollback"],
  },
  {
    command: "conflictResolver.back",
    label: "返回上一个冲突",
    detail: "Alt+Left",
    group: "undo",
    isVisible: VISIBLE_WHEN_UNDO,
  },
  // Settings / utility
  {
    command: "conflictResolver.rescanCurrentFile",
    label: "重新扫描当前文件",
    group: "settings",
    isVisible: VISIBLE_ALWAYS,
  },
  {
    command: "conflictResolver.openMergeEditor",
    label: "打开 Merge Editor",
    group: "settings",
    isVisible: VISIBLE_ALWAYS,
  },
  {
    command: "conflictResolver.toggleLockFiles",
    label: "切换 lock 文件扫描",
    group: "settings",
    isVisible: VISIBLE_ALWAYS,
  },
];

const GROUP_ORDER: Record<ConflictPaletteEntry["group"], number> = {
  navigation: 0,
  panel: 1,
  accept: 2,
  scenario: 3,
  undo: 4,
  settings: 5,
};

function matchesQuery(entry: ConflictPaletteEntry, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const haystack = [
    entry.label,
    entry.command,
    entry.detail ?? "",
    ...(entry.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return fuzzyMatch(haystack, query.toLowerCase());
}

/**
 * Subsequence fuzzy match: every character of the query must appear in
 * the haystack in order, with non-matching gaps allowed. Greedy from the
 * start of the haystack so prefix-heavy queries rank better.
 */
function fuzzyMatch(haystack: string, query: string): boolean {
  let queryIndex = 0;
  for (let i = 0; i < haystack.length && queryIndex < query.length; i += 1) {
    if (haystack[i] === query[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === query.length;
}

function scoreEntry(entry: ConflictPaletteEntry, query: string): number {
  if (query.length === 0) {
    return 0;
  }
  const lower = query.toLowerCase();
  let score = 0;
  if (entry.label.toLowerCase().includes(lower)) {
    score += 100;
  }
  if (entry.command.toLowerCase().includes(lower)) {
    score += 50;
  }
  if (entry.detail?.toLowerCase().includes(lower)) {
    score += 30;
  }
  for (const alias of entry.aliases ?? []) {
    if (alias.toLowerCase().includes(lower)) {
      score += 20;
    }
  }
  if (entry.label.toLowerCase().startsWith(lower)) {
    score += 10;
  }
  return score;
}

export type PaletteFilterOptions = {
  query?: string;
  context: CommandVisibilityContext;
};

export type FilteredPaletteEntry = ConflictPaletteEntry & { score: number };

export function filterConflictCommands({
  query = "",
  context,
}: PaletteFilterOptions): FilteredPaletteEntry[] {
  const trimmed = query.trim();
  const visible = CONFLICT_PALETTE_COMMANDS.filter((entry) => entry.isVisible(context));
  const matched = visible.filter((entry) => matchesQuery(entry, trimmed));
  return matched
    .map((entry) => ({ ...entry, score: scoreEntry(entry, trimmed) }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const groupDelta = GROUP_ORDER[left.group] - GROUP_ORDER[right.group];
      if (groupDelta !== 0) {
        return groupDelta;
      }
      return left.label.localeCompare(right.label, "zh-CN");
    });
}