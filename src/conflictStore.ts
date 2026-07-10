import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseConflictMarkers } from "./conflictParser";
import type { ConflictFilter } from "./conflictFilter";
import { createConflictFilter } from "./conflictFilter";
import { hasLocatedConflictMarkers, toConflictFileKey } from "./conflictScmMenu";
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
  readDiskText?(uri: string): MaybePromise<string | undefined>;
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
  filter?: ConflictFilter;
  git?: ConflictStoreGitService;
  includeLockFiles?: boolean;
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
  async readDiskText(uri) {
    try {
      return await readFile(fileURLToPath(uri), "utf8");
    } catch {
      return undefined;
    }
  },
  async getRepositoryRoots() {
    return [];
  },
};

function hasLocatedConflictCandidate(text: string): boolean {
  return hasLocatedConflictMarkers(text);
}

function parseLocatedConflicts(
  text: string,
  parseConflicts: typeof parseConflictMarkers,
): Pick<ConflictFile, "locatedConflicts" | "parseError"> {
  if (!hasLocatedConflictCandidate(text)) {
    return { locatedConflicts: [], parseError: undefined };
  }

  const parsed = parseConflicts(text);
  if (parsed.blocks.length === 0 && parsed.error === undefined) {
    return { locatedConflicts: [], parseError: undefined };
  }

  return {
    locatedConflicts: parsed.blocks,
    parseError: parsed.error,
  };
}

function finalizeSnapshot(
  files: readonly ConflictFile[],
  now: () => number,
): ConflictSnapshot {
  const snapshotFiles = [...files].sort(compareFiles);

  return {
    files: snapshotFiles,
    generatedAt: now(),
    gitOnlyCount: snapshotFiles.filter(
      (file) =>
        file.gitUnmerged &&
        file.locatedConflicts.length === 0 &&
        file.parseError !== undefined,
    ).length,
    locatedCount: snapshotFiles.reduce(
      (count, file) => count + file.locatedConflicts.length,
      0,
    ),
  };
}

function shouldOmitResolvedGitFile(
  gitUnmerged: boolean,
  locatedConflicts: readonly ConflictBlock[],
  parseError: string | undefined,
): boolean {
  return (
    gitUnmerged &&
    locatedConflicts.length === 0 &&
    parseError === undefined
  );
}

function toFileSystemPath(uri: string): string | undefined {
  try {
    return resolve(new URL(uri).protocol === "file:" ? fileURLToPath(uri) : uri);
  } catch {
    return undefined;
  }
}

function canonicalizeDirectory(uri: string): string {
  const fileSystemPath = toFileSystemPath(uri);
  if (fileSystemPath === undefined) {
    return uri;
  }

  return dirname(fileSystemPath);
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

function findContainingRepositoryRoot(
  repositoryRoots: readonly string[],
  uri: string,
): string | undefined {
  const matches = repositoryRoots.filter(
    (repositoryRoot) =>
      toRepositoryRelativePath(repositoryRoot, uri) !== undefined,
  );

  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((left, right) => right.length - left.length);
  return matches[0];
}

function formatLoadError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error);

  return `Failed to load unmerged file: ${message}`;
}

type ConflictRecord = {
  file: ConflictFile;
};

export class ConflictStore {
  private readonly clearTimer: typeof clearTimeout;
  private readonly debounceMs: number;
  private readonly documents: ConflictStoreDocumentLoader;
  private readonly filter: ConflictFilter;
  private readonly git: ConflictStoreGitService;
  private readonly listeners = new Set<ConflictStoreChangeListener>();
  private readonly now: () => number;
  private readonly parseConflicts: typeof parseConflictMarkers;
  private readonly scheduleTimer: typeof setTimeout;

  private inFlightRefresh: Promise<ConflictSnapshot> | undefined;
  private pendingRefresh = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: ConflictSnapshot = EMPTY_SNAPSHOT;
  private readonly recentlyOmittedFiles = new Map<string, ConflictFile>();

