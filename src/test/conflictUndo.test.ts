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
    expect(store.take()).toBeUndefined();
    expect(store.describe()).toBeUndefined();
  });

  it("records entries and pops the most recent batch on take", () => {
    const store = createConflictUndoStore();
    store.record([makeEntry("a", "first")]);
    store.record([makeEntry("b", "second")]);

    expect(store.size()).toBe(2);
    expect(store.describe()).toBe("撤销：b");

    const taken = store.take();
    expect(taken?.entries).toHaveLength(1);
    expect(taken?.entries[0]?.label).toBe("b");
    expect(store.size()).toBe(1);
  });

  it("treats each record() call as one undoable batch", () => {
    const store = createConflictUndoStore();
    store.record([
      makeEntry("a", "1"),
      makeEntry("a", "2"),
      makeEntry("a", "3"),
    ]);

    const taken = store.take();
    expect(taken?.entries).toHaveLength(3);
    expect(taken?.label).toBe("a × 3");
    expect(store.size()).toBe(0);
  });

  it("caps history depth at 20 by default", () => {
    const store = createConflictUndoStore();
    for (let i = 0; i < 25; i += 1) {
      store.record([makeEntry(String(i), String(i))]);
    }
    expect(store.size()).toBeLessThanOrEqual(20);
  });

  it("caps entries per batch at 200", () => {
    const store = createConflictUndoStore();
    const many = Array.from({ length: 500 }, (_, i) =>
      makeEntry(`f${i}`, String(i)),
    );
    store.record(many);

    const taken = store.take();
    expect(taken?.entries).toHaveLength(200);
  });

  it("respects a custom maxDepth", () => {
    const store = createConflictUndoStore({ maxDepth: 5 });
    for (let i = 0; i < 10; i += 1) {
      store.record([makeEntry(String(i), String(i))]);
    }
    expect(store.size()).toBe(5);
    // Oldest 5 batches were dropped; the surviving batch is the
    // most recent one recorded.
    expect(store.describe()).toBe("撤销：9");
  });

  it("clamps maxDepth values below 1 up to 1", () => {
    const store = createConflictUndoStore({ maxDepth: 0 });
    store.record([makeEntry("a", "a")]);
    store.record([makeEntry("b", "b")]);
    expect(store.size()).toBe(1);
    expect(store.describe()).toBe("撤销：b");
  });

  it("clamps maxDepth values above 200 down to 200", () => {
    const store = createConflictUndoStore({ maxDepth: 9999 });
    for (let i = 0; i < 201; i += 1) {
      store.record([makeEntry(String(i), String(i))]);
    }
    expect(store.size()).toBe(200);
  });

  it("falls back to the default when maxDepth is not a finite number", () => {
    const store = createConflictUndoStore({ maxDepth: Number.NaN });
    for (let i = 0; i < 25; i += 1) {
      store.record([makeEntry(String(i), String(i))]);
    }
    expect(store.size()).toBe(20);
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