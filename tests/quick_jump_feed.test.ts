import { describe, expect, test } from "bun:test";
import {
  feedFreshnessTitle,
  formatRelativeAge,
  quickJumpFeedState,
  QUICK_JUMP_STALE_MS,
} from "../packages/ui/src/quick_jump_feed.ts";

const NOW = Date.UTC(2026, 10, 16, 3, 40, 0);

describe("quick_jump_feed · relative age", () => {
  test("reports sub-second and clock-skewed timestamps as just now", () => {
    expect(formatRelativeAge(NOW, NOW)).toBe("just now");
    expect(formatRelativeAge(NOW, NOW - 400)).toBe("just now");
    expect(formatRelativeAge(NOW, NOW + 5_000)).toBe("just now");
  });

  test("scales seconds, minutes, hours and days", () => {
    expect(formatRelativeAge(NOW, NOW - 1_500)).toBe("1s ago");
    expect(formatRelativeAge(NOW, NOW - 59_000)).toBe("59s ago");
    expect(formatRelativeAge(NOW, NOW - 60_000)).toBe("1m ago");
    expect(formatRelativeAge(NOW, NOW - 3_600_000)).toBe("1h ago");
    expect(formatRelativeAge(NOW, NOW - 90_000_000)).toBe("1d ago");
  });

  test("returns null when there is no usable timestamp", () => {
    expect(formatRelativeAge(NOW, null)).toBeNull();
    expect(formatRelativeAge(NOW, Number.NaN)).toBeNull();
  });
});

describe("quick_jump_feed · state", () => {
  test("a missing feed is pending, never just now", () => {
    expect(quickJumpFeedState(null, NOW)).toEqual({
      known: false,
      stale: false,
      label: "pending",
    });
  });

  test("marks a feed stale only past the budget", () => {
    expect(quickJumpFeedState(NOW - 2_000, NOW)).toEqual({
      known: true,
      stale: false,
      label: "2s ago",
    });
    expect(quickJumpFeedState(NOW - QUICK_JUMP_STALE_MS, NOW).stale).toBe(
      false,
    );
    expect(quickJumpFeedState(NOW - QUICK_JUMP_STALE_MS - 1, NOW)).toEqual({
      known: true,
      stale: true,
      label: "1m ago",
    });
  });

  test("accepts a caller-supplied stale budget", () => {
    expect(quickJumpFeedState(NOW - 30_000, NOW, 10_000).stale).toBe(true);
  });
});

describe("quick_jump_feed · tooltip copy", () => {
  test("names the feed source and states what the number means", () => {
    expect(
      feedFreshnessTitle(quickJumpFeedState(NOW - 5_000, NOW), "Live API"),
    ).toContain("Live API");
    expect(
      feedFreshnessTitle(quickJumpFeedState(null, NOW), "Pending Hydration"),
    ).toContain("reads 0");
    expect(
      feedFreshnessTitle(quickJumpFeedState(NOW - 120_000, NOW), "Live API"),
    ).toContain("last landed snapshot");
  });
});
