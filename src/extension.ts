import * as vscode from "vscode";
import { readFile } from "node:fs/promises";

import { ConflictDecorationManager } from "./conflictDecorations";
import { ConflictFileDecorationProvider, getConflictBadgeCount } from "./conflictFileDecorations";
import { ConflictNavigation } from "./conflictNavigation";
import { ConflictStore } from "./conflictStore";
import type { ConflictStoreDocumentLoader } from "./conflictStore";
import {
  CONFLICT_TREE_FETCH_MR_TARGET_COMMAND,
  CONFLICT_TREE_GO_TO_COMMAND,
  CONFLICT_TREE_ACCEPT_CURRENT_COMMAND,
  CONFLICT_TREE_ACCEPT_INCOMING_COMMAND,
  CONFLICT_TREE_OPEN_MERGE_EDITOR_COMMAND,
  CONFLICT_TREE_OPEN_MR_COMMAND,
  CONFLICT_TREE_OPEN_MR_CONFLICTS_COMMAND,
  CONFLICT_TREE_PREVIEW_MR_MERGE_COMMAND,
  ConflictTreeProvider,
  type ConflictTreeCommandArguments,
  type ConflictTreeMrActionArguments,
  type ConflictTreeOpenMrArguments,
} from "./conflictTreeProvider";
import {
  EMPTY_CONFLICT_WORK_STATE,
  formatLocatedClearedNotification,
  shouldNotifyLocatedConflictsCleared,
  updateConflictWorkState,
} from "./conflictCompletion";
import { createConflictFilter, isLockFilePath, type ConflictFilterMode } from "./conflictFilter";
import { GitRepositoryService } from "./gitRepositoryService";
import {
  applyConflictResolution,
  applyBatchConflictResolution,
  collectBatchTargets,
  formatBatchResolutionMessage,
  type ConflictResolutionSide,
} from "./conflictResolution";
import { applyConflictUndo, createConflictUndoStore, type ConflictUndoEntry } from "./conflictUndo";
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
import { MergeRequestConflictService } from "./mergeRequestConflictService";
import {
  buildMrConflictsUrl,
  fetchMrTargetBranch,
  formatMergePreviewMessage,
  previewMrMerge,
} from "./mergeRequestActions";
import { formatMergeProgressLabel, getMergeProgress } from "./mergeProgress";
import type { ConflictBlock } from "./types";
import { ConflictStatusBar } from "./statusBar";

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
        return await readFile(vscode.Uri.parse(uri).fsPath, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

const GIT_STATE_WATCH_PATTERNS = [
  "**/.git/MERGE_HEAD",
  "**/.git/CHERRY_PICK_HEAD",
  "**/.git/REBASE_MERGE",
  "**/.git/index",
] as const;

const DOCUMENT_CHANGE_DEBOUNCE_MS = 16;

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
  await vscode.commands.executeCommand(
    "setContext",
    "conflictResolver.hasMergeConflicts",
    menuContext.hasMergeConflicts,
  );
  await vscode.commands.executeCommand(
    "setContext",
    "conflictResolver.hasLocatedConflicts",
    snapshot.locatedCount > 0,
  );
  await vscode.commands.executeCommand(
    "setContext",
    "conflictResolver.hasGitOnlyMergeFiles",
    menuContext.hasGitOnlyMergeFiles,
  );

  const editorContext = buildScmEditorSlotContext(snapshot, editorUri);
  for (const [key, value] of Object.entries(editorContext)) {
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
        if (file === undefined || !file.gitUnmerged || file.locatedConflicts.length > 0) {
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

function getPrimaryRepositoryRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function createMergeRequestConfig(): {
  getGitlabUrl(): string;
  getGitlabToken(): string;
  getEnvToken(): string | undefined;
} {
  return {
    getGitlabUrl: () =>
      vscode.workspace.getConfiguration("conflictResolver").get<string>("gitlabUrl") ??
      "https://gitlab.com",
    getGitlabToken: () =>
      vscode.workspace.getConfiguration("conflictResolver").get<string>("gitlabToken") ?? "",
    getEnvToken: () => process.env.GITLAB_TOKEN,
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
  // ponytail: select from <<<<<<< through the separator so Adopt Current / Incoming
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

  if (
    args !== undefined &&
    typeof args === "object" &&
    args !== null &&
    "uri" in args &&
    "conflictId" in args
  ) {
    const candidate = args as { uri: unknown; conflictId: unknown };
    if (typeof candidate.uri === "string" && typeof candidate.conflictId === "string") {
      targets = [{ uri: candidate.uri, conflictId: candidate.conflictId }];
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

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitRepositoryService({
    runMergeEditorCommand: async (uri) => {
      await vscode.commands.executeCommand("git.openMergeEditor", vscode.Uri.parse(uri));
    },
  });
  const store = new ConflictStore({
    documents: createDocumentLoader(),
    git,
    includeLockFiles: vscode.workspace
      .getConfiguration("conflictResolver")
      .get<boolean>("includeLockFiles", false),
    filter: createConflictFilter({
      includeLockFiles: vscode.workspace
        .getConfiguration("conflictResolver")
        .get<boolean>("includeLockFiles", false),
      mode: vscode.workspace
        .getConfiguration("conflictResolver")
        .get<ConflictFilterMode>("treeFilterMode", "all"),
    }),
  });
  const remoteMr = new MergeRequestConflictService({ config: createMergeRequestConfig() });
  const tree = new ConflictTreeProvider(
    store,
    remoteMr,
    (uri) => vscode.Uri.parse(uri),
    {
      getFileText: getConflictFileText,
      createThemeIcon: (id) => new vscode.ThemeIcon(id),
    },
  );
  const initialFilterMode = vscode.workspace
    .getConfiguration("conflictResolver")
    .get<ConflictFilterMode>("treeFilterMode", "all");
  tree.setFilterMode(initialFilterMode);
  const treeView = vscode.window.createTreeView("conflictResolver.tree", { treeDataProvider: tree });
  let conflictWorkState = EMPTY_CONFLICT_WORK_STATE;
  let locatedClearedNotified = false;
  let previousSnapshot = store.getSnapshot();
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
  });

  const runMrAction = async (
    args: ConflictTreeMrActionArguments,
    action: (repositoryRoot: string) => Promise<string>,
  ): Promise<void> => {
    const repositoryRoot = getPrimaryRepositoryRoot();
    if (repositoryRoot === undefined) {
      await vscode.window.showWarningMessage("未找到 Git 仓库");
      return;
    }

    const message = await action(repositoryRoot);
    await vscode.window.showInformationMessage(message);
  };

  const refreshRemoteMr = async (force = false): Promise<void> => {
    const repositoryRoot = getPrimaryRepositoryRoot();
    if (repositoryRoot === undefined) {
      return;
    }
    await remoteMr.refresh(repositoryRoot, force);
  };

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
        const label = formatMergeProgressLabel(getMergeProgress(snapshot));
        return label === "无待处理冲突" ? undefined : label;
      })();
  };

  const handleSnapshotTransition = (snapshot: ReturnType<typeof store.getSnapshot>): void => {
    if (
      shouldNotifyLocatedConflictsCleared(previousSnapshot, snapshot) &&
      !locatedClearedNotified
    ) {
      locatedClearedNotified = true;
      void vscode.window.showInformationMessage(
        formatLocatedClearedNotification(snapshot),
      );
    }

    if (snapshot.locatedCount > 0) {
      locatedClearedNotified = false;
    }

    conflictWorkState = updateConflictWorkState(conflictWorkState, snapshot);
    tree.setWorkState(conflictWorkState);
    previousSnapshot = snapshot;
  };

  registerGitStateWatchers(context, () => store.scheduleImmediateRefresh("git-state"));
  registerBuiltinGitRefresh(context, () => store.scheduleImmediateRefresh("git-repository-state"));
  registerScmConflictMenus(context, store, navigation, git);

  const refreshConflictUi = async (snapshot: ReturnType<typeof store.getSnapshot>): Promise<void> => {
    handleSnapshotTransition(snapshot);
    decorations.update(snapshot);
    fileDecorations.update(snapshot);
    updateConflictBadges(snapshot);
    await updateScmMenuContext(
      snapshot,
      vscode.window.activeTextEditor?.document.uri.toString(),
    );
    await vscode.commands.executeCommand("git.refresh");
  };

  context.subscriptions.push(
    tree,
    treeView,
    remoteMr,
    startDecoration,
    overviewDecoration,
    navigation,
    statusBar,
    fileDecorations,
    fileDecorationChangeEmitter,
    fileDecorations.onDidChange(() => fileDecorationChangeEmitter.fire(undefined)),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: fileDecorationChangeEmitter.event,
      provideFileDecoration(uri) {
        const decoration = fileDecorations.provideFileDecoration(uri.toString());
        if (decoration === undefined) {
          return undefined;
        }

        return {
          badge: decoration.badge,
          tooltip: decoration.tooltip,
          color: new vscode.ThemeColor(decoration.colorId),
        };
      },
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
    vscode.commands.registerCommand("conflictResolver.undoLastAccept", async () => {
      const entries = undoStore.take();
      syncUndoContext();
      if (entries.length === 0) {
        await vscode.window.showInformationMessage("没有可撤销的采纳操作");
        return;
      }
      const result = await applyConflictUndo(entries);
      await store.waitForChange();
      if (result.failed === 0) {
        await vscode.window.showInformationMessage(`已撤销：${entries[0]?.label ?? ""}`);
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
    vscode.commands.registerCommand(CONFLICT_TREE_OPEN_MR_COMMAND, (args: ConflictTreeOpenMrArguments) => vscode.env.openExternal(vscode.Uri.parse(args.webUrl))),
    vscode.commands.registerCommand(
      CONFLICT_TREE_FETCH_MR_TARGET_COMMAND,
      (args: ConflictTreeMrActionArguments) =>
        runMrAction(args, async (repositoryRoot) => {
          const result = await fetchMrTargetBranch(git, repositoryRoot, args);
          return result.message;
        }),
    ),
    vscode.commands.registerCommand(
      CONFLICT_TREE_PREVIEW_MR_MERGE_COMMAND,
      async (args: ConflictTreeMrActionArguments) => {
        const repositoryRoot = getPrimaryRepositoryRoot();
        if (repositoryRoot === undefined) {
          await vscode.window.showWarningMessage("未找到 Git 仓库");
          return;
        }

        const result = await previewMrMerge(git, repositoryRoot, args);
        const message = formatMergePreviewMessage(result);
        if (result.ok && result.conflictCount > 0) {
          const channel = vscode.window.createOutputChannel("Conflict Resolver");
          channel.appendLine(message);
          channel.appendLine("");
          channel.appendLine(result.output);
          channel.show(true);
        }
        await vscode.window.showInformationMessage(message);
      },
    ),
    vscode.commands.registerCommand(
      CONFLICT_TREE_OPEN_MR_CONFLICTS_COMMAND,
      (args: ConflictTreeMrActionArguments) =>
        vscode.env.openExternal(vscode.Uri.parse(buildMrConflictsUrl(args.webUrl))),
    ),
    vscode.commands.registerCommand("conflictResolver.nextConflict", () => navigation.next()),
    vscode.commands.registerCommand("conflictResolver.previousConflict", () => navigation.previous()),
    vscode.commands.registerCommand("conflictResolver.nextConflictInFile", () => navigation.nextInFile()),
    vscode.commands.registerCommand("conflictResolver.previousConflictInFile", () => navigation.previousInFile()),
    vscode.commands.registerCommand("conflictResolver.openPanel", () => vscode.commands.executeCommand("workbench.view.extension.conflictResolver")),
    vscode.commands.registerCommand("conflictResolver.rescanCurrentFile", () => store.refresh()),
    vscode.commands.registerCommand("conflictResolver.openMergeEditor", () => {
      const uri = vscode.window.activeTextEditor?.document.uri.toString();
      return uri === undefined ? undefined : git.openMergeEditor(uri);
    }),
    vscode.commands.registerCommand("conflictResolver.refreshRemoteMR", () => refreshRemoteMr(true)),
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
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        store.scheduleRefresh("panel-visible");
      }
    }),
    vscode.workspace.onDidOpenTextDocument(() => store.scheduleRefresh("document-open")),
    vscode.workspace.onDidCloseTextDocument(() => store.scheduleRefresh("document-close")),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const changed = store.applyOpenDocumentText(
        event.document.uri.toString(),
        event.document.getText(),
      );
      if (
        changed ||
        hasLocatedConflictMarkers(event.document.getText()) ||
        isTrackedConflictDocument(event.document, store.getSnapshot())
      ) {
        void refreshConflictUi(store.getSnapshot());
      }

      if (isTrackedConflictDocument(event.document, store.getSnapshot())) {
        store.scheduleRefresh("document-change", { debounceMs: DOCUMENT_CHANGE_DEBOUNCE_MS });
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => store.scheduleImmediateRefresh("document-save")),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      store.scheduleRefresh("active-editor");
      void updateScmMenuContext(
        store.getSnapshot(),
        editor?.document.uri.toString(),
      );
      const repositoryRoot = getPrimaryRepositoryRoot();
      if (repositoryRoot !== undefined) {
        remoteMr.scheduleRefresh(repositoryRoot);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      store.scheduleRefresh("workspace-folders");
      void refreshRemoteMr(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("conflictResolver.gitlabUrl") ||
        event.affectsConfiguration("conflictResolver.gitlabToken")
      ) {
        void refreshRemoteMr(true);
      }
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
      void refreshConflictUi(snapshot);
    }),
  );
  syncUndoContext();

  void store.refresh().then((snapshot) => refreshConflictUi(snapshot));
  void refreshRemoteMr();
}

export function deactivate(): void {}
