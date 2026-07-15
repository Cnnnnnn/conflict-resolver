import type { ConflictBlock } from "./types";

const MAX_PREVIEW_LINES = 3;
const MAX_LINE_LENGTH = 72;

export type ConflictPreviewSides = {
  ours: string[];
  theirs: string[];
};

export function extractConflictPreview(
  text: string,
  conflict: ConflictBlock,
): ConflictPreviewSides {
  return extractConflictPreviewFromLines(text.split(/\r?\n/), conflict);
}

export function extractConflictPreviewFromLines(
  lines: readonly string[],
  conflict: ConflictBlock,
): ConflictPreviewSides {
  return {
    ours: trimPreviewLines(
      lines.slice(conflict.oursRange.startLine, conflict.oursRange.endLine + 1),
    ),
    theirs: trimPreviewLines(
      lines.slice(conflict.theirsRange.startLine, conflict.theirsRange.endLine + 1),
    ),
  };
}

function trimPreviewLines(lines: string[]): string[] {
  return lines
    .slice(0, MAX_PREVIEW_LINES)
    .map((line) =>
      line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
    );
}

function formatSide(label: string, lines: string[]): string {
  const body = lines.length > 0 ? lines.join("\n") : "(空)";
  return `${label}\n${body}`;
}

export function formatConflictPreviewTooltip(
  relativePath: string,
  conflict: ConflictBlock,
  text: string | undefined,
  lines?: readonly string[],
): string {
  const header = `${relativePath}\n第 ${conflict.startLine + 1}–${conflict.endLine + 1} 行`;
  if (text === undefined) {
    return header;
  }

  const { ours, theirs } = lines === undefined
    ? extractConflictPreview(text, conflict)
    : extractConflictPreviewFromLines(lines, conflict);
  return [header, "", formatSide("当前 (HEAD)", ours), "", formatSide("传入", theirs)].join(
    "\n",
  );
}
