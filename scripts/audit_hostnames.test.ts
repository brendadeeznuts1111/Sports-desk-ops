import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AUDITED_ENDPOINTS_CACHE } from "../lib/hostname_surface_audit.ts";
import {
  auditRepositoryHostnames,
  bump,
  classifyHostname,
  collect,
  extractFromText,
  isIp,
  normalizeHost,
  type HostHitSummary,
} from "./audit_hostnames.ts";

describe("scripts/audit_hostnames", () => {
  test("normalizeHost lowercases, strips scheme/userinfo/port/path, and punycodes IDNA", () => {
    expect(
      normalizeHost("HTTPS://User@WS-Subscriptions-CLOB.Polymarket.com:443/x"),
    ).toBe("ws-subscriptions-clob.polymarket.com");
    expect(normalizeHost("münchen.example")).toBe("xn--mnchen-3ya.example");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("clob")).toBe("clob");
    expect(normalizeHost("http://[::1]:8080/api")).toBe("[::1]");
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });

  test("extractFromText and bump preserve [::1], reject single-label truncations, and drop FILE_TLDS", () => {
    expect(isIp("[::1]")).toBe(true);
    expect(isIp("127.0.0.1")).toBe(true);
    expect(isIp("fantasy402.com")).toBe(false);

    const ipv6Map = extractFromText("http://[::1]:8080/api");
    expect(ipv6Map.get("[::1]")?.count).toBe(1);

    const truncated = extractFromText(
      "https://clob.${H_P}",
      "lib/hostname_surface_audit.ts",
    );
    expect(truncated.size).toBe(0);
    expect(truncated.get("clob")).toBeUndefined();

    const fileMap = new Map<string, HostHitSummary>();
    bump(fileMap, "foo.ts", "a.ts", 5);
    bump(fileMap, "bar.json", "a.ts", 5);
    bump(fileMap, "localhost", "a.ts", 5);
    expect(fileMap.has("foo.ts")).toBe(false);
    expect(fileMap.has("bar.json")).toBe(false);
    expect(fileMap.has("localhost")).toBe(true);
  });

  test("collect extracts URLs and caps sample sources via bump", () => {
    const out = new Map<string, HostHitSummary>();
    collect(
      out,
      "https://api.telegram.org/bot1/send https://API.TELEGRAM.ORG:443/bot2/send",
      "a.ts",
      2,
    );
    collect(out, "https://api.telegram.org/bot3", "b.ts", 2);
    collect(out, "https://api.telegram.org/bot4", "c.ts", 2);

    const entry = out.get("api.telegram.org");
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(4);
    expect(entry?.sources).toEqual(["a.ts", "b.ts"]);
    bump(out, "https://not a valid host", "bad.ts", 2);
    expect(out.size).toBe(1);

    // Single-label template truncation artifacts must be rejected by bump/collect
    const truncated = new Map<string, HostHitSummary>();
    collect(
      truncated,
      "https://clob.${H_P}",
      "lib/hostname_surface_audit.ts",
      2,
    );
    expect(truncated.size).toBe(0);
    expect(truncated.get("clob")).toBeUndefined();

    // Localhost and IPv6 loopback still survive bump
    bump(truncated, "localhost", "local.ts", 2);
    bump(truncated, "http://[::1]:8080/api", "local.ts", 2);
    expect(truncated.has("localhost")).toBe(true);
    expect(truncated.has("[::1]")).toBe(true);
  });

  test("classifyHostname maps core sources and sinks to OriginDomainId and VenueId", () => {
    expect(classifyHostname("fantasy402.com")).toMatchObject({
      role: "source",
      originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
      venueId: "f402",
    });
    expect(classifyHostname("plive.sportswidgets.pro")).toMatchObject({
      role: "source",
      originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
      venueId: "gslive_partner118",
    });
    expect(classifyHostname("gamma-api.polymarket.com")).toMatchObject({
      role: "source",
      originDomainId: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
      venueId: "polymarket",
    });
    expect(classifyHostname("api.elections.kalshi.com")).toMatchObject({
      role: "source",
      originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
      venueId: "kalshi",
    });
    expect(
      classifyHostname("pub-d061f943df0e4477ba7ff200721eddb1.r2.dev"),
    ).toMatchObject({
      role: "sink",
      originDomainId: "ORIGIN_STORAGE_R2_LAKEHOUSE",
      venueId: "lakehouse",
    });
  });

  test("auditRepositoryHostnames discovers and classifies real repo sources", async () => {
    const root = resolve(import.meta.dir, "..");
    const rows = await auditRepositoryHostnames({ root });
    const hosts = new Set(rows.map((r) => r.host));

    expect(hosts.has("fantasy402.com")).toBe(true);
    expect(hosts.has("plive.sportswidgets.pro")).toBe(true);
    expect(hosts.has("gamma-api.polymarket.com")).toBe(true);
    expect(hosts.has("api.elections.kalshi.com")).toBe(true);
    expect(hosts.has("bun.sh")).toBe(true);
    expect(rows.every((r) => r.role !== "unclassified")).toBe(true);
  });

  test("registry and ruleset agree on every registered host in AUDITED_ENDPOINTS_CACHE", () => {
    const withHostname = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => ep.whatwgHostname !== "",
    );
    expect(withHostname.length).toBe(23);

    for (const ep of withHostname) {
      const actual = classifyHostname(ep.whatwgHostname);
      expect(actual.role).not.toBe("unclassified");
      if (ep.endpointId === "LOCAL-UWS-02") {
        expect(actual.role).toBe("local");
        expect(actual.originDomainId).toBe("ORIGIN_HOST_NSH_DESK_LOCAL");
      } else {
        expect(actual.role).toBe(ep.role);
      }
    }
  });
});
