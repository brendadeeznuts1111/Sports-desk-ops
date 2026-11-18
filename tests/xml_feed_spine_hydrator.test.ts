import { describe, expect, test } from "bun:test";
import {
  createXmlOddsFeedColumnStore,
  hydrateXmlOddsFeedIntoSoA,
  isXmlOddsLineUnknown,
  XML_FEED_LINE_UNIT,
  XML_FEED_LINE_UNKNOWN_INTEGER_MIN_ABS,
  type XmlOddsFeedColumnStore,
} from "../src/lib/xml_feed_spine_hydrator.ts";
import {
  assertXmlIngestBytesNotHtmlOn200,
  parseXmlCompactDocument,
} from "../src/lib/xml_ingest_preflight.ts";
import { buildPartner118RequestXml } from "../src/lib/partner118_request_xml.ts";
import {
  publishXmlIngestSnapshotToR2,
  type XmlIngestR2ManifestPut,
} from "../src/lib/xml_ingest_r2_publish.ts";
import { packSubSportComboKey15 } from "../src/lib/portal_taxonomy_normalizer.ts";

// The sample feed carries decimal lines only; a moneyline price belongs in a price
// field, not `@line`, and is covered by the malformed-line tests below.
const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <event id="42" sport="FOOTBALL" subSport="NFL" line="3.5" wagerType="1" period="2" marketKind="1"/>
  <event id="43" sport="BASKETBALL" subSport="NBA" line="-3.5" wagerType="2" period="0" marketKind="0"/>
</feed>`;

const PREFIXED_SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<m:feed xmlns:m="urn:sportsdesk:xml">
  <m:event id="42" sport="FOOTBALL" subSport="NFL" line="3.5" wagerType="1" period="2" marketKind="1"/>
  <m:event id="43" sport="BASKETBALL" subSport="NBA" line="-3.5" wagerType="2" period="0" marketKind="0"/>
</m:feed>`;

const resolveSampleTaxonomy = (sport: string, sub: string | null) =>
  sport === "FOOTBALL" && sub === "NFL" ? 1 : sub === "NBA" ? 3 : 0;

// @bun-behavior: xml-parse

