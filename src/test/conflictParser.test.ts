import { describe, expect, it } from "vitest";

import { parseConflictMarkers } from "../conflictParser";

describe("parseConflictMarkers", () => {
  it("finds a complete conflict block with zero-based lines", () => {
    const result = parseConflictMarkers(
      "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nb",
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      startLine: 1,
      separatorLine: 3,
      endLine: 5,
    });
  });

  it("finds multiple complete conflict blocks", () => {
    const result = parseConflictMarkers(
      [
        "<<<<<<< HEAD",
        "ours-1",
        "=======",
        "theirs-1",
        ">>>>>>> branch-1",
        "middle",
        "<<<<<<< HEAD",
        "ours-2",
        "=======",
        "theirs-2",
        ">>>>>>> branch-2",
      ].join("\n"),
    );

    expect(result.error).toBeUndefined();
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map((block) => block.startLine)).toEqual([0, 6]);
  });

  it("supports CRLF and Unicode text", () => {
    const result = parseConflictMarkers(
      "前\r\n<<<<<<< HEAD\r\n甲\r\n=======\r\n乙\r\n>>>>>>> branch",
    );

    expect(result.blocks[0].oursRange.startLine).toBe(2);
  });

  it("reports an incomplete marker without throwing", () => {
    const result = parseConflictMarkers("<<<<<<< HEAD\nours");

    expect(result.blocks).toHaveLength(0);
    expect(result.error).toContain("incomplete");
  });

  it("reports invalid marker order without throwing", () => {
    const result = parseConflictMarkers("=======\n>>>>>>> branch");

    expect(result.blocks).toHaveLength(0);
    expect(result.error).toContain("invalid");
  });

  it("returns an empty result for empty input", () => {
    expect(parseConflictMarkers("")).toEqual({ blocks: [] });
  });

  it("does not treat marker-like text inside a completed block as a second block", () => {
    const result = parseConflictMarkers(
      [
        "<<<<<<< HEAD",
        "ours",
        "=======",
        "<<<<<<< not-a-new-block",
        ">>>>>>> feature",
      ].join("\n"),
    );

    expect(result.error).toBeUndefined();
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      startLine: 0,
      separatorLine: 2,
      endLine: 4,
      theirsRange: {
        startLine: 3,
        endLine: 3,
      },
    });
  });

  it("requires exact marker lines for separators and block boundaries", () => {
    const result = parseConflictMarkers(
      [
        "<<<<<<<< not-a-start",
        "<<<<<<< HEAD",
        "ours",
        "======= not-a-separator",
        "=======",
        ">>>>>>>> not-an-end",
        "theirs",
        ">>>>>>> feature",
      ].join("\n"),
    );

    expect(result.error).toBeUndefined();
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      startLine: 1,
      separatorLine: 4,
      endLine: 7,
      oursRange: {
        startLine: 2,
        endLine: 3,
      },
      theirsRange: {
        startLine: 5,
        endLine: 6,
      },
    });
  });

  it("ignores prefixed marker-like content outside a conflict block", () => {
    const result = parseConflictMarkers(
      [
        "<<<<<<<< not-a-start",
        "======= not-a-separator",
        ">>>>>>>> not-an-end",
      ].join("\n"),
    );

    expect(result).toEqual({ blocks: [] });
  });
});
