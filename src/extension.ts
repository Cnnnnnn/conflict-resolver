import * as vscode from "vscode";
import { readFile, stat } from "node:fs/promises";

import { ConflictDecorationManager } from "./conflictDecorations";
import { ConflictFileDecorationProvider, getConflictBadgeCount } from "./conflictFileDecorations";
import { ConflictNavigation } from "./conflictNavigation";
import { ConflictStore, type ConflictStoreDocumentLoader } from "./conflictStore";
import {
  CONFLICT_TREE_GO_TO_COMMAND,
  CONFLICT_TREE_ACCEPT_CURRENT_COMMAND,
  CONFLICT_TREE_ACCEPT_INCOMING_COMMAND,
  CONFLICT_TREE_ACCEPT_BOTH_COMMAND,
  CONFLICT_TREE_OPEN_DIFF_COMMAND,
  CONFLICT_TREE_OPEN_MERGE_EDITOR_COMMAND,
  ConflictTreeProvider,
  type ConflictTreeCommandArguments,
} from "./conflictTreeProvider";
import {
  EMPTY_CONFLICT_WORK_STATE,
  formatLocatedClearedNotification,
  shouldNotifyLocatedConflictsCleared,
  updateConflictWorkState,
} from "./conflictCompletion";
import { createConflictFilter, isLockFilePath, type ConflictFilterMode } from "./conflictFilter";
import { isGitOnlyUnresolved } from "./conflictPredicates";
import { filterConflictCommands } from "./conflictCommandPalette";
import {
  createConflictDiffPreviewer,
  fetchConflictSides,
  type ConflictDiffPreviewer,
} from "./conflictDiffPreview";
import { GitRepositoryService } from "./gitRepositoryService";
import {
  ACCEPT_CURRENT_CONFLICT_COMMAND,
  ACCEPT_INCOMING_CONFLICT_COMMAND,
  ACCEPT_BOTH_CONFLICT_COMMAND,
  applyConflictResolution,
  applyBatchConflictResolution,
  collectBatchTargets,
  formatBatchResolutionMessage,
  type ConflictResolutionSide,
} from "./conflictResolution";
import {
  applyConflictUndo,
  createConflictUndoStore,
  type ConflictUndoEntry,
  type ConflictUndoWorkspace,
} from "./conflictUndo";
import {
  buildScmEditorSlotContext,
  canonicalizeConflictUri,
  findConflictFile,
  getLocatedConflictAtSlot,
  getMergeConflictMenuContext,
  hasLocatedConflictMarkers,
  pickLocatedConflictForResource,
  resolveScmResourceUri,
  SCM_LOCATED_SLOT_COUNT,
  toConflictFileKey,
} from "./conflictScmMenu";
import { formatMergeProgressLabel, getMergeProgress } from "./mergeProgress";
import {
  detectMergeScenario,
  formatScenarioIcon,
  formatScenarioLabel,
  formatScenarioTitle,
  runScenarioContinue,
  type MergeScenario,
} from "./mergeScenario";
import type { ConflictBlock, ConflictSnapshot } from "./types";
import { ConflictStatusBar, type StatusBarState } from "./statusBar";

const GIT_STATE_WATCH_PATTERNS = [
  "**/.git/MERGE_HEAD",
  "**/.git/CHERRY_PICK_HEAD",
  "**/.git/REBASE_MERGE",
  "**/.git/index",
] as const;

const DOCUMENT_CHANGE_DEBOUNCE_MS = 16;
// Coalesce UI refreshes triggered by onDidChangeTextDocument. The store keeps
// its own snapshot fresh synchronously (applyOpenDocumentText), so delaying the
// tree/status bar/SCM context paint to this cadence does not lose information
// while preventing per-keystroke rendering churn on large files.
const DOCUMENT_UI_REFRESH_DEBOUNCE_MS = 50;

// Skip reading files larger than this from disk so a huge unmerged file cannot
// block the UI thread; its git state is still reflected via the index.
const MAX_DISK_READ_BYTES = 5 * 1024 * 1024;

// Status bar label click target. Higher-priority states (scenario in progress,
// markers cleared) win so a single click resolves the most relevant next step.
function resolveStatusBarLabelCommand(
  state: StatusBarState,
  snapshot: ConflictSnapshot,
  activeUri: string | undefined,
  activeLine: number | undefined,
  activeScenario: MergeScenario,
): string | undefined {
  const markersCleared =
    snapshot.locatedCount === 0 &&
    snapshot.files.some((file) => file.gitUnmerged);
  if (markersCleared) {
    return "conflictResolver.stageAllResolved";
  }
  if (activeScenario.inProgress && activeScenario.kind !== "none") {
    return "conflictResolver.continueScenario";
  }
  if (state.kind === "git-only") {
    return activeUri !== undefined ? "conflictResolver.rescanCurrentFile" : undefined;
  }
  if (state.kind === "located") {
    if (state.activeFileConflictCount > 0) {
      return "conflictResolver.nextConflict";
    }
    if (activeUri !== undefined && state.uri === activeUri) {
      return "conflictResolver.firstConflictInActiveFile";
    }
    return "conflictResolver.openPanel";
  }
  void activeLine;
  return undefined;
}

// Built-in `merge-conflict.accept.*` commands are provided by VS Code's built-in
// Merge Conflict support. When they are unavailable (e.g. disabled, or a Cursor
// build without them) we fall back to a text-based resolution.
let builtinMergeConflictAvailable = true;
let builtinMergeConflictBothAvailable = false;

// Module-level handles so deactivate() can cancel in-flight work on shutdown.
let activeStore: ConflictStore | undefined;

