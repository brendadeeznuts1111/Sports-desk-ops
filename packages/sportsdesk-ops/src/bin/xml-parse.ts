#!/usr/bin/env bun
// packages/sportsdesk-ops/src/bin/xml-parse.ts
/**
 * Zero-disk XML ingest entrypoint for `bun x xml-parse`.
 *
 * Live HTTP feed → DenseSubSportLookupTable (open-addressed FNV-1a) → DodSpine SoA
 * → canonical XML snapshot → `chunks/<sha256>.bin` + generation manifest → conditional
 * `PUT manifests/xml-ingest/latest` with `If-Match: <prevETag>` (0 rebases, exit 74 on 412).
 *
 * Adaptation note (Bun 1.4.4): `Bun.S3Client` exposes file/write/stat/presign but no
 * `fetch()`, so the conditional PUT and ETag reads go through the repo's
 * `R2S3Client.writeWithMetadata(ifMatch)` / `headEtag`, which sign the same S3 requests
 * with Web Crypto. Semantics and error codes are unchanged.
 */
import { parseArgs } from "node:util";
import { XML } from "bun";
import {
  R2PreconditionFailedError,
  R2S3Client,
} from "../../../../lib/r2_s3_client.ts";
import {
  MARKET_KIND_MASK,
  PERIOD_MASK,
  PERIOD_SHIFT,
  SUB_SPORT_MASK,
  SUB_SPORT_SHIFT,
  WAGER_TYPE_MASK,
  WAGER_TYPE_SHIFT,
} from "../../../../src/lib/portal_taxonomy_normalizer.ts";
import {
  hydrateXmlOddsFeedIntoSoA,
  type XmlOddsFeedColumnStore,
} from "../../../../src/lib/xml_feed_spine_hydrator.ts";

const RETIRED_FALLBACK_ENV_KEYS = [
  "DOD6_SPINE_PATH",
  "DOD_SPINE_PATH",
  "F402_BETS_JSONL_PATH",
  "DOD_SQLITE_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

const R2_BUCKET = "sportsdesk-ops-reports";
const TAXONOMY_MANIFEST_KEY = "manifests/portal-taxonomy/latest";
const XML_INGEST_MANIFEST_KEY = "manifests/xml-ingest/latest";

const FNV_OFFSET_LO32 = 0x84222325;
const FNV_OFFSET_HI32 = 0xcbf29ce4;
const FNV_PRIME_LO32 = 0x000001b3;
const FNV_PRIME_HI32 = 0x00000100;

export interface PortalTaxonomyEntry {
  readonly sport: string;
  readonly subSport: string | null;
  readonly denseCode6: number;
}

export interface PortalTaxonomyManifest {
  readonly generation_u32: number;
  readonly entries: readonly PortalTaxonomyEntry[];
}

export interface XmlIngestManifest {
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly chunk_key: string;
  readonly circuit_state: "CLOSED" | "OPEN";
}

export interface QuarantineSink {
  write(
    key: string,
    data: string | Uint8Array,
    options?: { readonly type?: string },
  ): Promise<unknown>;
}

/**
 * Open-addressed power-of-two FNV-1a radix lookup table for (SPORT\0SUBSPORT) -> denseCode6 (1..63).
 * Slot layout in `tableWords32` (stride 3): [hashLo32, hashHi32, denseCode6AndLen].
 */
export class DenseSubSportLookupTable {
  private readonly mask: number;
  private readonly tableWords32: Uint32Array;
  private readonly canonicalKeys: Array<string | null>;

  constructor(entries: readonly PortalTaxonomyEntry[]) {
    const minSlots = Math.max(128, entries.length * 4);
    let capacity = 128;
    while (capacity < minSlots) capacity <<= 1;

    this.mask = capacity - 1;
    this.tableWords32 = new Uint32Array(capacity * 3);
    this.canonicalKeys = Array.from(
      { length: capacity },
      (): string | null => null,
    );

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex]!;
      if (entry.subSport === null) continue;
      if (
        !Number.isInteger(entry.denseCode6) ||
        entry.denseCode6 < 1 ||
        entry.denseCode6 > 63
      ) {
        throw new Error("ERR_DOD_BITFIELD_RANGE_OVERFLOW");
      }

      const canonical = `${entry.sport.trim().toUpperCase()}\0${entry.subSport.trim().toUpperCase()}`;
      const [hLo, hHi] = DenseSubSportLookupTable.hashPair64(
        entry.sport,
        entry.subSport,
      );
      let slot = hLo & this.mask;

      while (true) {
        const base = slot * 3;
        const existingCode = this.tableWords32[base + 2]!;
        if (existingCode === 0) {
          this.tableWords32[base] = hLo;
          this.tableWords32[base + 1] = hHi;
          this.tableWords32[base + 2] = entry.denseCode6;
          this.canonicalKeys[slot] = canonical;
          break;
        }
        if (
          this.tableWords32[base] === hLo &&
          this.tableWords32[base + 1] === hHi &&
          this.canonicalKeys[slot] !== canonical
        ) {
          throw new Error("ERR_DOD_TAXONOMY_HASH_COLLISION");
        }
        if (this.canonicalKeys[slot] === canonical) {
          break;
        }
        slot = (slot + 1) & this.mask;
      }
    }
  }

  public resolve(sport: string, subSport: string | null): number {
    if (subSport === null) return 0;
    const [hLo, hHi] = DenseSubSportLookupTable.hashPair64(sport, subSport);
    let slot = hLo & this.mask;

    while (true) {
      const base = slot * 3;
      const code = this.tableWords32[base + 2]!;
      if (code === 0) return 0;
      if (
        this.tableWords32[base] === hLo &&
        this.tableWords32[base + 1] === hHi
      ) {
        const expected = `${sport.trim().toUpperCase()}\0${subSport.trim().toUpperCase()}`;
        if (this.canonicalKeys[slot] === expected) {
          return code;
        }
      }
      slot = (slot + 1) & this.mask;
    }
  }

  private static hashPair64(sport: string, subSport: string): [number, number] {
    let lo = FNV_OFFSET_LO32 >>> 0;
    let hi = FNV_OFFSET_HI32 >>> 0;

    const feedUpper = (segment: string) => {
      const trimmed = segment.trim();
      for (let charIndex = 0; charIndex < trimmed.length; charIndex++) {
        let code = trimmed.charCodeAt(charIndex);
        if (code >= 97 && code <= 122) code -= 32;
        lo ^= code & 0xff;
        const nextLo = Math.imul(lo, FNV_PRIME_LO32) >>> 0;
        const carry = ((lo * FNV_PRIME_LO32) / 0x100000000) >>> 0;
        hi =
          (Math.imul(hi, FNV_PRIME_LO32) +
            Math.imul(lo, FNV_PRIME_HI32) +
            carry) >>>
          0;
        lo = nextLo;
      }
    };

    feedUpper(sport);
    // NUL delimiter prevents ("FOOT", "BALL") vs ("FOO", "TBALL") boundary collision
    lo ^= 0x00;
    lo = Math.imul(lo, FNV_PRIME_LO32) >>> 0;
    hi = Math.imul(hi, FNV_PRIME_LO32) >>> 0;
    feedUpper(subSport);

    return [lo >>> 0, hi >>> 0];
  }
}

