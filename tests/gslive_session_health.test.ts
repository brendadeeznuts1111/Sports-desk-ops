import { describe, expect, test } from "bun:test";
import {
  classifyAjaxSessionProbe,
  classifyProbe,
  createGsliveSessionMonitor,
  GSLIVE_SURFACE_MAP,
  gsliveCookieNames,
  gsliveSessionAdvisory,
  probeGsliveSession,
  type GsliveSessionProbe,
} from "../lib/gslive_session_health.ts";

const checkedAt = "2026-11-04T19:30:00.000Z";

function classify(
  httpStatus: number,
  options: {
    contentType?: string;
    cfMitigated?: string | null;
    body?: string;
  } = {},
): GsliveSessionProbe {
  return classifyProbe({
    httpStatus,
    contentType: options.contentType ?? "application/json",
    cfMitigated: options.cfMitigated ?? null,
    body: options.body ?? "{}",
    latencyMs: 12,
    checkedAt,
  });
}

describe("GSLive session probe classification", () => {
  test("ajax JSON 200 is healthy; login HTML is expired", () => {
    expect(
      classifyAjaxSessionProbe({
        httpStatus: 200,
        body: '{"r":[]}',
        latencyMs: 1,
        checkedAt,
        cfMitigated: null,
      }).status,
    ).toBe("ok");
    expect(
      classifyAjaxSessionProbe({
        httpStatus: 200,
        body: "<html>login</html>",
        latencyMs: 1,
        checkedAt,
        cfMitigated: null,
      }).status,
    ).toBe("expired");
  });

  test("legacy partnerConfig classifier: JSON 200 is healthy; a login HTML 200 is expired", () => {
    expect(classify(200).status).toBe("ok");
    expect(
      classify(200, {
        contentType: "text/html",
        body: "<html>login</html>",
      }).status,
    ).toBe("expired");
    expect(classify(200, { body: "<html>login</html>" }).status).toBe(
      "expired",
    );
  });

  test("redirects and 401 mean the cookie is expired", () => {
    expect(classify(302).status).toBe("expired");
    expect(classify(401).status).toBe("expired");
  });

  test("403 is split into Cloudflare challenge and plain forbidden", () => {
    expect(classify(403, { cfMitigated: "challenge" }).status).toBe(
      "challenge",
    );
    expect(classify(403).status).toBe("forbidden");
  });

  test("429, 5xx and unexpected statuses stay distinct", () => {
    expect(classify(429).status).toBe("throttled");
    expect(classify(503).status).toBe("unreachable");
    expect(classify(418).status).toBe("forbidden");
    expect(gsliveSessionAdvisory("challenge")).toContain("Cloudflare");
    expect(gsliveSessionAdvisory("expired")).toContain("Re-export");
  });
});