// Cache of the last setContext values so we only issue a `setContext` IPC
// round-trip when a value actually changes (was ~24 IPC calls per refresh).
const scmContextCache = new Map<string, unknown>();

function logError(error: unknown): void {
  console.error("[conflict-resolver]", error instanceof Error ? error.message : String(error));
}

function isTrackedConflictDocument(
  document: vscode.TextDocument,
  snapshot: ReturnType<ConflictStore["getSnapshot"]>,
): boolean {
  const key = toConflictFileKey(document.uri.fsPath);
  if (snapshot.files.some((file) => toConflictFileKey(file.uri) === key)) {
    return true;
  }

  return hasLocatedConflictMarkers(document.getText());
}

function createDocumentLoader(): ConflictStoreDocumentLoader {
  const collectOpenDocuments = (): Array<{ uri: string; getText: () => string }> => {
    const byKey = new Map<string, { uri: string; getText: () => string }>();
    const addDocument = (document: vscode.TextDocument): void => {
      const uri = document.uri.toString();
      byKey.set(toConflictFileKey(document.uri.fsPath), {
        uri,
        getText: () => document.getText(),
      });
    };

    for (const document of vscode.workspace.textDocuments) {
      addDocument(document);
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor !== undefined) {
      addDocument(activeEditor.document);
    }

    return [...byKey.values()];
  };

  return {
    getOpenDocuments: () => collectOpenDocuments(),
    loadDocument: async (uri) => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        return { uri: document.uri.toString(), getText: () => document.getText() };
      } catch {
        return undefined;
      }
    },
    getRepositoryRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    readDiskText: async (uri) => {
      try {
        const fileStat = await stat(vscode.Uri.parse(uri).fsPath);
        if (fileStat.size > MAX_DISK_READ_BYTES) {
          return "";
        }
        return await readFile(vscode.Uri.parse(uri).fsPath, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

function registerGitStateWatchers(
  context: vscode.ExtensionContext,
  onGitStateChange: () => void,
): void {
  for (const pattern of GIT_STATE_WATCH_PATTERNS) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(onGitStateChange);
    watcher.onDidCreate(onGitStateChange);
    watcher.onDidDelete(onGitStateChange);
    context.subscriptions.push(watcher);
  }
}

type BuiltinGitRepository = {
  state: {
    onDidChange: vscode.Event<void>;
  };
};

type BuiltinGitApi = {
  repositories: readonly BuiltinGitRepository[];
  onDidOpenRepository: vscode.Event<BuiltinGitRepository>;
};

function registerBuiltinGitRefresh(
  context: vscode.ExtensionContext,
  onRepositoryChange: () => void,
): void {
  const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): BuiltinGitApi }>(
    "vscode.git",
  );
  if (gitExtension === undefined) {
    return;
  }

  const subscribeRepository = (repository: BuiltinGitRepository): void => {
    context.subscriptions.push(repository.state.onDidChange(() => onRepositoryChange()));
  };

  const subscribeApi = (api: BuiltinGitApi): void => {
    for (const repository of api.repositories) {
      subscribeRepository(repository);
    }
    context.subscriptions.push(
      api.onDidOpenRepository((repository) => {
        subscribeRepository(repository);
        onRepositoryChange();
      }),
    );
  };

  if (gitExtension.isActive) {
    subscribeApi(gitExtension.exports.getAPI(1));
    return;
  }

  void gitExtension.activate().then(() => {
    subscribeApi(gitExtension.exports.getAPI(1));
  });
}

async function updateScmMenuContext(
  snapshot: ReturnType<ConflictStore["getSnapshot"]>,
  editorUri: string | undefined,
): Promise<void> {
  const menuContext = getMergeConflictMenuContext(snapshot);
  const entries: Array<[string, unknown]> = [
    ["conflictResolver.hasMergeConflicts", menuContext.hasMergeConflicts],
    ["conflictResolver.hasLocatedConflicts", snapshot.locatedCount > 0],
    ["conflictResolver.hasGitOnlyMergeFiles", menuContext.hasGitOnlyMergeFiles],
    ...Object.entries(buildScmEditorSlotContext(snapshot, editorUri)),
  ];

  for (const [key, value] of entries) {
    if (scmContextCache.get(key) === value) {
      continue;
    }
    scmContextCache.set(key, value);
    await vscode.commands.executeCommand("setContext", key, value);
  }
}

function registerScmConflictMenus(
  context: vscode.ExtensionContext,
  store: ConflictStore,
  navigation: ConflictNavigation,
  git: GitRepositoryService,
): void {
  for (let slot = 1; slot <= SCM_LOCATED_SLOT_COUNT; slot++) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `conflictResolver.scmGotoLocated${slot}`,
        async (resource: unknown) => {
          const uri = resolveScmResourceUri(resource);
          if (uri === undefined) {
            return;
          }

          const file = findConflictFile(store.getSnapshot(), uri);
          if (file === undefined || file.locatedConflicts.length === 0) {
            await vscode.window.showInformationMessage("当前文件没有可定位冲突");
            return;
          }

          const conflict = getLocatedConflictAtSlot(file, slot - 1);
          if (conflict === undefined) {
            await vscode.window.showInformationMessage(
              `该文件只有 ${file.locatedConflicts.length} 个可定位冲突`,
            );
            return;
          }

          await navigation.goTo(file.uri, conflict.id);
        },
      ),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "conflictResolver.scmPickConflict",
      async (resource: unknown) => {
        await pickLocatedConflictForResource(
          resource,
          store.getSnapshot(),
          navigation,
          vscode.window,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "conflictResolver.scmOpenMergeEditor",
      async (resource: unknown) => {
        const uri = resolveScmResourceUri(resource);
        if (uri === undefined) {
          return;
        }

        const file = findConflictFile(store.getSnapshot(), uri);
        if (file === undefined || !isGitOnlyUnresolved(file)) {
          await vscode.window.showInformationMessage("该文件没有需要 Merge Editor 处理的未知冲突");
          return;
        }

        await git.openMergeEditor(file.uri);
      },
    ),
  );
}

