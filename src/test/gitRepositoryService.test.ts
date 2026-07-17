import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitCommandError,
  GitRepositoryService,
  GitServiceError,
  type GitCommandRunner,
} from "../gitRepositoryService";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });

  return result.stdout;
}

async function createTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// `git rev-parse --show-toplevel` emits forward-slash paths even on
// Windows; `realpath` returns native separators. Normalise so the test
// can compare them on any platform.
function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function createLsFilesOutput(
  records: Array<{ stage: number; relativePath: string }>,
): string {
  return records
    .map(
      ({ stage, relativePath }) =>
        `100644 ${"a".repeat(40)} ${stage}\t${relativePath}\0`,
    )
    .join("");
}

describe("GitRepositoryService", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirectories.map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      }),
    );
    tempDirectories.length = 0;
  });

  it("returns undefined when the candidate URI is outside a Git repository", async () => {
    const directory = await createTempDirectory("git-repo-service-no-repo-");
    tempDirectories.push(directory);

    const nestedFile = join(directory, "space name", "子目录", "conflict.txt");
    await mkdir(dirname(nestedFile), { recursive: true });
    await writeFile(nestedFile, "content", "utf8");

    const service = new GitRepositoryService();

    await expect(
      service.findRepositoryRoot(pathToFileURL(nestedFile).toString()),
    ).resolves.toBeUndefined();
  });

  it("forces a stable C locale for git discovery and classifies the canonical non-repo stderr as undefined", async () => {
    const directory = await createTempDirectory("git-repo-service-stable-locale-");
    tempDirectories.push(directory);

    const nestedFile = join(directory, "space name", "子目录", "conflict.txt");
    await mkdir(dirname(nestedFile), { recursive: true });
    await writeFile(nestedFile, "content", "utf8");

    const gitError = Object.assign(
      new Error("fatal: not a git repository (or any of the parent directories): .git"),
      {
        code: 128,
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      },
    );
    const execFileMock = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        callback(gitError);
      },
    );

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    try {
      const { GitRepositoryService: StableLocaleGitRepositoryService } = await import(
        "../gitRepositoryService"
      );
      const service = new StableLocaleGitRepositoryService();

      await expect(
        service.findRepositoryRoot(pathToFileURL(nestedFile).toString()),
      ).resolves.toBeUndefined();

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        "git",
        ["-C", dirname(nestedFile), "rev-parse", "--show-toplevel"],
        expect.objectContaining({
          encoding: "utf8",
          env: expect.objectContaining({
            LANG: "C",
            LC_ALL: "C",
          }),
        }),
        expect.any(Function),
      );
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("treats unrelated exit-128 stderr without a .git ancestor as a typed GitServiceError", async () => {
    const directory = await createTempDirectory(
      "git-repo-service-unrelated-exit-128-",
    );
    tempDirectories.push(directory);

    const nestedFile = join(directory, "space name", "子目录", "conflict.txt");
    await mkdir(dirname(nestedFile), { recursive: true });
    await writeFile(nestedFile, "content", "utf8");

    const candidatePath = dirname(nestedFile);
    const service = new GitRepositoryService({
      runGit: vi.fn().mockRejectedValue(
        new GitCommandError(
          ["-C", candidatePath, "rev-parse", "--show-toplevel"],
          128,
          "fatal: unrelated repository parsing failure",
        ),
      ),
    });

    await expect(
      service.findRepositoryRoot(pathToFileURL(nestedFile).toString()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GitServiceError &&
        error.code === "git-command-failed" &&
        error.operation === "findRepositoryRoot",
    );
  });

  it("throws invalid-git-output when git discovery succeeds with blank stdout", async () => {
    const directory = await createTempDirectory(
      "git-repo-service-blank-root-output-",
    );
    tempDirectories.push(directory);

    const nestedFile = join(directory, "repo", "conflict.txt");
    await mkdir(dirname(nestedFile), { recursive: true });
    await writeFile(nestedFile, "content", "utf8");

    const service = new GitRepositoryService({
      runGit: vi.fn().mockResolvedValue({
        stderr: "",
        stdout: "  \n\t  ",
      }),
    });

    await expect(
      service.findRepositoryRoot(pathToFileURL(nestedFile).toString()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GitServiceError &&
        error.code === "invalid-git-output" &&
        error.operation === "findRepositoryRoot",
    );
  });

  it("preserves leading and trailing spaces in repository roots while removing only line terminators", async () => {
    const directory = await createTempDirectory(
      "git-repo-service-spaced-root-output-",
    );
    tempDirectories.push(directory);

    const nestedFile = join(directory, "repo", "conflict.txt");
    await mkdir(dirname(nestedFile), { recursive: true });
    await writeFile(nestedFile, "content", "utf8");

    const service = new GitRepositoryService({
      runGit: vi.fn().mockResolvedValue({
        stderr: "",
        stdout: " /tmp/repo with spaces \r\n",
      }),
    });

    await expect(
      service.findRepositoryRoot(pathToFileURL(nestedFile).toString()),
    ).resolves.toBe(" /tmp/repo with spaces ");
  });

  it("throws a typed error when git rejects an unsafe repository", async () => {
    const repositoryRoot = await createTempDirectory("git-repo-service-unsafe-");
    tempDirectories.push(repositoryRoot);

    await mkdir(join(repositoryRoot, ".git"));

    const nestedFile = join(repositoryRoot, "conflict.txt");
    await writeFile(nestedFile, "content", "utf8");

    const service = new GitRepositoryService({
      runGit: vi.fn().mockRejectedValue(
        new GitCommandError(
          ["-C", repositoryRoot, "rev-parse", "--show-toplevel"],
          128,
          "fatal: detected dubious ownership in repository",
        ),
      ),
    });

    await expect(
      service.findRepositoryRoot(pathToFileURL(nestedFile).toString()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GitServiceError &&
        error.code === "git-command-failed" &&
        error.operation === "findRepositoryRoot",
    );
  });

  it("throws a typed error when git cannot access a repository candidate", async () => {
    const repositoryRoot = await createTempDirectory(
      "git-repo-service-permission-denied-",
    );
    tempDirectories.push(repositoryRoot);

    await mkdir(join(repositoryRoot, ".git"));

    const nestedFile = join(repositoryRoot, "conflict.txt");
    await writeFile(nestedFile, "content", "utf8");

    const service = new GitRepositoryService({
      runGit: vi.fn().mockRejectedValue(
        new GitCommandError(
          ["-C", repositoryRoot, "rev-parse", "--show-toplevel"],
          128,
          "fatal: cannot change to '/restricted/path': Permission denied",
        ),
      ),
    });

    await expect(
      service.findRepositoryRoot(pathToFileURL(nestedFile).toString()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GitServiceError &&
        error.code === "git-command-failed" &&
        error.operation === "findRepositoryRoot",
    );
  });

  it("wraps ancestor marker probe failures in a typed discovery error", async () => {
    const directory = await createTempDirectory("git-repo-service-marker-probe-");
    tempDirectories.push(directory);

    const restrictedDirectory = join(directory, "restricted");
    await mkdir(restrictedDirectory, { recursive: true });

    const permissionError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const hasRepositoryMarkerInAncestors = vi
      .fn()
      .mockRejectedValue(permissionError);

    const service = new GitRepositoryService({
      hasRepositoryMarkerInAncestors,
      runGit: vi.fn().mockRejectedValue(
        new GitCommandError(
          ["-C", restrictedDirectory, "rev-parse", "--show-toplevel"],
          128,
          "fatal: not a git repository (or any of the parent directories): .git",
        ),
      ),
    });

    await expect(
      service.findRepositoryRoot(pathToFileURL(restrictedDirectory).toString()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GitServiceError &&
        error.code === "git-command-failed" &&
        error.operation === "findRepositoryRoot" &&
        error.cause instanceof Error &&
        "code" in error.cause &&
        error.cause.code === permissionError.code,
    );

    expect(hasRepositoryMarkerInAncestors).toHaveBeenCalledWith(restrictedDirectory);
  });

  it("maps NUL-delimited unmerged records into unique repository-relative paths", async () => {
    const repositoryRoot = join(tmpdir(), "repo root");
    const runGit: GitCommandRunner = vi
      .fn()
      .mockResolvedValue({
        stderr: "",
        stdout: createLsFilesOutput([
          { stage: 1, relativePath: "folder with spaces/file one.txt" },
          { stage: 2, relativePath: "folder with spaces/file one.txt" },
          { stage: 3, relativePath: "unicøde/子 file.txt" },
        ]),
      });

    const service = new GitRepositoryService({ runGit });

    await expect(service.listUnmergedFiles(repositoryRoot)).resolves.toEqual([
      {
        repositoryRoot,
        relativePath: "folder with spaces/file one.txt",
        uri: pathToFileURL(
          join(repositoryRoot, "folder with spaces", "file one.txt"),
        ).toString(),
      },
      {
        repositoryRoot,
        relativePath: "unicøde/子 file.txt",
        uri: pathToFileURL(join(repositoryRoot, "unicøde", "子 file.txt")).toString(),
      },
    ]);

    expect(runGit).toHaveBeenCalledWith(["-C", repositoryRoot, "ls-files", "-u", "-z"]);
  });

  it("preserves literal backslashes in git-reported filenames", async () => {
    const repositoryRoot = join(tmpdir(), "repo-root");
    const runGit: GitCommandRunner = vi.fn().mockResolvedValue({
      stderr: "",
      stdout: createLsFilesOutput([{ stage: 1, relativePath: "a\\b.txt" }]),
    });

    const service = new GitRepositoryService({ runGit });

    await expect(service.listUnmergedFiles(repositoryRoot)).resolves.toEqual([
      {
        repositoryRoot,
        relativePath: "a\\b.txt",
        uri: pathToFileURL(join(repositoryRoot, "a\\b.txt")).toString(),
      },
    ]);
  });

  it("rejects unsafe relative paths from git output", async () => {
    const repositoryRoot = join(tmpdir(), "repo-root");
    const runGit: GitCommandRunner = vi.fn().mockResolvedValue({
      stderr: "",
      stdout: createLsFilesOutput([{ stage: 1, relativePath: "../escape.txt" }]),
    });

    const service = new GitRepositoryService({ runGit });

    await expect(service.listUnmergedFiles(repositoryRoot)).rejects.toMatchObject({
      code: "unsafe-path",
    });
  });

  it("maps git command failures to a typed GitServiceError", async () => {
    const repositoryRoot = join(tmpdir(), "repo-root");
    const runGit: GitCommandRunner = vi.fn().mockRejectedValue(
      new GitCommandError(
        ["-C", repositoryRoot, "ls-files", "-u", "-z"],
        128,
        "fatal: bad revision",
      ),
    );

    const service = new GitRepositoryService({ runGit });

    await expect(service.listUnmergedFiles(repositoryRoot)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GitServiceError &&
        error.code === "git-command-failed" &&
        error.operation === "listUnmergedFiles",
    );
  });

  it("delegates merge editor opening to the injected runner", async () => {
    const runMergeEditorCommand = vi.fn().mockResolvedValue(undefined);
    const service = new GitRepositoryService({ runMergeEditorCommand });
    const uri = "file:///tmp/conflicted.ts";

    await service.openMergeEditor(uri);

    expect(runMergeEditorCommand).toHaveBeenCalledWith(uri);
  });

  it("detects a real conflicted file in a temporary repository", async () => {
    const repositoryRoot = await createTempDirectory("git-repo-service-conflict-");
    tempDirectories.push(repositoryRoot);

    await runGit(repositoryRoot, ["init", "-b", "main"]);
    await runGit(repositoryRoot, ["config", "user.email", "test@example.com"]);
    await runGit(repositoryRoot, ["config", "user.name", "Test User"]);

    const conflictedFile = join(repositoryRoot, "folder name", "合并.txt");
    await mkdir(dirname(conflictedFile), { recursive: true });
    await writeFile(conflictedFile, "line\nbase\n", "utf8");
    await runGit(repositoryRoot, ["add", "."]);
    await runGit(repositoryRoot, ["commit", "-m", "base"]);

    await runGit(repositoryRoot, ["checkout", "-b", "feature"]);
    await writeFile(conflictedFile, "line\nfeature\n", "utf8");
    await runGit(repositoryRoot, ["commit", "-am", "feature"]);

    await runGit(repositoryRoot, ["checkout", "main"]);
    await writeFile(conflictedFile, "line\nmain\n", "utf8");
    await runGit(repositoryRoot, ["commit", "-am", "main"]);

    await expect(
      execFileAsync("git", ["-C", repositoryRoot, "merge", "feature"], {
        encoding: "utf8",
      }),
    ).rejects.toMatchObject({
      code: 1,
    });

    const service = new GitRepositoryService();
    const discoveredRoot = await service.findRepositoryRoot(
      pathToFileURL(conflictedFile).toString(),
    );

    expect(discoveredRoot).toBe(toPosixPath(await realpath(repositoryRoot)));
    await expect(service.listUnmergedFiles(repositoryRoot)).resolves.toEqual([
      {
        repositoryRoot,
        relativePath: "folder name/合并.txt",
        uri: pathToFileURL(conflictedFile).toString(),
      },
    ]);
  });
});