describe("xml ingest preflight", () => {
  test("rejects Class A HTML-on-200", () => {
    const html = new TextEncoder().encode(
      "<!doctype html><html><body>login</body></html>",
    );
    expect(() => assertXmlIngestBytesNotHtmlOn200(html)).toThrow(
      "ERR_GSLIVE_SESSION_EXPIRED",
    );
  });

  test("maps entity-related SyntaxError to ERR_XML_ENTITY_BOMB", () => {
    const entities: string[] = [];
    for (let i = 0; i < 8; i++) {
      entities.push(`<!ENTITY e${i} "&#38;e${i === 0 ? "" : i - 1};">`);
    }
    const bomb = new TextEncoder().encode(
      `<!DOCTYPE r [${entities.join("")}]><r>&e7;</r>`,
    );
    expect(() => parseXmlCompactDocument(bomb)).toThrow(/ERR_XML_ENTITY_BOMB/);
  });

  test("maps exponential entity expansion to ERR_XML_ENTITY_BOMB", () => {
    // 10× expansion per level; measured on Bun 1.4.4 the depth-6 frame trips
    // "Entity expansion exceeds the amplification limit".
    const declarations = ['<!ENTITY lol0 "lol">'];
    for (let depth = 1; depth <= 6; depth++) {
      declarations.push(
        `<!ENTITY lol${depth} "${`&lol${depth - 1};`.repeat(10)}">`,
      );
    }
    const bomb = new TextEncoder().encode(
      `<!DOCTYPE r [${declarations.join("")}]><r>&lol6;</r>`,
    );
    expect(() => parseXmlCompactDocument(bomb)).toThrow(/ERR_XML_ENTITY_BOMB/);
  });

  test("classifies a truncated tag as ERR_XML_PARSE_FAILED, not an entity bomb", () => {
    const truncated = new TextEncoder().encode('<feed><event id="42"');
    let caught: Error | undefined;
    try {
      parseXmlCompactDocument(truncated);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toMatch(/ERR_XML_PARSE_FAILED/);
    expect(caught?.message).not.toMatch(/ERR_XML_ENTITY_BOMB/);
  });
});

describe("xml feed spine hydrator", () => {
  test("hydrates compact feed into SoA without Map/Set", () => {
    const store = createXmlOddsFeedColumnStore(8);
    const resolve = (sport: string, sub: string | null) =>
      sport === "FOOTBALL" && sub === "NFL" ? 1 : sub === "NBA" ? 3 : 0;

    const written = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(SAMPLE_FEED),
      store,
      resolve,
    );
    expect(written).toBe(2);
    expect(store.count).toBe(2);
    expect(store.eventId32Col[0]).toBe(42);
    expect(store.lineHundredthsI32Col[0]).toBe(350);
    expect(store.lineHundredthsI32Col[1]).toBe(-350);
    expect(store.malformedLineCount).toBe(0);
    expect(store.lineUnknownFlags).toEqual(new Uint32Array([0]));
    expect(store.packedComboKey15Col[0]).toBe(
      packSubSportComboKey15(1, 1, 2, 1),
    );
  });

  test("pins the tri-state @line contract: decimal unit, integer ambiguity threshold 20", () => {
    expect(XML_FEED_LINE_UNIT).toBe("decimal");
    expect(XML_FEED_LINE_UNKNOWN_INTEGER_MIN_ABS).toBe(20);
    const store = createXmlOddsFeedColumnStore(1);
    expect(store.malformedLineCount).toBe(0);
    expect(store.lineUnknownFlags).toBeInstanceOf(Uint32Array);
    expect(store.lineUnknownFlags?.length).toBe(1);
  });

  test("keeps fractional and small lines KNOWN and marks every UNKNOWN shape", () => {
    const known: ReadonlyArray<readonly [string, number]> = [
      ["3.5", 350],
      ["-3.25", -325],
      ["48.5", 4850],
      ["0", 0],
      ["0.0", 0],
      ["19", 1900],
      ["-3", -300],
    ];
    const unknown = [
      "48",
      "220",
      "20.0",
      "-20",
      "-110",
      "-110.0",
      "+145",
      "+145.0",
      "N/A",
    ];
    const events = [
      ...known.map(
        ([raw], index) => `<event id="${index + 1}" line="${raw}"/>`,
      ),
      ...unknown.map(
        (raw, index) =>
          `<event id="${known.length + index + 1}" line="${raw}"/>`,
      ),
    ];
    const store = createXmlOddsFeedColumnStore(events.length);
    const written = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(`<feed>${events.join("")}</feed>`),
      store,
      resolveSampleTaxonomy,
    );

    expect(written).toBe(events.length);
    expect(store.count).toBe(events.length);
    expect(store.malformedLineCount).toBe(unknown.length);
    expect(
      Array.from(store.lineHundredthsI32Col.subarray(0, known.length)),
    ).toEqual(known.map(([, hundredths]) => hundredths));
    expect(
      Array.from(store.lineHundredthsI32Col.subarray(known.length)),
    ).toEqual(unknown.map(() => 0));
    for (let index = 0; index < known.length; index++) {
      expect(isXmlOddsLineUnknown(store, index), known[index]![0]).toBe(false);
    }
    for (let index = 0; index < unknown.length; index++) {
      expect(
        isXmlOddsLineUnknown(store, known.length + index),
        unknown[index]!,
      ).toBe(true);
    }
    // The decimal-form price is UNKNOWN, never stored as the scaled -11000.
    expect(Array.from(store.lineHundredthsI32Col)).not.toContain(-11000);
  });

  test("a blank or absent @line is UNKNOWN and counted", () => {
    const store = createXmlOddsFeedColumnStore(3);
    const written = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(
        '<feed><event id="1"/><event id="2" line=""/><event id="3" line="   "/></feed>',
      ),
      store,
      resolveSampleTaxonomy,
    );
    expect(written).toBe(3);
    expect(store.malformedLineCount).toBe(3);
    expect(Array.from(store.lineHundredthsI32Col.subarray(0, 3))).toEqual([
      0, 0, 0,
    ]);
    for (let index = 0; index < 3; index++) {
      expect(isXmlOddsLineUnknown(store, index)).toBe(true);
    }
  });

  test("counts unparseable or unrepresentable @line text as UNKNOWN", () => {
    const store = createXmlOddsFeedColumnStore(4);
    const written = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(
        "<feed>" +
          '<event id="1" line="N/A"/>' +
          '<event id="2" line="1e3"/>' +
          '<event id="3" line="abc"/>' +
          '<event id="4" line="999999999999.5"/>' +
          "</feed>",
      ),
      store,
      resolveSampleTaxonomy,
    );
    expect(written).toBe(4);
    expect(store.count).toBe(4);
    expect(store.malformedLineCount).toBe(4);
    expect(Array.from(store.lineHundredthsI32Col.subarray(0, 4))).toEqual([
      0, 0, 0, 0,
    ]);
    for (let index = 0; index < 4; index++) {
      expect(isXmlOddsLineUnknown(store, index)).toBe(true);
    }
  });

  test("a store literal without the counter or bitset still hydrates and counts", () => {
    // A legacy arena literal carries neither field: classification and the count still work,
    // it just cannot expose per-row flags (the shipped CLI arena is factory-built).
    const store: XmlOddsFeedColumnStore = {
      capacity: 2,
      count: 0,
      eventId32Col: new Uint32Array(2),
      packedComboKey15Col: new Uint16Array(2),
      lineHundredthsI32Col: new Int32Array(2),
    };
    const written = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(
        '<feed><event id="1" line="-110"/><event id="2" line="-3.5"/></feed>',
      ),
      store,
      resolveSampleTaxonomy,
    );
    expect(written).toBe(2);
    expect(store.count).toBe(2);
    expect(store.malformedLineCount).toBe(1);
    expect(store.lineUnknownFlags).toBeUndefined();
    expect(store.lineHundredthsI32Col[0]).toBe(0);
    expect(store.lineHundredthsI32Col[1]).toBe(-350);
  });

  test("hydrates a namespace-prefixed feed root by local name", () => {
    const plainStore = createXmlOddsFeedColumnStore(8);
    const prefixedStore = createXmlOddsFeedColumnStore(8);
    const plainWritten = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(SAMPLE_FEED),
      plainStore,
      resolveSampleTaxonomy,
    );
    const prefixedWritten = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(PREFIXED_SAMPLE_FEED),
      prefixedStore,
      resolveSampleTaxonomy,
    );

    expect(prefixedWritten).toBe(plainWritten);
    expect(prefixedStore.count).toBe(2);
    expect(Array.from(prefixedStore.eventId32Col.subarray(0, 2))).toEqual(
      Array.from(plainStore.eventId32Col.subarray(0, 2)),
    );
    expect(
      Array.from(prefixedStore.packedComboKey15Col.subarray(0, 2)),
    ).toEqual(Array.from(plainStore.packedComboKey15Col.subarray(0, 2)));
    expect(
      Array.from(prefixedStore.lineHundredthsI32Col.subarray(0, 2)),
    ).toEqual(Array.from(plainStore.lineHundredthsI32Col.subarray(0, 2)));
    expect(Array.from(prefixedStore.lineUnknownFlags ?? [])).toEqual(
      Array.from(plainStore.lineUnknownFlags ?? []),
    );
  });

  test("throws ERR_XML_FEED_ROOT_MISSING when there is no feed root", () => {
    const store = createXmlOddsFeedColumnStore(8);
    expect(() =>
      hydrateXmlOddsFeedIntoSoA(
        new TextEncoder().encode('<odds><event id="42"/></odds>'),
        store,
        resolveSampleTaxonomy,
      ),
    ).toThrow("ERR_XML_FEED_ROOT_MISSING");
    expect(store.count).toBe(0);
  });

  test("a feed root with no events hydrates zero rows", () => {
    const store = createXmlOddsFeedColumnStore(8);
    const written = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode("<feed></feed>"),
      store,
      resolveSampleTaxonomy,
    );
    expect(written).toBe(0);
    expect(store.count).toBe(0);
  });

  test("ERR_DOD_CSR_CONSERVATION_BREACH when capacity exceeded", () => {
    const store = createXmlOddsFeedColumnStore(1);
    expect(() =>
      hydrateXmlOddsFeedIntoSoA(
        new TextEncoder().encode(SAMPLE_FEED),
        store,
        () => 1,
      ),
    ).toThrow("ERR_DOD_CSR_CONSERVATION_BREACH");
    // The pre-check rejects the whole frame: no partial row was written.
    expect(store.count).toBe(0);
    expect(store.eventId32Col[0]).toBe(0);
  });

  test("a full store rejects the next frame without mutating existing rows", () => {
    const store = createXmlOddsFeedColumnStore(2);
    expect(
      hydrateXmlOddsFeedIntoSoA(
        new TextEncoder().encode(SAMPLE_FEED),
        store,
        resolveSampleTaxonomy,
      ),
    ).toBe(2);
    expect(store.count).toBe(2);

    expect(() =>
      hydrateXmlOddsFeedIntoSoA(
        new TextEncoder().encode(SAMPLE_FEED),
        store,
        resolveSampleTaxonomy,
      ),
    ).toThrow("ERR_DOD_CSR_CONSERVATION_BREACH");
    expect(store.count).toBe(2);
    expect(store.eventId32Col[0]).toBe(42);
    expect(store.eventId32Col[1]).toBe(43);
  });
});