function createDecorationAdapter(
  startDecoration: vscode.TextEditorDecorationType,
  overviewDecoration: vscode.TextEditorDecorationType,
) {
  return {
    getEditors: () => vscode.window.visibleTextEditors.map((editor) => ({
      uri: editor.document.uri.toString(),
      setStartLineDecorations: (ranges: readonly { startLine: number; endLine: number }[]) => {
        editor.setDecorations(startDecoration, ranges.map((range) => new vscode.Range(range.startLine, 0, range.endLine, 0)));
      },
      setOverviewDecorations: (ranges: readonly { startLine: number; endLine: number }[]) => {
        editor.setDecorations(overviewDecoration, ranges.map((range) => new vscode.Range(range.startLine, 0, range.endLine, 0)));
      },
    })),
  };
}

function getConflictFileText(uri: string): string | undefined {
  const key = toConflictFileKey(uri);
  for (const document of vscode.workspace.textDocuments) {
    if (toConflictFileKey(document.uri.fsPath) === key) {
      return document.getText();
    }
  }

  return undefined;
}

async function revealConflictInEditor(uri: string, conflict: ConflictBlock): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.toString() !== uri) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    await vscode.window.showTextDocument(document);
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor === undefined) {
    return;
  }

  const startPosition = new vscode.Position(conflict.startLine, 0);
  // Select from <<<<<<< through the separator so Adopt Current / Incoming
  // buttons can act on the chunk immediately. Falls back to start line for diff3.
  const separatorLine =
    conflict.separatorLine > conflict.startLine ? conflict.separatorLine : conflict.startLine;
  const endPosition = new vscode.Position(separatorLine, Number.MAX_SAFE_INTEGER);
  activeEditor.selection = new vscode.Selection(startPosition, endPosition);
  await activeEditor.revealRange(
    new vscode.Range(startPosition, endPosition),
    vscode.TextEditorRevealType.InCenter,
  );
}

async function updateFilterMode(mode: ConflictFilterMode): Promise<void> {
  const config = vscode.workspace.getConfiguration("conflictResolver");
  await config.update("treeFilterMode", mode, vscode.ConfigurationTarget.Workspace);
}

/**
 * Text-based conflict resolution used when the built-in `merge-conflict.accept.*`
 * command is unavailable. Replaces the conflict region (markers included) with
 * the chosen side, preserving the document's line endings.
 */
async function resolveConflictByTextEdit(
  uri: string,
  conflict: ConflictBlock,
  side: ConflictResolutionSide,
): Promise<boolean> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    const lines = document.getText().split("\n");
    const ours = lines.slice(conflict.oursRange.startLine, conflict.oursRange.endLine + 1);
    const theirs = lines.slice(conflict.theirsRange.startLine, conflict.theirsRange.endLine + 1);
    const kept =
      side === "current" ? ours : side === "incoming" ? theirs : [...ours, ...theirs];
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const startPos = document.lineAt(conflict.startLine).range.start;
    const endLineInfo = document.lineAt(conflict.endLine);
    const endPos = new vscode.Position(conflict.endLine, endLineInfo.text.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(startPos, endPos), kept.join(eol));
    return vscode.workspace.applyEdit(edit);
  } catch {
    return false;
  }
}

async function acceptConflictAndAdvance(
  side: ConflictResolutionSide,
  args: { uri: string; conflictId: string },
  store: ConflictStore,
  navigation: ConflictNavigation,
  undoStore: ReturnType<typeof createConflictUndoStore>,
  syncUndoContext: () => void,
): Promise<void> {
  const undoEntries = await snapshotForUndo([{ uri: args.uri, conflictId: args.conflictId }]);
  const ok = await applyConflictResolution(
    store.getSnapshot(),
    {
      revealConflict: revealConflictInEditor,
      runCommand: async (command) => {
        await vscode.commands.executeCommand(command);
      },
      resolveByText: resolveConflictByTextEdit,
      preferBuiltinCommand: builtinMergeConflictAvailable,
      builtinBothAvailable: builtinMergeConflictBothAvailable,
    },
    args.uri,
    args.conflictId,
    side,
  );
  if (!ok) {
    await vscode.window.showWarningMessage("未找到可处理的冲突");
    return;
  }
  undoStore.record(undoEntries);
  syncUndoContext();
  await store.waitForChange();
  await navigation.goToAfter(args.uri, 0);
}

async function snapshotForUndo(
  targets: readonly { uri: string; conflictId: string }[],
): Promise<ConflictUndoEntry[]> {
  const byPath = new Map<string, { uri: string; label: string }>();
  for (const target of targets) {
    const label = target.uri.split("/").pop() ?? target.uri;
    byPath.set(target.uri, { uri: target.uri, label });
  }

  const entries: ConflictUndoEntry[] = [];
  for (const { uri, label } of byPath.values()) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      entries.push({
        uri,
        fsPath: document.uri.fsPath,
        contents: document.getText(),
        label,
      });
    } catch {
      // skip: file might be removed; undo can ignore it
    }
  }
  return entries;
}

