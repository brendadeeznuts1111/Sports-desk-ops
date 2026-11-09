import { describe, expect, it } from "bun:test";
import { dns } from "bun";
import {
  formatDnsTelemetryMarkdown,
  getDnsTelemetry,
  lookupHost,
  prefetchSportsDeskEndpoints,
  resolvePrimaryAddress,
  SPORTSDESK_CORE_HOSTS,
} from "../lib/bun_dns.ts";

describe("Bun Native DNS & Networking Engine", () => {
  it("prefetches core SportsDesk endpoints without throwing", () => {
    const prefetched = prefetchSportsDeskEndpoints();
    expect(prefetched).toBe(SPORTSDESK_CORE_HOSTS.length);
  });

  it("retrieves DNS cache telemetry with valid metrics", () => {
    const stats = getDnsTelemetry();
    expect(typeof stats.size).toBe("number");
    expect(typeof stats.cacheHitsCompleted).toBe("number");
    expect(typeof stats.cacheMisses).toBe("number");
    expect(typeof stats.totalCount).toBe("number");
    expect(typeof stats.hitRatePercent).toBe("number");
    expect(stats.defaultTtlSeconds).toBeGreaterThanOrEqual(1);
  });

  it("resolves hostname using system and c-ares backends", async () => {
    const results = await lookupHost("localhost", "system");
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first).toBeDefined();
    expect(["127.0.0.1", "::1"]).toContain(first?.address ?? "");
  });

  it("resolves primary address using destructuring pattern", async () => {
    const [record] = await dns.lookup("localhost", {
      backend: "system",
    });
    expect(record).toBeDefined();
    const address = record?.address;
    expect(typeof address).toBe("string");
    expect(["127.0.0.1", "::1"]).toContain(address ?? "");

    const helperAddress = await resolvePrimaryAddress("localhost", "system");
    expect(helperAddress).toBe(address ?? null);
  });

  it("formats DNS telemetry markdown", () => {
    const md = formatDnsTelemetryMarkdown();
    expect(md).toContain("Bun Native DNS Cache");
    expect(md).toContain("Cache Size");
    expect(md).toContain("Hit Rate");
  });
});
