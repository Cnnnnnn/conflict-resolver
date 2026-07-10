import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseConflictMarkers } from "./conflictParser";
import { GitRepositoryService } from "./gitRepositoryService";
import type { ConflictBlock, ConflictFile, ConflictSnapshot, GitUnmergedFile } from "./types";

type MaybePromise<T> = T | Promise<T>;

export type ConflictStoreDocument = {
  uri: string;
  getText(): MaybePromise<string>;
};

export type ConflictStoreDocumentLoader = {
  getOpenDocuments(): MaybePromise<readonly ConflictStoreDocument[]>;
  loadDocument(uri: string): MaybePromise<ConflictStoreDocument | undefined>;
  getRepositoryRoots(): MaybePromise<readonly string[]>;
};

export type ConflictStoreGitService = Pick<
  GitRepositoryService,
  "findRepositoryRoot" | "listUnmergedFiles"
>;

export type ConflictStoreChangeListener = (
  snapshot: ConflictSnapshot,
) => void | Promise<void>;

export type ConflictStoreDisposable = {
  dispose(): void;
};

export type ConflictStoreOptions = {
  debounceMs?: number;
  documents?: ConflictStoreDocumentLoader;
  git?: ConflictStoreGitService;
  now?: () => number;
  parseConflicts?: typeof parseConflictMarkers;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

const DEFAULT_DEBOUNCE_MS = 100;

const EMPTY_SNAPSHOT: ConflictSnapshot = {
  files: [],
  generatedAt: 0,
  gitOnlyCount: 0,
  locatedCount: 0,
};

function createFileBackedDocument(uri: string, text: string): ConflictStoreDocument {
  return {
    uri,
    getText() {
      return text;
    },
  };
}

const defaultDocumentLoader: ConflictStoreDocumentLoader = {
  async getOpenDocuments() {
    return [];
  },
  async loadDocument(uri) {
    const text = await readFile(fileURLToPath(uri), "utf8");
    return createFileBackedDocument(uri, text);
  },
  async getRepositoryRoots() {
    return [];
  },
};

function canonicalizeUri(uri: string): string {
  try {
    if (new URL(uri).protocol !== "file:") {
      return uri;
    }

    return pathToFileURL(fileURLToPath(uri)).toString();
  } catch {
    return uri;
  }
}

function toRepositoryRelativePath(
  repositoryRoot: string,
  uri: string,
): string | undefined {
  try {
    const absolutePath = resolve(fileURLToPath(uri));
    const resolvedRoot = resolve(repositoryRoot);
    const rebased = relative(resolvedRoot, absolutePath);

    if (
      rebased.length === 0 ||
      rebased === ".." ||
      rebased.startsWith(`..${sep}`)
    ) {
      return undefined;
    }

    return rebased.split(sep).join("/");
  } catch {
    return undefined;
  }
}

function compareFiles(left: ConflictFile, right: ConflictFile): number {
  if (left.relativePath < right.relativePath) {
    return -1;
  }

  if (left.relativePath > right.relativePath) {
    return 1;
  }

  if (left.uri < right.uri) {
    return -1;
  }

  if (left.uri > right.uri) {
    return 1;
  }

  return 0;
}

function hasLocatedConflictCandidate(text: string): boolean {
  return (
    text.includes("<<<<<<<") ||
    text.includes("=======") ||
    text.includes(">>>>>>>")
  );
}

type ConflictRecord = {
  file: ConflictFile;
};

export class ConflictStore {
  private readonly clearTimer: typeof clearTimeout;
  private readonly debounceMs: number;
  private readonly documents: ConflictStoreDocumentLoader;
  private readonly git: ConflictStoreGitService;
  private readonly listeners = new Set<ConflictStoreChangeListener>();
  private readonly now: () => number;
  private readonly parseConflicts: typeof parseConflictMarkers;
  private readonly scheduleTimer: typeof setTimeout;

  private inFlightRefresh: Promise<ConflictSnapshot> | undefined;
  private pendingRefresh = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: ConflictSnapshot = EMPTY_SNAPSHOT;

  constructor(options: ConflictStoreOptions = {}) {
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.documents = options.documents ?? defaultDocumentLoader;
    this.git = options.git ?? new GitRepositoryService();
    this.now = options.now ?? Date.now;
    this.parseConflicts = options.parseConflicts ?? parseConflictMarkers;
    this.scheduleTimer = options.setTimeout ?? setTimeout;
  }

  getSnapshot(): ConflictSnapshot {
    return this.snapshot;
  }

  onDidChange(listener: ConflictStoreChangeListener): ConflictStoreDisposable {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  scheduleRefresh(_reason: string): void {
    if (this.refreshTimer !== undefined) {
      return;
    }

    this.refreshTimer = this.scheduleTimer(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, this.debounceMs);
  }

  async refresh(): Promise<ConflictSnapshot> {
    this.clearScheduledRefresh();
    this.pendingRefresh = true;

    if (this.inFlightRefresh !== undefined) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = this.runRefreshLoop().finally(() => {
      this.inFlightRefresh = undefined;
    });

    return this.inFlightRefresh;
  }

  private clearScheduledRefresh(): void {
    if (this.refreshTimer === undefined) {
      return;
    }

    this.clearTimer(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async runRefreshLoop(): Promise<ConflictSnapshot> {
    do {
      this.pendingRefresh = false;
      const nextSnapshot = await this.buildSnapshot();
      this.snapshot = nextSnapshot;
      await this.emitDidChange(nextSnapshot);
    } while (this.pendingRefresh);

    return this.snapshot;
  }

  private async emitDidChange(snapshot: ConflictSnapshot): Promise<void> {
    for (const listener of this.listeners) {
      await listener(snapshot);
    }
  }

  private async buildSnapshot(): Promise<ConflictSnapshot> {
    const openDocuments = [...await this.documents.getOpenDocuments()];
    const openDocumentState = await Promise.all(
      openDocuments.map(async (document) => ({
        document,
        key: canonicalizeUri(document.uri),
        repositoryRoot: await this.git.findRepositoryRoot(document.uri),
      })),
    );

    const repositoryRoots = new Set(await this.documents.getRepositoryRoots());
    for (const entry of openDocumentState) {
      if (entry.repositoryRoot !== undefined) {
        repositoryRoots.add(entry.repositoryRoot);
      }
    }

    const files = new Map<string, ConflictRecord>();

    for (const repositoryRoot of [...repositoryRoots].sort()) {
      const unmergedFiles = [...await this.git.listUnmergedFiles(repositoryRoot)].sort(
        (left, right) => {
          if (left.relativePath < right.relativePath) {
            return -1;
          }

          if (left.relativePath > right.relativePath) {
            return 1;
          }

          return left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0;
        },
      );

      for (const file of unmergedFiles) {
        await this.mergeGitUnmergedFile(files, file);
      }
    }

    for (const entry of openDocumentState) {
      await this.mergeOpenDocument(files, entry.document, entry.repositoryRoot, entry.key);
    }

    const snapshotFiles = [...files.values()]
      .map((entry) => entry.file)
      .sort(compareFiles);

    return {
      files: snapshotFiles,
      generatedAt: this.now(),
      gitOnlyCount: snapshotFiles.filter(
        (file) => file.gitUnmerged && file.locatedConflicts.length === 0,
      ).length,
      locatedCount: snapshotFiles.reduce(
        (count, file) => count + file.locatedConflicts.length,
        0,
      ),
    };
  }

  private async mergeGitUnmergedFile(
    files: Map<string, ConflictRecord>,
    gitFile: GitUnmergedFile,
  ): Promise<void> {
    const text = await this.loadDocumentText(gitFile.uri);
    const parsed = this.parseConflicts(text);
    const key = canonicalizeUri(gitFile.uri);
    const existing = files.get(key);

    files.set(key, {
      file: {
        uri: existing?.file.uri ?? gitFile.uri,
        repositoryRoot: gitFile.repositoryRoot,
        relativePath: gitFile.relativePath,
        locatedConflicts: parsed.blocks,
        gitUnmerged: true,
        parseError: parsed.error,
      },
    });
  }

  private async mergeOpenDocument(
    files: Map<string, ConflictRecord>,
    document: ConflictStoreDocument,
    repositoryRoot: string | undefined,
    key: string,
  ): Promise<void> {
    const text = await document.getText();
    if (!hasLocatedConflictCandidate(text)) {
      return;
    }

    const parsed = this.parseConflicts(text);
    if (parsed.blocks.length === 0 && parsed.error === undefined) {
      return;
    }

    const existing = files.get(key);
    const resolvedRepositoryRoot = repositoryRoot ?? existing?.file.repositoryRoot;
    if (resolvedRepositoryRoot === undefined) {
      return;
    }

    const relativePath =
      existing?.file.relativePath ??
      toRepositoryRelativePath(resolvedRepositoryRoot, document.uri);
    if (relativePath === undefined) {
      return;
    }

    files.set(key, {
      file: {
        uri: document.uri,
        repositoryRoot: resolvedRepositoryRoot,
        relativePath,
        locatedConflicts: parsed.blocks,
        gitUnmerged: existing?.file.gitUnmerged ?? false,
        parseError: parsed.error,
      },
    });
  }

  private async loadDocumentText(uri: string): Promise<string> {
    const document = await this.documents.loadDocument(uri);
    if (document !== undefined) {
      return document.getText();
    }

    const loadedDocument = await defaultDocumentLoader.loadDocument(uri);
    if (loadedDocument === undefined) {
      return "";
    }

    return loadedDocument.getText();
  }
}
