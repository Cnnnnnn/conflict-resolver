import * as vscode from "vscode";

import { ConflictDecorationManager } from "./conflictDecorations";
import { ConflictNavigation } from "./conflictNavigation";
import { ConflictStore } from "./conflictStore";
import type { ConflictStoreDocumentLoader } from "./conflictStore";
import { ConflictTreeProvider, CONFLICT_TREE_GO_TO_COMMAND } from "./conflictTreeProvider";
import { GitRepositoryService } from "./gitRepositoryService";
import { ConflictStatusBar } from "./statusBar";

function createDocumentLoader(): ConflictStoreDocumentLoader {
  return {
    getOpenDocuments: () => vscode.workspace.textDocuments.map((document) => ({
      uri: document.uri.toString(),
      getText: () => document.getText(),
    })),
    loadDocument: async (uri) => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        return { uri: document.uri.toString(), getText: () => document.getText() };
      } catch {
        return undefined;
      }
    },
    getRepositoryRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  };
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

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitRepositoryService({
    runMergeEditorCommand: async (uri) => {
      await vscode.commands.executeCommand("git.openMergeEditor", vscode.Uri.parse(uri));
    },
  });
  const store = new ConflictStore({ documents: createDocumentLoader(), git });
  const tree = new ConflictTreeProvider(store);
  const treeView = vscode.window.createTreeView("conflictResolver.tree", { treeDataProvider: tree });
  const startDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
  });
  const overviewDecoration = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
  });
  const decorations = new ConflictDecorationManager(createDecorationAdapter(startDecoration, overviewDecoration));
  const navigation = new ConflictNavigation(store, {
    getActiveLocation: () => {
      const editor = vscode.window.activeTextEditor;
      return editor === undefined ? undefined : { uri: editor.document.uri.toString(), line: editor.selection.active.line };
    },
    revealConflict: async (uri, conflict) => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.toString() !== uri) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        await vscode.window.showTextDocument(document);
      }
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor === undefined) return;
      const position = new vscode.Position(conflict.startLine, 0);
      activeEditor.selection = new vscode.Selection(position, position);
      await activeEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    },
    openMergeEditor: (uri) => git.openMergeEditor(uri),
    showMergeEditorFallback: async (uri, error) => {
      await vscode.window.showWarningMessage(`无法打开 Merge Editor：${uri}。${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const statusBar = new ConflictStatusBar({
    store,
    statusBar: { createStatusBarItem: () => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      return item;
    } },
    activeFile: {
      getActiveUri: () => vscode.window.activeTextEditor?.document.uri.toString(),
      onDidChangeActiveUri: (listener) => vscode.window.onDidChangeActiveTextEditor((editor) => listener(editor?.document.uri.toString())),
    },
  });

  context.subscriptions.push(
    tree,
    treeView,
    startDecoration,
    overviewDecoration,
    navigation,
    statusBar,
    vscode.window.registerTreeDataProvider("conflictResolver.tree", tree),
    vscode.commands.registerCommand(CONFLICT_TREE_GO_TO_COMMAND, (args: { uri: string; conflictId: string }) => navigation.goTo(args.uri, args.conflictId)),
    vscode.commands.registerCommand("conflictResolver.nextConflict", () => navigation.next()),
    vscode.commands.registerCommand("conflictResolver.previousConflict", () => navigation.previous()),
    vscode.commands.registerCommand("conflictResolver.openPanel", () => vscode.commands.executeCommand("workbench.view.extension.conflictResolver")),
    vscode.commands.registerCommand("conflictResolver.rescanCurrentFile", () => store.refresh()),
    vscode.commands.registerCommand("conflictResolver.openMergeEditor", () => {
      const uri = vscode.window.activeTextEditor?.document.uri.toString();
      return uri === undefined ? undefined : git.openMergeEditor(uri);
    }),
    vscode.workspace.onDidOpenTextDocument(() => store.scheduleRefresh("document-open")),
    vscode.workspace.onDidChangeTextDocument(() => store.scheduleRefresh("document-change")),
    vscode.workspace.onDidSaveTextDocument(() => store.scheduleRefresh("document-save")),
    vscode.window.onDidChangeActiveTextEditor(() => store.scheduleRefresh("active-editor")),
    vscode.workspace.onDidChangeWorkspaceFolders(() => store.scheduleRefresh("workspace-folders")),
    store.onDidChange((snapshot) => decorations.update(snapshot)),
  );

  void store.refresh();
}

export function deactivate(): void {}