  constructor(options: ConflictStoreOptions = {}) {
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.documents = options.documents ?? defaultDocumentLoader;
    this.filter = options.filter ?? createConflictFilter({
      includeLockFiles: options.includeLockFiles ?? false,
    });
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

  scheduleRefresh(_reason: string, options?: { debounceMs?: number }): void {
    this.clearScheduledRefresh();

    const debounceMs = options?.debounceMs ?? this.debounceMs;
    this.refreshTimer = this.scheduleTimer(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, debounceMs);
  }

  scheduleImmediateRefresh(_reason: string): void {
    this.clearScheduledRefresh();
    void this.refresh();
  }

  applyOpenDocumentText(uri: string, text: string): boolean {
    const key = toConflictFileKey(uri);
    const filteredOut = !this.filter.isIncluded(this.relativePathForFilter(uri, key));
    if (filteredOut) {
      const existing = this.snapshot.files.find(
        (file) => toConflictFileKey(file.uri) === key,
      );
      if (existing === undefined) {
        return false;
      }
      this.recentlyOmittedFiles.set(key, existing);
      this.snapshot = {
        ...this.snapshot,
        files: this.snapshot.files.filter(
          (file) => toConflictFileKey(file.uri) !== key,
        ),
        locatedCount: this.snapshot.locatedCount - existing.locatedConflicts.length,
      };
      return true;
    }

    const fileIndex = this.snapshot.files.findIndex(
      (file) => toConflictFileKey(file.uri) === key,
    );
    const existing = fileIndex >= 0 ? this.snapshot.files[fileIndex] : undefined;
    const hasMarkers = hasLocatedConflictCandidate(text);

    if (existing === undefined && !hasMarkers) {
      return false;
    }

    const { locatedConflicts, parseError } = parseLocatedConflicts(
      text,
      this.parseConflicts,
    );

    if (existing === undefined) {
      const cached = this.recentlyOmittedFiles.get(key);
      if (cached !== undefined && hasMarkers) {
        const restoredFile: ConflictFile = {
          ...cached,
          uri,
          locatedConflicts,
          parseError,
        };

        if (
          !shouldOmitResolvedGitFile(
            restoredFile.gitUnmerged,
            restoredFile.locatedConflicts,
            restoredFile.parseError,
          )
        ) {
          this.recentlyOmittedFiles.delete(key);
          this.publishSnapshot([...this.snapshot.files, restoredFile]);
          return true;
        }
      }

      if (hasMarkers) {
        this.scheduleImmediateRefresh("restored-markers");
        return true;
      }

      return false;
    }

    const updatedFile: ConflictFile = {
      ...existing,
      uri,
      locatedConflicts,
      parseError,
    };

    let nextFiles = [...this.snapshot.files];
    if (shouldOmitResolvedGitFile(
      updatedFile.gitUnmerged,
      updatedFile.locatedConflicts,
      updatedFile.parseError,
    )) {
      this.recentlyOmittedFiles.set(key, updatedFile);
      nextFiles = nextFiles.filter((file) => toConflictFileKey(file.uri) !== key);
    } else {
      this.recentlyOmittedFiles.delete(key);
      nextFiles[fileIndex] = updatedFile;
    }

    const previousCount = this.snapshot.locatedCount;
    const previousFiles = this.snapshot.files.length;
    const previousLocated = existing.locatedConflicts.length;
    this.publishSnapshot(nextFiles);

    return (
      this.snapshot.locatedCount !== previousCount ||
      this.snapshot.files.length !== previousFiles ||
      previousLocated !== locatedConflicts.length
    );
  }

  private publishSnapshot(files: readonly ConflictFile[]): void {
    this.snapshot = finalizeSnapshot(files, this.now);
    void this.emitDidChange(this.snapshot);
  }

  private syncRecentlyOmittedFiles(): void {
    for (const key of [...this.recentlyOmittedFiles.keys()]) {
      if (
        this.snapshot.files.some((file) => toConflictFileKey(file.uri) === key)
      ) {
        this.recentlyOmittedFiles.delete(key);
      }
    }
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
      this.syncRecentlyOmittedFiles();
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
    const repositoryRoots = new Set(
      [...await this.documents.getRepositoryRoots()].map((repositoryRoot) =>
        resolve(repositoryRoot),
      ),
    );
    const repositoryRootDiscoveries = new Map<string, Promise<string | undefined>>();

    const resolveRepositoryRoot = async (uri: string): Promise<string | undefined> => {
      const knownRepositoryRoot = findContainingRepositoryRoot(
        [...repositoryRoots],
        uri,
      );
      if (knownRepositoryRoot !== undefined) {
        return knownRepositoryRoot;
      }

      const directoryKey = canonicalizeDirectory(uri);
      const cachedDiscovery = repositoryRootDiscoveries.get(directoryKey);
      if (cachedDiscovery !== undefined) {
        return cachedDiscovery;
      }

      const discovery = (async () => {
        const discoveredRoot = await this.git.findRepositoryRoot(uri);
        if (discoveredRoot !== undefined) {
          const normalizedRoot = resolve(discoveredRoot);
          repositoryRoots.add(normalizedRoot);
          return normalizedRoot;
        }

        return undefined;
      })();

      repositoryRootDiscoveries.set(directoryKey, discovery);
      return discovery;
    };

    const openDocumentsByKey = new Map<string, ConflictStoreDocument>();
    for (const document of openDocuments) {
      openDocumentsByKey.set(toConflictFileKey(document.uri), document);
    }

    const openDocumentState = [];
    for (const document of openDocuments) {
      openDocumentState.push({
        document,
        key: toConflictFileKey(document.uri),
        repositoryRoot: await resolveRepositoryRoot(document.uri),
      });
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
        await this.mergeGitUnmergedFile(files, file, openDocumentsByKey);
      }
    }

    for (const entry of openDocumentState) {
      await this.mergeOpenDocument(files, entry.document, entry.repositoryRoot, entry.key);
    }

    const snapshotFiles = [...files.values()]
      .map((entry) => entry.file)
      .filter((file) => this.filter.isIncluded(file.relativePath))
      .filter(
        (file) =>
          !shouldOmitResolvedGitFile(
            file.gitUnmerged,
            file.locatedConflicts,
            file.parseError,
          ),
      );

    return finalizeSnapshot(snapshotFiles, this.now);
  }

