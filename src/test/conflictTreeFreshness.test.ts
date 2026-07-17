import { describe, expect, it } from "vitest";

import { formatTreeFreshness } from "../conflictTreeProvider";

describe("formatTreeFreshness", () => {
  it("returns empty description for sentinel generatedAt of 0", () => {
    expect(formatTreeFreshness(0, 0)).toEqual({ description: "", stale: false });
  });

  it("reports just-now for very fresh snapshots", () => {
    expect(formatTreeFreshness(1_000, 1_500)).toEqual({ description: "刚刚", stale: false });
  });

  it("reports seconds elapsed between 1.5s and 60s", () => {
    expect(formatTreeFreshness(1_000, 4_500)).toEqual({ description: "3 秒前", stale: false });
    expect(formatTreeFreshness(1_000, 60_999)).toEqual({ description: "59 秒前", stale: false });
  });

  it("reports minutes elapsed after 60s and flags stale", () => {
    expect(formatTreeFreshness(1_000, 65_000)).toEqual({ description: "1 分钟前", stale: true });
    expect(formatTreeFreshness(1_000, 125_000)).toEqual({ description: "2 分钟前", stale: true });
  });

  it("does not flag stale within the first minute", () => {
    expect(formatTreeFreshness(1_000, 59_999).stale).toBe(false);
    expect(formatTreeFreshness(1_000, 61_000).stale).toBe(true);
  });

  it("clamps negative deltas (clock skew) to zero", () => {
    expect(formatTreeFreshness(2_000, 1_500)).toEqual({ description: "刚刚", stale: false });
  });
});