import { promises as fs } from "node:fs";
import { dirname, posix, sep } from "node:path";
import * as os from "node:os";

import * as vscode from "vscode";

import type { ConflictBlock } from "./types";

const DIFF_DIR_PREFIX = "conflict-resolver-diff-";

export type ConflictSides = {
  ours: string[];
  theirs: string[];
};

export type ConflictSideKind = "ours" | "theirs";

export type ConflictDiffPreviewer = {
  openDiff(
    uri: string,
    conflict: ConflictBlock,
    sides: ConflictSides,
    sourceLabel: string,
  ): Promise<void>;
};

type ConflictDiffPreviewerOptions = {
  fetchFileText?: (uri: string) => Promise<string | undefined>;
  workspacePath?: () => string | undefined;
  fsRoot?: () => string;
};

async function defaultFetchFileText(uri: string): Promise<string | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    return document.getText();
  } catch {
    return undefined;
  }
}

function defaultWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function defaultFsRoot(): string {
  return os.tmpdir();
}

function safeBaseName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return cleaned.length > 0 ? cleaned : "conflict";
}

export function extractConflictSides(
  text: string,
  conflict: ConflictBlock,
): ConflictSides {
  const lines = text.split("\n");
  const ours = lines.slice(conflict.oursRange.startLine, conflict.oursRange.endLine + 1);
  const theirs = lines.slice(
    conflict.theirsRange.startLine,
    conflict.theirsRange.endLine + 1,
  );
  return { ours, theirs };
}

export function extractConflictSideText(
  text: string,
  conflict: ConflictBlock,
  side: ConflictSideKind,
): string {
  const { ours, theirs } = extractConflictSides(text, conflict);
  return (side === "ours" ? ours : theirs).join("\n");
}

export class TempConflictDiffStore {
  private rootDir: string | undefined;
  private readonly created = new Set<string>();

  constructor(private readonly fsRoot: () => string = defaultFsRoot) {}

  async allocateDir(): Promise<string> {
    if (this.rootDir === undefined) {
      this.rootDir = await fs.mkdtemp(
        posix.join(this.fsRoot(), `${DIFF_DIR_PREFIX}${process.pid}-`),
      );
    }
    return this.rootDir;
  }

  async writeSide(
    filePath: string,
    side: ConflictSideKind,
    label: string,
    contents: string,
  ): Promise<string> {
    const dir = await this.allocateDir();
    const fileDir = dirname(filePath);
    const relativeSegments = fileDir.split(sep).filter((segment) => segment.length > 0);
    const targetDir = posix.join(dir, ...relativeSegments);
    await fs.mkdir(targetDir, { recursive: true });
    const base = safeBaseName(label);
    const target = posix.join(targetDir, `${base}.${side}.tmp`);
    await fs.writeFile(target, contents, "utf8");
    this.created.add(target);
    return target;
  }

  async cleanup(): Promise<void> {
    if (this.rootDir === undefined) {
      return;
    }
    for (const file of this.created) {
      try {
        await fs.unlink(file);
      } catch {
        // best effort cleanup; tmp dir will eventually be GC'd
      }
    }
    this.created.clear();
    try {
      await fs.rm(this.rootDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.rootDir = undefined;
  }
}

export function createConflictDiffPreviewer(
  options: ConflictDiffPreviewerOptions = {},
): ConflictDiffPreviewer {
  const fetchFileText = options.fetchFileText ?? defaultFetchFileText;
  const workspacePath = options.workspacePath ?? defaultWorkspacePath;
  const store = new TempConflictDiffStore(options.fsRoot);

  const openDiff: ConflictDiffPreviewer["openDiff"] = async (
    uri,
    conflict,
    sides,
    sourceLabel,
  ) => {
    const filePath = vscode.Uri.parse(uri).fsPath;
    const relativePath = workspacePath() === undefined
      ? filePath
      : filePath.startsWith(workspacePath()!)
        ? filePath.slice(workspacePath()!.length).replace(/^[/\\]/u, "")
        : filePath;

    const oursTarget = await store.writeSide(
      relativePath,
      "ours",
      `${sourceLabel}#${conflict.id}`,
      sides.ours.join("\n"),
    );
    const theirsTarget = await store.writeSide(
      relativePath,
      "theirs",
      `${sourceLabel}#${conflict.id}`,
      sides.theirs.join("\n"),
    );

    const oursUri = vscode.Uri.file(oursTarget);
    const theirsUri = vscode.Uri.file(theirsTarget);
    const title = `${sourceLabel} · 当前 vs 传入`;
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        oursUri,
        theirsUri,
        title,
        { preview: true },
      );
    } finally {
      void store.cleanup();
    }
  };

  return { openDiff };
}

export async function fetchConflictSides(
  uri: string,
  conflict: ConflictBlock,
  fetcher: (uri: string) => Promise<string | undefined> = defaultFetchFileText,
): Promise<ConflictSides | undefined> {
  const text = await fetcher(uri);
  if (text === undefined) {
    return undefined;
  }
  return extractConflictSides(text, conflict);
}