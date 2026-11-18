import { afterAll, describe, expect, test } from "bun:test";
import {
  assertLiveRuntimePreflight,
  DenseSubSportLookupTable,
  serializeSoAToCanonicalXml,
  UnmappedTaxonomyQuarantineRing,
  type PortalTaxonomyEntry,
} from "../packages/sportsdesk-ops/src/bin/xml-parse.ts";
import {
  createXmlOddsFeedColumnStore,
  hydrateXmlOddsFeedIntoSoA,
} from "../src/lib/xml_feed_spine_hydrator.ts";

const BIN = joinBin();
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <event id="42" sport="FOOTBALL" subSport="NFL" line="3.5" wagerType="1" period="2" marketKind="1"/>
  <event id="43" sport="BASKETBALL" subSport="NBA" line="-110" wagerType="2" period="0" marketKind="0"/>
</feed>`;

const TAXONOMY_MANIFEST = {
  generation_u32: 7,
  entries: [
    { sport: "FOOTBALL", subSport: "NFL", denseCode6: 1 },
    { sport: "BASKETBALL", subSport: "NBA", denseCode6: 3 },
  ],
};

const INGEST_MANIFEST = {
  generation_u32: 41,
  merkle_root_sha256: "b".repeat(64),
  watermark_cursor: "wm-41",
  data_window_max_epoch_ms: 1_762_000_000_000,
  r2_published_at_epoch_ms: 1_762_000_000_000,
  chunk_key: `chunks/${"b".repeat(64)}.bin`,
  circuit_state: "CLOSED" as const,
};

function joinBin(): string {
  return `${import.meta.dir}/../packages/sportsdesk-ops/src/bin/xml-parse.ts`;
}

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

interface MockS3 {
  endpoint: string;
  readonly objects: Map<string, { body: Uint8Array; etag: string }>;
  readonly puts: Array<{ key: string; ifMatch: string | null }>;
  rejectManifestPut: boolean;
}

function startMockS3(): MockS3 {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  objects.set("manifests/portal-taxonomy/latest", {
    body: new TextEncoder().encode(JSON.stringify(TAXONOMY_MANIFEST)),
    etag: '"tax-1"',
  });
  objects.set("manifests/xml-ingest/latest", {
    body: new TextEncoder().encode(JSON.stringify(INGEST_MANIFEST)),
    etag: '"xml-41"',
  });
  const puts: MockS3["puts"] = [];
  const state: MockS3 = {
    endpoint: "",
    objects,
    puts,
    rejectManifestPut: false,
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.replace(/^\/+/, "").split("/");
      const bucket = parts.shift() ?? "";
      if (bucket !== "sportsdesk-ops-reports") {
        return new Response("wrong bucket", { status: 400 });
      }
      const key = parts.join("/");
      const current = objects.get(key);

      if (req.method === "HEAD") {
        return current === undefined
          ? new Response(null, { status: 404 })
          : new Response(null, {
              status: 200,
              headers: { etag: current.etag },
            });
      }
      if (req.method === "GET") {
        return current === undefined
          ? new Response(null, { status: 404 })
          : new Response(current.body, {
              status: 200,
              headers: {
                etag: current.etag,
                "content-type": "application/json",
              },
            });
      }
      if (req.method === "PUT") {
        const ifMatch = req.headers.get("if-match");
        puts.push({ key, ifMatch });
        if (
          key === "manifests/xml-ingest/latest" &&
          (state.rejectManifestPut ||
            (ifMatch !== null &&
              current !== undefined &&
              ifMatch !== current.etag))
        ) {
          return new Response(null, { status: 412 });
        }
        const body = new Uint8Array(await req.arrayBuffer());
        objects.set(key, { body, etag: `"v${puts.length}"` });
        return new Response(null, {
          status: 200,
          headers: { etag: `"v${puts.length}"` },
        });
      }
      return new Response("method not allowed", { status: 405 });
    },
  });
  servers.push(server);
  state.endpoint = `http://127.0.0.1:${server.port}`;
  return state;
}

