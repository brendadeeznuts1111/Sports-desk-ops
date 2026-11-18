import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";

describe("Dev Dashboard Endpoints (scripts/dev_dashboard.ts)", () => {
  let proc: Subprocess;
  let baseUrl: string;

  /** Bind an ephemeral port, read it, release it for the subprocess. */
  function reservePort(): number {
    const probe = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 204 }),
    });
    const port = probe.port;
    probe.stop(true);
    if (port === undefined) {
      throw new Error(
        "ERR_DEV_DASHBOARD_NO_PORT: could not reserve an ephemeral port",
      );
    }
    return port;
  }

  async function waitForHealth(url: string): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < 6000) {
      try {
        if ((await fetch(`${url}/health`)).ok) return true;
      } catch {
        await Bun.sleep(100);
      }
    }
    return false;
  }

  beforeAll(async () => {
    // Parallel test workers share the OS network namespace, so a fixed port lets two
    // copies of this file talk to each other's server (observed: one copy fails while
    // the other holds 4055). Reserve an ephemeral port and retry if it is taken.
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = reservePort();
      baseUrl = `http://127.0.0.1:${port}`;
      proc = Bun.spawn(["bun", "run", "scripts/dev_dashboard.ts"], {
        env: {
          ...process.env,
          PORT: String(port),
          SPORTSDESK_AUTH_DISABLED: "1",
          SPORTSDESK_LIVE_WAGERS_JSON:
            "tests/fixtures/live-wagers.partial.json",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (await waitForHealth(baseUrl)) return;
      proc.kill();
    }
    throw new Error("Dev dashboard failed to start within timeout");
  });

  afterAll(() => {
    proc.kill();
  });

  describe("Static directory routes", () => {
    it("serves /static/* through the range-aware handler, not the native dir mount", async () => {
      const res = await fetch(`${baseUrl}/static/live-bets.html`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("Live");
      // A strong validator: the native `{ dir }` route answers `W/"1000-…"`, so this also proves
      // the mount is the handler and not the directory route.
      const etag = res.headers.get("etag") ?? "";
      expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
    });

    it("answers a byte range on a static page", async () => {
      const res = await fetch(`${baseUrl}/static/live-bets.html`, {
        headers: { Range: "bytes=0-9" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toMatch(/^bytes 0-9\/\d+$/);
      expect((await res.arrayBuffer()).byteLength).toBe(10);
    });

    it("revalidates a static page with its ETag", async () => {
      const first = await fetch(`${baseUrl}/static/live-bets.html`);
      const etag = first.headers.get("etag") ?? "";
      const cached = await fetch(`${baseUrl}/static/live-bets.html`, {
        headers: { "If-None-Match": etag },
      });
      expect(cached.status).toBe(304);
    });

    it("does not escape the static directory", async () => {
      const res = await fetch(`${baseUrl}/static/../package.json`);
      expect([400, 403, 404]).toContain(res.status);
    });
  });

  describe("DNS Telemetry Endpoints", () => {
    it("answers GET /api/dns with telemetry and core hosts", async () => {
      const res = await fetch(`${baseUrl}/api/dns`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(data.telemetry).toBeDefined();
      expect(Array.isArray(data.hosts)).toBe(true);
      expect(Array.isArray(data.coreHosts)).toBe(true);
    });

    it("answers canonical GET /api/dns/telemetry with identical payload", async () => {
      const res = await fetch(`${baseUrl}/api/dns/telemetry`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(data.telemetry).toBeDefined();
      expect(Array.isArray(data.coreHosts)).toBe(true);
    });
  });

  describe("Customer Profiling & Rating Endpoints", () => {
    it("derives dynamic cohort counts on GET /api/customers without static hardcoding", async () => {
      const res = await fetch(`${baseUrl}/api/customers`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        cohorts: {
          backtestCount: number;
          keyNumberSharpsCount: number;
          hookSyndicateCount: number;
          fixtureCount: number;
          fullBookSpecCount: number;
          uniqueSurveillanceCount: number;
        };
      };
      expect(data.cohorts.keyNumberSharpsCount).toBeGreaterThan(0);
      expect(data.cohorts.hookSyndicateCount).toBeGreaterThan(0);
      expect(data.cohorts.fixtureCount).toBeGreaterThan(0);
      expect(data.cohorts.uniqueSurveillanceCount).toBeGreaterThan(0);
    });

    it("serves comprehensive customer profile on GET /api/customer/profile?id=SYNTH_SYN_01", async () => {
      const res = await fetch(
        `${baseUrl}/api/customer/profile?id=SYNTH_SYN_01`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        profile: { customerId: string };
      };
      expect(data.success).toBe(true);
      expect(data.profile.customerId).toBe("SYNTH_SYN_01");
    });

    it("serves Bayesian customer rating on GET /api/customer/rating?id=SYNTH_SYN_01", async () => {
      const res = await fetch(`${baseUrl}/api/customer/rating?id=SYNTH_SYN_01`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        rating: { customerId: string };
      };
      expect(data.success).toBe(true);
      expect(data.rating.customerId).toBe("SYNTH_SYN");
    });
  });

  describe("Live Wagers Ingestion Feed", () => {
    it("dynamically loads and projects wagers on GET /api/wagers", async () => {
      const res = await fetch(`${baseUrl}/api/wagers`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        wagers: Array<{ ticketId: string; alertTier: string; riskUsd: number }>;
        totalRiskUsd: number;
        autoExecute: boolean;
        provenance: { kind: string; sourcePath: string | null };
      };
      expect(Array.isArray(data.wagers)).toBe(true);
      expect(data.wagers.length).toBeGreaterThan(0);
      expect(data.totalRiskUsd).toBeGreaterThan(0);
      expect(data.autoExecute).toBe(false);
      expect(data.provenance.kind).toBe("fixture");
      expect(data.provenance.sourcePath).toBe(
        "tests/fixtures/live-wagers.partial.json",
      );
    });

    it("serves live wagers on alias route GET /api/live-wagers", async () => {
      const res = await fetch(`${baseUrl}/api/live-wagers`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        wagers: Array<{ ticketId: string }>;
      };
      expect(Array.isArray(data.wagers)).toBe(true);
      expect(data.wagers.length).toBeGreaterThan(0);
    });
  });

  describe("Bet-Ticker, R2 Pipeline, and Local Agent/Customer Link Endpoints", () => {
    it("serves GET /api/bet-ticker with localFeed channels/types and autoExecute: false", async () => {
      const res = await fetch(`${baseUrl}/api/bet-ticker`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        autoExecute: boolean;
        localFeed: {
          tickets: Array<{ ticketId: string }>;
          byWriter: Array<{ writer: string }>;
        };
      };
      expect(data.autoExecute).toBe(false);
      expect(Array.isArray(data.localFeed.tickets)).toBe(true);
      expect(Array.isArray(data.localFeed.byWriter)).toBe(true);
    });

    it("serves GET /api/r2/pipeline and GET /api/daemon/status", async () => {
      const [r2Res, daemonRes] = await Promise.all([
        fetch(`${baseUrl}/api/r2/pipeline`),
        fetch(`${baseUrl}/api/daemon/status`),
      ]);
      expect(r2Res.status).toBe(200);
      const r2Json = (await r2Res.json()) as {
        sinks: Array<{ id: string }>;
        daemon4020: { online: boolean };
      };
      expect(Array.isArray(r2Json.sinks)).toBe(true);
      expect(r2Json.sinks.length).toBe(4);
      expect(daemonRes.status).toBe(200);
    });

    it("serves GET /api/r2/pipeline/history as a process-local series", async () => {
      const res = await fetch(
        `${baseUrl}/api/r2/pipeline/history?refresh=1&limit=5`,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        schemaVersion: number;
        source: string;
        minSampleIntervalSeconds: number;
        sampledSince: string | null;
        sinks: Array<{
          id: string;
          sampleCount: number;
          samples: Array<{ at: string; state: string }>;
        }>;
      };
      expect(json.schemaVersion).toBe(1);
      expect(json.source).toBe("process-memory");
      expect(json.minSampleIntervalSeconds).toBe(60);
      expect(json.sinks.map((sink) => sink.id)).toEqual([
        "f402-bet-ticker",
        "gslive-tally",
        "f402-weblog",
        "wagers-by-state",
      ]);
      for (const sink of json.sinks) {
        expect(sink.sampleCount).toBeGreaterThanOrEqual(1);
        expect(sink.samples.length).toBeGreaterThanOrEqual(1);
        expect(sink.samples.at(-1)?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
      expect(json.sampledSince).not.toBeNull();
    });

    it("serves GET /api/r2/image-provenance for a public WebP over R2", async () => {
      const res = await fetch(
        `${baseUrl}/api/r2/image-provenance?key=assets/ARCH-Guide.webp`,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        key: string;
        publicUrl: string;
        fetchedBytes: number;
        report: {
          available: boolean;
          format: string;
          fields: { streamId: string | null };
          issues: readonly string[];
        };
      };
      expect(json.key).toBe("assets/ARCH-Guide.webp");
      expect(json.publicUrl).toBe(
        "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/ARCH-Guide.webp",
      );
      expect(json.fetchedBytes).toBeGreaterThan(0);
      expect(json.report.available).toBe(true);
      expect(json.report.format).toBe("webp");
      // The shipped WebP carries no XMP chunk: missing provenance is reported, never invented.
      expect(json.report.fields.streamId).toBeNull();
      expect(json.report.issues).toContain("no_sportsdesk_metadata");
    });

    it("serves GET /api/agent/:id JSON, GET /agent/:id HTML, and 302 redirect on GET /customer/:id", async () => {
      const [apiRes, htmlRes, custRes] = await Promise.all([
        fetch(`${baseUrl}/api/agent/FAKEMONEY`),
        fetch(`${baseUrl}/agent/FAKEMONEY`),
        fetch(`${baseUrl}/customer/GP301`, { redirect: "manual" }),
      ]);
      expect(apiRes.status).toBe(200);
      const apiJson = (await apiRes.json()) as {
        agentId: string;
        autoExecute: boolean;
      };
      expect(apiJson.agentId).toBe("FAKEMONEY");
      expect(apiJson.autoExecute).toBe(false);

      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toContain("text/html");
      const html = await htmlRes.text();
      expect(html).toContain("Agent FAKEMONEY");

      expect(custRes.status).toBe(302);
      expect(custRes.headers.get("location")).toBe(
        "/?tab=customers&search=GP301",
      );
      // Three concurrent fetches against a subprocess server: 5s (the default) is
      // not enough headroom when the file runs inside a saturated --parallel pool.
    }, 15_000);
  });
});
