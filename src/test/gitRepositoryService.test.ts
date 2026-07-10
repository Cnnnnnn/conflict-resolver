import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

    expect(discoveredRoot).toBe(await realpath(repositoryRoot));
    await expect(service.listUnmergedFiles(repositoryRoot)).resolves.toEqual([
      {
        repositoryRoot,
        relativePath: "folder name/合并.txt",
        uri: pathToFileURL(conflictedFile).toString(),
      },
    ]);
  });
});
