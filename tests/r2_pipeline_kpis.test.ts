import { describe, expect, test } from "bun:test";
import { probeR2PipelineKpis } from "../lib/r2_pipeline_kpis.ts";

describe("probeR2PipelineKpis", () => {
  test("maps HEAD Last-Modified into ageSeconds and stale", async () => {
    const now = new Date("2026-11-09T04:00:00.000Z");
    const last = new Date("2026-11-04T04:37:28.000Z");
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method !== "HEAD") throw new Error("expected HEAD");
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
          headers: { "last-modified": new Date("2026-11-09T03:45:00.000Z").toUTCString() },
        });
      }
      return new Response(null, { status: 404 });
    };
    const kpis = await probeR2PipelineKpis(now, fetchImpl);
    expect(kpis["f402-bet-ticker"]?.stale).toBe(false);
    expect(kpis["gslive-tally"]?.stale).toBe(true);
    expect(kpis["gslive-tally"]?.ageSeconds).toBeGreaterThan(400_000);
  });
});