export class UnmappedTaxonomyQuarantineRing {
  private readonly maxItems: number;
  private readonly seenKeys = new Array<string>();
  private readonly records = new Array<{
    sport: string;
    subSport: string;
    seenAtEpochMs: number;
  }>();

  constructor(maxItems = 256) {
    this.maxItems = maxItems;
  }

  public record(sport: string, subSport: string): void {
    const key = `${sport}\0${subSport}`;
    if (this.seenKeys.includes(key)) return;
    if (this.records.length >= this.maxItems) return;
    this.seenKeys.push(key);
    this.records.push({ sport, subSport, seenAtEpochMs: Date.now() });
  }

  public get size(): number {
    return this.records.length;
  }

  public async flushToR2(s3: QuarantineSink): Promise<string | null> {
    if (this.records.length === 0) return null;
    const now = Date.now();
    const body = JSON.stringify({
      domain: "[DOD Spine]",
      quarantine_type: "unmapped_portal_taxonomy",
      recorded_at_epoch_ms: now,
      count: this.records.length,
      pairs: this.records,
    });
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(body);
    const digest16 = hasher.digest("hex").slice(0, 16);
    const key = `quarantine/portal-taxonomy/unmapped/${now}-${digest16}.json`;
    await s3.write(key, body, { type: "application/json" });
    return key;
  }
}

export function assertLiveRuntimePreflight(
  env: Readonly<Record<string, string | undefined>>,
  feedUrl: string,
  capacity: number,
): void {
  for (const key of RETIRED_FALLBACK_ENV_KEYS) {
    if (env[key]) {
      throw new Error(`ERR_DOD_LEGACY_FALLBACK_REMOVED: ${key}`);
    }
  }
  if (env.CLOUDFLARE_R2_API_TOKEN && env.CLOUDFLARE_API_TOKEN) {
    throw new Error("ERR_CF_TOKEN_BLEED_10000");
  }
  if (
    !/^https?:\/\//i.test(feedUrl) ||
    /\.(?:json|jsonl|sqlite|dodbin)(?:$|\?)/i.test(feedUrl)
  ) {
    throw new Error("ERR_OPS_LOCAL_JSON_FORBIDDEN");
  }
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 1_048_576) {
    throw new Error("ERR_DOD_BITFIELD_RANGE_OVERFLOW");
  }
}