describe("GSLive cookie handling", () => {
  test("returns cookie names only", () => {
    expect(gsliveCookieNames("GSID=secret; cf_clearance=also-secret")).toEqual([
      "GSID",
      "cf_clearance",
    ]);
    expect(gsliveCookieNames("")).toEqual([]);
  });

  test("uses stored ganchrow gate without signin bootstrap", async () => {
    const calls: string[] = [];
    const probe = await probeGsliveSession("GSID=live-secret", {
      now: () => Date.parse(checkedAt),
      readSessionGate: async () => "stored-gate",
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    expect(probe.status).toBe("ok");
    expect(calls.some((u) => u.includes("signin"))).toBe(false);
    expect(calls.some((u) => u.includes("ajax.php"))).toBe(true);
  });

  test("the probe bootstraps signin then posts ajax but never returns the cookie", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const probe = await probeGsliveSession("GSID=live-secret", {
      now: () => Date.parse(checkedAt),
      readSessionGate: async () => "",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push(init === undefined ? { url } : { url, init });
        if (String(url).includes("signin")) {
          return new Response(
            JSON.stringify({
              ganchrowSessionId: "gate-1",
              adminUserName: "a",
              agentName: "b",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    expect(probe.status).toBe("ok");
    const ajax = calls.find((call) => call.url.includes("ajax.php"));
    expect(ajax?.init?.method).toBe("POST");
    const headers = new Headers(ajax?.init?.headers);
    expect(headers.get("cookie")).toBe("GSID=live-secret");
    expect(headers.get("x-gs-session")).toBe("gate-1");
    expect(JSON.stringify(probe)).not.toContain("live-secret");
  });

  test("network failure is unreachable, not an empty session", async () => {
    const probe = await probeGsliveSession("GSID=live-secret", {
      now: () => Date.parse(checkedAt),
      readSessionGate: async () => "",
      fetchImpl: (async (url: string) => {
        if (String(url).includes("signin")) {
          return new Response(
            JSON.stringify({
              ganchrowSessionId: "gate",
              adminUserName: "a",
              agentName: "b",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(probe.status).toBe("unreachable");
    expect(JSON.stringify(probe)).not.toContain("live-secret");
  });
});

describe("GSLive session monitor", () => {
  const cookie = "GSID=live-secret; cf_clearance=cloudflare-secret";

  test("caches per cookie, misses on rotation, and never serializes the value", async () => {
    let calls = 0;
    let current = cookie;
    let clock = Date.parse(checkedAt);
    const monitor = createGsliveSessionMonitor({
      resolveSession: async () => ({
        source: "env-cookie",
        cookieHeader: current,
      }),
      readSessionGate: async () => "",
      now: () => clock,
      fetchImpl: (async (url: string) => {
        calls += 1;
        if (String(url).includes("signin")) {
          return new Response(
            JSON.stringify({
              ganchrowSessionId: "gate",
              adminUserName: "a",
              agentName: "b",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response('{"r":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const first = await monitor.read();
    expect(first.probe.status).toBe("ok");
    expect(first.probe.cached).toBe(false);
    expect(first.session.cookieNames).toEqual(["GSID", "cf_clearance"]);
    expect(first.surfaceMap.length).toBeGreaterThan(4);
    expect(calls).toBe(2);

    clock += 30_000;
    const second = await monitor.read();
    expect(second.probe.cached).toBe(true);
    expect(calls).toBe(2);

    const forced = await monitor.read(true);
    expect(forced.probe.cached).toBe(false);
    expect(calls).toBe(4);

    current = "GSID=rotated-secret";
    const rotated = await monitor.read();
    expect(rotated.probe.cached).toBe(false);
    expect(calls).toBe(6);

    expect(JSON.stringify([first, second, forced, rotated])).not.toContain(
      "live-secret",
    );
    expect(JSON.stringify([first, second, forced, rotated])).not.toContain(
      "cloudflare-secret",
    );
    expect(JSON.stringify(rotated)).not.toContain("rotated-secret");
  });

  test("the legacy-vs-v4 map is explicit about what was observed", () => {
    const statuses = new Set(GSLIVE_SURFACE_MAP.map((row) => row.status));
    expect(statuses).toEqual(new Set(["v4", "listed", "legacy", "unverified"]));
    expect(
      GSLIVE_SURFACE_MAP.find((row) => row.capability === "Partner config")
        ?.status,
    ).toBe("v4");
    expect(
      GSLIVE_SURFACE_MAP.find((row) => row.capability === "Per-bet log")
        ?.status,
    ).toBe("legacy");
    expect(JSON.stringify(GSLIVE_SURFACE_MAP)).not.toContain("GSID=");
  });

  test("an absent cookie is unconfigured without a network call", async () => {
    let calls = 0;
    const monitor = createGsliveSessionMonitor({
      resolveSession: async () => ({ source: "none", cookieHeader: "" }),
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    const health = await monitor.read();
    expect(health.session.configured).toBe(false);
    expect(health.probe.status).toBe("unconfigured");
    expect(health.probe.cached).toBe(false);
    expect(calls).toBe(0);
  });
});