  private async mergeGitUnmergedFile(
    files: Map<string, ConflictRecord>,
    gitFile: GitUnmergedFile,
    openDocumentsByKey: ReadonlyMap<string, ConflictStoreDocument>,
  ): Promise<void> {
    const key = toConflictFileKey(gitFile.uri);
    const existing = files.get(key);
    const openDocument = openDocumentsByKey.get(key);
    let locatedConflicts: ConflictBlock[] = [];
    let parseError: string | undefined;

    try {
      const text =
        openDocument !== undefined
          ? await openDocument.getText()
          : await this.readDiskText(gitFile.uri);
      const parsed = parseLocatedConflicts(text, this.parseConflicts);
      locatedConflicts = parsed.locatedConflicts;
      parseError = parsed.parseError;
    } catch (error) {
      parseError = formatLoadError(error);
    }

    if (
      shouldOmitResolvedGitFile(true, locatedConflicts, parseError)
    ) {
      return;
    }

    files.set(key, {
      file: {
        uri: openDocument?.uri ?? existing?.file.uri ?? gitFile.uri,
        repositoryRoot: gitFile.repositoryRoot,
        relativePath: gitFile.relativePath,
        locatedConflicts,
        gitUnmerged: true,
        parseError,
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

    const { locatedConflicts, parseError } = parseLocatedConflicts(
      text,
      this.parseConflicts,
    );

    if (existing === undefined) {
      if (locatedConflicts.length === 0) {
        return;
      }
    } else if (
      !this.filter.isIncluded(existing.file.relativePath) &&
      existing.file.locatedConflicts.length > 0
    ) {
      // ponytail: file became filtered; keep cached so toggling back restores it
      this.recentlyOmittedFiles.set(key, {
        ...existing.file,
        locatedConflicts,
        parseError,
      });
      return;
    } else if (
      shouldOmitResolvedGitFile(
        existing.file.gitUnmerged,
        locatedConflicts,
        parseError,
      )
    ) {
      files.delete(key);
      return;
    }

    if (locatedConflicts.length === 0 && existing === undefined) {
      return;
    }

    files.set(key, {
      file: {
        uri: document.uri,
        repositoryRoot: resolvedRepositoryRoot,
        relativePath,
        locatedConflicts,
        gitUnmerged: existing?.file.gitUnmerged ?? false,
        parseError,
      },
    });
  }

  private relativePathForFilter(uri: string, key: string): string {
    const existing = this.snapshot.files.find(
      (file) => toConflictFileKey(file.uri) === key,
    );
    if (existing !== undefined) {
      return existing.relativePath;
    }

    const fileSystemPath = toFileSystemPath(uri);
    if (fileSystemPath === undefined) {
      return uri;
    }
    return fileSystemPath;
  }

  private async readDiskText(uri: string): Promise<string> {
    if (this.documents.readDiskText !== undefined) {
      const text = await this.documents.readDiskText(uri);
      if (text !== undefined) {
        return text;
      }
    }

    return readFile(fileURLToPath(uri), "utf8");
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