function createR2Client(
  env: Readonly<Record<string, string | undefined>>,
): R2S3Client {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT;
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error("ERR_CF_R2_CREDENTIALS_MISSING");
  }
  return R2S3Client.fromOptions({
    bucket: R2_BUCKET,
    endpoint,
    accessKeyId,
    secretAccessKey,
    publicBase: endpoint,
  });
}

export function serializeSoAToCanonicalXml(
  store: XmlOddsFeedColumnStore,
  watermarkCursor: string,
  dataWindowMaxEpochMs: number,
): Uint8Array {
  const eventNodes: XML.NodeInput[] = [];
  for (let rowIndex = 0; rowIndex < store.count; rowIndex++) {
    const packed = store.packedComboKey15Col[rowIndex]!;
    eventNodes.push({
      name: "event",
      attributes: {
        id: String(store.eventId32Col[rowIndex]!),
        subSportCode6: String((packed >>> SUB_SPORT_SHIFT) & SUB_SPORT_MASK),
        wagerTypeCode3: String((packed >>> WAGER_TYPE_SHIFT) & WAGER_TYPE_MASK),
        periodCode4: String((packed >>> PERIOD_SHIFT) & PERIOD_MASK),
        marketKindCode2: String(packed & MARKET_KIND_MASK),
        lineHundredths: String(store.lineHundredthsI32Col[rowIndex]!),
      },
    });
  }

  const rootNode: XML.NodeInput = {
    name: "sportsdeskXmlFeed",
    attributes: {
      watermarkCursor,
      dataWindowMaxEpochMs: String(dataWindowMaxEpochMs),
      rowCount: String(store.count),
    },
    children: eventNodes,
  };

  const xmlText =
    '<?xml version="1.0" encoding="UTF-8"?>\n' + XML.stringify(rootNode);
  return new TextEncoder().encode(xmlText);
}

