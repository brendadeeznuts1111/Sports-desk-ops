import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeWeblogCorpusPresent,
  resolveBridgeWeblogCorpusFrom,
} from "../lib/f402_weblog_bridge_inputs.ts";

describe("resolveBridgeWeblogCorpusFrom", () => {
  test("defaults to desk-date capture under out/f402/weblog", () => {
    const root = "/repo";
    const path = resolveBridgeWeblogCorpusFrom(root, {
      now: () => new Date("2026-11-08T12:00:00.000Z"),
    });
    expect(path).toBe(join(root, "out/f402/weblog/11-08-2026.jsonl"));
  });

  test("F402_WEBLOG_FROM overrides default", () => {
    const dir = mkdtempSync(join(tmpdir(), "weblog-from-"));
    const corpus = join(dir, "activity.jsonl");
    writeFileSync(corpus, "{}\n");
    try {
      expect(
        resolveBridgeWeblogCorpusFrom("/repo", {
          env: { F402_WEBLOG_FROM: corpus },
        }),
      ).toBe(corpus);
      expect(bridgeWeblogCorpusPresent(corpus).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
