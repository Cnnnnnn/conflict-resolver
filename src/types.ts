export type ConflictBlock = {
  id: string;
  startLine: number;
  separatorLine: number;
  endLine: number;
  oursRange: { startLine: number; endLine: number };
  theirsRange: { startLine: number; endLine: number };
};

export type ConflictFile = {
  uri: string;
  repositoryRoot: string;
  relativePath: string;
  locatedConflicts: ConflictBlock[];
  gitUnmerged: boolean;
  parseError?: string;
};

export type ConflictSnapshot = {
  files: ConflictFile[];
  locatedCount: number;
  gitOnlyCount: number;
  generatedAt: number;
};

export type GitUnmergedFile = {
  uri: string;
  repositoryRoot: string;
  relativePath: string;
};

export type MergeRequestConflict = {
  iid: number;
  title: string;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  hasConflicts: boolean;
};

export type RemoteMergeRequestSnapshot = {
  repositoryRoot: string;
  branch: string;
  mergeRequests: MergeRequestConflict[];
  error?:
    | "not-configured"
    | "not-found"
    | "unauthorized"
    | "network"
    | "invalid-response"
    | "detached-head";
  generatedAt: number;
};
