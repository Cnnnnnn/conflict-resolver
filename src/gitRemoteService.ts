import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitCommandRunner = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export type GitLabProjectContext = {
  host: string;
  protocol: "http" | "https";
  projectPath: string;
  branch: string;
};

export type GitLabContextResult =
  | GitLabProjectContext
  | { error: "detached-head" }
  | undefined;

function createGitCommandRunner(): GitCommandRunner {
  return async (args) => {
    const result = await execFileAsync("git", [...args], {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

function stripTrailingLineTerminators(output: string): string {
  return output.replace(/[\r\n]+$/u, "");
}

function decodeProjectPath(rawPath: string): string {
  return rawPath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function stripGitSuffix(path: string): string {
  return path.endsWith(".git") ? path.slice(0, -4) : path;
}

export function parseGitLabRemoteUrl(remoteUrl: string): { host: string; protocol: "http" | "https"; projectPath: string } | undefined {
  const trimmed = remoteUrl.trim();

  const sshColonMatch = /^git@([^:]+):(.+)$/u.exec(trimmed);
  if (sshColonMatch !== null) {
    const projectPath = stripGitSuffix(sshColonMatch[2]);
    if (projectPath.length === 0) {
      return undefined;
    }
    return {
      host: sshColonMatch[1],
      protocol: "https",
      projectPath: decodeProjectPath(projectPath),
    };
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol === "http:" ? "http" : "https";

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const projectPath = stripGitSuffix(parsed.pathname.replace(/^\//u, ""));
      if (projectPath.length === 0) {
        return undefined;
      }
      return {
        host: parsed.host,
        protocol,
        projectPath: decodeProjectPath(projectPath),
      };
    }

    if (parsed.protocol === "ssh:") {
      const projectPath = stripGitSuffix(parsed.pathname.replace(/^\//u, ""));
      if (projectPath.length === 0) {
        return undefined;
      }
      return {
        host: parsed.host,
        protocol: "https",
        projectPath: decodeProjectPath(projectPath),
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export class GitRemoteService {
  private readonly runGit: GitCommandRunner;

  constructor(options?: { runGit?: GitCommandRunner }) {
    this.runGit = options?.runGit ?? createGitCommandRunner();
  }

  async getContext(repositoryRoot: string): Promise<GitLabContextResult> {
    const remoteUrl = await this.readOriginRemote(repositoryRoot);
    if (remoteUrl === undefined) {
      return undefined;
    }

    const parsed = parseGitLabRemoteUrl(remoteUrl);
    if (parsed === undefined) {
      return undefined;
    }

    const branch = await this.readCurrentBranch(repositoryRoot);
    if (branch === undefined) {
      return { error: "detached-head" };
    }

    return {
      host: parsed.host,
      protocol: parsed.protocol,
      projectPath: parsed.projectPath,
      branch,
    };
  }

  private async readOriginRemote(repositoryRoot: string): Promise<string | undefined> {
    try {
      const result = await this.runGit(["-C", repositoryRoot, "remote", "get-url", "origin"]);
      const remoteUrl = stripTrailingLineTerminators(result.stdout).trim();
      return remoteUrl.length === 0 ? undefined : remoteUrl;
    } catch {
      return undefined;
    }
  }

  private async readCurrentBranch(repositoryRoot: string): Promise<string | undefined> {
    try {
      const result = await this.runGit(["-C", repositoryRoot, "branch", "--show-current"]);
      const branch = stripTrailingLineTerminators(result.stdout).trim();
      return branch.length === 0 ? undefined : branch;
    } catch {
      return undefined;
    }
  }
}
