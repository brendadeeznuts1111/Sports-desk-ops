import { describe, expect, test } from "bun:test";
import {
  CANONICAL_MANIFEST_SINK_IDS,
  canonicalManifestPublicUrl,
  probeCanonicalManifestKpis,
  type CanonicalManifestFetcher,
} from "../lib/r2_canonical_manifests.ts";
import { CANONICAL_R2_SINK_SPECS } from "../lib/r2_manifest_cas.ts";
import { R2_DATA_STALE_SECONDS } from "../lib/r2_pipeline_kpis.ts";
import { R2_PUBLIC_BASE } from "../lib/r2_staleness.ts";

const NOW = new Date("2026-11-17T22:00:00.000Z");
const MERKLE =
  "762d82a5191e06e2437b456e5fe6282434319fbe0e442ebdf49cc4e5a08de392";

interface FakeSink {
  readonly head: { readonly status: number; readonly lastModified?: Date };
  /** Absent means the GET 404s; "non-json" means a 200 with a non-JSON body. */
  readonly body?: unknown;
  readonly refuses?: boolean;
}

/** Route a fake response by the sink id in the manifest URL. */
function fetcherFor(
  bySink: Record<string, FakeSink>,
): CanonicalManifestFetcher {
  return async (url) => {
    const sinkId = url.split("/manifests/")[1]?.slice(0, -"/latest".length);
    const sink = sinkId === undefined ? undefined : bySink[sinkId];
    if (sink === undefined) return new Response(null, { status: 404 });
    if (sink.refuses === true) throw new Error("connection refused");
    const headers =
      sink.head.lastModified === undefined
        ? {}
        : { "last-modified": sink.head.lastModified.toUTCString() };
    if (sink.head.status !== 200) {
      return new Response(null, { status: sink.head.status, headers });
    }
    if (sink.body === undefined) {
      return new Response(null, { status: 200, headers });
    }
    if (sink.body === "non-json") return new Response("not json", { headers });
    return Response.json(sink.body, { status: 200, headers });
  };
}

function manifestBody(
  sinkId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    domain: "[Ops & Governance]",
    sink_id: sinkId,
    r2_bucket: "sportsdesk-ops-reports",
    generation_u32: 2,
    merkle_root_sha256: MERKLE,
    watermark_cursor: "762d82a5191e06e2:381",
    data_window_max_epoch_ms: NOW.getTime() - 10 * 60 * 1_000,
    r2_published_at_epoch_ms: NOW.getTime() - 2 * 60 * 1_000,
    circuit_state: "CLOSED",
    unresolved_gap_cents: "0",
    ...overrides,
  };
}

function freshSink(
  sinkId: string,
  overrides: Record<string, unknown> = {},
): FakeSink {
  return {
    head: {
      status: 200,
      lastModified: new Date(NOW.getTime() - 2 * 60 * 1_000),
    },
    body: manifestBody(sinkId, overrides),
  };
}

describe("canonical manifest targets", () => {
  test("enumerates every canonical sink and reads its spec's manifest key", () => {
    expect(CANONICAL_MANIFEST_SINK_IDS.length).toBe(
      Object.keys(CANONICAL_R2_SINK_SPECS).length,
    );
    expect(new Set(CANONICAL_MANIFEST_SINK_IDS).size).toBe(
      Object.keys(CANONICAL_R2_SINK_SPECS).length,
    );
    const ids: readonly string[] = CANONICAL_MANIFEST_SINK_IDS;
    expect([...ids].sort()).toEqual(
      Object.keys(CANONICAL_R2_SINK_SPECS).sort(),
    );
    for (const sinkId of CANONICAL_MANIFEST_SINK_IDS) {
      expect(canonicalManifestPublicUrl(sinkId)).toBe(
        `${R2_PUBLIC_BASE}/${CANONICAL_R2_SINK_SPECS[sinkId].manifestKey}`,
      );
    }
  });
});

