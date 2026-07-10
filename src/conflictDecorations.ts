import type { ConflictSnapshot } from "./types";

export type ConflictDecorationRange = { startLine: number; endLine: number };

export type ConflictDecorationEditor = {
  uri: string;
  setStartLineDecorations(ranges: readonly ConflictDecorationRange[]): void;
  setOverviewDecorations(ranges: readonly ConflictDecorationRange[]): void;
};

export type ConflictDecorationAdapter = {
  getEditors(): readonly ConflictDecorationEditor[];
};

export class ConflictDecorationManager {
  private readonly previousEditors = new Map<string, ConflictDecorationEditor>();

  constructor(private readonly adapter: ConflictDecorationAdapter) {}

  update(snapshot: ConflictSnapshot): void {
    const byUri = new Map(snapshot.files.map((file) => [file.uri, file]));
    const editors = this.adapter.getEditors();
    for (const editor of editors) {
      const ranges = (byUri.get(editor.uri)?.locatedConflicts ?? []).map((conflict) => ({
        startLine: conflict.startLine,
        endLine: conflict.startLine,
      }));
      editor.setStartLineDecorations(ranges);
      editor.setOverviewDecorations(ranges);
      this.previousEditors.set(editor.uri, editor);
    }

    for (const [uri, editor] of this.previousEditors) {
      if (!editors.some((current) => current.uri === uri)) {
        editor.setStartLineDecorations([]);
        editor.setOverviewDecorations([]);
        this.previousEditors.delete(uri);
      }
    }
  }
}
