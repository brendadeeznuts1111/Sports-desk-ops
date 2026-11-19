import { describe, expect, test } from "bun:test";
import {
  XML_ODDS_SOA_STALE_IF_ERROR_MS,
  XML_ODDS_SOA_TTL_MS,
  XmlOddsSoaSource,
  handleXmlOddsSoaRequest,
} from "../services/sportsdesk_webview_server.ts";

/**
 * The snapshot cache around `GET /api/xml-odds/soa`.
 *
 * Bun's `fetch` implements no HTTP cache, so the route composes one: a TTL window, a
 * conditional `If-None-Match` on the manifest (a 304 must skip the chunk GET entirely), one
 * shared promise while a refresh is in flight, and the last good snapshot served for a bounded
 * window when a refresh fails. These tests pin each of those, because a cache that silently
 * re-downloads or silently empties a panel is worse than no cache.
 */

const CHUNK_KEY = `chunks/${"a".repeat(64)}.bin`;
const MANIFEST_ETAG = '"etag-gen-7"';

const manifestBody = (): string =>
  JSON.stringify({
    domain: "[Ops & Governance]",
    sink_id: "xml-ingest",
    r2_bucket: "sportsdesk-ops-reports",
    generation_u32: 7,
    merkle_root_sha256: "a".repeat(64),
    watermark_cursor: "wm-9",
    data_window_max_epoch_ms: 1700000000000,
    r2_published_at_epoch_ms: 1700000000123,
    chunk_key: CHUNK_KEY,
    row_count: 2,
    circuit_state: "CLOSED",
  });

const chunkBody = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<sportsdeskXmlFeed watermarkCursor="wm-9" dataWindowMaxEpochMs="1700000000000" rowCount="2">',
  '<event id="11" subSportCode6="2" wagerTypeCode3="1" periodCode4="3" marketKindCode2="1" lineHundredths="350"/>',
  '<event id="12" subSportCode6="4" wagerTypeCode3="0" periodCode4="0" marketKindCode2="2" lineHundredths="-110"/>',
  "</sportsdeskXmlFeed>",
].join("");

interface Recorded {
  readonly url: string;
  readonly ifNoneMatch: string | null;
}

/**
 * A fake R2 that serves the manifest and chunk, honours `If-None-Match` when `conditional` is
 * on, and can be switched into a failure mode mid-test.
 */
function fakeR2(
  options: {
    readonly conditional?: boolean;
    readonly etag?: string;
  } = {},
): {
  readonly fetchImpl: (
    url: string,
    init: { readonly headers?: Readonly<Record<string, string>> },
  ) => Promise<Response>;
  readonly calls: Recorded[];
  fail: boolean;
  /** Answer 304 to any conditional request (the manifest is unchanged). */
  notModified: boolean;
} {
  const calls: Recorded[] = [];
  const etag = options.etag ?? MANIFEST_ETAG;
  const state = {
    calls,
    fail: false,
    notModified: true,
    async fetchImpl(
      url: string,
      init: { readonly headers?: Readonly<Record<string, string>> },
    ): Promise<Response> {
      const ifNoneMatch = init.headers?.["If-None-Match"] ?? null;
      calls.push({ url, ifNoneMatch });
      if (state.fail) return new Response("boom", { status: 500 });

      const isManifest = url.endsWith("/manifests/xml-ingest/latest");
      if (isManifest) {
        if (
          options.conditional === true &&
          state.notModified &&
          ifNoneMatch === etag
        ) {
          return new Response(null, { status: 304, headers: { ETag: etag } });
        }
        return new Response(manifestBody(), {
          status: 200,
          headers: { ETag: etag },
        });
      }
      return new Response(chunkBody, { status: 200 });
    },
  };
  return state;
}