describe("probeCanonicalManifestKpis", () => {
  test("reports pointer freshness, lineage and data age as separate facts", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({ "wagers-by-state": freshSink("wagers-by-state") }),
    );
    const wagers = kpis["wagers-by-state"];
    expect(wagers.state).toBe("fresh");
    expect(wagers.stale).toBe(false);
    expect(wagers.ageSeconds).toBe(120);
    expect(wagers.reason).toContain("SLA 1h");
    expect(wagers.generation).toBe(2);
    expect(wagers.merkleRoot).toBe(MERKLE);
    expect(wagers.circuitState).toBe("CLOSED");
    expect(wagers.unresolvedGapCents).toBe("0");
    expect(wagers.identityOk).toBe(true);
    expect(wagers.manifestKey).toBe("manifests/wagers-by-state/latest");
    expect(wagers.dataAgeSeconds).toBe(600);
    expect(wagers.dataStale).toBe(false);
    expect(wagers.publishedAt).toBe(
      new Date(NOW.getTime() - 2 * 60 * 1_000).toISOString(),
    );

    // An unstubbed sink is missing, never silently fresh.
    expect(kpis["syndicate-rings"].state).toBe("missing");
    expect(kpis["syndicate-rings"].stale).toBe(true);
    expect(kpis["syndicate-rings"].generation).toBeNull();
  });

  test("a pointer older than the spec SLA is stale, not fresh", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "ops-supervisor": {
          head: {
            status: 200,
            lastModified: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000),
          },
          body: manifestBody("ops-supervisor"),
        },
      }),
    );
    const ops = kpis["ops-supervisor"];
    expect(ops.state).toBe("stale");
    expect(ops.stale).toBe(true);
    expect(ops.ageSeconds).toBe(7_200);
  });

  test("a 404 pointer is missing, never fresh", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "edge-topology": { head: { status: 404 } },
      }),
    );
    const edge = kpis["edge-topology"];
    expect(edge.state).toBe("missing");
    expect(edge.stale).toBe(true);
    expect(edge.ageSeconds).toBeNull();
    expect(edge.reason).toContain("404");
    expect(edge.generation).toBeNull();
    expect(edge.identityOk).toBeNull();
  });

  test("a refused connection is error for that sink only", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "syndicate-rings": { head: { status: 0 }, refuses: true },
      }),
    );
    expect(kpis["syndicate-rings"].state).toBe("error");
    expect(kpis["syndicate-rings"].stale).toBe(true);
    expect(kpis["syndicate-rings"].reason).toContain("connection refused");
    // The other sinks still answered, so their own state stands.
    expect(kpis["wagers-by-state"].state).toBe("missing");
  });

  test("separates publish freshness from data-window age", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "wagers-by-state": freshSink("wagers-by-state", {
          data_window_max_epoch_ms:
            NOW.getTime() - (R2_DATA_STALE_SECONDS + 60) * 1_000,
        }),
      }),
    );
    const wagers = kpis["wagers-by-state"];
    expect(wagers.stale).toBe(false);
    expect(wagers.dataAgeSeconds).toBe(R2_DATA_STALE_SECONDS + 60);
    expect(wagers.dataStale).toBe(true);
  });

  test("a manifest at the wrong key reports identity drift", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "wagers-by-state": freshSink("syndicate-rings"),
      }),
    );
    expect(kpis["wagers-by-state"].identityOk).toBe(false);
  });

  test("falls back to manifest_key when a body omits sink_id", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "syndicate-rings": freshSink("syndicate-rings", {
          sink_id: undefined,
          manifest_key: "manifests/syndicate-rings/latest",
        }),
      }),
    );
    expect(kpis["syndicate-rings"].identityOk).toBe(true);

    const drifted = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "syndicate-rings": freshSink("syndicate-rings", {
          sink_id: undefined,
          manifest_key: "manifests/wagers-by-state/latest",
        }),
      }),
    );
    expect(drifted["syndicate-rings"].identityOk).toBe(false);
  });

  test("carries circuit state and a non-zero reconciliation gap", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "ops-supervisor": freshSink("ops-supervisor", {
          circuit_state: "OPEN",
          unresolved_gap_cents: "500",
        }),
      }),
    );
    const ops = kpis["ops-supervisor"];
    // Acceptance is a pointer fact; circuit and gap stay separate evidence.
    expect(ops.state).toBe("fresh");
    expect(ops.circuitState).toBe("OPEN");
    expect(ops.unresolvedGapCents).toBe("500");
  });

  test("200 without Last-Modified is an error but lineage survives", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "ops-supervisor": {
          head: { status: 200 },
          body: manifestBody("ops-supervisor"),
        },
      }),
    );
    const ops = kpis["ops-supervisor"];
    expect(ops.state).toBe("error");
    expect(ops.ageSeconds).toBeNull();
    expect(ops.generation).toBe(2);
    expect(ops.identityOk).toBe(true);
  });

  test("a non-JSON body never invents lineage", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "edge-topology": { head: { status: 200 }, body: "non-json" },
      }),
    );
    const edge = kpis["edge-topology"];
    expect(edge.generation).toBeNull();
    expect(edge.merkleRoot).toBeNull();
    expect(edge.identityOk).toBeNull();
    expect(edge.dataAgeSeconds).toBeNull();
  });

  test("an absent body leaves lineage null while the pointer still measures", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "syndicate-rings": {
          head: {
            status: 200,
            lastModified: new Date(NOW.getTime() - 60 * 1_000),
          },
        },
      }),
    );
    const rings = kpis["syndicate-rings"];
    expect(rings.state).toBe("fresh");
    expect(rings.ageSeconds).toBe(60);
    expect(rings.generation).toBeNull();
    expect(rings.merkleRoot).toBeNull();
    expect(rings.identityOk).toBeNull();
    expect(rings.publishedAt).toBeNull();
  });

  test("edge-topology accepts snapshot_gen_u32 when generation_u32 is absent", async () => {
    const kpis = await probeCanonicalManifestKpis(
      NOW,
      fetcherFor({
        "edge-topology": freshSink("edge-topology", {
          generation_u32: undefined,
          snapshot_gen_u32: 7,
        }),
      }),
    );
    expect(kpis["edge-topology"].generation).toBe(7);
  });
});
