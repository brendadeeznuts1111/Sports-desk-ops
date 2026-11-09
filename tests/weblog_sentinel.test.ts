import { describe, expect, test } from "bun:test";
// ast-grep-ignore: node-fs-read-write-file -- sync fixtures for corpus presence test.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  formatWeblogSentinelMessage,
  runWeblogSentinelTick,
  weblogCorpusPresentOnDisk,
  weblogCorpusProbeForDeskDate,
} from "../lib/weblog_sentinel.ts";

describe("weblog_sentinel", () => {
  test("probe uses MM-DD-YYYY under repo and operator dir", () => {
    const root = "/repo";
    const probe = weblogCorpusProbeForDeskDate(root, "2026-11-09", "/probes");
    expect(probe.displayDate).toBe("11-09-2026");
    expect(probe.paths[0]).toBe("/repo/out/f402/weblog/11-09-2026.jsonl");
    expect(probe.paths[1]).toBe("/probes/11-09-2026.jsonl");
  });

  test("corpus present when either path exists", () => {
    const probe = weblogCorpusProbeForDeskDate("/r", "2026-11-09");
    expect(
      weblogCorpusPresentOnDisk(probe, (p) => p.endsWith("11-09-2026.jsonl")),
    ).toBe(true);
    expect(weblogCorpusPresentOnDisk(probe, () => false)).toBe(false);
  });

  test("format message names manual export action", () => {
    const html = formatWeblogSentinelMessage(
      weblogCorpusProbeForDeskDate("/r", "2026-11-09"),
    );
    expect(html).toContain("Weblog export missing");
    expect(html).toContain("11-09-2026");
    expect(html).toContain("weblog:rollup");
    expect(html).toContain("Cloudflare");
  });

  test("dry-run alerts once per desk date", async () => {
    const root = mkdtempSync(join(tmpdir(), "weblog-sentinel-"));
    const statePath = join(root, "state.json");
    let savedDeskDate: string | undefined;

    const first = await runWeblogSentinelTick({
      root,
      now: () => new Date("2026-11-09T14:00:00.000Z"),
      statePath,
      exists: () => false,
      dryRun: true,
      loadState: async () => ({
        schemaVersion: 1,
        lastMissingAlertDeskDate: null,
        updatedAt: "",
      }),
      saveState: async (s) => {
        savedDeskDate = s.lastMissingAlertDeskDate ?? undefined;
      },
    });
    expect(first.corpusPresent).toBe(false);
    expect(first.skippedReason).toBe("dry-run");
    expect(savedDeskDate).toBe("2026-11-09");

    const second = await runWeblogSentinelTick({
      root,
      now: () => new Date("2026-11-09T15:00:00.000Z"),
      statePath,
      exists: () => false,
      dryRun: true,
      loadState: async () => ({
        schemaVersion: 1,
        lastMissingAlertDeskDate: "2026-11-09",
        updatedAt: "",
      }),
    });
    expect(second.skippedReason).toBe("already-alerted");
  });

  test("skips when corpus staged in repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "weblog-sentinel-ok-"));
    const corpus = join(root, "out/f402/weblog/11-09-2026.jsonl");
    mkdirSync(join(root, "out/f402/weblog"), { recursive: true });
    writeFileSync(corpus, "{}\n", "utf8");

    const result = await runWeblogSentinelTick({
      root,
      now: () => new Date("2026-11-09T14:00:00.000Z"),
      exists: (p) => p === corpus,
    });
    expect(result.corpusPresent).toBe(true);
    expect(result.skippedReason).toBe("corpus-present");
  });
});