async function runTreeSearch(
  store: ConflictStore,
  navigation: ConflictNavigation,
  git: GitRepositoryService,
): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: "搜索冲突（按文件路径或行号）",
    placeHolder: "输入关键字、文件名或行号",
  });
  if (query === undefined) {
    return;
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return;
  }

  const snapshot = store.getSnapshot();
  const lower = trimmed.toLowerCase();
  const candidates = snapshot.files.filter((file) =>
    file.relativePath.toLowerCase().includes(lower) ||
    file.locatedConflicts.some((conflict) => `${conflict.startLine + 1}`.includes(lower)),
  );
  if (candidates.length === 0) {
    await vscode.window.showInformationMessage(`没有找到匹配 "${trimmed}" 的冲突文件`);
    return;
  }

  type CandidateFile = typeof candidates[number];
  const gotoFirst = async (file: CandidateFile): Promise<void> => {
    const conflict = file.locatedConflicts[0];
    if (conflict !== undefined) {
      await navigation.goTo(file.uri, conflict.id);
    } else {
      await git.openMergeEditor(file.uri);
    }
  };

  if (candidates.length === 1) {
    await gotoFirst(candidates[0]);
    return;
  }

  type CandidatePick = { label: string; description: string; file: CandidateFile };
  const picks: CandidatePick[] = candidates.map((file) => ({
    label: file.relativePath,
    description: `${file.locatedConflicts.length} 个可定位冲突`,
    file,
  }));
  const chosen = await vscode.window.showQuickPick<CandidatePick>(picks, {
    placeHolder: "选择要定位的文件",
  });
  if (chosen === undefined) {
    return;
  }
  await gotoFirst(chosen.file);
}

async function runConflictCommandPalette(
  store: ConflictStore,
  undoStore: ReturnType<typeof createConflictUndoStore>,
  activeScenario: MergeScenario,
): Promise<void> {
  const snapshot = store.getSnapshot();
  const markersCleared =
    snapshot.locatedCount === 0 &&
    snapshot.files.some((file) => file.gitUnmerged);
  const baseItems = filterConflictCommands({
    context: {
      snapshot,
      hasUndo: undoStore.size() > 0,
      scenarioInProgress: activeScenario.inProgress,
      markersCleared,
    },
  });

  if (baseItems.length === 0) {
    await vscode.window.showInformationMessage("当前状态下没有可用的冲突命令");
    return;
  }

  const items: vscode.QuickPickItem[] = baseItems.map((entry) => ({
    label: entry.label,
    description: entry.detail,
  }));
  const itemToCommand = new Map<vscode.QuickPickItem, string>();
  baseItems.forEach((entry, index) => {
    const item = items[index];
    if (item !== undefined) {
      itemToCommand.set(item, entry.command);
    }
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Conflict Resolver 命令",
    placeHolder: "输入关键字筛选 (支持中文/拼音子序列)",
    matchOnDescription: true,
  });
  if (picked === undefined) {
    return;
  }
  const commandId = itemToCommand.get(picked);
  if (commandId !== undefined) {
    await vscode.commands.executeCommand(commandId);
  }
}

async function runBatchResolution(
  args: unknown,
  side: ConflictResolutionSide,
  store: ConflictStore,
  tree: ConflictTreeProvider,
  undoStore: ReturnType<typeof createConflictUndoStore>,
  navigation: ConflictNavigation,
  syncUndoContext: () => void,
): Promise<void> {
  const snapshot = store.getSnapshot();
  const selection = tree.getSelection();

  let targets: { uri: string; conflictId: string }[] = [];
  let fileScope: string | undefined;

  if (
    args !== undefined &&
    typeof args === "object" &&
    args !== null &&
    "uri" in args
  ) {
    const candidate = args as { uri: unknown; conflictId?: unknown };
    if (typeof candidate.uri === "string") {
      if (typeof candidate.conflictId === "string") {
        targets = [{ uri: candidate.uri, conflictId: candidate.conflictId }];
      } else {
        fileScope = candidate.uri;
      }
    }
  }

  if (targets.length === 0 && fileScope !== undefined) {
    targets = collectBatchTargets(snapshot, { kind: "file", fileUri: fileScope });
    if (targets.length === 0) {
      await vscode.window.showInformationMessage("该文件没有可处理的冲突");
      return;
    }
  }

  if (targets.length === 0 && selection.size > 0) {
    for (const key of selection) {
      const [uri, conflictId] = key.split("::");
      if (uri !== undefined && conflictId !== undefined) {
        targets.push({ uri, conflictId });
      }
    }
  }

  if (targets.length === 0) {
    targets = collectBatchTargets(snapshot, { kind: "all" });
    if (targets.length === 0) {
      await vscode.window.showInformationMessage("当前没有可处理的冲突");
      return;
    }
  }

  const undoEntries = await snapshotForUndo(targets);

  const summary = await applyBatchConflictResolution(
    snapshot,
    {
      revealConflict: revealConflictInEditor,
      runCommand: async (command: string) => {
        await vscode.commands.executeCommand(command);
      },
      resolveByText: resolveConflictByTextEdit,
      preferBuiltinCommand: builtinMergeConflictAvailable,
      builtinBothAvailable: builtinMergeConflictBothAvailable,
    },
    targets,
    side,
  );

  if (summary.resolved > 0) {
    undoStore.record(undoEntries);
    syncUndoContext();
  }

  if (selection.size > 0) {
    tree.clearSelection();
  }

  if (summary.resolved > 0) {
    const anchor = targets[targets.length - 1];
    if (anchor !== undefined) {
      await store.waitForChange();
      await navigation.goToAfter(anchor.uri, Number.MAX_SAFE_INTEGER);
    }
  }

  await vscode.window.showInformationMessage(formatBatchResolutionMessage(side, summary));
}