async function fetchManifestWithETag<T>(
  s3: R2S3Client,
  key: string,
): Promise<{ etag: string; payload: T }> {
  let etag: string | null;
  let text: string;
  try {
    [etag, text] = await Promise.all([s3.headEtag(key), s3.file(key).text()]);
  } catch (error) {
    throw new Error(
      `ERR_R2_SINK_BACKPRESSURE: GET ${key} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (etag === null || etag.trim().length === 0) {
    throw new Error(`ERR_R2_MANIFEST_CAS_REJECTED: missing ETag on ${key}`);
  }
  let payload: T;
  try {
    payload = JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`ERR_R2_SINK_BACKPRESSURE: GET ${key} is not JSON`, {
      cause: error,
    });
  }
  return { etag, payload };
}

export async function run(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      url: { type: "string" },
      cursor: { type: "string", default: "0" },
      capacity: { type: "string", default: "65536" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: true },
    },
    strict: true,
  });

  const feedUrl = values.url ?? Bun.env.SPORTSDESK_XML_FEED_URL ?? "";
  const cursor = values.cursor ?? "0";
  const capacity = Number(values.capacity);
  const dryRun = Boolean(values["dry-run"]);

  // STAGE_0_PREFLIGHT
  assertLiveRuntimePreflight(Bun.env, feedUrl, capacity);
  const s3 = createR2Client(Bun.env);

  const [taxonomyState, currentManifestState] = await Promise.all([
    fetchManifestWithETag<PortalTaxonomyManifest>(s3, TAXONOMY_MANIFEST_KEY),
    fetchManifestWithETag<XmlIngestManifest>(s3, XML_INGEST_MANIFEST_KEY),
  ]);

  const taxonomyTable = new DenseSubSportLookupTable(
    taxonomyState.payload.entries,
  );
  const quarantineRing = new UnmappedTaxonomyQuarantineRing();
  const store: XmlOddsFeedColumnStore = {
    capacity,
    count: 0,
    eventId32Col: new Uint32Array(capacity),
    packedComboKey15Col: new Uint16Array(capacity),
    lineHundredthsI32Col: new Int32Array(capacity),
  };

  // STAGE_1_LIVE_INGEST (stream live HTTP response into bounded arena buffer)
  const upstreamRes = await fetch(feedUrl, {
    headers: {
      Accept: "application/xml, text/xml;q=0.9",
      "X-Watermark-Cursor": cursor,
    },
  });
  if (!upstreamRes.ok) {
    throw new Error(`ERR_GSLIVE_UPSTREAM_HTTP_${upstreamRes.status}`);
  }

  const rawBytes = new Uint8Array(await upstreamRes.arrayBuffer());
  const dataWindowMaxEpochMs = Date.now();

  const hydratedCount = hydrateXmlOddsFeedIntoSoA(
    rawBytes,
    store,
    (sport, subSport) => taxonomyTable.resolve(sport, subSport),
    (sport, subSport) => quarantineRing.record(sport, subSport),
  );

  // STAGE_2_INVARIANT_VERIFY
  if (store.count !== hydratedCount) {
    throw new Error("ERR_DOD_CSR_CONSERVATION_BREACH");
  }

  const quarantineKey = await quarantineRing.flushToR2(s3);
  const nextGenerationU32 =
    ((currentManifestState.payload.generation_u32 >>> 0) + 1) >>> 0;
  const watermarkCursor =
    upstreamRes.headers.get("x-next-watermark-cursor") ??
    `${cursor}:${hydratedCount}`;

  const canonicalXmlBytes = serializeSoAToCanonicalXml(
    store,
    watermarkCursor,
    dataWindowMaxEpochMs,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalXmlBytes);
  const merkleRootSha256 = hasher.digest("hex");

  // STAGE_3_R2_SNAPSHOT_CAS (0 manifest rebases on HTTP 412)
  let r2PublishedAtEpochMs = 0;
  const chunkKey = `chunks/${merkleRootSha256}.bin`;

  if (!dryRun) {
    await s3.write(chunkKey, canonicalXmlBytes, { type: "application/xml" });

    r2PublishedAtEpochMs = Date.now();
    const generationKey = `generations/xml-ingest/gen-${nextGenerationU32}-${merkleRootSha256.slice(0, 16)}`;
    const manifestBody = JSON.stringify({
      domain: "[Ops & Governance]",
      sink_id: "xml-ingest",
      r2_bucket: R2_BUCKET,
      r2_manifest_key: XML_INGEST_MANIFEST_KEY,
      generation_u32: nextGenerationU32,
      merkle_root_sha256: merkleRootSha256,
      watermark_cursor: watermarkCursor,
      data_window_max_epoch_ms: dataWindowMaxEpochMs,
      r2_published_at_epoch_ms: r2PublishedAtEpochMs,
      chunk_key: chunkKey,
      circuit_state: "CLOSED",
      unresolved_gap_cents: "0",
    });

    await s3.write(generationKey, manifestBody, { type: "application/json" });

    try {
      await s3.writeWithMetadata(XML_INGEST_MANIFEST_KEY, manifestBody, {
        type: "application/json",
        ifMatch: currentManifestState.etag,
      });
    } catch (error) {
      // `Bun.S3Client` has no conditional-PUT flag; R2S3Client surfaces 412 as
      // R2PreconditionFailedError. 0 rebases: the caller must re-probe.
      if (error instanceof R2PreconditionFailedError) {
        throw new Error("ERR_R2_MANIFEST_CAS_REJECTED", { cause: error });
      }
      throw new Error(
        `ERR_R2_SINK_BACKPRESSURE: PUT latest failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      domain: "[Ops & Governance]",
      sink_id: "xml-ingest",
      r2_bucket: R2_BUCKET,
      generation_u32: nextGenerationU32,
      merkle_root_sha256: merkleRootSha256,
      watermark_cursor: watermarkCursor,
      data_window_max_epoch_ms: dataWindowMaxEpochMs,
      r2_published_at_epoch_ms: r2PublishedAtEpochMs,
      hydrated_rows: hydratedCount,
      unmapped_taxonomy_quarantined: quarantineRing.size,
      quarantine_key: quarantineKey,
      dry_run: dryRun,
      circuit_state: "CLOSED",
      unresolved_gap_cents: "0",
    })}\n`,
  );
}

if (import.meta.main) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    const exitCode =
      message.includes("ERR_DOD_LEGACY_FALLBACK_REMOVED") ||
      message.includes("ERR_OPS_LOCAL_JSON_FORBIDDEN")
        ? 78
        : message.includes("ERR_CF_TOKEN_BLEED_10000")
          ? 77
          : message.includes("ERR_R2_MANIFEST_CAS_REJECTED")
            ? 74
            : message.includes("ERR_DOD_CSR_CONSERVATION_BREACH")
              ? 70
              : 65;
    process.exit(exitCode);
  });
}
