import { describe, expect, test } from "bun:test";
import { weblogPublishDataWindowLogLine } from "../lib/f402_weblog_publish_log.ts";

describe("weblogPublishDataWindowLogLine", () => {
  test("names window end and whole-day age at publish", () => {
    const toMs = Date.parse("2026-11-04T23:59:59.000Z");
    const nowMs = Date.parse("2026-11-09T12:00:00.000Z");
    expect(weblogPublishDataWindowLogLine(toMs, nowMs)).toBe(
      "weblog: published rollup for data window 2026-11-04T23:59:59.000Z (4d old)",
    );
  });
});
