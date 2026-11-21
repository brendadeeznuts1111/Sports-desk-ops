import type { WeblogAccountCoverage } from "../lib/f402_weblog_capture.ts";
import { describe, expect, test } from "bun:test";
import {
  parseDataWindowEndMs,
  probeR2PipelineKpis,
  R2_DATA_STALE_SECONDS,
  type R2PipelineFetcher,
} from "../lib/r2_pipeline_kpis.ts";

describe("parseDataWindowEndMs", () => {
  test("reads weblog window.toMs", () => {
    expect(parseDataWindowEndMs({ window: { toMs: 1_762_300_799_000 } })).toBe(
      1_762_300_799_000,
    );
  });

  test("reads wagers observedEnd", () => {
    const ms = Date.parse("2026-11-04T12:00:00.000Z");
    expect(
      parseDataWindowEndMs({
        window: { observedEnd: "2026-11-04T12:00:00.000Z" },
      }),
    ).toBe(ms);
  });

  test("reads gslive toEpochSec", () => {
    expect(
      parseDataWindowEndMs({ window: { toEpochSec: 1_762_000_000 } }),
    ).toBe(1_762_000_000_000);
  });
});

describe("probeR2PipelineKpis", () => {
  test("maps HEAD Last-Modified into ageSeconds and stale", async () => {
    const now = new Date("2026-11-09T04:00:00.000Z");
    const last = new Date("2026-11-04T04:37:28.000Z");
    const fetchImpl: R2PipelineFetcher = async (url, init) => {
      if (init.method === "GET") {
        return new Response(null, { status: 404 });
      }
      const key = url.split("/").slice(-2).join("/");
      if (key === "gslive-tally/latest.json") {
        return new Response(null, {
          status: 200,
          headers: { "last-modified": last.toUTCString() },
        });
      }
      if (key === "f402-bet-ticker/latest.json") {
        return new Response(null, {
          status: 200,
          headers: {
            "last-modified": new Date("2026-11-09T03:45:00.000Z").toUTCString(),
          },
        });
      }
      return new Response(null, { status: 404 });
    };
    const kpis = await probeR2PipelineKpis(now, fetchImpl);
    expect(kpis["f402-bet-ticker"]?.stale).toBe(false);
    expect(kpis["gslive-tally"]?.stale).toBe(true);
    expect(kpis["gslive-tally"]?.ageSeconds).toBeGreaterThan(400_000);
  });

  test("separates publish freshness from rollup data age", async () => {
    const now = new Date("2026-11-09T04:00:00.000Z");
    const publishLast = new Date("2026-11-09T03:00:00.000Z");
    const toMs = Date.parse("2026-11-04T23:59:59.000Z");
    const fetchImpl: R2PipelineFetcher = async (url, init) => {
      if (init.method === "HEAD") {
        if (url.endsWith("f402-weblog/latest.json")) {
          return new Response(null, {
            status: 200,
            headers: { "last-modified": publishLast.toUTCString() },
          });
        }
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("f402-weblog/latest.json")) {
        return Response.json({
          key: "f402-weblog/2026-11-04/rollup.json",
        });
      }
      if (url.endsWith("f402-weblog/2026-11-04/rollup.json")) {
        return Response.json({ window: { toMs } });
      }
      return new Response(null, { status: 404 });
    };
    const kpis = await probeR2PipelineKpis(now, fetchImpl);
    const weblog = kpis["f402-weblog"];
    expect(weblog?.stale).toBe(false);
    expect(weblog?.dataAgeSeconds).toBeGreaterThan(R2_DATA_STALE_SECONDS);
    expect(weblog?.dataStale).toBe(true);
    expect(weblog?.dataWindowToMs).toBe(toMs);
  });
});

test("weblog KPI exposes scoped account coverage and marks legacy coverage unmeasured", async () => {
  const coverage: WeblogAccountCoverage = {
    scope: "live-pending-accounts",
    wholeBookComplete: false,
    snapshotCapturedAt: "2026-11-19T12:00:00Z",
    capturedAt: "2026-11-19T12:05:00Z",
    reportDate: "2026-11-19",
    snapshotTicketRows: 50,
    unidentifiedTicketRows: 5,
    eligibleAccounts: 20,
    requestedAccounts: 20,
    completedAccounts: 20,
    accountsWithActivity: 18,
    emptyAccounts: 2,
    failedAccounts: 0,
    activityRows: 658,
  };
  const result = await probeR2PipelineKpis(
    new Date("2026-11-19T12:10:00Z"),
    async (url, init) =>
      init.method === "HEAD"
        ? new Response(null, {
            headers: { "last-modified": "Thu, 19 Nov 2026 12:05:00 GMT" },
          })
        : Response.json(
            url.includes("f402-weblog")
              ? {
                  coverage,
                  window: { toMs: Date.parse("2026-11-19T12:00:00Z") },
                }
              : {},
          ),
  );
  expect(result["f402-weblog"]?.accountCoverage).toEqual(coverage);
  const legacy = await probeR2PipelineKpis(new Date(), async () =>
    Response.json({}),
  );
  expect(legacy["f402-weblog"]?.accountCoverage).toBeNull();
});
