import { describe, expect, it } from "vitest";

import {
  applyConflictUndo,
  createConflictUndoStore,
  type ConflictUndoEntry,
} from "../conflictUndo";

function makeEntry(label: string, contents: string): ConflictUndoEntry {
  return { uri: `file:///${label}`, fsPath: `/${label}`, contents, label };
}

describe("createConflictUndoStore", () => {
  it("starts empty", () => {
    const store = createConflictUndoStore();
    expect(store.size()).toBe(0);
    expect(store.take()).toEqual([]);
    expect(store.describe()).toBeUndefined();
  });

  it("records entries and pops the most recent on take", () => {
    const store = createConflictUndoStore();
    store.record([makeEntry("a", "first")]);
    store.record([makeEntry("b", "second")]);

    expect(store.size()).toBe(2);
    expect(store.describe()).toBe("撤销：b");

    const taken = store.take();
    expect(taken).toHaveLength(1);
    expect(taken[0]?.label).toBe("b");
    expect(store.size()).toBe(1);
  });

  it("caps history depth", () => {
    const store = createConflictUndoStore();
    for (let i = 0; i < 8; i += 1) {
      store.record([makeEntry(String(i), String(i))]);
    }
    expect(store.size()).toBeLessThanOrEqual(5);
  });
});

describe("applyConflictUndo", () => {
  it("writes the original contents back via the workspace stub", async () => {
    let applied: { uri: string; contents: string } | undefined;
    const workspace = {
      parseUri: (value: string) => ({ toString: () => value, fsPath: value }),
      openTextDocument: async (uri: { toString(): string }) => ({
        uri,
        getText: () => "current",
        positionAt: (offset: number) => ({ line: 0, character: offset }),
      }),
      applyEdit: async (edit: { replace: (uri: unknown, range: unknown, newText: string) => void }) => {
        applied = { uri: "file:///a", contents: "" };
        edit.replace({ toString: () => "file:///a" }, { start: 0, end: 0 }, "before-accept");
        applied.contents = "before-accept";
        return true;
      },
      createWorkspaceEdit: () => ({
        replace: () => undefined,
      }),
      createRange: (start: unknown, end: unknown) => ({ start, end }),
    };
    const result = await applyConflictUndo(
      [makeEntry("a", "before-accept")],
      workspace as never,
    );
    expect(result).toEqual({ restored: 1, failed: 0 });
    expect(applied?.contents).toBe("before-accept");
  });

  it("counts failures when the workspace throws", async () => {
    const workspace = {
      parseUri: (value: string) => ({ toString: () => value }),
      openTextDocument: async () => {
        throw new Error("missing");
      },
      applyEdit: async () => false,
      createWorkspaceEdit: () => ({ replace: () => undefined }),
      createRange: (start: unknown, end: unknown) => ({ start, end }),
    };
    const result = await applyConflictUndo([makeEntry("a", "x")], workspace as never);
    expect(result).toEqual({ restored: 0, failed: 1 });
  });
});