function startFeed(
  body = FEED_XML,
  headers: Record<string, string> = {},
): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(body, {
        headers: { "content-type": "application/xml", ...headers },
      }),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/feed.xml`;
}

const RETIRED = [
  "DOD6_SPINE_PATH",
  "DOD_SPINE_PATH",
  "F402_BETS_JSONL_PATH",
  "DOD_SQLITE_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

function baseEnv(s3: MockS3 | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of RETIRED) delete env[key];
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_R2_API_TOKEN;
  if (s3 !== null) {
    env.R2_ACCESS_KEY_ID = "test-access";
    env.R2_SECRET_ACCESS_KEY = "test-secret";
    env.R2_ENDPOINT = s3.endpoint;
  }
  return env;
}

async function runCli(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// @bun-behavior: xml-parse

describe("xml-parse · DenseSubSportLookupTable", () => {
  const entries: PortalTaxonomyEntry[] = [
    { sport: "FOOTBALL", subSport: "NFL", denseCode6: 1 },
    { sport: "Basketball", subSport: " nba ", denseCode6: 3 },
    { sport: "FOOTBALL", subSport: null, denseCode6: 5 },
  ];

  test("resolves canonical pairs case/whitespace-insensitively", () => {
    const table = new DenseSubSportLookupTable(entries);
    expect(table.resolve("FOOTBALL", "NFL")).toBe(1);
    expect(table.resolve(" football ", "nfl")).toBe(1);
    expect(table.resolve("BASKETBALL", "NBA")).toBe(3);
  });

  test("unknown and null sub-sports resolve to the unknown code", () => {
    const table = new DenseSubSportLookupTable(entries);
    expect(table.resolve("FOOTBALL", null)).toBe(0);
    expect(table.resolve("FOOTBALL", "XYZ")).toBe(0);
    expect(table.resolve("", "NFL")).toBe(0);
  });

  test("rejects dense codes outside 1..63", () => {
    expect(
      () =>
        new DenseSubSportLookupTable([
          { sport: "FOOTBALL", subSport: "NFL", denseCode6: 0 },
        ]),
    ).toThrow("ERR_DOD_BITFIELD_RANGE_OVERFLOW");
    expect(
      () =>
        new DenseSubSportLookupTable([
          { sport: "FOOTBALL", subSport: "NFL", denseCode6: 64 },
        ]),
    ).toThrow("ERR_DOD_BITFIELD_RANGE_OVERFLOW");
  });
});

describe("xml-parse · live runtime preflight", () => {
  const ok = {
    R2_ACCESS_KEY_ID: "a",
    R2_SECRET_ACCESS_KEY: "b",
    R2_ENDPOINT: "http://x",
  };

  test("rejects retired fallback env keys", () => {
    for (const key of RETIRED) {
      expect(() =>
        assertLiveRuntimePreflight(
          { ...ok, [key]: "set" },
          "https://x/feed.xml",
          16,
        ),
      ).toThrow(`ERR_DOD_LEGACY_FALLBACK_REMOVED: ${key}`);
    }
  });

  test("rejects the Cloudflare token bleed", () => {
    expect(() =>
      assertLiveRuntimePreflight(
        { ...ok, CLOUDFLARE_R2_API_TOKEN: "r2", CLOUDFLARE_API_TOKEN: "cf" },
        "https://x/feed.xml",
        16,
      ),
    ).toThrow("ERR_CF_TOKEN_BLEED_10000");
  });

  test("rejects local JSON surfaces and non-HTTP feeds", () => {
    for (const feed of [
      "/var/tmp/feed.xml",
      "file:///tmp/feed.xml",
      "https://x/feed.json",
      "https://x/feed.jsonl?x=1",
      "https://x/feed.sqlite",
      "https://x/feed.dodbin",
    ]) {
      expect(() => assertLiveRuntimePreflight(ok, feed, 16)).toThrow(
        "ERR_OPS_LOCAL_JSON_FORBIDDEN",
      );
    }
  });

  test("bounds capacity", () => {
    for (const capacity of [0, -1, 1.5, 1_048_577]) {
      expect(() =>
        assertLiveRuntimePreflight(ok, "https://x/feed.xml", capacity),
      ).toThrow("ERR_DOD_BITFIELD_RANGE_OVERFLOW");
    }
    expect(() =>
      assertLiveRuntimePreflight(ok, "https://x/feed.xml", 64),
    ).not.toThrow();
  });
});

describe("xml-parse · canonical SoA serialization", () => {
  test("writes row attributes and watermark lineage", () => {
    const store = createXmlOddsFeedColumnStore(4);
    hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(FEED_XML),
      store,
      (sport, sub) => (sport === "FOOTBALL" && sub === "NFL" ? 1 : 3),
    );
    const bytes = serializeSoAToCanonicalXml(
      store,
      "wm-1:2",
      1_762_000_000_000,
    );
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(
      '<sportsdeskXmlFeed watermarkCursor="wm-1:2" dataWindowMaxEpochMs="1762000000000" rowCount="2">',
    );
    const parsed = Bun.XML.parse(bytes) as {
      sportsdeskXmlFeed: {
        "@rowCount": string;
        event: Array<Record<string, string>>;
      };
    };
    expect(parsed.sportsdeskXmlFeed["@rowCount"]).toBe("2");
    expect(parsed.sportsdeskXmlFeed.event[0]?.["@id"]).toBe("42");
    expect(parsed.sportsdeskXmlFeed.event[0]?.["@subSportCode6"]).toBe("1");
    expect(parsed.sportsdeskXmlFeed.event[0]?.["@lineHundredths"]).toBe("350");
    expect(parsed.sportsdeskXmlFeed.event[1]?.["@subSportCode6"]).toBe("3");
  });
});

describe("xml-parse · unmapped quarantine ring", () => {
  test("dedupes, caps, and flushes a hashed key", async () => {
    const ring = new UnmappedTaxonomyQuarantineRing(2);
    ring.record("FOOTBALL", "XYZ");
    ring.record("FOOTBALL", "XYZ");
    ring.record("BASKETBALL", "QQQ");
    ring.record("THIRD", "AAA");
    expect(ring.size).toBe(2);

    const writes: Array<{
      key: string;
      type: string | undefined;
      body: string;
    }> = [];
    const key = await ring.flushToR2({
      write: async (writeKey, data, options) => {
        writes.push({
          key: writeKey,
          type: options?.type,
          body:
            typeof data === "string" ? data : new TextDecoder().decode(data),
        });
        return 0;
      },
    });
    expect(key).not.toBeNull();
    expect(key ?? "").toMatch(
      /^quarantine\/portal-taxonomy\/unmapped\/\d+-[0-9a-f]{16}\.json$/,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(key ?? "");
    expect(writes[0]?.type).toBe("application/json");
    const body = JSON.parse(writes[0]!.body) as {
      count: number;
      pairs: Array<{ sport: string; subSport: string }>;
    };
    expect(body.count).toBe(2);
    expect(body.pairs.map((pair) => pair.subSport)).toEqual(["XYZ", "QQQ"]);
  });

  test("an empty ring flushes nothing", async () => {
    const ring = new UnmappedTaxonomyQuarantineRing();
    expect(await ring.flushToR2({ write: async () => 0 })).toBeNull();
  });
});

describe("xml-parse · end-to-end against a mock R2 + live feed", () => {
  test("dry-run hydrates and plans without snapshot writes", async () => {
    const s3 = startMockS3();
    const feed = startFeed();
    const result = await runCli(["--url", feed, "--dry-run"], baseEnv(s3));
    expect(result.exitCode, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      dry_run: boolean;
      hydrated_rows: number;
      generation_u32: number;
      r2_published_at_epoch_ms: number;
      merkle_root_sha256: string;
      quarantine_key: string | null;
    };
    expect(summary.dry_run).toBe(true);
    expect(summary.hydrated_rows).toBe(2);
    expect(summary.generation_u32).toBe(42);
    expect(summary.merkle_root_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.r2_published_at_epoch_ms).toBe(0);
    expect(summary.quarantine_key).toBeNull();
    expect(s3.puts).toHaveLength(0);
  });

  test("CAS-promotes chunk + generation + manifest with If-Match", async () => {
    const s3 = startMockS3();
    const feed = startFeed(FEED_XML, { "x-next-watermark-cursor": "wm-99" });
    const result = await runCli(
      ["--url", feed, "--capacity", "64"],
      baseEnv(s3),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      generation_u32: number;
      merkle_root_sha256: string;
      watermark_cursor: string;
      hydrated_rows: number;
      dry_run: boolean;
    };
    expect(summary.dry_run).toBe(false);
    expect(summary.hydrated_rows).toBe(2);
    expect(summary.generation_u32).toBe(42);
    expect(summary.watermark_cursor).toBe("wm-99");

    const chunkKey = `chunks/${summary.merkle_root_sha256}.bin`;
    const putKeys = s3.puts.map((put) => put.key);
    expect(putKeys).toContain(chunkKey);
    expect(
      putKeys.some((key) => key.startsWith("generations/xml-ingest/gen-42-")),
    ).toBe(true);
    const manifestPut = s3.puts.find(
      (put) => put.key === "manifests/xml-ingest/latest",
    );
    expect(manifestPut?.ifMatch).toBe('"xml-41"');

    const stored = s3.objects.get("manifests/xml-ingest/latest");
    expect(stored).toBeDefined();
    const manifest = JSON.parse(
      new TextDecoder().decode(stored!.body),
    ) as Record<string, unknown>;
    expect(manifest["generation_u32"]).toBe(42);
    expect(manifest["merkle_root_sha256"]).toBe(summary.merkle_root_sha256);
    expect(manifest["chunk_key"]).toBe(chunkKey);
    expect(manifest["watermark_cursor"]).toBe("wm-99");
    expect(manifest["r2_bucket"]).toBe("sportsdesk-ops-reports");
    expect(manifest["circuit_state"]).toBe("CLOSED");
  });

  test("HTTP 412 exits 74 with ERR_R2_MANIFEST_CAS_REJECTED", async () => {
    const s3 = startMockS3();
    s3.rejectManifestPut = true;
    const feed = startFeed();
    const result = await runCli(["--url", feed], baseEnv(s3));
    expect(result.exitCode).toBe(74);
    expect(result.stderr).toContain("ERR_R2_MANIFEST_CAS_REJECTED");
    // The chunk + generation are content-addressed and stay; the pointer did not move.
    expect(s3.objects.get("manifests/xml-ingest/latest")?.etag).toBe(
      '"xml-41"',
    );
  });

  test("unmapped taxonomy is quarantined and reported", async () => {
    const s3 = startMockS3();
    const feed = startFeed(
      FEED_XML.replace('subSport="NBA"', 'subSport="XYZ"'),
    );
    const result = await runCli(["--url", feed, "--dry-run"], baseEnv(s3));
    expect(result.exitCode, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      unmapped_taxonomy_quarantined: number;
      quarantine_key: string | null;
    };
    expect(summary.unmapped_taxonomy_quarantined).toBe(1);
    expect(summary.quarantine_key).toMatch(
      /^quarantine\/portal-taxonomy\/unmapped\/\d+-[0-9a-f]{16}\.json$/,
    );
    expect(
      s3.puts
        .map((put) => put.key)
        .some((key) => key.startsWith("quarantine/portal-taxonomy/unmapped/")),
    ).toBe(true);
  });

  test("fails before network on retired env keys (exit 78)", async () => {
    const s3 = startMockS3();
    const env = baseEnv(s3);
    env.AWS_ACCESS_KEY_ID = "leak";
    const result = await runCli(["--url", startFeed()], env);
    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain(
      "ERR_DOD_LEGACY_FALLBACK_REMOVED: AWS_ACCESS_KEY_ID",
    );
  });

  test("fails on a local JSON feed URL (exit 78)", async () => {
    const result = await runCli(
      ["--url", "https://desk.example/feed.json"],
      baseEnv(startMockS3()),
    );
    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain("ERR_OPS_LOCAL_JSON_FORBIDDEN");
  });

  test("fails on the Cloudflare token bleed (exit 77)", async () => {
    const env = baseEnv(startMockS3());
    env.CLOUDFLARE_R2_API_TOKEN = "r2-token";
    env.CLOUDFLARE_API_TOKEN = "cf-token";
    const result = await runCli(
      ["--url", "https://desk.example/feed.xml"],
      env,
    );
    expect(result.exitCode).toBe(77);
    expect(result.stderr).toContain("ERR_CF_TOKEN_BLEED_10000");
  });

  test("fails with ERR_CF_R2_CREDENTIALS_MISSING when R2 env is absent", async () => {
    const env = baseEnv(null);
    const result = await runCli(
      ["--url", "https://desk.example/feed.xml"],
      env,
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toContain("ERR_CF_R2_CREDENTIALS_MISSING");
  });

  test("a capacity smaller than the feed exits 70 on the CSR invariant", async () => {
    const s3 = startMockS3();
    const result = await runCli(
      ["--url", startFeed(), "--capacity", "1"],
      baseEnv(s3),
    );
    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("ERR_DOD_CSR_CONSERVATION_BREACH");
  });
});
