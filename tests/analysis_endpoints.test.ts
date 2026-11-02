import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("analysis endpoints", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("serves the filter vocabulary with its provenance", async () => {
    const res = await fetch(`${server.url}api/analysis/filters`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      provenance: string;
      captured: boolean;
      reports: Array<{ value: string; label: string }>;
      activities: Array<{ value: string; label: string }>;
      groups: Array<{ value: string }>;
      weeks: Array<{ value: string }>;
      requiredCapture: string;
    };

    expect(body.captured).toBe(false);
    expect(body.provenance).toContain("report.js");
    expect(body.reports.map((r) => r.value)).toEqual(["CP", "CPS", "CPV", "G"]);
    expect(body.activities.length).toBe(14);
    expect(body.groups.map((g) => g.value)).toEqual(["1", "2"]);
    expect(body.weeks.map((w) => w.value)).toContain("enter-dates");
    expect(body.requiredCapture).toContain("getAgentPerformance");
    expect(body.requiredCapture).toContain("getAnalysis");
  });

  test("validates a selection and refuses to invent a report", async () => {
    const res = await fetch(
      `${server.url}api/analysis?report=CPV&activity=4&group=2&week=0&agent=MJ2026`,
    );
    expect(res.status).toBe(501);

    const body = (await res.json()) as {
      available: boolean;
      filter: { report: string; activity: string; agent: string };
      description: string;
      requiredCapture: string;
    };
    expect(body.available).toBe(false);
    expect(body.filter.report).toBe("CPV");
    expect(body.filter.activity).toBe("4");
    expect(body.filter.agent).toBe("MJ2026");
    expect(body.description).toContain("Customer Volume");
    expect(body.requiredCapture).toContain("getAgentPerformance");
    expect(body.requiredCapture).toContain("getAnalysis");
  });

  test("rejects an unknown code with 400 and the allowed values", async () => {
    const res = await fetch(`${server.url}api/analysis?report=ZZ`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: string[] };
    expect(body.issues[0]).toContain("CP, CPS, CPV, G");
  });

  test("defaults an empty query to the portal's first option", async () => {
    const res = await fetch(`${server.url}api/analysis`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { filter: Record<string, string> };
    expect(body.filter).toEqual({
      report: "CP",
      activity: "-1",
      group: "1",
      week: "-1",
      agent: "",
    });
  });
});

describe("analysis report with a transcribed result", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const get = (path: string) => fetch(`${server.url}${path}`);

  const BASE = "report=CP&agent=BILLY666&sport=Baseball&week=-1&activity=0";

  test("serves the pasted Customer Performance report for its own selection", async () => {
    const res = await get(`api/analysis?${BASE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      available: boolean;
      report: string;
      source: string;
      observedAt: string;
      rows: Array<{
        customer: string;
        duplicateOf: string | null;
        risk: number;
      }>;
      totals: {
        accounts: number;
        wagers: number;
        risk: number;
        net: number;
        holdPercent: number;
      };
      recomputed: {
        accounts: number;
        wagers: number;
        risk: number;
        net: number;
        holdPercent: number;
      };
      discrepancies: unknown[];
    };

    expect(body.available).toBe(true);
    expect(body.report).toBe("CP");
    expect(body.observedAt).toBe("2026-11-01");
    expect(body.rows).toHaveLength(8);
    expect(body.totals).toEqual(body.recomputed);
    expect(body.discrepancies).toEqual([]);
    expect(body.totals.accounts).toBe(7);
    expect(body.totals.wagers).toBe(9);
    expect(body.totals.risk).toBe(1574500);
    expect(body.totals.holdPercent).toBe(-58.33);
  });

  test("keeps the duplicate row visible but out of the totals", async () => {
    const body = (await (await get(`api/analysis?${BASE}`)).json()) as {
      rows: Array<{ customer: string; duplicateOf: string | null }>;
      totals: { risk: number };
    };
    const dupes = body.rows.filter((row) => row.duplicateOf !== null);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.customer).toBe("KYM206");
    // Eight rows would sum to 1,575,000 cents; the totals use seven.
    expect(body.totals.risk).toBe(1574500);
  });

  test("answers 501 for a different selection instead of reusing the report", async () => {
    for (const path of [
      "api/analysis?report=CP&agent=BILLY666&sport=Football&week=-1&activity=0",
      "api/analysis?report=CPS&agent=BILLY666&sport=Baseball&week=-1&activity=0",
      "api/analysis?report=CP&agent=MJ2026&sport=Baseball&week=-1&activity=0",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { storedReports: unknown[] };
      expect(body.storedReports).toHaveLength(1);
    }
  });

  test("never echoes the password the paste carried", async () => {
    const res = await get(`api/analysis?${BASE}`);
    const text = await res.text();
    expect(text).not.toContain("RING");
    expect(text.toLowerCase()).not.toContain("pw:");
  });
});
