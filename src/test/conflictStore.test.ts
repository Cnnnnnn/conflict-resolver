import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictStore, type ConflictStoreDocument, type ConflictStoreDocumentLoader } from "../conflictStore";
import type { GitUnmergedFile } from "../types";

const REPOSITORY_ROOT = "/repo";
const NESTED_REPOSITORY_ROOT = "/repo/packages/nested";
const OTHER_REPOSITORY_ROOT = "/repo-other";
const WORKTREE_REPOSITORY_ROOT = "/workspace/repo-worktree";

type FakeDocumentEntry = {
  loadedText: string;
  openText: string;
};

function toUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

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
  private readonly documents = new Map<string, FakeDocumentEntry>();
  private readonly openUris = new Set<string>();

  constructor(repositoryRoots: readonly string[] = []) {
    this.repositoryRoots = [...repositoryRoots];
  }

  setDocument(
    relativePath: string,
    text: string,
    options?: { open?: boolean; openText?: string },
  ): void {
    this.setDocumentAtPath(`${REPOSITORY_ROOT}/${relativePath}`, text, options);
  }

  setDocumentAtPath(
    filePath: string,
    text: string,
    options?: { open?: boolean; openText?: string },
  ): void {
    const uri = toUri(filePath);
    this.loadErrors.delete(uri);
    this.documents.set(uri, {
      loadedText: text,
      openText: options?.openText ?? text,
    });

    if (options?.open ?? true) {
      this.openUris.add(uri);
      return;
    }

    this.openUris.delete(uri);
  }

  deleteDocument(relativePath: string): void {
    this.deleteDocumentAtPath(`${REPOSITORY_ROOT}/${relativePath}`);
  }

  deleteDocumentAtPath(filePath: string): void {
    const uri = toUri(filePath);
    this.loadErrors.delete(uri);
    this.documents.delete(uri);
    this.openUris.delete(uri);
  }

  setLoadError(relativePath: string, error: Error): void {
    this.setLoadErrorAtPath(`${REPOSITORY_ROOT}/${relativePath}`, error);
  }

  setLoadErrorAtPath(filePath: string, error: Error): void {
    const uri = toUri(filePath);
    this.loadErrors.set(uri, error);
    this.documents.delete(uri);
    this.openUris.delete(uri);
  }

  async getOpenDocuments(): Promise<ConflictStoreDocument[]> {
    return [...this.openUris].map(
      (uri) => new FakeDocument(uri, this.documents.get(uri)?.openText ?? ""),
    );
  }

  async loadDocument(uri: string): Promise<ConflictStoreDocument | undefined> {
    const error = this.loadErrors.get(uri);
    if (error !== undefined) {
      throw error;
    }

    const document = this.documents.get(uri);
    if (document === undefined) {
      return undefined;
    }

    return new FakeDocument(uri, document.loadedText);
  }

  async getRepositoryRoots(): Promise<string[]> {
    return [...this.repositoryRoots];
  }

  async readDiskText(uri: string): Promise<string | undefined> {
    const error = this.loadErrors.get(uri);
    if (error !== undefined) {
      throw error;
    }

    return this.documents.get(uri)?.loadedText;
  }
}

class FakeGitRepositoryService {
  readonly findRepositoryRoot = vi.fn(async (uri: string) => {
    const absolutePath = new URL(uri).pathname;
    const matchingRoots = [...this.knownRepositoryRoots].filter(
      (repositoryRoot) =>
        absolutePath === repositoryRoot ||
        absolutePath.startsWith(`${repositoryRoot}/`),
    );
    if (matchingRoots.length === 0) {
      return undefined;
    }

    matchingRoots.sort((left, right) => right.length - left.length);
    return matchingRoots[0];
  });

  readonly listUnmergedFiles = vi.fn(async (repositoryRoot: string) => {
    return this.unmergedFilesByRoot.get(resolve(repositoryRoot)) ?? [];
  });

  private readonly knownRepositoryRoots = new Set([resolve(REPOSITORY_ROOT)]);
  private readonly unmergedFilesByRoot = new Map<string, GitUnmergedFile[]>();

  setUnmerged(relativePaths: readonly string[]): void {
    this.setUnmergedForRoot(REPOSITORY_ROOT, relativePaths);
  }

