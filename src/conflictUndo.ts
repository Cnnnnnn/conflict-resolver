import type * as vscode from "vscode";

export type ConflictUndoEntry = {
  uri: string;
  fsPath: string;
  contents: string;
  label: string;
};

export type ConflictUndoWorkspace = {
  parseUri(uri: string): vscode.Uri;
  openTextDocument(uri: vscode.Uri): Promise<vscode.TextDocument>;
  applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
  createWorkspaceEdit(): vscode.WorkspaceEdit;
  createRange(start: vscode.Position, end: vscode.Position): vscode.Range;
};

export type ConflictUndoStore = {
  record(entries: readonly ConflictUndoEntry[]): void;
  take(): ConflictUndoEntry[];
  size(): number;
  describe(): string | undefined;
};

const MAX_UNDO_STACK = 5;

export function createConflictUndoStore(): ConflictUndoStore {
  let stack: ConflictUndoEntry[] = [];

  return {
    record(entries) {
      if (entries.length === 0) {
        return;
      }
      stack = [...entries, ...stack].slice(0, MAX_UNDO_STACK);
    },
    take() {
      const entry = stack[0];
      if (entry === undefined) {
        return [];
      }
      stack = stack.slice(1);
      return [entry];
    },
    size() {
      return stack.length;
    },
    describe() {
      const entry = stack[0];
      if (entry === undefined) {
        return undefined;
      }
      return `撤销：${entry.label}`;
    },
  };
}

export async function applyConflictUndo(
  entries: readonly ConflictUndoEntry[],
  workspace: ConflictUndoWorkspace,
): Promise<{ restored: number; failed: number }> {
  let restored = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const uri = workspace.parseUri(entry.uri);
      const document = await workspace.openTextDocument(uri);
      const edit = workspace.createWorkspaceEdit();
      const fullRange = workspace.createRange(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, fullRange, entry.contents);
      const ok = await workspace.applyEdit(edit);
      if (ok) {
        restored += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { restored, failed };
}