type ConflictResolverDeps = {
  store: ConflictStore;
  navigation: ConflictNavigation;
  git: GitRepositoryService;
  tree: ConflictTreeProvider;
  undoStore: ReturnType<typeof createConflictUndoStore>;
  syncUndoContext: () => void;
  getConflictFileText: (uri: string) => string | undefined;
  refreshConflictUi: (snapshot: ReturnType<ConflictStore["getSnapshot"]>) => Promise<void>;
  treeView: vscode.TreeView<unknown>;
  startDecoration: vscode.TextEditorDecorationType;
  overviewDecoration: vscode.TextEditorDecorationType;
  statusBar: ConflictStatusBar;
  fileDecorations: ConflictFileDecorationProvider;
  fileDecorationChangeEmitter: vscode.EventEmitter<vscode.Uri[] | undefined>;
  conflictUndoWorkspace: ConflictUndoWorkspace;
  diffPreviewer: ConflictDiffPreviewer;
};

function registerConflictSubscriptions(
  context: vscode.ExtensionContext,
  deps: ConflictResolverDeps,
): void {
  const {
    store,
    navigation,
    git,
    tree,
    undoStore,
    syncUndoContext,
    treeView,
    startDecoration,
    overviewDecoration,
    statusBar,
    fileDecorations,
    fileDecorationChangeEmitter,
    conflictUndoWorkspace,
    diffPreviewer,
  } = deps;

  context.subscriptions.push(
    tree,
    treeView,
    startDecoration,
    overviewDecoration,
    navigation,
    statusBar,
    fileDecorations,
    fileDecorationChangeEmitter,
    fileDecorations.onDidChange(() => fileDecorationChangeEmitter.fire(undefined)),
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        store.scheduleRefresh("panel-visible");
      }
    }),
    vscode.commands.registerCommand(CONFLICT_TREE_GO_TO_COMMAND, (args: ConflictTreeCommandArguments) => navigation.goTo(args.uri, args.conflictId)),
    vscode.commands.registerCommand(
      CONFLICT_TREE_ACCEPT_CURRENT_COMMAND,
      (args: ConflictTreeCommandArguments) =>
        acceptConflictAndAdvance("current", args, store, navigation, undoStore, syncUndoContext),
    ),
    vscode.commands.registerCommand(
      CONFLICT_TREE_ACCEPT_INCOMING_COMMAND,
      (args: ConflictTreeCommandArguments) =>
        acceptConflictAndAdvance("incoming", args, store, navigation, undoStore, syncUndoContext),
    ),
    vscode.commands.registerCommand(
      CONFLICT_TREE_ACCEPT_BOTH_COMMAND,
      (args: ConflictTreeCommandArguments) =>
        acceptConflictAndAdvance("both", args, store, navigation, undoStore, syncUndoContext),
    ),
    vscode.commands.registerCommand(
      CONFLICT_TREE_OPEN_DIFF_COMMAND,
      async (args: ConflictTreeCommandArguments) => {
        const snapshot = store.getSnapshot();
        const file = snapshot.files.find((candidate) => candidate.uri === args.uri);
        const conflict = file?.locatedConflicts.find(
          (candidate) => candidate.id === args.conflictId,
        );
        if (file === undefined || conflict === undefined) {
          await vscode.window.showWarningMessage("未找到可对比的冲突");
          return;
        }
        const sides = await fetchConflictSides(args.uri, conflict);
        if (sides === undefined) {
          await vscode.window.showWarningMessage("无法读取冲突文件内容");
          return;
        }
        await diffPreviewer.openDiff(args.uri, conflict, sides, file.relativePath);
      },
    ),
    vscode.commands.registerCommand("conflictResolver.undoLastAccept", async () => {
      const batch = undoStore.take();
      syncUndoContext();
      if (batch === undefined || batch.entries.length === 0) {
        await vscode.window.showInformationMessage("没有可撤销的采纳操作");
        return;
      }
      const result = await applyConflictUndo(batch.entries, conflictUndoWorkspace);
      await store.waitForChange();
      if (result.failed === 0) {
        await vscode.window.showInformationMessage(`已撤销：${batch.label}`);
      } else {
        await vscode.window.showWarningMessage(
          `已撤销 ${result.restored} 个文件，${result.failed} 个失败`,
        );
      }
    }),
    vscode.commands.registerCommand("conflictResolver.back", () => navigation.back()),
    vscode.commands.registerCommand(
      CONFLICT_TREE_OPEN_MERGE_EDITOR_COMMAND,
      async (args: { uri: string }) => git.openMergeEditor(args.uri),
    ),
    vscode.commands.registerCommand("conflictResolver.nextConflict", () => navigation.next()),
    vscode.commands.registerCommand("conflictResolver.previousConflict", () => navigation.previous()),
    vscode.commands.registerCommand("conflictResolver.nextConflictInFile", () => navigation.nextInFile()),
    vscode.commands.registerCommand("conflictResolver.previousConflictInFile", () => navigation.previousInFile()),
    vscode.commands.registerCommand("conflictResolver.nextFile", () => navigation.nextFile()),
    vscode.commands.registerCommand("conflictResolver.previousFile", () => navigation.previousFile()),
    vscode.commands.registerCommand("conflictResolver.firstConflictInActiveFile", () => {
      const uri = vscode.window.activeTextEditor?.document.uri.toString();
      return uri === undefined ? undefined : navigation.jumpToFirstInFile(uri);
    }),
    vscode.commands.registerCommand("conflictResolver.openPanel", () => vscode.commands.executeCommand("workbench.view.extension.conflictResolver")),
    vscode.commands.registerCommand("conflictResolver.rescanCurrentFile", () => store.refresh()),
    vscode.commands.registerCommand("conflictResolver.openMergeEditor", () => {
      const uri = vscode.window.activeTextEditor?.document.uri.toString();
      return uri === undefined ? undefined : git.openMergeEditor(uri);
    }),
    vscode.commands.registerCommand("conflictResolver.toggleLockFiles", async () => {
      const config = vscode.workspace.getConfiguration("conflictResolver");
      const current = config.get<boolean>("includeLockFiles", false);
      const next = !current;
      await config.update("includeLockFiles", next, vscode.ConfigurationTarget.Workspace);
      await vscode.window.showInformationMessage(
        next ? "已启用 lock 文件扫描" : "已跳过 lock 文件扫描",
      );
    }),
    vscode.commands.registerCommand("conflictResolver.batchAcceptCurrent", async (args?: unknown) =>
      runBatchResolution(args, "current", store, tree, undoStore, navigation, syncUndoContext),
    ),
    vscode.commands.registerCommand("conflictResolver.batchAcceptIncoming", async (args?: unknown) =>
      runBatchResolution(args, "incoming", store, tree, undoStore, navigation, syncUndoContext),
    ),
    vscode.commands.registerCommand("conflictResolver.batchAcceptBoth", async (args?: unknown) =>
      runBatchResolution(args, "both", store, tree, undoStore, navigation, syncUndoContext),
    ),
    vscode.commands.registerCommand("conflictResolver.treeSelectAll", () => {
      tree.selectAll();
    }),
    vscode.commands.registerCommand("conflictResolver.treeClearSelection", () => {
      tree.clearSelection();
    }),
    vscode.commands.registerCommand(
      "conflictResolver.treeSelectFile",
      (args: { uri: string }) => {
        tree.selectFile(args.uri);
      },
    ),
    vscode.commands.registerCommand("conflictResolver.treeFilterAll", async () => {
      await updateFilterMode("all");
    }),
    vscode.commands.registerCommand("conflictResolver.treeFilterSource", async () => {
      await updateFilterMode("source");
    }),
    vscode.commands.registerCommand("conflictResolver.treeFilterLock", async () => {
      await updateFilterMode("lock");
    }),
    vscode.commands.registerCommand("conflictResolver.treeSearch", async () => {
      await runTreeSearch(store, navigation, git);
    }),
    vscode.workspace.onDidOpenTextDocument(() => store.scheduleRefresh("document-open")),
    vscode.workspace.onDidCloseTextDocument(() => store.scheduleRefresh("document-close")),
    // Coalesce per-keystroke UI refreshes. The store snapshot stays fresh
    // synchronously (applyOpenDocumentText); only the tree / status bar / SCM
    // context paint is debounced to avoid redrawing on every keystroke.
    (() => {
      let uiRefreshTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleUiRefresh = (): void => {
        if (uiRefreshTimer !== undefined) {
          clearTimeout(uiRefreshTimer);
        }
        uiRefreshTimer = setTimeout(() => {
          uiRefreshTimer = undefined;
          void deps.refreshConflictUi(store.getSnapshot()).catch(logError);
        }, DOCUMENT_UI_REFRESH_DEBOUNCE_MS);
      };
      return vscode.workspace.onDidChangeTextDocument((event) => {
        const changed = store.applyOpenDocumentText(
          event.document.uri.toString(),
          event.document.getText(),
        );
        if (
          changed ||
          hasLocatedConflictMarkers(event.document.getText()) ||
          isTrackedConflictDocument(event.document, store.getSnapshot())
        ) {
          scheduleUiRefresh();
        }

        if (isTrackedConflictDocument(event.document, store.getSnapshot())) {
          store.scheduleRefresh("document-change", { debounceMs: DOCUMENT_CHANGE_DEBOUNCE_MS });
        }
      });
    })(),
    vscode.workspace.onDidSaveTextDocument(() => store.scheduleImmediateRefresh("document-save")),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      tree.setActiveFileUri(editor?.document.uri.toString());
      store.scheduleRefresh("active-editor");
      void updateScmMenuContext(
        store.getSnapshot(),
        editor?.document.uri.toString(),
      ).catch(logError);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      store.scheduleRefresh("workspace-folders");
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("conflictResolver.includeLockFiles")) {
        const config = vscode.workspace.getConfiguration("conflictResolver");
        const include = config.get<boolean>("includeLockFiles", false);
        const mode = config.get<ConflictFilterMode>("treeFilterMode", "all");
        store.updateFilter(createConflictFilter({ includeLockFiles: include, mode }));
        store.scheduleImmediateRefresh("lock-files-toggle");
      }
      if (event.affectsConfiguration("conflictResolver.treeFilterMode")) {
        const config = vscode.workspace.getConfiguration("conflictResolver");
        const include = config.get<boolean>("includeLockFiles", false);
        const mode = config.get<ConflictFilterMode>("treeFilterMode", "all");
        tree.setFilterMode(mode);
        store.updateFilter(createConflictFilter({ includeLockFiles: include, mode }));
        store.scheduleImmediateRefresh("filter-mode-toggle");
      }
    }),
    tree.onDidChangeTreeData(() => {
      void vscode.commands.executeCommand(
        "setContext",
        "conflictResolver.hasSelection",
        tree.getSelection().size > 0,
      );
    }),
    store.onDidChange((snapshot) => {
      void deps.refreshConflictUi(snapshot).catch(logError);
    }),
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const git = new GitRepositoryService({
    runMergeEditorCommand: async (uri) => {
      await vscode.commands.executeCommand("git.openMergeEditor", vscode.Uri.parse(uri));
    },
  });

  const store = new ConflictStore({
    documents: createDocumentLoader(),
    git,
  });

  const tree = new ConflictTreeProvider(
    store,
    (uri) => vscode.Uri.parse(uri),
    {
      getFileText: getConflictFileText,
      createThemeIcon: (id) => new vscode.ThemeIcon(id),
    },
  );

  // Detect built-in Merge Conflict support; if missing, warn and rely on the
  // text-based fallback for accept operations.
  void Promise.resolve(vscode.commands.getCommands(true)).then((commands) => {
    builtinMergeConflictAvailable =
      commands.includes(ACCEPT_CURRENT_CONFLICT_COMMAND) &&
      commands.includes(ACCEPT_INCOMING_CONFLICT_COMMAND);
    builtinMergeConflictBothAvailable = commands.includes(ACCEPT_BOTH_CONFLICT_COMMAND);
    if (!builtinMergeConflictAvailable) {
      void vscode.window.showWarningMessage(
        "内置 Merge Conflict 支持未启用，已回退到文本采纳实现。如需最佳体验，请在扩展面板启用 built-in 'Merge Conflict'。",
      );
    }
  }).catch(() => {
    // If we cannot enumerate commands, assume the built-in is present.
  });

  const initialFilterMode = vscode.workspace
    .getConfiguration("conflictResolver")
    .get<ConflictFilterMode>("treeFilterMode", "all");
  tree.setFilterMode(initialFilterMode);
  const treeView = vscode.window.createTreeView("conflictResolver.tree", { treeDataProvider: tree });
  let conflictWorkState = EMPTY_CONFLICT_WORK_STATE;
  let locatedClearedNotified = false;
  let previousSnapshot = store.getSnapshot();
  let activeScenario: MergeScenario = { kind: "none", inProgress: false };
  vscode.commands.registerCommand("conflictResolver.quickPick", () => runConflictCommandPalette(store, undoStore, activeScenario));
  const startDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
  });
  const overviewDecoration = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
  });
  const decorations = new ConflictDecorationManager(createDecorationAdapter(startDecoration, overviewDecoration));
  const fileDecorations = new ConflictFileDecorationProvider();
  const fileDecorationChangeEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  const navigation = new ConflictNavigation(store, {
    getActiveLocation: () => {
      const editor = vscode.window.activeTextEditor;
      return editor === undefined ? undefined : { uri: editor.document.uri.toString(), line: editor.selection.active.line };
    },
    revealConflict: async (uri, conflict) => revealConflictInEditor(uri, conflict),
    openMergeEditor: (uri) => git.openMergeEditor(uri),
    showMergeEditorFallback: async (uri, error) => {
      await vscode.window.showWarningMessage(`无法打开 Merge Editor：${uri}。${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const undoStore = createConflictUndoStore();
  const syncUndoContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "conflictResolver.hasUndo",
      undoStore.size() > 0,
    );
  };
  const statusBar = new ConflictStatusBar({
    store,
    statusBar: {
      createStatusBarItem: (priority = 100) => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
        return {
          get text() {
            return item.text;
          },
          set text(value: string) {
            item.text = value;
          },
          get tooltip() {
            return typeof item.tooltip === "string" ? item.tooltip : undefined;
          },
          set tooltip(value: string | undefined) {
            item.tooltip = value;
          },
          get command() {
            return typeof item.command === "string" ? item.command : undefined;
          },
          set command(value: string | undefined) {
            item.command = value;
          },
          show: () => item.show(),
          hide: () => item.hide(),
          dispose: () => item.dispose(),
        };
      },
    },
    activeFile: {
      getActiveUri: () => vscode.window.activeTextEditor?.document.uri.toString(),
      getActiveLine: () => vscode.window.activeTextEditor?.selection.active.line,
      onDidChangeActiveUri: (listener) => vscode.window.onDidChangeActiveTextEditor((editor) => listener(editor?.document.uri.toString())),
    },
    resolveCommand: ({ state, snapshot, activeUri, activeLine }) =>
      resolveStatusBarLabelCommand(state, snapshot, activeUri, activeLine, activeScenario),
  });

  const conflictUndoWorkspace: ConflictUndoWorkspace = {
    parseUri: (uri) => vscode.Uri.parse(uri),
    openTextDocument: (uri) => Promise.resolve(vscode.workspace.openTextDocument(uri)),
    applyEdit: (edit) => Promise.resolve(vscode.workspace.applyEdit(edit)),
    createWorkspaceEdit: () => new vscode.WorkspaceEdit(),
    createRange: (start, end) => new vscode.Range(start, end),
  };

  const diffPreviewer: ConflictDiffPreviewer = createConflictDiffPreviewer();

  const updateConflictBadges = (snapshot: ReturnType<typeof store.getSnapshot>): void => {
    const count = getConflictBadgeCount(snapshot);
    treeView.badge =
      count > 0
        ? { value: count, tooltip: `${count} 个冲突文件` }
        : undefined;
    const completionMessage = tree.getCompletionMessage();
    treeView.message =
      completionMessage ??
      (() => {
        const label = formatMergeProgressLabel(getMergeProgress(snapshot, activeScenario));
        return label === "无待处理冲突" ? undefined : label;
      })();
    void vscode.commands.executeCommand(
      "setContext",
      "conflictResolver.scenarioInProgress",
      activeScenario.inProgress,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "conflictResolver.scenarioKind",
      activeScenario.kind,
    );
    const markersCleared = snapshot.locatedCount === 0 && snapshot.files.some((file) => file.gitUnmerged);
    void vscode.commands.executeCommand(
      "setContext",
      "conflictResolver.markersCleared",
      markersCleared,
    );
    statusBar.refreshCommand();
  };

  const handleSnapshotTransition = (snapshot: ReturnType<typeof store.getSnapshot>): void => {
    if (
      shouldNotifyLocatedConflictsCleared(previousSnapshot, snapshot) &&
      !locatedClearedNotified
    ) {
      locatedClearedNotified = true;
      const scenarioTitle = formatScenarioTitle(activeScenario);
      const message =
        scenarioTitle !== undefined
          ? `${formatLocatedClearedNotification(snapshot)}（${scenarioTitle} 可继续）`
          : formatLocatedClearedNotification(snapshot);
      void vscode.window.showInformationMessage(message);
    }

    if (snapshot.locatedCount > 0) {
      locatedClearedNotified = false;
    }

    conflictWorkState = updateConflictWorkState(conflictWorkState, snapshot);
    tree.setWorkState(conflictWorkState);
    previousSnapshot = snapshot;
  };

  const refreshScenario = async (): Promise<void> => {
    const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const scenario: MergeScenario = repoRoot === undefined
      ? { kind: "none", inProgress: false }
      : await detectMergeScenario(repoRoot);
    activeScenario = scenario;
  };

  const ensureScenarioUpToDate = async (snapshot: ReturnType<typeof store.getSnapshot>): Promise<void> => {
    await refreshScenario();
    statusBar.setScenarioIcon(formatScenarioIcon(activeScenario));
    if (
      activeScenario.inProgress &&
      formatScenarioLabel(activeScenario) !== undefined
    ) {
      void scenarioWatchEmitter.fire(snapshot);
    }
  };

  const scenarioWatchEmitter = new vscode.EventEmitter<
    ReturnType<typeof store.getSnapshot>
  >();

  registerGitStateWatchers(context, () => store.scheduleImmediateRefresh("git-state"));
  registerBuiltinGitRefresh(context, () => store.scheduleImmediateRefresh("git-repository-state"));
  registerScmConflictMenus(context, store, navigation, git);

  context.subscriptions.push(
    vscode.commands.registerCommand("conflictResolver.continueScenario", async () => {
      await refreshScenario();
      const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const silent = vscode.workspace
        .getConfiguration("conflictResolver")
        .get<boolean>("silentScenarioContinue", false);
      const result = await runScenarioContinue(activeScenario, repoRoot, { silent });
      if (!result.ok) {
        await vscode.window.showWarningMessage(result.message);
        return;
      }
      if (silent) {
        await vscode.window.showInformationMessage(result.message);
      }
      store.scheduleImmediateRefresh("scenario-continue");
    }),
    vscode.commands.registerCommand("conflictResolver.stageAllResolved", async () => {
      const snapshot = store.getSnapshot();
      const targets = snapshot.files.filter((file) => file.gitUnmerged);
      if (targets.length === 0) {
        await vscode.window.showInformationMessage("没有可暂存的已解决冲突文件");
        return;
      }
      let staged = 0;
      let failed = 0;
      for (const file of targets) {
        try {
          await vscode.commands.executeCommand("git.add", vscode.Uri.parse(file.uri));
          staged += 1;
        } catch (error) {
          logError(error);
          failed += 1;
        }
      }
      store.scheduleImmediateRefresh("stage-all-resolved");
      if (failed === 0) {
        await vscode.window.showInformationMessage(`已暂存 ${staged} 个已解决冲突文件`);
      } else {
        await vscode.window.showWarningMessage(
          `已暂存 ${staged} 个文件，${failed} 个失败`,
        );
      }
    }),
  );

  void refreshScenario().catch(logError);

  const refreshConflictUi = async (snapshot: ReturnType<typeof store.getSnapshot>): Promise<void> => {
    handleSnapshotTransition(snapshot);
    decorations.update(snapshot);
    fileDecorations.update(snapshot);
    updateConflictBadges(snapshot);
    await updateScmMenuContext(
      snapshot,
      vscode.window.activeTextEditor?.document.uri.toString(),
    );
    await ensureScenarioUpToDate(snapshot);
    // NOTE: intentionally NOT calling `git refresh` here. It forced the built-in
    // Git extension to re-scan the whole repository on every snapshot change,
    // and could form a feedback loop with the changes we observe. The extension
    // maintains its own snapshot; git status refreshes on its own.
  };

  registerConflictSubscriptions(context, {
    store,
    navigation,
    git,
    tree,
    undoStore,
    syncUndoContext,
    getConflictFileText,
    refreshConflictUi,
    treeView,
    startDecoration,
    overviewDecoration,
    statusBar,
    fileDecorations,
    fileDecorationChangeEmitter,
    conflictUndoWorkspace,
    diffPreviewer,
  });
  syncUndoContext();

  // Keep module-level handles so deactivate() can cancel in-flight work.
  activeStore = store;

  void store.refresh().then((snapshot) => refreshConflictUi(snapshot)).catch(logError);

  tree.setActiveFileUri(vscode.window.activeTextEditor?.document.uri.toString());
}

export function deactivate(): void {
  activeStore?.dispose();
}
