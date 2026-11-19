/**
 * Actual Bun handler workload, synthetic fixtures only. Run:
 *   bun test tests/sportsdesk_cache_five_client.test.ts
 * Five concurrent clients, 11 polls each, one synthetic 10k-row R2 snapshot.
 * Timings are local CI runner measurements, not production latency.
 */
import { expect, test } from "bun:test";
import { encodedResponse, resetEncodedBodies } from "../lib/http_compression.ts";
import {
  handleXmlOddsSoaRequest,
  readXmlOddsSoaFromR2,
  XmlOddsSoaSource,
} from "../services/sportsdesk_webview_server.ts";

const clients = 5;
const rounds = 11;
const encoder = new TextEncoder();
const rows = 10_000;
const xmlEvents = Array.from({ length: rows }, (_, i) =>
  '<event id="' + (i + 1) + '" subSportCode6="2" wagerTypeCode3="1"' +
    ' periodCode4="3" marketKindCode2="1" lineHundredths="350"/>',
).join("");
const xml = (revision: number) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sportsdeskXmlFeed watermarkCursor="w-' + revision +
  '" dataWindowMaxEpochMs="1700000000000" rowCount="' + rows + '">' +
  xmlEvents + '</sportsdeskXmlFeed>';
const origin = "https://r2-benchmark.invalid";

