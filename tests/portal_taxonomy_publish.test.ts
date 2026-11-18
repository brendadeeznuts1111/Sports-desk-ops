import { describe, expect, test } from "bun:test";
import {
  PORTAL_TAXONOMY_MANIFEST_KEY,
  assertPortalTaxonomyEntries,
  publishPortalTaxonomyToR2,
  type PortalTaxonomyPublisherClient,
  type PortalTaxonomyR2ManifestPut,
} from "../src/lib/portal_taxonomy_r2_publish.ts";
import type { PortalTaxonomyEntry } from "../src/lib/portal_taxonomy_normalizer.ts";

/**
 * The taxonomy manifest has no in-repo producer: the dense codes come from the portal (its order
 * is NFL, CFB, NBA, NCAAB, NHL, MLB — not the catalog's NFL, NCAAF, NBA, NCAAB, WNBA, NHL), so the
 * table is an input. This pins the validation and the CAS shape the `xml:ingest` reader depends on.
 */

const ENTRIES: readonly PortalTaxonomyEntry[] = [
  { sport: "FOOTBALL", subSport: "NFL", denseCode6: 1, aliases: ["NFL"] },
  { sport: "FOOTBALL", subSport: "CFB", denseCode6: 2 },
  { sport: "BASKETBALL", subSport: "NBA", denseCode6: 3 },
];

interface Put {
  readonly key: string;
  readonly headers: PortalTaxonomyR2ManifestPut["headers"];
  readonly body: string;
}

function fakeClient(status = 200): {
  readonly client: PortalTaxonomyPublisherClient;
  readonly puts: Put[];
  readonly writes: { key: string; type?: string }[];
} {
  const puts: Put[] = [];
  const writes: { key: string; type?: string }[] = [];
  return {
    puts,
    writes,
    client: {
      async write(key, _data, opts) {
        writes.push({ key, ...(opts?.type ? { type: opts.type } : {}) });
        return undefined;
      },
      async fetch(key, init) {
        puts.push({ key, headers: init.headers, body: init.body });
        return new Response(null, { status });
      },
    },
  };
}

describe("publishPortalTaxonomyToR2", () => {
  test("first publish uses If-None-Match and writes a generation object", async () => {
    const fake = fakeClient();
    const result = await publishPortalTaxonomyToR2({
      client: fake.client,
      entries: ENTRIES,
      prevManifestETag: "",
      nextGenerationU32: 1,
    });

    expect(result.entryCount).toBe(3);
    expect(result.merkleRootSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.writes).toEqual([
      { key: result.generationKey, type: "application/json" },
    ]);
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.key).toBe(PORTAL_TAXONOMY_MANIFEST_KEY);
    expect(fake.puts[0]!.headers["If-None-Match"]).toBe("*");
    expect(fake.puts[0]!.headers["If-Match"]).toBeUndefined();

    // The body is the shape the reader parses.
    const manifest = JSON.parse(fake.puts[0]!.body) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual([
      "entries",
      "generation_u32",
      "merkle_root_sha256",
      "r2_published_at_epoch_ms",
    ]);
    expect(manifest.generation_u32).toBe(1);
    expect(manifest.entries).toEqual(ENTRIES);
  });

  test("a later publish CASes on the previous ETag", async () => {
    const fake = fakeClient();
    await publishPortalTaxonomyToR2({
      client: fake.client,
      entries: ENTRIES,
      prevManifestETag: '"xml-7"',
      nextGenerationU32: 8,
    });
    expect(fake.puts[0]!.headers["If-Match"]).toBe('"xml-7"');
    expect(fake.puts[0]!.headers["If-None-Match"]).toBeUndefined();
  });

  test("--dry-run validates and plans without writing", async () => {
    const fake = fakeClient();
    const result = await publishPortalTaxonomyToR2({
      client: fake.client,
      entries: ENTRIES,
      prevManifestETag: '"xml-7"',
      nextGenerationU32: 8,
      dryRun: true,
    });
    expect(result.r2PublishedAtEpochMs).toBe(0);
    expect(result.generationKey).toContain("gen-8-");
    expect(fake.writes).toEqual([]);
    expect(fake.puts).toEqual([]);
  });

  test("a 412 is ERR_R2_MANIFEST_CAS_REJECTED, never a rebase", async () => {
    const fake = fakeClient(412);
    await expect(
      publishPortalTaxonomyToR2({
        client: fake.client,
        entries: ENTRIES,
        prevManifestETag: '"xml-7"',
        nextGenerationU32: 8,
      }),
    ).rejects.toThrow("ERR_R2_MANIFEST_CAS_REJECTED");
  });
});

describe("assertPortalTaxonomyEntries", () => {
  test("accepts the portal table shape", () => {
    expect(() => assertPortalTaxonomyEntries(ENTRIES)).not.toThrow();
  });

  test("rejects codes outside 1..63, duplicates, and malformed rows", () => {
    expect(() => assertPortalTaxonomyEntries([])).toThrow(
      "ERR_PORTAL_TAXONOMY_INVALID",
    );
    for (const denseCode6 of [0, 64, 1.5]) {
      expect(() =>
        assertPortalTaxonomyEntries([
          { sport: "FOOTBALL", subSport: "NFL", denseCode6 },
        ]),
      ).toThrow(/denseCode6/);
    }
    expect(() =>
      assertPortalTaxonomyEntries([
        { sport: "FOOTBALL", subSport: "NFL", denseCode6: 1 },
        { sport: "FOOTBALL", subSport: "CFB", denseCode6: 1 },
      ]),
    ).toThrow(/reuses denseCode6 1/);
    expect(() =>
      assertPortalTaxonomyEntries([
        { sport: "FOOTBALL", subSport: "NFL", denseCode6: 1 },
        { sport: "football ", subSport: " nfl", denseCode6: 2 },
      ]),
    ).toThrow(/repeats/);
    expect(() =>
      assertPortalTaxonomyEntries([
        { sport: " ", subSport: "NFL", denseCode6: 1 },
      ]),
    ).toThrow(/non-empty/);
  });
});
