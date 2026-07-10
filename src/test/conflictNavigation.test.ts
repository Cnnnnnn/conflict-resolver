import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ConflictNavigation,
  type ConflictNavigationCallbacks,
  type ConflictNavigationLocation,
  type ConflictNavigationStore,
} from "../conflictNavigation";
import type { ConflictBlock, ConflictSnapshot } from "../types";

function createConflict(id: string, startLine: number): ConflictBlock {
  return {
    id,
    startLine,
    separatorLine: startLine + 2,
    endLine: startLine + 4,
    oursRange: {
      startLine: startLine + 1,
      endLine: startLine + 1,
    },
    theirsRange: {
      startLine: startLine + 3,
      endLine: startLine + 3,
    },
  };
}

function createSnapshot(
  entries: Array<{
    gitUnmerged?: boolean;
    locatedConflicts?: ConflictBlock[];
    relativePath: string;
    uri?: string;
  }>,
): ConflictSnapshot {
  return {
    files: entries.map((entry) => ({
      uri: entry.uri ?? pathToFileURL(`/repo/${entry.relativePath}`).toString(),
      repositoryRoot: "/repo",
      relativePath: entry.relativePath,
      locatedConflicts: [...(entry.locatedConflicts ?? [])],
      gitUnmerged: entry.gitUnmerged ?? false,
    })),
    generatedAt: 1,
    gitOnlyCount: entries.filter(
      (entry) =>
        (entry.gitUnmerged ?? false) &&
        (entry.locatedConflicts?.length ?? 0) === 0,
    ).length,
    locatedCount: entries.reduce(
      (count, entry) => count + (entry.locatedConflicts?.length ?? 0),
      0,
    ),
  };
}

class FakeConflictNavigationStore implements ConflictNavigationStore {
  private snapshot: ConflictSnapshot;
  private readonly listeners = new Set<
    (snapshot: ConflictSnapshot) => void | Promise<void>
  >();

  constructor(snapshot: ConflictSnapshot) {
    this.snapshot = snapshot;
  }

  getSnapshot(): ConflictSnapshot {
    return this.snapshot;
  }

  onDidChange(listener: (snapshot: ConflictSnapshot) => void | Promise<void>) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async emit(snapshot: ConflictSnapshot): Promise<void> {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      await listener(snapshot);
    }
  }
}

function createCallbacks(
  getActiveLocation: () => ConflictNavigationLocation | undefined,
  overrides?: Partial<ConflictNavigationCallbacks>,
): ConflictNavigationCallbacks & {
  openMergeEditor: ReturnType<typeof vi.fn>;
  revealConflict: ReturnType<typeof vi.fn>;
  showMergeEditorFallback: ReturnType<typeof vi.fn>;
} {
  const revealConflict = vi.fn(async () => undefined);
  const openMergeEditor = vi.fn(async () => undefined);
  const showMergeEditorFallback = vi.fn(async () => undefined);

  return {
    getActiveLocation,
    revealConflict,
    openMergeEditor,
    showMergeEditorFallback,
    ...overrides,
  } as ConflictNavigationCallbacks & {
    openMergeEditor: ReturnType<typeof vi.fn>;
    revealConflict: ReturnType<typeof vi.fn>;
    showMergeEditorFallback: ReturnType<typeof vi.fn>;
  };
}

