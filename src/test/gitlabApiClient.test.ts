import { describe, expect, it, vi } from "vitest";

import { listOpenedMergeRequests, type FetchFn } from "../gitlabApiClient";

function createFetchResponse(
  status: number,
  body: unknown,
  options?: { throwOnJson?: boolean },
): ReturnType<FetchFn> extends Promise<infer T> ? T : never {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: options?.throwOnJson
      ? () => Promise.reject(new Error("invalid json"))
      : () => Promise.resolve(body),
  };
}

describe("listOpenedMergeRequests", () => {
  const protocol = "https" as const;
  const host = "gitlab.com";
  const projectPath = "group/sub/project";
  const sourceBranch = "feature/login";
  const token = "secret-token-value";

  it("builds encoded URL and query parameters", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createFetchResponse(200, []),
    );

    await listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, "", { fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(
      "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests?state=opened&source_branch=feature%2Flogin&per_page=20",
    );
    expect(init.headers["PRIVATE-TOKEN"]).toBeUndefined();
  });

  it("sends PRIVATE-TOKEN when provided", async () => {
    const fetch = vi.fn().mockResolvedValue(createFetchResponse(200, []));

    await listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, token, { fetch });

    const [, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["PRIVATE-TOKEN"]).toBe(token);
  });

  it("parses and sorts multiple merge requests by IID", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createFetchResponse(200, [
        {
          iid: 9,
          title: "Later",
          web_url: "https://gitlab.com/group/sub/project/-/merge_requests/9",
          source_branch: "feature/login",
          target_branch: "main",
          has_conflicts: false,
        },
        {
          iid: 3,
          title: "Earlier",
          web_url: "https://gitlab.com/group/sub/project/-/merge_requests/3",
          source_branch: "feature/login",
          target_branch: "main",
          has_conflicts: true,
        },
      ]),
    );

    const result = await listOpenedMergeRequests(
      protocol,
      host,
      projectPath,
      sourceBranch,
      token,
      { fetch },
    );

    expect(result).toEqual({
      ok: true,
      mergeRequests: [
        {
          iid: 3,
          title: "Earlier",
          webUrl: "https://gitlab.com/group/sub/project/-/merge_requests/3",
          sourceBranch: "feature/login",
          targetBranch: "main",
          hasConflicts: true,
        },
        {
          iid: 9,
          title: "Later",
          webUrl: "https://gitlab.com/group/sub/project/-/merge_requests/9",
          sourceBranch: "feature/login",
          targetBranch: "main",
          hasConflicts: false,
        },
      ],
    });
  });

  it("maps auth and not-found HTTP statuses", async () => {
    const unauthorizedFetch = vi.fn().mockResolvedValue(createFetchResponse(401, {}));
    const forbiddenFetch = vi.fn().mockResolvedValue(createFetchResponse(403, {}));
    const notFoundFetch = vi.fn().mockResolvedValue(createFetchResponse(404, {}));

    await expect(
      listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, token, {
        fetch: unauthorizedFetch,
      }),
    ).resolves.toEqual({ ok: false, error: "unauthorized" });
    await expect(
      listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, token, {
        fetch: forbiddenFetch,
      }),
    ).resolves.toEqual({ ok: false, error: "unauthorized" });
    await expect(
      listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, token, {
        fetch: notFoundFetch,
      }),
    ).resolves.toEqual({ ok: false, error: "not-found" });
  });

  it("returns invalid-response for malformed payloads", async () => {
    const missingFieldFetch = vi.fn().mockResolvedValue(
      createFetchResponse(200, [{ iid: 1, title: "x" }]),
    );
    const nonArrayFetch = vi.fn().mockResolvedValue(createFetchResponse(200, {}));
    const invalidJsonFetch = vi.fn().mockResolvedValue(
      createFetchResponse(200, [], { throwOnJson: true }),
    );

    await expect(
      listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, token, {
        fetch: missingFieldFetch,
      }),
    ).resolves.toEqual({ ok: false, error: "invalid-response" });
    await expect(
      listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, token, {
        fetch: nonArrayFetch,
      }),
    ).resolves.toEqual({ ok: false, error: "invalid-response" });
    await expect(
      listOpenedMergeRequests(protocol, host, projectPath, sourceBranch, token, {
        fetch: invalidJsonFetch,
      }),
    ).resolves.toEqual({ ok: false, error: "invalid-response" });
  });

  it("maps network failures without leaking token text", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error(`request failed with ${token}`));

    const result = await listOpenedMergeRequests(
      protocol,
      host,
      projectPath,
      sourceBranch,
      token,
      { fetch },
    );

    expect(result).toEqual({ ok: false, error: "network" });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
