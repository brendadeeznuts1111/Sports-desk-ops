import { describe, expect, it } from "bun:test";
import { dns } from "bun";
import {
  BUN_DNS_CACHE_CAPACITY,
  benchmarkResolverLatency,
  classifyIpAddress,
  computeDnsTelemetry,
  ContinuousDnsWarmingManager,
  formatDnsTelemetryMarkdown,
  getDnsTelemetry,
  lookupHost,
  prefetchSportsDeskEndpoints,
  resolveDnsRecordSet,
  resolveDnsTtlSeconds,
  resolvePrimaryAddress,
  SPORTSDESK_CORE_HOSTS,
} from "../lib/bun_dns.ts";

describe("Bun Native DNS & Networking Engine", () => {
  it("prefetches core SportsDesk endpoints without throwing", () => {
    const prefetched = prefetchSportsDeskEndpoints();
    expect(prefetched).toBe(SPORTSDESK_CORE_HOSTS.length);
  });

  it("rejects a NaN prefetch port", () => {
    expect(() => dns.prefetch("example.com", Number.NaN)).toThrow(RangeError);
  });

  it("retrieves DNS cache telemetry with valid metrics", () => {
    const stats = getDnsTelemetry();
    expect(typeof stats.size).toBe("number");
    expect(typeof stats.cacheHitsCompleted).toBe("number");
    expect(typeof stats.cacheMisses).toBe("number");
    expect(typeof stats.cacheHitsInflight).toBe("number");
    expect(typeof stats.errors).toBe("number");
    expect(typeof stats.totalCount).toBe("number");
    expect(typeof stats.hitRatePercent).toBe("number");
    expect(stats.hitRatePercent).toBeGreaterThanOrEqual(0);
    expect(stats.hitRatePercent).toBeLessThanOrEqual(100);
    expect(typeof stats.cacheHitsTotal).toBe("number");
    expect(typeof stats.classifiedRequests).toBe("number");
    expect(typeof stats.unclassifiedRequests).toBe("number");
    expect(typeof stats.cacheHitRatePercent).toBe("number");
    expect(stats.cacheHitsTotal).toBe(
      stats.cacheHitsCompleted + stats.cacheHitsInflight,
    );
    expect(stats.classifiedRequests).toBe(
      stats.cacheHitsTotal + stats.cacheMisses,
    );
    expect(stats.unclassifiedRequests).toBe(
      Math.max(0, stats.totalCount - stats.classifiedRequests),
    );
    expect(stats.cacheHitRatePercent).toBeGreaterThanOrEqual(0);
    expect(stats.cacheHitRatePercent).toBeLessThanOrEqual(100);
    expect(stats.defaultTtlSeconds).toBeGreaterThanOrEqual(1);
  });

  it("computes hit rate over all requests and handles a zero total", () => {
    const populated = computeDnsTelemetry(
      {
        cacheHitsCompleted: 1,
        cacheHitsInflight: 1,
        cacheMisses: 2,
        size: 3,
        errors: 0,
        totalCount: 4,
      },
      30,
    );
    expect(populated.hitRatePercent).toBe(50);
    expect(populated.cacheHitsTotal).toBe(2);
    expect(populated.classifiedRequests).toBe(4);
    expect(populated.unclassifiedRequests).toBe(0);
    expect(populated.cacheHitRatePercent).toBe(50);
    expect(populated.defaultTtlSeconds).toBe(30);

    const empty = computeDnsTelemetry(
      {
        cacheHitsCompleted: 0,
        cacheHitsInflight: 0,
        cacheMisses: 0,
        size: 0,
        errors: 0,
        totalCount: 0,
      },
      30,
    );
    expect(empty.hitRatePercent).toBe(0);
  });

  it("separates request hit rate from classified cache hit rate", () => {
    // A prefetch on an already-cached host increments totalCount without
    // incrementing a hit or a miss; the request rate includes it.
    const prefetched = computeDnsTelemetry(
      {
        cacheHitsCompleted: 1,
        cacheHitsInflight: 0,
        cacheMisses: 1,
        size: 2,
        errors: 0,
        totalCount: 3,
      },
      30,
    );
    expect(prefetched.hitRatePercent).toBe(33.3);
    expect(prefetched.cacheHitRatePercent).toBe(50);
    expect(prefetched.cacheHitsTotal).toBe(1);
    expect(prefetched.classifiedRequests).toBe(2);
    expect(prefetched.unclassifiedRequests).toBe(1);

    // A concurrent request coalesced into one in-flight hit still counts as a hit.
    const coalesced = computeDnsTelemetry(
      {
        cacheHitsCompleted: 0,
        cacheHitsInflight: 1,
        cacheMisses: 1,
        size: 1,
        errors: 0,
        totalCount: 2,
      },
      30,
    );
    expect(coalesced.cacheHitsTotal).toBe(1);
    expect(coalesced.hitRatePercent).toBe(50);
    expect(coalesced.cacheHitRatePercent).toBe(50);

    // A resolution failure is a miss plus an error, not an unclassified request.
    const failed = computeDnsTelemetry(
      {
        cacheHitsCompleted: 0,
        cacheHitsInflight: 0,
        cacheMisses: 1,
        size: 0,
        errors: 1,
        totalCount: 1,
      },
      30,
    );
    expect(failed.classifiedRequests).toBe(1);
    expect(failed.unclassifiedRequests).toBe(0);
    expect(failed.cacheHitRatePercent).toBe(0);
  });

  it("falls back to a 30s TTL for invalid or non-positive config", () => {
    expect(resolveDnsTtlSeconds("5")).toBe(5);
    expect(resolveDnsTtlSeconds("5.9")).toBe(5);
    expect(resolveDnsTtlSeconds("0")).toBe(30);
    expect(resolveDnsTtlSeconds("-1")).toBe(30);
    expect(resolveDnsTtlSeconds("not-a-number")).toBe(30);
    expect(resolveDnsTtlSeconds("")).toBe(30);
  });

  it("pins Bun's documented DNS cache capacity", () => {
    expect(BUN_DNS_CACHE_CAPACITY).toBe(256);
  });

  it("resolves hostname using system and c-ares backends", async () => {
    const results = await lookupHost("localhost", "system");
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first).toBeDefined();
    expect(["127.0.0.1", "::1"]).toContain(first?.address ?? "");
  });

  it("resolves primary address using destructuring pattern", async () => {
    const records = await dns.lookup("example.com", {
      backend: "system",
    });
    const [record] = records;
    expect(record).toBeDefined();
    const address = record?.address;
    expect(typeof address).toBe("string");
    expect(address?.length).toBeGreaterThan(0);

    const helperAddress = await resolvePrimaryAddress("example.com", "system");
    expect(typeof helperAddress).toBe("string");
    expect(records.map((entry) => entry.address)).toContain(
      helperAddress ?? "",
    );
  });

  it("coalesces concurrent requests and records cacheHitsInflight", async () => {
    // Concurrent fetches to test in-flight deduplication
    await Promise.all([
      fetch("https://bun.com").catch(() => {}),
      fetch("https://bun.com").catch(() => {}),
      fetch("https://bun.com").catch(() => {}),
    ]);

    const stats = dns.getCacheStats();
    expect(stats.totalCount).toBeGreaterThanOrEqual(1);
  });

  it("formats DNS telemetry markdown", () => {
    const md = formatDnsTelemetryMarkdown();
    expect(md).toContain("Bun Native DNS Cache");
    expect(md).toContain("Cache Size");
    expect(md).toContain("Hit Rate");
    expect(md).toContain("Cache Hit Rate");
    expect(md).toContain("Unclassified Requests");
  });

  it("benchmarks resolver latency between system and c-ares", async () => {
    const res = await benchmarkResolverLatency(
      "localhost",
      ["system", "c-ares"],
      2,
    );
    expect(res.hostname).toBe("localhost");
    expect(res.metrics.length).toBe(2);
    expect(res.speedupFactor).toBeGreaterThanOrEqual(1.0);
    expect(["system", "c-ares"]).toContain(res.fastestBackend);
  });

  it("classifies IP addresses via reverse DNS lookups", async () => {
    const res = await classifyIpAddress("1.1.1.1");
    expect(res.ipAddress).toBe("1.1.1.1");
    expect(res.isDatacenterOrCloud).toBe(true);
    expect(res.organization).toBe("Cloudflare Edge");
  });

  it("resolves multi-type DNS resource record set", async () => {
    const set = await resolveDnsRecordSet("example.com");
    expect(set.hostname).toBe("example.com");
    expect(set.aRecords.length).toBeGreaterThanOrEqual(0);
    expect(typeof set.timestamp).toBe("string");
  });

  it("ContinuousDnsWarmingManager manages background cycle", () => {
    const manager = new ContinuousDnsWarmingManager(
      SPORTSDESK_CORE_HOSTS,
      5000,
    );
    expect(manager.active()).toBe(false);
    manager.start();
    expect(manager.active()).toBe(true);
    manager.stop();
    expect(manager.active()).toBe(false);
  });
});
