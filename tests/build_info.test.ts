import { describe, expect, test } from "bun:test";
import { getDashboardBuildInfo } from "../packages/ui/src/build_info.ts";

describe("build_info", () => {
  test("is null in an unbundled run, where the define identifiers are undeclared", () => {
    expect(getDashboardBuildInfo()).toBeNull();
  });
});
