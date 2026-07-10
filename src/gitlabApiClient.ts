import type { MergeRequestConflict } from "./types";

export type GitLabApiError =
  | "unauthorized"
  | "not-found"
  | "network"
  | "invalid-response";

export type GitLabApiResult =
  | { ok: true; mergeRequests: MergeRequestConflict[] }
  | { ok: false; error: GitLabApiError };

export type FetchFn = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const DEFAULT_PER_PAGE = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

type GitLabMergeRequestRecord = {
  iid?: unknown;
  title?: unknown;
  web_url?: unknown;
  source_branch?: unknown;
  target_branch?: unknown;
  has_conflicts?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMergeRequestRecord(record: unknown): MergeRequestConflict | undefined {
  if (!isRecord(record)) {
    return undefined;
  }

  const typed = record as GitLabMergeRequestRecord;
  if (
    typeof typed.iid !== "number" ||
    typeof typed.title !== "string" ||
    typeof typed.web_url !== "string" ||
    typeof typed.source_branch !== "string" ||
    typeof typed.target_branch !== "string" ||
    typeof typed.has_conflicts !== "boolean"
  ) {
    return undefined;
  }

  return {
    iid: typed.iid,
    title: typed.title,
    webUrl: typed.web_url,
    sourceBranch: typed.source_branch,
    targetBranch: typed.target_branch,
    hasConflicts: typed.has_conflicts,
  };
}

function buildApiUrl(
  protocol: "http" | "https",
  host: string,
  projectPath: string,
  sourceBranch: string,
): string {
  const encodedProject = encodeURIComponent(projectPath);
  const params = new URLSearchParams({
    state: "opened",
    source_branch: sourceBranch,
    per_page: String(DEFAULT_PER_PAGE),
  });
  return `${protocol}://${host}/api/v4/projects/${encodedProject}/merge_requests?${params.toString()}`;
}

function mapHttpStatus(status: number): GitLabApiError {
  if (status === 401 || status === 403) {
    return "unauthorized";
  }
  if (status === 404) {
    return "not-found";
  }
  return "network";
}

function containsToken(text: string, token: string): boolean {
  return token.length > 0 && text.includes(token);
}

export async function listOpenedMergeRequests(
  protocol: "http" | "https",
  host: string,
  projectPath: string,
  sourceBranch: string,
  token: string,
  options?: {
    fetch?: FetchFn;
    timeoutMs?: number;
    now?: () => number;
  },
): Promise<GitLabApiResult> {
  const fetchFn =
    options?.fetch ??
    ((globalThis as unknown as { fetch?: FetchFn }).fetch ??
      (() => Promise.reject(new Error("fetch is not available")) as ReturnType<FetchFn>));
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildApiUrl(protocol, host, projectPath, sourceBranch);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token.length > 0) {
    headers["PRIVATE-TOKEN"] = token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, { headers, signal: controller.signal });

    if (!response.ok) {
      return { ok: false, error: mapHttpStatus(response.status) };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: "invalid-response" };
    }

    if (!Array.isArray(payload)) {
      return { ok: false, error: "invalid-response" };
    }

    const mergeRequests: MergeRequestConflict[] = [];
    for (const item of payload) {
      const parsed = parseMergeRequestRecord(item);
      if (parsed === undefined) {
        return { ok: false, error: "invalid-response" };
      }
      mergeRequests.push(parsed);
    }

    mergeRequests.sort((left, right) => left.iid - right.iid);
    return { ok: true, mergeRequests };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (containsToken(message, token)) {
      return { ok: false, error: "network" };
    }
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}
