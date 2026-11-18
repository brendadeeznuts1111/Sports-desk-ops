import { describe, expect, test } from "bun:test";
import {
  createXmlOddsFeedColumnStore,
  hydrateXmlOddsFeedIntoSoA,
} from "../src/lib/xml_feed_spine_hydrator.ts";
import {
  assertXmlIngestBytesNotHtmlOn200,
  parseXmlCompactDocument,
} from "../src/lib/xml_ingest_preflight.ts";
import { buildPartner118RequestXml } from "../src/lib/partner118_request_xml.ts";
import { publishXmlIngestSnapshotToR2 } from "../src/lib/xml_ingest_r2_publish.ts";
import { packSubSportComboKey15 } from "../src/lib/portal_taxonomy_normalizer.ts";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <event id="42" sport="FOOTBALL" subSport="NFL" line="3.5" wagerType="1" period="2" marketKind="1"/>
  <event id="43" sport="BASKETBALL" subSport="NBA" line="-110" wagerType="2" period="0" marketKind="0"/>
</feed>`;

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

  test("maps entity bomb SyntaxError to ERR_XML_ENTITY_BOMB", () => {
    const entities: string[] = [];
    for (let i = 0; i < 8; i++) {
      entities.push(`<!ENTITY e${i} "&#38;e${i === 0 ? "" : i - 1};">`);
    }
    const bomb = new TextEncoder().encode(
      `<!DOCTYPE r [${entities.join("")}]><r>&e7;</r>`,
    );
    expect(() => parseXmlCompactDocument(bomb)).toThrow(/ERR_XML_ENTITY_BOMB/);
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
    expect(store.packedComboKey15Col[0]).toBe(
      packSubSportComboKey15(1, 1, 2, 1),
    );
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
  test("publishXmlIngestSnapshotToR2 uses If-Match CAS and rejects 412", async () => {
    const writes: string[] = [];
    const client = {
      async write(key: string, data: string | Uint8Array) {
        writes.push(key);
        return data;
      },
      async fetch(_key: string, init: RequestInit) {
        return new Response(init.body, { status: 200 });
      },
    };
    const res = await publishXmlIngestSnapshotToR2({
      client,
      prevManifestETag: '"etag-1"',
      nextGenerationU32: 9,
      watermarkCursor: "cursor-9",
      dataWindowMaxEpochMs: 1_700_000_000_000,
      normalizedNode: {
        name: "feed",
        children: [{ name: "event", children: ["1"] }],
      },
    });
    expect(res.merkleRootSha256).toHaveLength(64);
    expect(writes.some((k) => k.startsWith("chunks/"))).toBe(true);
    expect(writes.some((k) => k.startsWith("generations/xml-ingest/"))).toBe(
      true,
    );
  });

  test("publishXmlIngestSnapshotToR2 throws ERR_R2_MANIFEST_CAS_REJECTED on 412", async () => {
    const client = {
      async write() {
        return;
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
        normalizedNode: { name: "a" },
      }),
    ).rejects.toThrow("ERR_R2_MANIFEST_CAS_REJECTED");
  });
});
