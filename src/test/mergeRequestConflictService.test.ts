import { describe, expect, it, vi } from "vitest";

import type { FetchFn } from "../gitlabApiClient";
import { MergeRequestConflictService } from "../mergeRequestConflictService";
import type { GitLabContextResult } from "../gitRemoteService";

function createFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function createService(options: {
  context: GitLabContextResult;
  fetch?: FetchFn;
  envToken?: string;
  configToken?: string;
  now?: () => number;
  cacheTtlMs?: number;
}) {
  let now = 1_000;
  const gitRemote = {
    getContext: vi.fn().mockResolvedValue(options.context),
  };
  const config = {
    getGitlabUrl: () => "https://gitlab.com",
    getGitlabToken: () => options.configToken ?? "",
    getEnvToken: () => options.envToken,
  };

  const service = new MergeRequestConflictService({
    cacheTtlMs: options.cacheTtlMs ?? 30_000,
    config,
    fetch: options.fetch,
    gitRemote: gitRemote as never,
    now: options.now ?? (() => now),
  });

  return {
    service,
  };
}

describe("MergeRequestConflictService", () => {
  it("returns not-configured for non-GitLab remotes", async () => {
    const { service } = createService({ context: undefined });

    const snapshot = await service.refresh("/repo");

    expect(snapshot.error).toBe("not-configured");
    expect(snapshot.mergeRequests).toEqual([]);
  });

  it("returns detached-head without network calls", async () => {
    const fetch = vi.fn();
    const { service } = createService({
      context: { error: "detached-head" },
      fetch,
    });

    const snapshot = await service.refresh("/repo");

    expect(snapshot.error).toBe("detached-head");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prefers GITLAB_TOKEN over configuration token", async () => {
    const fetch = vi.fn().mockResolvedValue(createFetchResponse(200, []));
    const { service } = createService({
      context: {
        host: "gitlab.com",
        protocol: "https",
        projectPath: "group/project",
        branch: "feature/login",
      },
      envToken: "env-token",
      configToken: "config-token",
      fetch,
    });

    await service.refresh("/repo");

    const [, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["PRIVATE-TOKEN"]).toBe("env-token");
  });

  it("marks empty MR lists as not-found", async () => {
    const fetch = vi.fn().mockResolvedValue(createFetchResponse(200, []));
    const { service } = createService({
      context: {
        host: "gitlab.com",
        protocol: "https",
        projectPath: "group/project",
        branch: "feature/login",
      },
      fetch,
    });

    const snapshot = await service.refresh("/repo");

    expect(snapshot.error).toBe("not-found");
    expect(snapshot.mergeRequests).toEqual([]);
  });

  it("reuses cache for the same repository and branch", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createFetchResponse(200, [
        {
          iid: 1,
          title: "MR",
          web_url: "https://gitlab.com/group/project/-/merge_requests/1",
          source_branch: "feature/login",
          target_branch: "main",
          has_conflicts: true,
        },
      ]),
    );
    const { service } = createService({
      context: {
        host: "gitlab.com",
        protocol: "https",
        projectPath: "group/project",
        branch: "feature/login",
      },
      fetch,
      cacheTtlMs: 60_000,
    });

    await service.refresh("/repo");
    await service.refresh("/repo");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forces refresh when requested", async () => {
    const fetch = vi.fn().mockResolvedValue(createFetchResponse(200, []));
    const { service } = createService({
      context: {
        host: "gitlab.com",
        protocol: "https",
        projectPath: "group/project",
        branch: "feature/login",
      },
      fetch,
    });

    await service.refresh("/repo");
    await service.refresh("/repo", true);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains the previous successful MR list on network failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        createFetchResponse(200, [
          {
            iid: 2,
            title: "Stable MR",
            web_url: "https://gitlab.com/group/project/-/merge_requests/2",
            source_branch: "feature/login",
            target_branch: "main",
            has_conflicts: false,
          },
        ]),
      )
      .mockRejectedValueOnce(new Error("network down"));

    const { service } = createService({
      context: {
        host: "gitlab.com",
        protocol: "https",
        projectPath: "group/project",
        branch: "feature/login",
      },
      fetch,
    });

    const success = await service.refresh("/repo");
    const failure = await service.refresh("/repo", true);

    expect(success.mergeRequests).toHaveLength(1);
    expect(failure.error).toBe("network");
    expect(failure.mergeRequests).toEqual(success.mergeRequests);
  });

  it("notifies listeners when snapshots change", async () => {
    const fetch = vi.fn().mockResolvedValue(createFetchResponse(200, []));
    const { service } = createService({
      context: {
        host: "gitlab.com",
        protocol: "https",
        projectPath: "group/project",
        branch: "feature/login",
      },
      fetch,
    });
    const listener = vi.fn();

    service.onDidChange(listener);
    await service.refresh("/repo");

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
