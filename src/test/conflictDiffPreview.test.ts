import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import {
  extractConflictSides,
  fetchConflictSides,
  createConflictDiffPreviewer,
} from "../conflictDiffPreview";
import type { ConflictBlock } from "../types";

function makeConflict(id: string): ConflictBlock {
  return {
    id,
    startLine: 0,
    separatorLine: 2,
    endLine: 4,
    oursRange: { startLine: 1, endLine: 1 },
    theirsRange: { startLine: 3, endLine: 3 },
  };
}

describe("extractConflictSides", () => {
  it("returns ours and theirs line ranges", () => {
    const text = ["<<<<<<<", "ours-line", "=======", "theirs-line", ">>>>>>>"].join("\n");
    const result = extractConflictSides(text, makeConflict("a"));
    expect(result.ours).toEqual(["ours-line"]);
    expect(result.theirs).toEqual(["theirs-line"]);
  });

  it("handles empty sides", () => {
    const conflict: ConflictBlock = {
      id: "empty",
      startLine: 0,
      separatorLine: 0,
      endLine: 2,
      oursRange: { startLine: 0, endLine: -1 },
      theirsRange: { startLine: 1, endLine: 0 },
    };
    const result = extractConflictSides(
      ["<<<<<<<", "=======", ">>>>>>>"].join("\n"),
      conflict,
    );
    expect(result.ours).toEqual([]);
    expect(result.theirs).toEqual([]);
  });
});

describe("fetchConflictSides", () => {
  it("returns undefined when fetcher has no text", async () => {
    const result = await fetchConflictSides(
      "file:///missing.ts",
      makeConflict("a"),
      async () => undefined,
    );
    expect(result).toBeUndefined();
  });

  it("returns parsed sides when text is available", async () => {
    const text = ["<<<<<<<", "ours", "=======", "theirs", ">>>>>>>"].join("\n");
    const result = await fetchConflictSides(
      "file:///repo/a.ts",
      makeConflict("a"),
      async () => text,
    );
    expect(result?.ours).toEqual(["ours"]);
    expect(result?.theirs).toEqual(["theirs"]);
  });
});

describe("createConflictDiffPreviewer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens vscode.diff with temporary ours/theirs files", async () => {
    const executeCommand = vi.fn(async () => undefined);
    const fsRoot = `/tmp/conflict-resolver-test-${Math.random().toString(36).slice(2)}`;
    const fsModule = await import("node:fs/promises");
    await fsModule.mkdir(fsRoot, { recursive: true });
    const previewer = createConflictDiffPreviewer({
      fsRoot: () => fsRoot,
      fetchFileText: async () =>
        ["<<<<<<<", "ours", "=======", "theirs", ">>>>>>>"].join("\n"),
      workspacePath: () => "/repo",
    });

    const executeCommandModule = await import("vscode");
    const originalExecute = executeCommandModule.commands.executeCommand;
    Object.assign(executeCommandModule.commands, {
      executeCommand,
    });

    try {
      await previewer.openDiff(
        "file:///repo/src/a.ts",
        makeConflict("a"),
        { ours: ["ours"], theirs: ["theirs"] },
        "src/a.ts",
      );
    } finally {
      Object.assign(executeCommandModule.commands, {
        executeCommand: originalExecute,
      });
    }

    expect(executeCommand).toHaveBeenCalledTimes(1);
    const call = executeCommand.mock.calls[0] as unknown as [
      string,
      vscode.Uri,
      vscode.Uri,
      string,
      vscode.TextDocumentShowOptions,
    ];
    const [command, left, right, title, options] = call;
    expect(command).toBe("vscode.diff");
    expect(String(left)).toMatch(/ours\.tmp$/u);
    expect(String(right)).toMatch(/theirs\.tmp$/u);
    expect(title).toBe("src/a.ts · 当前 vs 传入");
    expect(options).toEqual({ preview: true });
    expect(options).toEqual({ preview: true });
  });
});