describe("partner118_request_xml", () => {
  test("buildPartner118RequestXml preserves lossless template lineage", () => {
    const xml = buildPartner118RequestXml(118_001, "SESS-ABC");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<m:SessionId>SESS-ABC</m:SessionId>");
    expect(xml).toContain("<m:BetGroupId>118001</m:BetGroupId>");
    expect(xml).toContain("betGroupId=118001");
  });
});

describe("xml ingest R2 publish", () => {
  const CANONICAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sportsdeskXmlFeed watermarkCursor="cursor-9" dataWindowMaxEpochMs="1700000000000" rowCount="2"><event id="42"/><event id="43"/></sportsdeskXmlFeed>`;

  test("publishes chunk + generation through one If-Match CAS manifest body", async () => {
    const writes: Array<{ key: string; body: string }> = [];
    const manifestPuts: Array<{
      key: string;
      ifMatch: string | null;
      body: string;
    }> = [];
    const client = {
      async write(key: string, data: string | Uint8Array) {
        writes.push({
          key,
          body:
            typeof data === "string" ? data : new TextDecoder().decode(data),
        });
        return data;
      },
      async fetch(key: string, init: XmlIngestR2ManifestPut) {
        manifestPuts.push({
          key,
          ifMatch: init.headers["If-Match"] ?? null,
          body: init.body,
        });
        return new Response(null, { status: 200 });
      },
    };
    const canonicalXmlBytes = new TextEncoder().encode(CANONICAL_XML);
    const res = await publishXmlIngestSnapshotToR2({
      client,
      prevManifestETag: '"etag-1"',
      nextGenerationU32: 9,
      watermarkCursor: "cursor-9",
      dataWindowMaxEpochMs: 1_700_000_000_000,
      canonicalXmlBytes,
      rowCount: 2,
    });

    expect(res.merkleRootSha256).toHaveLength(64);
    expect(res.chunkKey).toBe(`chunks/${res.merkleRootSha256}.bin`);
    // The chunk bytes are the canonical bytes, content-addressed by their sha256.
    expect(writes.find((write) => write.key === res.chunkKey)?.body).toBe(
      CANONICAL_XML,
    );
    expect(
      writes.some((w) => w.key.startsWith("generations/xml-ingest/")),
    ).toBe(true);

    // Exactly one CAS request, conditional on the previous ETag.
    expect(manifestPuts).toHaveLength(1);
    const manifestPut = manifestPuts[0]!;
    expect(manifestPut.key).toBe("manifests/xml-ingest/latest");
    expect(manifestPut.ifMatch).toBe('"etag-1"');
    // The parsed body is the published contract: these two fields are the ones the
    // shipped CLI used to add inline, and they must not drift out of the lib.
    const manifestBody = JSON.parse(manifestPut.body) as Record<
      string,
      unknown
    >;
    expect(manifestBody["r2_manifest_key"]).toBe("manifests/xml-ingest/latest");
    expect(manifestBody["unresolved_gap_cents"]).toBe("0");
    expect(manifestBody["row_count"]).toBe(2);
    expect(manifestBody["generation_u32"]).toBe(9);
    expect(manifestBody["merkle_root_sha256"]).toBe(res.merkleRootSha256);
    expect(manifestBody["chunk_key"]).toBe(res.chunkKey);
    expect(manifestBody["watermark_cursor"]).toBe("cursor-9");
    expect(manifestBody["data_window_max_epoch_ms"]).toBe(1_700_000_000_000);
    expect(manifestBody["r2_published_at_epoch_ms"]).toBe(
      res.r2PublishedAtEpochMs,
    );
    expect(manifestBody["r2_bucket"]).toBe("sportsdesk-ops-reports");
    expect(manifestBody["domain"]).toBe("[Ops & Governance]");
    expect(manifestBody["sink_id"]).toBe("xml-ingest");
    expect(manifestBody["circuit_state"]).toBe("CLOSED");
  });

  test("throws ERR_R2_MANIFEST_CAS_REJECTED on a 412 CAS response", async () => {
    const client = {
      async write() {
        return 0;
      },
      async fetch() {
        return new Response("precondition failed", { status: 412 });
      },
    };
    await expect(
      publishXmlIngestSnapshotToR2({
        client,
        prevManifestETag: '"stale"',
        nextGenerationU32: 1,
        watermarkCursor: "c",
        dataWindowMaxEpochMs: 1,
        canonicalXmlBytes: new TextEncoder().encode(CANONICAL_XML),
        rowCount: 2,
      }),
    ).rejects.toThrow("ERR_R2_MANIFEST_CAS_REJECTED");
  });

  test("dry-run returns the planned snapshot without writing or CAS", async () => {
    let writes = 0;
    let fetches = 0;
    const client = {
      async write() {
        writes += 1;
        return 0;
      },
      async fetch() {
        fetches += 1;
        return new Response(null, { status: 200 });
      },
    };
    const res = await publishXmlIngestSnapshotToR2({
      client,
      prevManifestETag: '"etag-1"',
      nextGenerationU32: 9,
      watermarkCursor: "cursor-9",
      dataWindowMaxEpochMs: 1_700_000_000_000,
      canonicalXmlBytes: new TextEncoder().encode(CANONICAL_XML),
      rowCount: 2,
      dryRun: true,
    });
    expect(res.merkleRootSha256).toHaveLength(64);
    expect(res.r2PublishedAtEpochMs).toBe(0);
    expect(writes).toBe(0);
    expect(fetches).toBe(0);
  });
});
