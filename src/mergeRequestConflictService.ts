import { GitRemoteService } from "./gitRemoteService";
import { listOpenedMergeRequests } from "./gitlabApiClient";
import type { FetchFn } from "./gitlabApiClient";
import type { RemoteMergeRequestSnapshot } from "./types";

export type MergeRequestConflictChangeListener = (
  snapshot: RemoteMergeRequestSnapshot,
) => void | Promise<void>;

export type MergeRequestConflictDisposable = {
  dispose(): void;
};

export type MergeRequestConfigReader = {
  getGitlabUrl(): string;
  getGitlabToken(): string;
  getEnvToken(): string | undefined;
};

export type MergeRequestConflictServiceOptions = {
  cacheTtlMs?: number;
  config?: MergeRequestConfigReader;
  fetch?: FetchFn;
  gitRemote?: GitRemoteService;
  now?: () => number;
};

const DEFAULT_CACHE_TTL_MS = 30_000;

const EMPTY_SNAPSHOT: RemoteMergeRequestSnapshot = {
  repositoryRoot: "",
  branch: "",
  mergeRequests: [],
  error: "not-configured",
  generatedAt: 0,
};

type CacheEntry = {
  key: string;
  snapshot: RemoteMergeRequestSnapshot;
  expiresAt: number;
};

function resolveToken(config: MergeRequestConfigReader): string {
  const envToken = config.getEnvToken();
  if (envToken !== undefined && envToken.length > 0) {
    return envToken;
  }
  return config.getGitlabToken();
}

function createCacheKey(repositoryRoot: string, branch: string): string {
  return `${repositoryRoot}::${branch}`;
}

export class MergeRequestConflictService {
  private readonly cacheTtlMs: number;
  private readonly config: MergeRequestConfigReader;
  private readonly fetch?: FetchFn;
  private readonly gitRemote: GitRemoteService;
  private readonly listeners = new Set<MergeRequestConflictChangeListener>();
  private readonly now: () => number;

  private cache: CacheEntry | undefined;
  private inFlightRefresh: Promise<RemoteMergeRequestSnapshot> | undefined;
  private snapshot: RemoteMergeRequestSnapshot = EMPTY_SNAPSHOT;

  constructor(options: MergeRequestConflictServiceOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.config = options.config ?? {
      getGitlabUrl: () => "https://gitlab.com",
      getGitlabToken: () => "",
      getEnvToken: () => process.env.GITLAB_TOKEN,
    };
    this.fetch = options.fetch;
    this.gitRemote = options.gitRemote ?? new GitRemoteService();
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): RemoteMergeRequestSnapshot {
    return this.snapshot;
  }

  onDidChange(
    listener: MergeRequestConflictChangeListener,
  ): MergeRequestConflictDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  scheduleRefresh(repositoryRoot: string): void {
    void this.refresh(repositoryRoot);
  }

  async refresh(
    repositoryRoot: string,
    force = false,
  ): Promise<RemoteMergeRequestSnapshot> {
    const cacheKey = this.cache?.key;
    const context = await this.gitRemote.getContext(repositoryRoot);

    if (context === undefined) {
      const nextSnapshot: RemoteMergeRequestSnapshot = {
        repositoryRoot,
        branch: "",
        mergeRequests: [],
        error: "not-configured",
        generatedAt: this.now(),
      };
      this.cache = undefined;
      return this.publish(nextSnapshot);
    }

    if ("error" in context) {
      const nextSnapshot: RemoteMergeRequestSnapshot = {
        repositoryRoot,
        branch: "",
        mergeRequests: [],
        error: context.error,
        generatedAt: this.now(),
      };
      this.cache = undefined;
      return this.publish(nextSnapshot);
    }

    const key = createCacheKey(repositoryRoot, context.branch);
    if (
      !force &&
      this.cache !== undefined &&
      this.cache.key === key &&
      this.cache.expiresAt > this.now()
    ) {
      return this.publish(this.cache.snapshot);
    }

    if (this.inFlightRefresh !== undefined && !force) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = this.queryAndPublish(
      repositoryRoot,
      context.host,
      context.protocol,
      context.projectPath,
      context.branch,
    ).finally(() => {
      this.inFlightRefresh = undefined;
    });

    return this.inFlightRefresh;
  }

  private async queryAndPublish(
    repositoryRoot: string,
    host: string,
    protocol: "http" | "https",
    projectPath: string,
    branch: string,
  ): Promise<RemoteMergeRequestSnapshot> {
    const token = resolveToken(this.config);
    const result = await listOpenedMergeRequests(
      protocol,
      host,
      projectPath,
      branch,
      token,
      { fetch: this.fetch },
    );

    if (result.ok) {
      const nextSnapshot: RemoteMergeRequestSnapshot = {
        repositoryRoot,
        branch,
        mergeRequests: result.mergeRequests,
        error: result.mergeRequests.length === 0 ? "not-found" : undefined,
        generatedAt: this.now(),
      };
      this.cache = {
        key: createCacheKey(repositoryRoot, branch),
        snapshot: nextSnapshot,
        expiresAt: this.now() + this.cacheTtlMs,
      };
      return this.publish(nextSnapshot);
    }

    const retainedMrs =
      this.snapshot.repositoryRoot === repositoryRoot &&
      this.snapshot.branch === branch
        ? this.snapshot.mergeRequests
        : [];

    const nextSnapshot: RemoteMergeRequestSnapshot = {
      repositoryRoot,
      branch,
      mergeRequests: retainedMrs,
      error: result.error,
      generatedAt: this.now(),
    };
    return this.publish(nextSnapshot);
  }

  private async publish(
    snapshot: RemoteMergeRequestSnapshot,
  ): Promise<RemoteMergeRequestSnapshot> {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      await listener(snapshot);
    }
    return snapshot;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
