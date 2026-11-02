import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pullRawIngestionFeed,
  resolveIngestionFeedSource,
} from "../services/sportsdesk_ingestion_feed.ts";
import {
  ingestionFeedPullExitCode,
  pullIngestionFeedWithProvenance,
} from "../services/sportsdesk_ingestion_feed_provenance.ts";

const TMP = mkdtempSync(join(tmpdir(), "sportsdesk-ingestion-feed-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("sportsdesk_ingestion_feed", () => {
  test("resolve explicit URL", () => {
    const s = resolveIngestionFeedSource({
      url: "https://example.test/audit.jsonl",
    });
    expect(s?.url).toBe("https://example.test/audit.jsonl");
  });

  test("pull raw bytes from local file URL", async () => {
    const fixture = new URL(
      "../tests/fixtures/ingestion-replay-domain.jsonl",
      import.meta.url,
    );
    const { bytes } = await pullRawIngestionFeed({
      url: fixture.href,
      label: "test",
    });
    expect(bytes.byteLength).toBeGreaterThan(100);
    expect(new TextDecoder().decode(bytes.slice(0, 1))).toBe("{");
  });

  test("provenance: drain audit + sidecar + divergence", async () => {
    const fixture = new URL(
      "../tests/fixtures/ingestion-replay-domain.jsonl",
      import.meta.url,
    );
    const out = join(TMP, `prov-${Date.now()}.jsonl`);
    const first = await pullIngestionFeedWithProvenance(out, {
      url: fixture.href,
    });
    expect(first.provenance.jsonl.recordCount).toBe(9);
    expect(first.provenance.jsonl.corruptedLineSkips).toBe(0);
    expect(first.provenance.divergedFromPrior).toBe(false);
    expect(ingestionFeedPullExitCode(first.provenance)).toBe(0);
    await Bun.write(out, "not jsonl\n");
    const second = await pullIngestionFeedWithProvenance(out, {
      url: fixture.href,
    });
    expect(second.provenance.divergedFromPrior).toBe(true);
    expect(second.provenance.sha256Hex).toBe(first.provenance.sha256Hex);
    await Bun.write(out, "");
    await Bun.write(`${out}.provenance.json`, "");
  });
});
