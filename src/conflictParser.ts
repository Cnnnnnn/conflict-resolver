import type { ConflictBlock } from "./types";

export type ParseResult = {
  blocks: ConflictBlock[];
  error?: string;
};

const START_MARKER = "<<<<<<<";
const SEPARATOR_MARKER = "=======";
const END_MARKER = ">>>>>>>";

type ParserState = "normal" | "ours" | "theirs";

function isStartMarkerLine(line: string): boolean {
  return line === START_MARKER || /^<<<<<<< .+$/.test(line);
}

function isSeparatorMarkerLine(line: string): boolean {
  return line === SEPARATOR_MARKER;
}

function isEndMarkerLine(line: string): boolean {
  return line === END_MARKER || /^>>>>>>> .+$/.test(line);
}

export function parseConflictMarkers(text: string): ParseResult {
  if (text.length === 0) {
    return { blocks: [] };
  }

  const lines = text.split(/\r?\n/);
  const blocks: ConflictBlock[] = [];
  let state: ParserState = "normal";
  let startLine = -1;
  let separatorLine = -1;

  for (const [lineNumber, line] of lines.entries()) {
    if (state === "normal") {
      if (isStartMarkerLine(line)) {
        state = "ours";
        startLine = lineNumber;
        separatorLine = -1;
        continue;
      }

      if (isSeparatorMarkerLine(line) || isEndMarkerLine(line)) {
        return {
          blocks,
          error: `invalid conflict marker order at line ${lineNumber}`,
        };
      }

      continue;
    }

    if (state === "ours") {
      if (isSeparatorMarkerLine(line)) {
        state = "theirs";
        separatorLine = lineNumber;
        continue;
      }

      if (isEndMarkerLine(line)) {
        return {
          blocks,
          error: `invalid conflict marker order at line ${lineNumber}`,
        };
      }

      continue;
    }

    if (isEndMarkerLine(line)) {
      blocks.push({
        id: `${startLine}:${lineNumber}`,
        startLine,
        separatorLine,
        endLine: lineNumber,
        oursRange: {
          startLine: startLine + 1,
          endLine: separatorLine - 1,
        },
        theirsRange: {
          startLine: separatorLine + 1,
          endLine: lineNumber - 1,
        },
      });

      state = "normal";
      startLine = -1;
      separatorLine = -1;
      continue;
    }

    if (isSeparatorMarkerLine(line)) {
      return {
        blocks,
        error: `invalid conflict marker order at line ${lineNumber}`,
      };
    }
  }

  if (state !== "normal") {
    return {
      blocks,
      error: `incomplete conflict marker block starting at line ${startLine}`,
    };
  }

  return { blocks };
}