/** A clock the test moves by hand. */
function clock(startMs = 1_700_000_000_000): {
  readonly now: () => number;
  advance(ms: number): void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

const countOf = (calls: readonly Recorded[], suffix: string): number =>
  calls.filter((call) => call.url.endsWith(suffix)).length;

describe("XmlOddsSoaSource", () => {
  test("defaults are under the panel's poll and long enough to dedupe clients", () => {
    expect(XML_ODDS_SOA_TTL_MS).toBe(30_000);
    expect(XML_ODDS_SOA_STALE_IF_ERROR_MS).toBe(5 * 60_000);
    expect(XML_ODDS_SOA_TTL_MS).toBeLessThan(60_000);
  });

  test("a second read inside the TTL makes no upstream call", async () => {
    const r2 = fakeR2();
    const time = clock();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: time.now,
    });

    const first = await source.read();
    expect(first.outcome.available).toBe(true);
    expect(first.cached).toBe(false);
    expect(first.stale).toBe(false);
    expect(countOf(r2.calls, "/manifests/xml-ingest/latest")).toBe(1);
    expect(countOf(r2.calls, CHUNK_KEY)).toBe(1);

    time.advance(XML_ODDS_SOA_TTL_MS - 1);
    const second = await source.read();
    expect(second.cached).toBe(true);
    expect(second.stale).toBe(false);
    // Same payload object, not a re-parse.
    expect(second.outcome).toBe(first.outcome);
    expect(r2.calls).toHaveLength(2);
  });

  test("after the TTL a revalidation sends If-None-Match, and a 304 skips the chunk", async () => {
    const r2 = fakeR2({ conditional: true });
    const time = clock();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: time.now,
    });

    const first = await source.read();
    expect(first.outcome.available).toBe(true);
    // Nothing to validate the first time.
    expect(r2.calls[0]!.ifNoneMatch).toBeNull();

    time.advance(XML_ODDS_SOA_TTL_MS + 1);
    const second = await source.read();
    expect(second.outcome.available).toBe(true);
    expect(second.cached).toBe(true);
    expect(second.stale).toBe(false);
    // The cached payload came back, not a re-fetch of the 1 MiB chunk.
    expect(countOf(r2.calls, CHUNK_KEY)).toBe(1);
    expect(countOf(r2.calls, "/manifests/xml-ingest/latest")).toBe(2);
    // Call order is manifest → chunk → revalidating manifest.
    const revalidation = r2.calls.filter((call) =>
      call.url.endsWith("/manifests/xml-ingest/latest"),
    );
    expect(revalidation[1]!.ifNoneMatch).toBe(MANIFEST_ETAG);
  });

  test("a changed manifest refetches the chunk and reports cached:false", async () => {
    const r2 = fakeR2({ conditional: true });
    const time = clock();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: time.now,
    });

    await source.read();
    // The manifest moved on: a conditional request now answers 200 with a new body.
    r2.notModified = false;
    time.advance(XML_ODDS_SOA_TTL_MS + 1);
    const second = await source.read();
    expect(second.outcome.available).toBe(true);
    expect(second.cached).toBe(false);
    expect(second.stale).toBe(false);
    expect(countOf(r2.calls, CHUNK_KEY)).toBe(2);
  });

  test("concurrent reads share one upstream fetch (single-flight)", async () => {
    const r2 = fakeR2();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: clock().now,
    });

    const [a, b, c] = await Promise.all([
      source.read(),
      source.read(),
      source.read(),
    ]);
    expect(a.outcome.available).toBe(true);
    expect(a.cached).toBe(false);
    // The followers resolve from the same promise, so they read the same outcome.
    expect(b.outcome).toBe(a.outcome);
    expect(c.outcome).toBe(a.outcome);
    expect(countOf(r2.calls, "/manifests/xml-ingest/latest")).toBe(1);
    expect(countOf(r2.calls, CHUNK_KEY)).toBe(1);
  });

  test("a failed refresh serves the last good snapshot as stale, then gives up", async () => {
    const r2 = fakeR2();
    const time = clock();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: time.now,
      staleIfErrorMs: 60_000,
    });

    await source.read();
    r2.fail = true;
    time.advance(XML_ODDS_SOA_TTL_MS + 1);

    const during = await source.read();
    expect(during.outcome.available).toBe(true);
    expect(during.cached).toBe(true);
    expect(during.stale).toBe(true);

    // Past the stale window the measurement replaces the stale copy.
    time.advance(60_000 + 1);
    const after = await source.read();
    expect(after.outcome.available).toBe(false);
    expect(after.cached).toBe(false);
    expect(after.stale).toBe(false);
    if (!after.outcome.available) {
      expect(after.outcome.reason).toContain("500");
    }
  });

  test("a failure with no cached snapshot is unavailable immediately", async () => {
    const r2 = fakeR2();
    r2.fail = true;
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: clock().now,
    });
    const read = await source.read();
    expect(read.outcome.available).toBe(false);
    expect(read.cached).toBe(false);
    expect(read.stale).toBe(false);
  });

  test("ttlMs:0 disables the reuse window", async () => {
    const r2 = fakeR2();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: clock().now,
      ttlMs: 0,
    });
    await source.read();
    const second = await source.read();
    expect(second.cached).toBe(false);
    expect(countOf(r2.calls, "/manifests/xml-ingest/latest")).toBe(2);
    expect(countOf(r2.calls, CHUNK_KEY)).toBe(2);
  });
});

