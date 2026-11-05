import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushCaptureLog,
  logCaptureEvent,
} from "../lib/f402_hierarchy_redact_log.ts";

describe("capture log sink", () => {
  test("switching paths ends the previous FileSink without losing its line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-log-"));
    const first = join(dir, "first.jsonl");
    const second = join(dir, "second.jsonl");
    try {
      logCaptureEvent(first, { event: "first" });
      logCaptureEvent(second, { event: "second" });
      flushCaptureLog();

      expect(await Bun.file(first).text()).toContain('"event":"first"');
      expect(await Bun.file(second).text()).toContain('"event":"second"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