describe("ConflictNavigation", () => {
  it("navigates across files in workspace order", async () => {
    const firstUri = pathToFileURL("/repo/a.ts").toString();
    const secondUri = pathToFileURL("/repo/b.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "a.ts",
          uri: firstUri,
          locatedConflicts: [createConflict("a-1", 4)],
        },
        {
          relativePath: "b.ts",
          uri: secondUri,
          locatedConflicts: [createConflict("b-1", 8)],
        },
      ]),
    );

    let activeUri = firstUri;
    let activeLine = 4;
    const callbacks = createCallbacks(() => ({
      uri: activeUri,
      line: activeLine,
    }));
    const navigation = new ConflictNavigation(store, callbacks);

    await expect(navigation.next()).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenCalledWith(
      secondUri,
      expect.objectContaining({ id: "b-1" }),
    );

    activeUri = secondUri;
    activeLine = 8;
    await expect(navigation.previous()).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenLastCalledWith(
      firstUri,
      expect.objectContaining({ id: "a-1" }),
    );
  });

  it("keeps file-local navigation available", async () => {
    const uri = pathToFileURL("/repo/src/example.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/example.ts",
          uri,
          locatedConflicts: [
            createConflict("late", 20),
            createConflict("early", 4),
          ],
        },
        {
          relativePath: "src/other.ts",
          uri: pathToFileURL("/repo/src/other.ts").toString(),
          locatedConflicts: [createConflict("other", 1)],
        },
      ]),
    );

    let activeLine = 5;
    const callbacks = createCallbacks(() => ({
      uri,
      line: activeLine,
    }));
    const navigation = new ConflictNavigation(store, callbacks);

    await expect(navigation.nextInFile()).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({ id: "late", startLine: 20 }),
    );
  });

  it("navigates previous and next conflicts by sorted start line without wrapping", async () => {
    const uri = pathToFileURL("/repo/src/example.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/example.ts",
          uri,
          locatedConflicts: [
            createConflict("late", 20),
            createConflict("early", 4),
            createConflict("middle", 12),
          ],
        },
      ]),
    );

    let activeLine = 5;
    const callbacks = createCallbacks(() => ({
      uri,
      line: activeLine,
    }));
    const navigation = new ConflictNavigation(store, callbacks);

    await expect(navigation.next()).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenNthCalledWith(
      1,
      uri,
      expect.objectContaining({ id: "middle", startLine: 12 }),
    );

    activeLine = 12;
    await expect(navigation.next()).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenNthCalledWith(
      2,
      uri,
      expect.objectContaining({ id: "late", startLine: 20 }),
    );

    activeLine = 20;
    await expect(navigation.next()).resolves.toBe(false);
    expect(callbacks.revealConflict).toHaveBeenCalledTimes(2);

    await expect(navigation.previous()).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenNthCalledWith(
      3,
      uri,
      expect.objectContaining({ id: "middle", startLine: 12 }),
    );

    activeLine = 4;
    await expect(navigation.previous()).resolves.toBe(false);
    expect(callbacks.revealConflict).toHaveBeenCalledTimes(3);
  });

  it("uses updated snapshots from store changes", async () => {
    const uri = pathToFileURL("/repo/src/updated.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/updated.ts",
          uri,
          locatedConflicts: [createConflict("stale", 40)],
        },
      ]),
    );

    let activeLine = 0;
    const callbacks = createCallbacks(() => ({
      uri,
      line: activeLine,
    }));
    const navigation = new ConflictNavigation(store, callbacks);

    await store.emit(
      createSnapshot([
        {
          relativePath: "src/updated.ts",
          uri,
          locatedConflicts: [createConflict("fresh", 8)],
        },
      ]),
    );

    activeLine = 1;
    await expect(navigation.next()).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({ id: "fresh", startLine: 8 }),
    );
  });

  it("goes directly to the requested conflict id", async () => {
    const uri = pathToFileURL("/repo/src/direct.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/direct.ts",
          uri,
          locatedConflicts: [
            createConflict("second", 15),
            createConflict("first", 3),
          ],
        },
      ]),
    );

    const callbacks = createCallbacks(() => undefined);
    const navigation = new ConflictNavigation(store, callbacks);

    await expect(navigation.goTo(uri, "second")).resolves.toBe(true);
    expect(callbacks.revealConflict).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({ id: "second", startLine: 15 }),
    );
  });

  it("opens the merge editor for Git-only files with no located conflicts", async () => {
    const uri = pathToFileURL("/repo/src/git-only.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/git-only.ts",
          uri,
          gitUnmerged: true,
        },
      ]),
    );

    const callbacks = createCallbacks(() => ({
      uri,
      line: 0,
    }));
    const navigation = new ConflictNavigation(store, callbacks);

    await expect(navigation.next()).resolves.toBe(true);
    expect(callbacks.openMergeEditor).toHaveBeenCalledWith(uri);
    expect(callbacks.showMergeEditorFallback).not.toHaveBeenCalled();
  });

  it("routes Git-only goTo failures through the injected fallback callback", async () => {
    const uri = pathToFileURL("/repo/src/fallback.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/fallback.ts",
          uri,
          gitUnmerged: true,
        },
      ]),
    );

    const error = new Error("merge editor unavailable");
    const callbacks = createCallbacks(() => undefined, {
      openMergeEditor: vi.fn(async () => {
        throw error;
      }),
    });
    const navigation = new ConflictNavigation(store, callbacks);

    await expect(navigation.goTo(uri)).resolves.toBe(false);
    expect(callbacks.openMergeEditor).toHaveBeenCalledWith(uri);
    expect(callbacks.showMergeEditorFallback).toHaveBeenCalledWith(uri, error);
  });

  it("history: back jumps to the previous reveal and tracks history size", async () => {
    const uri = pathToFileURL("/repo/src/example.ts").toString();
    const otherUri = pathToFileURL("/repo/src/other.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/example.ts",
          uri,
          locatedConflicts: [createConflict("first", 5)],
        },
        {
          relativePath: "src/other.ts",
          uri: otherUri,
          locatedConflicts: [createConflict("second", 8)],
        },
      ]),
    );

    let active: { uri: string; line: number } | undefined = undefined;
    const callbacks = createCallbacks(() => active);
    const navigation = new ConflictNavigation(store, callbacks);

    await navigation.goTo(uri, "first");
    active = { uri, line: 5 };
    await navigation.goTo(otherUri, "second");
    expect(callbacks.revealConflict).toHaveBeenCalledTimes(2);
    expect(navigation.getHistorySize()).toBeGreaterThan(0);

    active = { uri: otherUri, line: 8 };
    await navigation.back();
    expect(callbacks.revealConflict).toHaveBeenCalledTimes(3);
    const lastCall = callbacks.revealConflict.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(uri);
  });

  it("goToAfter lands on the next unresolved conflict", async () => {
    const uri = pathToFileURL("/repo/src/example.ts").toString();
    const otherUri = pathToFileURL("/repo/src/other.ts").toString();
    const store = new FakeConflictNavigationStore(
      createSnapshot([
        {
          relativePath: "src/example.ts",
          uri,
          locatedConflicts: [createConflict("first", 5), createConflict("third", 40)],
        },
        {
          relativePath: "src/other.ts",
          uri: otherUri,
          locatedConflicts: [createConflict("second", 10)],
        },
      ]),
    );

    let active: { uri: string; line: number } = { uri, line: 0 };
    const callbacks = createCallbacks(() => active);
    const navigation = new ConflictNavigation(store, callbacks);

    await navigation.goToAfter(uri, 0);
    const lastCall = callbacks.revealConflict.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(uri);
    expect(lastCall?.[1]).toEqual(expect.objectContaining({ id: "first" }));

    active = { uri, line: 5 };
    await navigation.goToAfter(uri, 5);
    const lastAfter = callbacks.revealConflict.mock.calls.at(-1);
    expect(lastAfter?.[0]).toBe(uri);
    expect(lastAfter?.[1]).toEqual(expect.objectContaining({ id: "third" }));

    active = { uri, line: 40 };
    await navigation.goToAfter(uri, 40);
    const lastOther = callbacks.revealConflict.mock.calls.at(-1);
    expect(lastOther?.[0]).toBe(otherUri);
    expect(lastOther?.[1]).toEqual(expect.objectContaining({ id: "second" }));
  });
});
