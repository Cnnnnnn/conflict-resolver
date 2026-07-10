import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictStore, type ConflictStoreDocument, type ConflictStoreDocumentLoader } from "../conflictStore";
import type { GitUnmergedFile } from "../types";

const REPOSITORY_ROOT = "/repo";

class FakeDocument implements ConflictStoreDocument {
  readonly uri: string;
  private readonly text: string;

  constructor(uri: string, text: string) {
    this.uri = uri;
    this.text = text;
  }

  getText(): string {
    return this.text;
  }
}

class FakeDocumentLoader implements ConflictStoreDocumentLoader {
  private readonly repositoryRoots: string[];
  private readonly loadErrors = new Map<string, Error>();
  private readonly texts = new Map<string, string>();
  private readonly openUris = new Set<string>();

  constructor(repositoryRoots: readonly string[] = []) {
    this.repositoryRoots = [...repositoryRoots];
  }

  setDocument(relativePath: string, text: string, options?: { open?: boolean }): void {
    const uri = pathToFileURL(`${REPOSITORY_ROOT}/${relativePath}`).toString();
    this.loadErrors.delete(uri);
    this.texts.set(uri, text);

    if (options?.open ?? true) {
      this.openUris.add(uri);
      return;
    }

    this.openUris.delete(uri);
  }

  deleteDocument(relativePath: string): void {
    const uri = pathToFileURL(`${REPOSITORY_ROOT}/${relativePath}`).toString();
    this.loadErrors.delete(uri);
    this.texts.delete(uri);
    this.openUris.delete(uri);
  }

  setLoadError(relativePath: string, error: Error): void {
    const uri = pathToFileURL(`${REPOSITORY_ROOT}/${relativePath}`).toString();
    this.loadErrors.set(uri, error);
    this.texts.delete(uri);
    this.openUris.delete(uri);
  }

  async getOpenDocuments(): Promise<ConflictStoreDocument[]> {
    return [...this.openUris].map((uri) => new FakeDocument(uri, this.texts.get(uri) ?? ""));
  }

  async loadDocument(uri: string): Promise<ConflictStoreDocument | undefined> {
    const error = this.loadErrors.get(uri);
    if (error !== undefined) {
      throw error;
    }

    const text = this.texts.get(uri);
    if (text === undefined) {
      return undefined;
    }

    return new FakeDocument(uri, text);
  }

  async getRepositoryRoots(): Promise<string[]> {
    return [...this.repositoryRoots];
  }
}

class FakeGitRepositoryService {
  readonly findRepositoryRoot = vi.fn(async (uri: string) => {
    const absolutePath = new URL(uri).pathname;
    if (!absolutePath.startsWith(REPOSITORY_ROOT)) {
      return undefined;
    }

    return REPOSITORY_ROOT;
  });

  readonly listUnmergedFiles = vi.fn(async (_repositoryRoot: string) => {
    return this.unmergedFiles;
  });

  private unmergedFiles: GitUnmergedFile[] = [];

  setUnmerged(relativePaths: readonly string[]): void {
    this.unmergedFiles = relativePaths.map((relativePath) => ({
      repositoryRoot: REPOSITORY_ROOT,
      relativePath,
      uri: pathToFileURL(`${REPOSITORY_ROOT}/${relativePath}`).toString(),
    }));
  }
}

function markerText(label: string): string {
  return [
    "<<<<<<< HEAD",
    `${label}-ours`,
    "=======",
    `${label}-theirs`,
    ">>>>>>> branch",
  ].join("\n");
}

describe("ConflictStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps located conflicts and git-only files separate", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("src/z.ts", markerText("z"), { open: false });
    fakeDocuments.setDocument("config.json", "{\"resolved\":true}", { open: false });
    fakeDocuments.setDocument("src/a.ts", markerText("a"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["src/z.ts", "config.json"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.locatedCount).toBe(2);
    expect(snapshot.gitOnlyCount).toBe(1);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "config.json",
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(snapshot.files.find((file) => file.relativePath === "config.json")?.locatedConflicts).toHaveLength(0);
    expect(snapshot.files.find((file) => file.relativePath === "src/a.ts")).toMatchObject({
      gitUnmerged: false,
    });
    expect(snapshot.files.find((file) => file.relativePath === "src/z.ts")).toMatchObject({
      gitUnmerged: true,
    });
  });

  it("removes a file when both marker and git-unmerged state disappear", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("src/a.ts", markerText("a"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["src/a.ts"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    await store.refresh();
    fakeDocuments.setDocument("src/a.ts", "resolved");
    fakeGit.setUnmerged([]);
    await store.refresh();

    expect(store.getSnapshot().files).toHaveLength(0);
  });

  it("merges git and open-document scans by canonical file URI", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("folder with spaces/conflict file.ts", markerText("shared"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["folder with spaces/conflict file.ts"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]).toMatchObject({
      relativePath: "folder with spaces/conflict file.ts",
      gitUnmerged: true,
    });
    expect(snapshot.files[0].locatedConflicts).toHaveLength(1);
  });

  it("keeps document-only conflicts when git reports none", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("notes.md", markerText("notes"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged([]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.gitOnlyCount).toBe(0);
    expect(snapshot.locatedCount).toBe(1);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        relativePath: "notes.md",
        gitUnmerged: false,
      }),
    ]);
  });

  it("deduplicates repository root discovery across open documents in one repository", async () => {
    const fakeDocuments = new FakeDocumentLoader();
    fakeDocuments.setDocument("src/a.ts", markerText("a"));
    fakeDocuments.setDocument("nested/src/b.ts", markerText("b"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged([]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "nested/src/b.ts",
      "src/a.ts",
    ]);
    expect(fakeGit.findRepositoryRoot).toHaveBeenCalledTimes(1);
    expect(fakeGit.listUnmergedFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps git-unmerged files when document loading fails", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setLoadError("missing.ts", new Error("EACCES: permission denied"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["missing.ts"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.gitOnlyCount).toBe(1);
    expect(snapshot.locatedCount).toBe(0);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        relativePath: "missing.ts",
        gitUnmerged: true,
        locatedConflicts: [],
        parseError: "Failed to load unmerged file: EACCES: permission denied",
      }),
    ]);
  });

  it("debounces scheduled refreshes through a single timer", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("src/a.ts", markerText("a"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["src/a.ts"]);

    const store = new ConflictStore({
      debounceMs: 25,
      documents: fakeDocuments,
      git: fakeGit,
    });
    const listener = vi.fn();
    const disposable = store.onDidChange(listener);

    store.scheduleRefresh("first");
    store.scheduleRefresh("second");
    await vi.advanceTimersByTimeAsync(24);

    expect(fakeGit.listUnmergedFiles).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(fakeGit.listUnmergedFiles).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    disposable.dispose();
  });
});
