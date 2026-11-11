import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyManagerEndpointResponse,
  defaultManagerWindow,
  managerReportUrl,
  MANAGER_ENDPOINT_KINDS,
  parseLiveDataCatalog,
  parsePeriodVocabulary,
  probeManagerEndpoint,
  probeManagerEndpoints,
} from "../lib/gslive_manager_endpoints.ts";
import { fetchAndWriteReportPeriods } from "../scripts/fetch-report-periods.ts";
import { fetchLiveData } from "../scripts/fetch-live-data.ts";
import { parseStatusArgs } from "../scripts/fetch-report-status.ts";

const checkedAt = Date.parse("2026-11-08T20:00:00.000Z");
const PERIODS = ["Game", "Half"];
const REPORT_ROWS = [{ id: 1 }, { id: 2 }];
const CATALOG = {
  sports: { "1": { n: "Baseball" }, "2": { n: "Basketball" } },
  leagues: { "2": { n: "NBA Props", s: 24 }, "4": { n: "NFL", s: 3 } },
  countries: { "1": { n: "England" } },
};

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

describe("manager endpoint classification", () => {
  test("reports are ok only for JSON arrays; catalogs need sports/leagues; periods need strings", () => {
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "application/json",
        body: "[]",
        kind: "users-report",
      }).status,
    ).toBe("ok");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "application/json",
        body: '{"sports":{},"leagues":{}}',
        kind: "live-data",
      }).status,
    ).toBe("ok");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "application/json",
        body: '{"sports":{}}',
        kind: "live-data",
      }).status,
    ).toBe("shape_error");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "application/json",
        body: '{"rows":[]}',
        kind: "users-report",
      }).status,
    ).toBe("shape_error");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "text/html",
        body: '["Game","Half"]',
        kind: "periods",
      }).status,
    ).toBe("ok");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "text/html",
        body: '["Game",1]',
        kind: "periods",
      }).status,
    ).toBe("shape_error");
  });

  test("permission gaps, expired sessions, challenges and transport stay distinct", () => {
    const base = {
      httpStatus: 403,
      contentType: "text/html",
      body: '{"e":1,"r":[],"d":"Not permitted to access this report"}',
      kind: "bettor-report" as const,
    };
    expect(classifyManagerEndpointResponse(base).status).toBe("not_permitted");
    expect(
      classifyManagerEndpointResponse({
        ...base,
        cfMitigated: "challenge",
      }).status,
    ).toBe("challenge");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 401,
        contentType: "text/html",
        body: "",
        kind: "users-report",
      }).status,
    ).toBe("session_expired");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "text/html",
        body: "<html>login</html>",
        kind: "users-report",
      }).status,
    ).toBe("session_expired");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 200,
        contentType: "application/json",
        body: "not json",
        kind: "users-report",
      }).status,
    ).toBe("invalid_json");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 429,
        contentType: "application/json",
        body: "",
        kind: "users-report",
      }).status,
    ).toBe("throttled");
    expect(
      classifyManagerEndpointResponse({
        httpStatus: 503,
        contentType: "application/json",
        body: "",
        kind: "users-report",
      }).status,
    ).toBe("server_error");
  });

  test("URL builder uses epoch bounds and partner id", () => {
    const url = managerReportUrl(
      "events-report",
      { fromEpochSec: 1793509200, toEpochSec: 1794203999 },
      118,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("kind")).toBe("events-report");
    expect(parsed.searchParams.get("from")).toBe("1793509200");
    expect(parsed.searchParams.get("to")).toBe("1794203999");
    expect(parsed.searchParams.get("partnerId")).toBe("118");
  });

  test("live-data parser counts the three catalogs", () => {
    expect(parseLiveDataCatalog(CATALOG)).toEqual({
      sports: 2,
      leagues: 2,
      countries: 1,
    });
    expect(parseLiveDataCatalog({ sports: {} })).toBeNull();
    expect(parsePeriodVocabulary(["Game", "Half"])).toEqual(["Game", "Half"]);
    expect(parsePeriodVocabulary(["Game", 1])).toBeNull();
  });
});

