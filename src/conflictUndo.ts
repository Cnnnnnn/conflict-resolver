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

export type ConflictUndoBatch = {
  label: string;
  entries: readonly ConflictUndoEntry[];
};

export type ConflictUndoStore = {
  record(entries: readonly ConflictUndoEntry[]): void;
  take(): ConflictUndoBatch | undefined;
  size(): number;
  describe(): string | undefined;
};

const MAX_UNDO_STACK = 20;
const MAX_ENTRIES_PER_BATCH = 200;

export function createConflictUndoStore(): ConflictUndoStore {
  let stack: ConflictUndoBatch[] = [];

  return {
    record(entries) {
      if (entries.length === 0) {
        return;
      }
      // One undo batch corresponds to one record() call so batch accepts are
      // undone atomically. Cap the entries per batch so a multi-thousand
      // file operation does not blow memory.
      const limited = entries.slice(0, MAX_ENTRIES_PER_BATCH);
      const label = deriveBatchLabel(limited);
      const batch: ConflictUndoBatch = { label, entries: limited };
      stack = [batch, ...stack].slice(0, MAX_UNDO_STACK);
    },
    take() {
      const batch = stack[0];
      if (batch === undefined) {
        return undefined;
      }
      stack = stack.slice(1);
      return batch;
    },
    size() {
      return stack.length;
    },
    describe() {
      const batch = stack[0];
      if (batch === undefined) {
        return undefined;
      }
      return `撤销：${batch.label}`;
    },
  };
}

function deriveBatchLabel(entries: readonly ConflictUndoEntry[]): string {
  if (entries.length === 1) {
    return entries[0]?.label ?? "";
  }
  const uniqueLabels = new Set(entries.map((entry) => entry.label));
  if (uniqueLabels.size === 1) {
    const only = entries[0]?.label ?? "";
    return `${only} × ${entries.length}`;
  }
  return `${entries.length} 个文件`;
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