describe("GET /api/xml-odds/soa cache reporting", () => {
  test("the body says whether the read was cached, and keeps the status meaningful", async () => {
    const r2 = fakeR2();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: clock().now,
    });
    const request = (): Request =>
      new Request("http://127.0.0.1:4020/api/xml-odds/soa");

    const first = await handleXmlOddsSoaRequest(request(), { source });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.success).toBe(true);
    expect(firstBody.cached).toBe(false);
    expect(firstBody.stale).toBe(false);
    // Rows are still the payload, not replaced by the cache flags.
    expect(firstBody.eventId32).toEqual([11, 12]);

    const second = await handleXmlOddsSoaRequest(request(), { source });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.cached).toBe(true);
    expect(secondBody.stale).toBe(false);
    expect(secondBody.eventId32).toEqual([11, 12]);
    expect(countOf(r2.calls, "/manifests/xml-ingest/latest")).toBe(1);
  });

  test("a stale read still answers 200 with the previous rows and flags itself", async () => {
    const r2 = fakeR2();
    const time = clock();
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: time.now,
      ttlMs: 0,
      staleIfErrorMs: 60_000,
    });
    const request = (): Request =>
      new Request("http://127.0.0.1:4020/api/xml-odds/soa");

    await handleXmlOddsSoaRequest(request(), { source });
    r2.fail = true;
    const stale = await handleXmlOddsSoaRequest(request(), { source });
    expect(stale.status).toBe(200);
    const body = (await stale.json()) as Record<string, unknown>;
    expect(body.cached).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.eventId32).toEqual([11, 12]);
  });

  test("an unavailable artifact stays a 502 with its measured reason", async () => {
    const r2 = fakeR2();
    r2.fail = true;
    const source = new XmlOddsSoaSource({
      fetchImpl: r2.fetchImpl,
      publicBase: "https://r2.example",
      now: clock().now,
    });
    const response = await handleXmlOddsSoaRequest(
      new Request("http://127.0.0.1:4020/api/xml-odds/soa"),
      { source },
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(String(body.error)).toContain("500");
    expect(body.stale).toBe(false);
  });

  test("a one-off probe never enters the daemon's shared cache", async () => {
    // `fetchImpl`/`publicBase` mean a test or a probe: its reads must not seed the singleton
    // that serves the dashboard, which is why the handler builds a private source for them.
    const r2 = fakeR2();
    const request = (): Request =>
      new Request("http://127.0.0.1:4020/api/xml-odds/soa");
    await handleXmlOddsSoaRequest(request(), {
      publicBase: "https://r2.example",
      fetchImpl: r2.fetchImpl,
    });
    await handleXmlOddsSoaRequest(request(), {
      publicBase: "https://r2.example",
      fetchImpl: r2.fetchImpl,
    });
    // Two calls, two upstream reads: the private source defaults to ttlMs 0.
    expect(countOf(r2.calls, "/manifests/xml-ingest/latest")).toBe(2);
  });
});