describe("manager endpoint probes", () => {
  test("probes every endpoint and never returns the cookie", async () => {
    const results = await probeManagerEndpoints({
      cookieHeader: "GSID=live-secret",
      window: { fromEpochSec: 1, toEpochSec: 2 },
      now: () => checkedAt,
      fetchImpl: fakeFetch((url) => {
        if (url.includes("/live/data")) {
          return Response.json(CATALOG);
        }
        if (url.includes("/periods/index.php")) {
          return Response.json(PERIODS);
        }
        if (url.includes("kind=open-bet-report")) {
          return Response.json(REPORT_ROWS);
        }
        if (url.includes("kind=bettor-report")) {
          return new Response(
            '{"e":1,"r":[],"d":"Not permitted to access this report"}',
            { status: 403, headers: { "content-type": "text/html" } },
          );
        }
        return Response.json(REPORT_ROWS);
      }),
    });
    expect(results.map((result) => result.kind)).toEqual([
      ...MANAGER_ENDPOINT_KINDS,
    ]);
    const byKind = new Map(results.map((result) => [result.kind, result]));
    expect(byKind.get("live-data")?.status).toBe("ok");
    expect(byKind.get("live-data")?.count).toBe(Object.keys(CATALOG).length);
    expect(byKind.get("periods")?.status).toBe("ok");
    expect(byKind.get("periods")?.count).toBe(PERIODS.length);
    expect(byKind.get("users-report")?.count).toBe(REPORT_ROWS.length);
    expect(byKind.get("open-bet-report")?.count).toBe(REPORT_ROWS.length);
    expect(byKind.get("bettor-report")?.status).toBe("not_permitted");
    expect(JSON.stringify(results)).not.toContain("live-secret");
  });

  test("network failure is unreachable, not an empty success", async () => {
    const result = await probeManagerEndpoint("users-report", {
      cookieHeader: "GSID=live-secret",
      window: defaultManagerWindow(checkedAt),
      now: () => checkedAt,
      fetchImpl: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(result.status).toBe("unreachable");
    expect(result.count).toBeNull();
    expect(JSON.stringify(result)).not.toContain("live-secret");
  });
});

describe("fetch-live-data and status args", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test("writes the catalog atomically and reports counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-data-"));
    roots.push(root);
    const outPath = join(root, "live-data.json");
    const result = await fetchLiveData({
      outPath,
      cookieHeader: "",
      fetchImpl: fakeFetch(() => Response.json(CATALOG)),
    });
    expect(result.summary).toEqual({ sports: 2, leagues: 2, countries: 1 });
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(CATALOG);
  });

  test("writes the report period vocabulary", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-periods-"));
    roots.push(root);
    const outPath = join(root, "report-periods.json");
    const result = await fetchAndWriteReportPeriods({
      outPath,
      cookieHeader: "",
      fetchImpl: fakeFetch(() => Response.json(PERIODS)),
    });
    expect(result.periods).toEqual(PERIODS);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(PERIODS);
  });

  test("status args default to a 7-day window and parse overrides", () => {
    const defaults = parseStatusArgs([], checkedAt);
    expect(defaults?.window.toEpochSec).toBe(Math.floor(checkedAt / 1000));
    const parsed = parseStatusArgs(
      [
        "--from",
        "1793509200",
        "--to",
        "1794203999",
        "--json",
        "--partner",
        "118",
      ],
      checkedAt,
    );
    expect(parsed?.window).toEqual({
      fromEpochSec: 1793509200,
      toEpochSec: 1794203999,
    });
    expect(parsed?.json).toBe(true);
    expect(() => parseStatusArgs(["--bogus"], checkedAt)).toThrow();
  });
});
