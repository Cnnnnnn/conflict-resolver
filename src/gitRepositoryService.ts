import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { GitUnmergedFile } from "./types";

const execFileAsync = promisify(execFile);

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

export type GitCommandRunner = (
  args: readonly string[],
) => Promise<GitCommandResult>;

export type MergeEditorCommandRunner = (uri: string) => Promise<void>;
export type RepositoryMarkerProbe = (candidatePath: string) => Promise<boolean>;

type GitServiceErrorCode =
  | "git-command-failed"
  | "invalid-git-output"
  | "unsafe-path"
  | "merge-editor-failed";

type GitServiceOperation =
  | "findRepositoryRoot"
  | "listUnmergedFiles"
  | "openMergeEditor";

type GitServiceErrorContext = {
  args?: readonly string[];
  exitCode?: number | null;
  relativePath?: string;
  stderr?: string;
  uri?: string;
};

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    args: readonly string[],
    exitCode: number | null,
    stderr: string,
    cause?: unknown,
  ) {
    super(`git ${args.join(" ")} failed`, { cause });
    this.name = "GitCommandError";
    this.args = [...args];
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class GitServiceError extends Error {
  readonly code: GitServiceErrorCode;
  readonly operation: GitServiceOperation;
  readonly context: GitServiceErrorContext;

  constructor(
    code: GitServiceErrorCode,
    operation: GitServiceOperation,
    message: string,
    context: GitServiceErrorContext = {},
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "GitServiceError";
    this.code = code;
    this.operation = operation;
    this.context = context;
  }
}

function isGitCommandError(error: unknown): error is GitCommandError {
  return error instanceof GitCommandError;
}

function hasCode(
  error: unknown,
  ...codes: readonly string[]
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function createGitCommandRunner(): GitCommandRunner {
  return async (args) => {
    try {
      const result = await execFileAsync("git", [...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          LANG: "C",
          LC_ALL: "C",
        },
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      const exitCode =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "number"
          ? error.code
          : null;
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr
          : "";

      throw new GitCommandError(args, exitCode, stderr, error);
    }
  };
}

function normalizeRepositoryRelativePath(relativePath: string): string {
  const normalized = posix.normalize(relativePath);

  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    throw new GitServiceError(
      "unsafe-path",
      "listUnmergedFiles",
      `Git reported an unsafe unmerged path: ${relativePath}`,
      { relativePath },
    );
  }

  return normalized;
}

function ensurePathStaysInsideRoot(
  repositoryRoot: string,
  relativePath: string,
): string {
  const resolvedRoot = resolve(repositoryRoot);
  const absolutePath = resolve(resolvedRoot, ...relativePath.split("/"));
  const rebased = relative(resolvedRoot, absolutePath);

  if (
    rebased === "" ||
    rebased === ".." ||
    rebased.startsWith(`..${sep}`) ||
    isAbsolute(rebased)
  ) {
    throw new GitServiceError(
      "unsafe-path",
      "listUnmergedFiles",
      `Git reported a path outside the repository root: ${relativePath}`,
      { relativePath },
    );
  }

  return absolutePath;
}

function mapGitCommandError(
  operation: GitServiceOperation,
  error: GitCommandError,
): GitServiceError {
  return new GitServiceError(
    "git-command-failed",
    operation,
    `Git command failed during ${operation}`,
    {
      args: error.args,
      exitCode: error.exitCode,
      stderr: error.stderr,
    },
    error,
  );
}

function mapRepositoryDiscoveryFailure(
  uri: string,
  candidatePath: string | undefined,
  error: unknown,
): GitServiceError {
  return new GitServiceError(
    "git-command-failed",
    "findRepositoryRoot",
    "Failed to discover the Git repository root",
    {
      args:
        candidatePath === undefined
          ? undefined
          : ["-C", candidatePath, "rev-parse", "--show-toplevel"],
      uri,
    },
    error,
  );
}

function stripTrailingLineTerminators(output: string): string {
  return output.replace(/[\r\n]+$/u, "");
}

async function resolveCandidatePath(uri: string): Promise<string> {
  const filesystemPath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;

  try {
    const candidateStat = await stat(filesystemPath);
    return candidateStat.isDirectory() ? filesystemPath : dirname(filesystemPath);
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) {
      return dirname(filesystemPath);
    }

    throw error;
  }
}

async function hasRepositoryMarkerInAncestors(
  candidatePath: string,
): Promise<boolean> {
  let currentPath = resolve(candidatePath);

  while (true) {
    try {
      await stat(resolve(currentPath, ".git"));
      return true;
    } catch (error) {
      if (!hasCode(error, "ENOENT", "ENOTDIR")) {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return false;
    }

    currentPath = parentPath;
  }
}

async function isNotRepositoryResult(
  candidatePath: string,
  error: GitCommandError,
  repositoryMarkerProbe: RepositoryMarkerProbe,
): Promise<boolean> {
  if (error.exitCode !== 128) {
    return false;
  }

  const stderr = error.stderr.trim();
  const isKnownNotRepositoryFailure =
    /^fatal: not a git repository(?: \(or any of the parent directories\): \.git)?$/m.test(
      stderr,
    );

  if (!isKnownNotRepositoryFailure) {
    return false;
  }

  return !(await repositoryMarkerProbe(candidatePath));
}

export class GitRepositoryService {
  private readonly runGit: GitCommandRunner;
  private readonly runMergeEditorCommand: MergeEditorCommandRunner;
  private readonly hasRepositoryMarkerInAncestors: RepositoryMarkerProbe;

  constructor(options?: {
    runGit?: GitCommandRunner;
    runMergeEditorCommand?: MergeEditorCommandRunner;
    hasRepositoryMarkerInAncestors?: RepositoryMarkerProbe;
  }) {
    this.runGit = options?.runGit ?? createGitCommandRunner();
    this.runMergeEditorCommand =
      options?.runMergeEditorCommand ??
      (async () => {
        throw new GitServiceError(
          "merge-editor-failed",
          "openMergeEditor",
          "No merge editor command runner has been configured",
        );
      });
    this.hasRepositoryMarkerInAncestors =
      options?.hasRepositoryMarkerInAncestors ?? hasRepositoryMarkerInAncestors;
  }

  async findRepositoryRoot(uri: string): Promise<string | undefined> {
    let candidatePath: string | undefined;

    try {
      candidatePath = await resolveCandidatePath(uri);
      const result = await this.runGit([
        "-C",
        candidatePath,
        "rev-parse",
        "--show-toplevel",
      ]);

      const repositoryRoot = stripTrailingLineTerminators(result.stdout);
      if (/^\s*$/u.test(repositoryRoot)) {
        throw new GitServiceError(
          "invalid-git-output",
          "findRepositoryRoot",
          "Git rev-parse returned an empty repository root",
          { args: ["-C", candidatePath, "rev-parse", "--show-toplevel"], uri },
        );
      }

      return repositoryRoot;
    } catch (error) {
      if (error instanceof GitServiceError) {
        throw error;
      }

      if (isGitCommandError(error)) {
        if (candidatePath === undefined) {
          throw mapRepositoryDiscoveryFailure(uri, candidatePath, error);
        }

        try {
          if (
            await isNotRepositoryResult(
              candidatePath,
              error,
              this.hasRepositoryMarkerInAncestors,
            )
          ) {
            return undefined;
          }
        } catch (discoveryError) {
          throw mapRepositoryDiscoveryFailure(uri, candidatePath, discoveryError);
        }

        throw mapGitCommandError("findRepositoryRoot", error);
      }

      throw mapRepositoryDiscoveryFailure(uri, candidatePath, error);
    }
  }

  async listUnmergedFiles(repositoryRoot: string): Promise<GitUnmergedFile[]> {
    try {
      const result = await this.runGit([
        "-C",
        repositoryRoot,
        "ls-files",
        "-u",
        "-z",
      ]);
      const records = result.stdout.split("\0").filter((record) => record.length > 0);
      const files = new Map<string, GitUnmergedFile>();

      for (const record of records) {
        const tabIndex = record.indexOf("\t");
        if (tabIndex === -1) {
          throw new GitServiceError(
            "invalid-git-output",
            "listUnmergedFiles",
            "Git ls-files output did not contain a path separator",
          );
        }

        const relativePath = normalizeRepositoryRelativePath(record.slice(tabIndex + 1));
        if (files.has(relativePath)) {
          continue;
        }

        const absolutePath = ensurePathStaysInsideRoot(repositoryRoot, relativePath);
        files.set(relativePath, {
          repositoryRoot,
          relativePath,
          uri: pathToFileURL(absolutePath).toString(),
        });
      }

      return [...files.values()];
    } catch (error) {
      if (error instanceof GitServiceError) {
        throw error;
      }

      if (isGitCommandError(error)) {
        throw mapGitCommandError("listUnmergedFiles", error);
      }

      throw new GitServiceError(
        "git-command-failed",
        "listUnmergedFiles",
        "Failed to list unmerged Git files",
        { args: ["-C", repositoryRoot, "ls-files", "-u", "-z"] },
        error,
      );
    }
  }

  async openMergeEditor(uri: string): Promise<void> {
    try {
      await this.runMergeEditorCommand(uri);
    } catch (error) {
      if (error instanceof GitServiceError) {
        throw error;
      }

      throw new GitServiceError(
        "merge-editor-failed",
        "openMergeEditor",
        "Failed to open the merge editor",
        { uri },
        error,
      );
    }
  }
}
