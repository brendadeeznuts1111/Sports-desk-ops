import { describe, expect, test } from "bun:test";
import { parseLiveSourceMode } from "../lib/desk_live_reads.ts";

describe("parseLiveSourceMode", () => {
  test("missing source defaults to live", () => {
    expect(parseLiveSourceMode(null)).toBe("live");
    expect(parseLiveSourceMode("")).toBe("live");
  });

  test("accepts explicit modes", () => {
    expect(parseLiveSourceMode("auto")).toBe("auto");
    expect(parseLiveSourceMode("file")).toBe("file");
    expect(parseLiveSourceMode("LIVE")).toBe("live");
  });

  test("rejects unknown values", () => {
    expect(parseLiveSourceMode("network")).toBe("invalid");
  });
});