function mockR2() {
  let revision = 1;
  let failing = false;
  const counters = { requests: 0, manifests: 0, chunks: 0, notModified: 0, bytes: 0 };
  const manifest = () => JSON.stringify({
    domain: "[Ops & Governance]",
    sink_id: "xml-ingest",
    r2_bucket: "sportsdesk-ops-reports",
    generation_u32: revision,
    merkle_root_sha256: (revision === 1 ? "a" : "b").repeat(64),
    watermark_cursor: "w-" + revision,
    data_window_max_epoch_ms: 1700000000000,
    r2_published_at_epoch_ms: 1700000000123 + revision * 1000,
    chunk_key: "chunks/" + (revision === 1 ? "a" : "b").repeat(64) + ".bin",
    row_count: rows,
    circuit_state: "CLOSED",
  });
  const fetchImpl = async (url: string, init: {
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<Response> => {
    counters.requests++;
    if (failing) return new Response("upstream down", { status: 503 });
    if (url.endsWith("/manifests/xml-ingest/latest")) {
      counters.manifests++;
      const etag = '"r2-' + revision + '"';
      if (init.headers?.["If-None-Match"] === etag) {
        counters.notModified++;
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      const body = manifest();
      counters.bytes += encoder.encode(body).byteLength;
      return new Response(body, { headers: { ETag: etag } });
    }
    counters.chunks++;
    const body = xml(revision);
    counters.bytes += encoder.encode(body).byteLength;
    return new Response(body);
  };
  return {
    fetchImpl,
    stats: () => ({ ...counters }),
    invalidate: () => { revision = 2; },
    fail: () => { failing = true; },
  };
}

const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return +sorted[Math.ceil(sorted.length * p) - 1]!.toFixed(3);
};

async function runR2(mode: "before" | "cached" | "changed") {
  const r2 = mockR2();
  let now = 1700000000000;
  const source = new XmlOddsSoaSource({
    fetchImpl: r2.fetchImpl,
    publicBase: origin,
    now: () => now,
  });
  const times: number[] = [];
  for (let round = 0; round < rounds; round++) {
    now += 60000;
    if (round === 5 && mode === "changed") r2.invalidate();
    await Promise.all(Array.from({ length: clients }, async () => {
      const start = performance.now();
      const snapshot = mode === "before"
        ? await readXmlOddsSoaFromR2({ fetchImpl: r2.fetchImpl, publicBase: origin })
        : (await source.read()).outcome;
      expect(snapshot.available).toBe(true);
      times.push(performance.now() - start);
    }));
  }
  return {
    ...r2.stats(),
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
  };
}

async function runClientXml() {
  const r2 = mockR2();
  let now = 1700000000000;
  const source = new XmlOddsSoaSource({
    fetchImpl: r2.fetchImpl,
    publicBase: origin,
    now: () => now,
  });
  let responseBytes = 0;
  let full200 = 0;
  for (let round = 0; round < rounds; round++) {
    now += 60000;
    await Promise.all(Array.from({ length: clients }, async () => {
      const response = await handleXmlOddsSoaRequest(
        new Request("http://local.invalid/api/xml-odds/soa"), { source },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      full200++;
      responseBytes += (await response.arrayBuffer()).byteLength;
    }));
  }
  return { full200, responseBytes, upstream: r2.stats() };
}

async function runDashboard(mode: "old" | "conditional" | "plain-poll") {
  resetEncodedBodies();
  const payload = encoder.encode(JSON.stringify({
    accounts: Array.from({ length: 220 }, (_, i) => ({
      id: "SYN-" + i,
      risk: i * 23,
      state: "stable",
    })),
  }));
  // Before ETags, the existing encoder reused the compressed body per version.
  const oldBody = new Uint8Array(Bun.gzipSync(payload));
  const tags: Array<string | null> = Array(clients).fill(null);
  let bodyBytes = 0;
  let full200 = 0;
  let responses304 = 0;
  const times: number[] = [];
  for (let round = 0; round < rounds; round++) {
    for (let client = 0; client < clients; client++) {
      const headers: Record<string, string> = { "accept-encoding": "gzip" };
      if (mode === "conditional" && tags[client]) {
        headers["if-none-match"] = tags[client]!;
      }
      const start = performance.now();
      const response = mode === "old"
        ? new Response(oldBody, { headers: { "content-encoding": "gzip" } })
        : encodedResponse(new Request("http://local.invalid/api/customers", { headers }), {
            version: "synthetic-customer-version",
            contentType: "application/json",
            produce: () => payload,
          });
      bodyBytes += (await response.arrayBuffer()).byteLength;
      if (response.status === 304) responses304++;
      else if (response.status === 200) full200++;
      else throw new Error("Unexpected response status");
      if (mode !== "old") tags[client] = response.headers.get("ETag");
      times.push(performance.now() - start);
    }
  }
  return { full200, responses304, bodyBytes, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95) };
}

test("five-client real Bun cache functions, ten-thousand-row synthetic fixture", async () => {
  const before = await runR2("before");
  const cached = await runR2("cached");
  const changed = await runR2("changed");
  const clientXml = await runClientXml();
  const dashboardBefore = await runDashboard("old");
  const dashboardConditional = await runDashboard("conditional");
  const dashboardNoConditional = await runDashboard("plain-poll");
  expect(before.requests).toBe(110);
  expect(cached.requests).toBe(12);
  expect(cached.chunks).toBe(1);
  expect(changed.requests).toBe(13);
  expect(changed.chunks).toBe(2);
  expect(clientXml.full200).toBe(55);
  expect(clientXml.upstream.requests).toBe(12);
  expect(dashboardBefore.full200).toBe(55);
  expect(dashboardConditional.full200).toBe(5);
  expect(dashboardConditional.responses304).toBe(50);
  expect(dashboardNoConditional.full200).toBe(55);
  const pct = (a: number, b: number) => +((1 - b / a) * 100).toFixed(2);
  console.log("SPORTSDESK_BUN_CACHE_BENCH " + JSON.stringify({
    kind: "synthetic CI Bun measurement, not live R2 or browser HAR",
    clients, rounds, rows, xmlBytes: encoder.encode(xml(1)).byteLength,
    r2: { before, cached, changed, requestReductionPct: pct(before.requests, cached.requests), bodyReductionPct: pct(before.bytes, cached.bytes) },
    clientXml,
    dashboard: { before: dashboardBefore, conditional: dashboardConditional, noConditional: dashboardNoConditional,
      conditionalBodyReductionPct: pct(dashboardBefore.bodyBytes, dashboardConditional.bodyBytes) },
  }));
});