import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DNS_TTL_SECONDS,
  DNS_CACHE_CAPACITY,
  DnsBoundaryError,
  type IpAddressScope,
  MAX_DNS_TTL_SECONDS,
  assertCleanHostname,
  assertCleanPort,
  assertDnsCacheHealthy,
  assertPublicIp,
  assertValidDnsTtlSeconds,
  classifyIpScope,
  lookupPublicStrictFamily,
  lookupStrictFamily,
  prefetchHostSafe,
  readDnsCacheStatsBoundary,
} from "../src/lib/dns_boundary.ts";

async function captureBoundaryError(
  fn: () => Promise<unknown>,
): Promise<DnsBoundaryError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DnsBoundaryError);
    return err as DnsBoundaryError;
  }
  throw new Error("Expected DnsBoundaryError to be thrown");
}

function captureSyncBoundaryError(fn: () => unknown): DnsBoundaryError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DnsBoundaryError);
    return err as DnsBoundaryError;
  }
  throw new Error("Expected DnsBoundaryError to be thrown");
}

describe("L1: Bun.dns Hostname & IP Family Boundaries", () => {
  test("assertCleanHostname normalizes valid domains and IPv4 literals", () => {
    expect(assertCleanHostname("Desk.BookDeskOps.com.")).toBe(
      "desk.bookdeskops.com",
    );
    expect(assertCleanHostname("127.0.0.1")).toBe("127.0.0.1");
  });

  test("assertCleanHostname rejects schemes, ports, brackets, and IPv6 zone IDs", () => {
    expect(() => assertCleanHostname("https://desk.bookdeskops.com")).toThrow(
      "ERR_DNS_INVALID_HOSTNAME",
    );
    expect(() => assertCleanHostname("desk.bookdeskops.com:443")).toThrow(
      "ERR_DNS_INVALID_HOSTNAME",
    );
    expect(() => assertCleanHostname("[::1]")).toThrow(
      "ERR_DNS_INVALID_HOSTNAME",
    );
    expect(() => assertCleanHostname("fe80::1%eth0")).toThrow(
      "ERR_DNS_IPV6_ZONE_FORBIDDEN",
    );
    expect(() => assertCleanHostname("fe80::1%25en0")).toThrow(
      "ERR_DNS_IPV6_ZONE_FORBIDDEN",
    );
    expect(() => assertCleanHostname("999.0.0.1")).toThrow(
      "ERR_DNS_INVALID_HOSTNAME",
    );
  });

  test("lookupStrictFamily resolves localhost strictly as IPv4 via system backend", async () => {
    const records = await lookupStrictFamily("localhost", {
      family: 4,
      backend: "system",
      timeoutMs: 2_000,
    });
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.family).toBe(4);
      expect(rec.address).toBe("127.0.0.1");
    }
  });

  test("lookupStrictFamily surfaces ERR_DNS_LOOKUP_FAILED on non-existent TLD", async () => {
    let caught: unknown;
    try {
      await lookupStrictFamily("nonexistent.sportsdesk.invalid", {
        family: 4,
        backend: "system",
        timeoutMs: 2_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DnsBoundaryError);
    expect((caught as DnsBoundaryError).code).toBe("ERR_DNS_LOOKUP_FAILED");
  });

  test("assertCleanHostname normalizes bare IPv6 literals and enforces RFC 1123 limits", () => {
    expect(assertCleanHostname("2001:DB8::1")).toBe("2001:db8::1");
    expect(assertCleanHostname("::1")).toBe("::1");
    expect(assertCleanHostname("A".repeat(63) + ".com")).toBe(
      "a".repeat(63) + ".com",
    );

    const max253 = [
      "a".repeat(63),
      "b".repeat(63),
      "c".repeat(63),
      "d".repeat(57),
      "com",
    ].join(".");
    expect(max253.length).toBe(253);
    expect(assertCleanHostname(max253)).toBe(max253);

    const over254 = max253 + "x";
    expect(over254.length).toBe(254);

    const invalidInputs = [
      "",
      " ",
      " example.com",
      "example.com ",
      "bad\u0000host.com",
      "bad\nhost.com",
      "bad\u007fhost.com",
      "example.com..",
      ".example.com",
      "a..b.com",
      "-a.com",
      "a-.com",
      "a".repeat(64) + ".com",
      over254,
      "user@example.com",
      "example.com/path",
      "example.com?a=1",
      "example.com#frag",
    ];
    for (const invalid of invalidInputs) {
      const err = captureSyncBoundaryError(() => assertCleanHostname(invalid));
      expect(err.code).toBe("ERR_DNS_INVALID_HOSTNAME");
    }
  });

  test("lookupStrictFamily enforces timeout, family mismatch, filtering, and failure cause", async () => {
    const timeoutErr = await captureBoundaryError(() =>
      lookupStrictFamily("example.com", {
        family: 4,
        timeoutMs: 25,
        lookupFn: () => new Promise(() => {}),
      }),
    );
    expect(timeoutErr.code).toBe("ERR_DNS_LOOKUP_TIMEOUT");

    const badFamilyErr = await captureBoundaryError(() =>
      lookupStrictFamily("example.com", {
        family: 0 as never,
      }),
    );
    expect(badFamilyErr.code).toBe("ERR_DNS_FAMILY_MISMATCH");

    const wrongFamilyErr = await captureBoundaryError(() =>
      lookupStrictFamily("example.com", {
        family: 4,
        lookupFn: async () => [{ address: "::1", family: 6, ttl: 10 }],
      }),
    );
    expect(wrongFamilyErr.code).toBe("ERR_DNS_FAMILY_MISMATCH");

    const spoofedFamilyErr = await captureBoundaryError(() =>
      lookupStrictFamily("example.com", {
        family: 6,
        lookupFn: async () => [{ address: "1.1.1.1", family: 6, ttl: 10 }],
      }),
    );
    expect(spoofedFamilyErr.code).toBe("ERR_DNS_FAMILY_MISMATCH");

    const filtered = await lookupStrictFamily("example.com", {
      family: 4,
      lookupFn: async () => [
        { address: "2606:4700:4700::1111", family: 6, ttl: 30 },
        { address: "1.1.1.1", family: 4 },
        { address: "::1", family: 4, ttl: 5 },
      ],
    });
    expect(filtered).toEqual([{ address: "1.1.1.1", family: 4, ttl: 0 }]);

    const emptyErr = await captureBoundaryError(() =>
      lookupStrictFamily("example.com", {
        family: 4,
        lookupFn: async () => [],
      }),
    );
    expect(emptyErr.code).toBe("ERR_DNS_LOOKUP_FAILED");

    const rootCause = new Error("EAI_AGAIN");
    const causeErr = await captureBoundaryError(() =>
      lookupStrictFamily("example.com", {
        family: 4,
        lookupFn: async () => {
          throw rootCause;
        },
      }),
    );
    expect(causeErr.code).toBe("ERR_DNS_LOOKUP_FAILED");
    expect(causeErr.cause).toBe(rootCause);
  });
});