  setUnmergedForRoot(
    repositoryRoot: string,
    relativePaths: readonly string[],
  ): void {
    const normalizedRoot = resolve(repositoryRoot);
    this.knownRepositoryRoots.add(normalizedRoot);
    this.unmergedFilesByRoot.set(
      normalizedRoot,
      relativePaths.map((relativePath) => ({
        repositoryRoot: normalizedRoot,
        relativePath,
        uri: toUri(`${normalizedRoot}/${relativePath}`),
      })),
    );
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
    expect(snapshot.gitOnlyCount).toBe(0);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
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

  it("treats the open document as authoritative when its unsaved buffer is resolved", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("src/a.ts", markerText("disk"), {
      open: true,
      openText: "resolved in editor",
    });

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["src/a.ts"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.locatedCount).toBe(0);
    expect(snapshot.gitOnlyCount).toBe(0);
    expect(snapshot.files).toEqual([]);
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

  it("parses CRLF conflict text from the open document", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("windows/conflict.ts", markerText("crlf").replaceAll("\n", "\r\n"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged([]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.locatedCount).toBe(1);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        relativePath: "windows/conflict.ts",
        locatedConflicts: [expect.objectContaining({ startLine: 0, endLine: 4 })],
      }),
    ]);
  });

  it("merges unicode paths without losing the repository-relative filename", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("unicøde/冲突 文件.ts", markerText("unicode"));

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["unicøde/冲突 文件.ts"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.files).toEqual([
      expect.objectContaining({
        relativePath: "unicøde/冲突 文件.ts",
        repositoryRoot: resolve(REPOSITORY_ROOT),
        gitUnmerged: true,
      }),
    ]);
  });

  it("selects the containing repository root for nested and distinct roots", async () => {
    const fakeDocuments = new FakeDocumentLoader([
      REPOSITORY_ROOT,
      NESTED_REPOSITORY_ROOT,
      OTHER_REPOSITORY_ROOT,
    ]);
    fakeDocuments.setDocumentAtPath(
      `${NESTED_REPOSITORY_ROOT}/src/nested.ts`,
      markerText("nested"),
    );
    fakeDocuments.setDocumentAtPath(
      `${OTHER_REPOSITORY_ROOT}/src/other.ts`,
      markerText("other"),
    );

    const fakeGit = new FakeGitRepositoryService();

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.files).toEqual([
      expect.objectContaining({
        relativePath: "src/nested.ts",
        repositoryRoot: resolve(NESTED_REPOSITORY_ROOT),
      }),
      expect.objectContaining({
        relativePath: "src/other.ts",
        repositoryRoot: resolve(OTHER_REPOSITORY_ROOT),
      }),
    ]);
  });

  it("normalizes worktree-style repository roots before matching files", async () => {
    const fakeDocuments = new FakeDocumentLoader([
      "/workspace/main/.git/worktrees/feature/../../../../repo-worktree",
    ]);
    fakeDocuments.setDocumentAtPath(
      `${WORKTREE_REPOSITORY_ROOT}/src/conflict.ts`,
      markerText("worktree"),
    );

    const fakeGit = new FakeGitRepositoryService();

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.files).toEqual([
      expect.objectContaining({
        relativePath: "src/conflict.ts",
        repositoryRoot: resolve(WORKTREE_REPOSITORY_ROOT),
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

  it("debounces scheduled refreshes with trailing debounce", async () => {
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

  it("updates located conflict count when the open buffer resolves one marker block", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument(
      "src/a.ts",
      `${markerText("first")}\n\n${markerText("second")}`,
      { open: true },
    );

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["src/a.ts"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    expect((await store.refresh()).locatedCount).toBe(2);

    fakeDocuments.setDocument("src/a.ts", markerText("first"), { open: true });
    expect((await store.refresh()).locatedCount).toBe(1);
  });

  it("updates conflict counts immediately from the open buffer", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument(
      "src/a.ts",
      `${markerText("first")}\n\n${markerText("second")}`,
      { open: true },
    );

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["src/a.ts"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    await store.refresh();
    const uri = toUri(`${REPOSITORY_ROOT}/src/a.ts`);

    expect(
      store.applyOpenDocumentText(uri, markerText("first")),
    ).toBe(true);
    expect(store.getSnapshot().locatedCount).toBe(1);

    expect(store.applyOpenDocumentText(uri, "resolved")).toBe(true);
    expect(store.getSnapshot().locatedCount).toBe(0);
    expect(store.getSnapshot().files).toEqual([]);

    expect(
      store.applyOpenDocumentText(
        uri,
        `${markerText("first")}\n\n${markerText("second")}`,
      ),
    ).toBe(true);
    expect(store.getSnapshot().locatedCount).toBe(2);
    expect(store.getSnapshot().files).toHaveLength(1);
  });

  it("prefers the open buffer over on-disk markers for git-unmerged files", async () => {
    const fakeDocuments = new FakeDocumentLoader([REPOSITORY_ROOT]);
    fakeDocuments.setDocument("package.json", markerText("disk"), {
      open: true,
      openText: "resolved in editor",
    });

    const fakeGit = new FakeGitRepositoryService();
    fakeGit.setUnmerged(["package.json"]);

    const store = new ConflictStore({
      documents: fakeDocuments,
      git: fakeGit,
    });

    const snapshot = await store.refresh();

    expect(snapshot.gitOnlyCount).toBe(0);
    expect(snapshot.locatedCount).toBe(0);
    expect(snapshot.files).toEqual([]);
  });
});
