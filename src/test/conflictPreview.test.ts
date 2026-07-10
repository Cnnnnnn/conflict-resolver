import { describe, expect, it } from "vitest";

import { extractConflictPreview, formatConflictPreviewTooltip } from "../conflictPreview";
import type { ConflictBlock } from "../types";

const conflict: ConflictBlock = {
  id: "1",
  startLine: 0,
  separatorLine: 2,
  endLine: 4,
  oursRange: { startLine: 1, endLine: 1 },
  theirsRange: { startLine: 3, endLine: 3 },
};

describe("conflictPreview", () => {
  it("extracts ours and theirs preview lines", () => {
    const text = ["<<<<<<<", "ours-line", "=======", "theirs-line", ">>>>>>>"].join("\n");
    expect(extractConflictPreview(text, conflict)).toEqual({
      ours: ["ours-line"],
      theirs: ["theirs-line"],
    });
  });

  it("truncates long preview lines", () => {
    const longLine = "x".repeat(100);
    const text = ["<<<<<<<", longLine, "=======", "short", ">>>>>>>"].join("\n");
    expect(extractConflictPreview(text, conflict).ours[0]).toHaveLength(73);
    expect(extractConflictPreview(text, conflict).ours[0]?.endsWith("…")).toBe(true);
  });

  it("formats tooltip with both sides", () => {
    const text = ["<<<<<<<", "keep-local", "=======", "keep-remote", ">>>>>>>"].join("\n");
    expect(formatConflictPreviewTooltip("src/a.ts", conflict, text)).toContain("当前 (HEAD)");
    expect(formatConflictPreviewTooltip("src/a.ts", conflict, text)).toContain("keep-local");
    expect(formatConflictPreviewTooltip("src/a.ts", conflict, text)).toContain("传入");
    expect(formatConflictPreviewTooltip("src/a.ts", conflict, text)).toContain("keep-remote");
  });
});