describe("L2: Bun.dns Prefetch Port & Egress SSRF Boundaries", () => {
  test("assertCleanPort accepts 1..65535 integers and rejects invalid ports", () => {
    for (const valid of [1, 80, 443, 65535]) {
      expect(assertCleanPort(valid)).toBe(valid);
    }

    for (const invalid of [
      0,
      -1,
      65536,
      443.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const err = captureSyncBoundaryError(() => assertCleanPort(invalid));
      expect(err.code).toBe("ERR_DNS_INVALID_PORT");
    }
  });

  test("prefetchHostSafe normalizes host, guards port/host, and delegates safely", () => {
    const calls: Array<{ host: string; port: number }> = [];
    const res = prefetchHostSafe("Desk.BookDeskOps.com.", 443, (host, port) => {
      calls.push({ host, port });
    });
    expect(res).toEqual({ hostname: "desk.bookdeskops.com", port: 443 });
    expect(calls).toEqual([{ host: "desk.bookdeskops.com", port: 443 }]);

    expect(prefetchHostSafe("localhost", 443)).toEqual({
      hostname: "localhost",
      port: 443,
    });

    let calledOnFailure = false;
    const failFn = () => {
      calledOnFailure = true;
    };
    expect(
      captureSyncBoundaryError(() =>
        prefetchHostSafe("https://desk.bookdeskops.com", 443, failFn),
      ).code,
    ).toBe("ERR_DNS_INVALID_HOSTNAME");
    expect(
      captureSyncBoundaryError(() =>
        prefetchHostSafe("fe80::1%eth0", 443, failFn),
      ).code,
    ).toBe("ERR_DNS_IPV6_ZONE_FORBIDDEN");
    expect(
      captureSyncBoundaryError(() =>
        prefetchHostSafe("desk.bookdeskops.com", Number.NaN, failFn),
      ).code,
    ).toBe("ERR_DNS_INVALID_PORT");
    expect(calledOnFailure).toBe(false);
  });

  test("classifyIpScope & assertPublicIp allow public IPs and block private/transition ranges", () => {
    const publicIps = [
      "1.1.1.1",
      "8.8.8.8",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "2606:4700:4700::1111",
      "::ffff:1.1.1.1",
    ];
    for (const ip of publicIps) {
      expect(classifyIpScope(ip)).toBe("public");
      expect(assertPublicIp(ip)).toBe(ip.toLowerCase());
    }

    const forbiddenCases: ReadonlyArray<
      readonly [string, Exclude<IpAddressScope, "public">]
    > = [
      ["0.0.0.0", "unspecified"],
      ["127.0.0.1", "loopback"],
      ["10.0.0.1", "private"],
      ["172.16.0.1", "private"],
      ["192.168.1.1", "private"],
      ["100.64.0.1", "cgnat"],
      ["169.254.169.254", "link_local"],
      ["192.0.2.1", "documentation"],
      ["198.51.100.1", "documentation"],
      ["203.0.113.1", "documentation"],
      ["198.18.0.1", "benchmark"],
      ["224.0.0.1", "multicast"],
      ["192.0.0.1", "reserved"],
      ["240.0.0.1", "reserved"],
      ["::1", "loopback"],
      ["::", "unspecified"],
      ["fc00::1", "private"],
      ["fd00::1", "private"],
      ["fe80::1", "link_local"],
      ["ff02::1", "multicast"],
      ["2001:db8::1", "documentation"],
      ["::ffff:127.0.0.1", "loopback"],
      ["::ffff:7f00:0001", "loopback"],
      ["::ffff:169.254.169.254", "link_local"],
      ["::ffff:a9fe:a9fe", "link_local"],
      ["::ffff:10.0.0.1", "private"],
      ["64:ff9b::10.0.0.1", "private"],
      ["64:ff9b::169.254.169.254", "link_local"],
      ["2002:7f00:0001::", "loopback"],
      ["2002:a9fe:a9fe::", "link_local"],
    ];

    for (const [ip, expectedScope] of forbiddenCases) {
      expect(classifyIpScope(ip)).toBe(expectedScope);
      const err = captureSyncBoundaryError(() => assertPublicIp(ip));
      expect(err.code).toBe("ERR_DNS_EGRESS_IP_FORBIDDEN");
    }

    expect(
      captureSyncBoundaryError(() => classifyIpScope("fe80::1%eth0")).code,
    ).toBe("ERR_DNS_IPV6_ZONE_FORBIDDEN");
    expect(
      captureSyncBoundaryError(() => classifyIpScope("example.com")).code,
    ).toBe("ERR_DNS_INVALID_HOSTNAME");
  });

  test("lookupPublicStrictFamily fails closed on loopback and split-horizon non-public records", async () => {
    const publicRecords = await lookupPublicStrictFamily(
      "desk.bookdeskops.com",
      {
        family: 4,
        lookupFn: async () => [{ address: "1.1.1.1", family: 4, ttl: 60 }],
      },
    );
    expect(publicRecords).toEqual([{ address: "1.1.1.1", family: 4, ttl: 60 }]);

    const localhostErr = await captureBoundaryError(() =>
      lookupPublicStrictFamily("localhost", {
        family: 4,
        backend: "system",
        timeoutMs: 2_000,
      }),
    );
    expect(localhostErr.code).toBe("ERR_DNS_EGRESS_IP_FORBIDDEN");

    const splitHorizonErr = await captureBoundaryError(() =>
      lookupPublicStrictFamily("desk.bookdeskops.com", {
        family: 4,
        lookupFn: async () => [
          { address: "1.1.1.1", family: 4, ttl: 30 },
          { address: "169.254.169.254", family: 4, ttl: 30 },
        ],
      }),
    );
    expect(splitHorizonErr.code).toBe("ERR_DNS_EGRESS_IP_FORBIDDEN");
  });
});

describe("L3: Bun.dns Cache Telemetry & TTL Health Boundaries", () => {
  test("assertValidDnsTtlSeconds enforces integer bounds and default fallback", () => {
    expect(assertValidDnsTtlSeconds(undefined)).toBe(DEFAULT_DNS_TTL_SECONDS);
    expect(assertValidDnsTtlSeconds("1")).toBe(1);
    expect(assertValidDnsTtlSeconds(" 45 ")).toBe(45);
    expect(assertValidDnsTtlSeconds(MAX_DNS_TTL_SECONDS)).toBe(
      MAX_DNS_TTL_SECONDS,
    );

    const invalidTtls: Array<string | number> = [
      "",
      "0",
      0,
      "-1",
      -1,
      "5.9",
      5.9,
      "abc",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_DNS_TTL_SECONDS + 1,
    ];
    for (const raw of invalidTtls) {
      const err = captureSyncBoundaryError(() => assertValidDnsTtlSeconds(raw));
      expect(err.code).toBe("ERR_DNS_INVALID_TTL");
    }
  });

  test("readDnsCacheStatsBoundary reads live stats and rejects malformed snapshots", () => {
    const live = readDnsCacheStatsBoundary();
    expect(Object.isFrozen(live)).toBe(true);
    expect(live.size).toBeGreaterThanOrEqual(0);
    expect(live.totalCount).toBeGreaterThanOrEqual(0);

    const badPayloads: unknown[] = [
      null,
      [],
      { cacheHitsCompleted: 0 },
      {
        cacheHitsCompleted: 0,
        cacheHitsInflight: 0,
        cacheMisses: 0,
        size: -1,
        errors: 0,
        totalCount: 0,
      },
      {
        cacheHitsCompleted: 0,
        cacheHitsInflight: 0,
        cacheMisses: 0,
        size: 0,
        errors: Number.NaN,
        totalCount: 1,
      },
    ];
    for (const payload of badPayloads) {
      const err = captureSyncBoundaryError(() =>
        readDnsCacheStatsBoundary(() => payload),
      );
      expect(err.code).toBe("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE");
    }
  });

  test("assertDnsCacheHealthy computes ratios and trips error-spike or pressure gates", () => {
    const liveReport = assertDnsCacheHealthy({
      maxErrorRatioBps: 10_000,
    });
    expect(liveReport.capacity).toBe(DNS_CACHE_CAPACITY);

    const healthy = assertDnsCacheHealthy({
      stats: {
        cacheHitsCompleted: 6,
        cacheHitsInflight: 2,
        cacheMisses: 2,
        size: 64,
        errors: 1,
        totalCount: 100,
      },
      maxErrorRatioBps: 500,
      minSamplesForErrorGate: 10,
      maxOccupancyBps: 5_000,
    });
    expect(healthy.cacheHitsTotal).toBe(8);
    expect(healthy.classifiedRequests).toBe(10);
    expect(healthy.hitRateBps).toBe(8_000);
    expect(healthy.errorRatioBps).toBe(100);
    expect(healthy.occupancyBps).toBe(2_500);

    const gatedByMinSamples = assertDnsCacheHealthy({
      stats: {
        cacheHitsCompleted: 0,
        cacheHitsInflight: 0,
        cacheMisses: 2,
        size: 2,
        errors: 2,
        totalCount: 4,
      },
      maxErrorRatioBps: 500,
      minSamplesForErrorGate: 5,
    });
    expect(gatedByMinSamples.errorRatioBps).toBe(5_000);

    const spikeErr = captureSyncBoundaryError(() =>
      assertDnsCacheHealthy({
        stats: {
          cacheHitsCompleted: 1,
          cacheHitsInflight: 0,
          cacheMisses: 3,
          size: 4,
          errors: 3,
          totalCount: 10,
        },
        maxErrorRatioBps: 500,
        minSamplesForErrorGate: 5,
      }),
    );
    expect(spikeErr.code).toBe("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE");

    const pressureByBpsErr = captureSyncBoundaryError(() =>
      assertDnsCacheHealthy({
        stats: {
          cacheHitsCompleted: 10,
          cacheHitsInflight: 0,
          cacheMisses: 0,
          size: 200,
          errors: 0,
          totalCount: 10,
        },
        maxOccupancyBps: 7_500,
      }),
    );
    expect(pressureByBpsErr.code).toBe("ERR_DNS_CACHE_PRESSURE");

    const pressureByCapErr = captureSyncBoundaryError(() =>
      assertDnsCacheHealthy({
        stats: {
          cacheHitsCompleted: 10,
          cacheHitsInflight: 0,
          cacheMisses: 0,
          size: DNS_CACHE_CAPACITY + 1,
          errors: 0,
          totalCount: 10,
        },
      }),
    );
    expect(pressureByCapErr.code).toBe("ERR_DNS_CACHE_PRESSURE");
  });
});
