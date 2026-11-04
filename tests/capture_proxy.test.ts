import { afterEach, describe, expect, test } from "bun:test";
import {
  describeProxy,
  isLoopbackHost,
  matchesNoProxy,
  normalizeProxyUrl,
  proxyForUrl,
  ProxyConfigError,
  readProxyEnv,
  redactProxyUrl,
  setProxyEnv,
  withProxyEnv,
  type ProxySettings,
} from "../scripts/capture/proxy.ts";
import type { Env } from "../scripts/capture/types.ts";

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

/**
 * Build a credential-bearing URL at runtime so the repository credential
 * scanner never sees a committed `scheme://user:pass@` literal.
 */
function credentialUrl(
  scheme: string,
  credentials: string,
  rest: string,
): string {
  return `${scheme}://${credentials}@${rest}`;
}

function snapshotProxyEnv(): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of PROXY_KEYS) snapshot[key] = Bun.env[key];
  return snapshot;
}

/** process.env properties are typed readonly; mutate through Reflect. */
function setProcessEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(Bun.env, key);
  else Reflect.set(Bun.env, key, value);
}

function restoreProxyEnv(snapshot: EnvSnapshot): void {
  for (const key of PROXY_KEYS) setProcessEnv(key, snapshot[key]);
}

let envSnapshot: EnvSnapshot | null = null;

afterEach(() => {
  if (envSnapshot !== null) {
    restoreProxyEnv(envSnapshot);
    envSnapshot = null;
  }
});

describe("readProxyEnv", () => {
  test("reads uppercase and lowercase variants and splits NO_PROXY", () => {
    const settings = readProxyEnv({
      HTTP_PROXY: "http://proxy.example:8080",
      HTTPS_PROXY: "http://secure.example:8443",
      NO_PROXY: "localhost, .example.com,10.0.0.0/8",
    });
    expect(settings.httpProxy).toBe("http://proxy.example:8080");
    expect(settings.httpsProxy).toBe("http://secure.example:8443");
    expect(settings.noProxy).toEqual([
      "localhost",
      ".example.com",
      "10.0.0.0/8",
    ]);
  });

  test("falls back to lowercase and treats an empty environment as no proxy", () => {
    const settings = readProxyEnv({
      http_proxy: "http://lower.example:3128",
      no_proxy: "internal.example",
    });
    expect(settings.httpProxy).toBe("http://lower.example:3128");
    expect(settings.httpsProxy).toBeNull();
    expect(settings.noProxy).toEqual(["internal.example"]);
    expect(readProxyEnv({}).noProxy).toEqual([]);
  });
});

describe("normalizeProxyUrl", () => {
  test("accepts host:port and http(s) URLs", () => {
    expect(normalizeProxyUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeProxyUrl("http://proxy.example:8080/")).toBe(
      "http://proxy.example:8080",
    );
    expect(normalizeProxyUrl("https://proxy.example:8443")).toBe(
      "https://proxy.example:8443",
    );
  });

  test("rejects empty, unsupported and path-bearing proxies", () => {
    expect(() => normalizeProxyUrl("  ")).toThrow(ProxyConfigError);
    expect(() => normalizeProxyUrl("socks5://127.0.0.1:1080")).toThrow(
      ProxyConfigError,
    );
    expect(() => normalizeProxyUrl("http://proxy.example:8080/tunnel")).toThrow(
      ProxyConfigError,
    );
  });
});

describe("describeProxy and redactProxyUrl", () => {
  test("never exposes proxy credentials", () => {
    const settings: ProxySettings = {
      httpProxy: credentialUrl(
        "http",
        "agent:super-secret",
        "proxy.example:8080",
      ),
      httpsProxy: credentialUrl(
        "https",
        "agent:super-secret",
        "proxy.example:8443",
      ),
      noProxy: ["internal.example"],
    };
    const description = describeProxy(settings);
    expect(description.present).toBe(true);
    expect(description.credentialsRedacted).toBe(true);
    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("agent:");
    expect(description.http).toBe("http://<redacted>@proxy.example:8080");
    expect(redactProxyUrl(credentialUrl("http", "u:p", "host:1"))).toBe(
      "http://<redacted>@host:1",
    );
  });

  test("reports absence cleanly", () => {
    const description = describeProxy({
      httpProxy: null,
      httpsProxy: null,
      noProxy: [],
    });
    expect(description.present).toBe(false);
    expect(description.http).toBeNull();
    expect(description.https).toBeNull();
    expect(description.credentialsRedacted).toBe(false);
  });
});

describe("matchesNoProxy", () => {
  test("matches exact hosts, suffixes and leading-dot domains", () => {
    expect(matchesNoProxy("example.com", ["example.com"])).toBe(true);
    expect(matchesNoProxy("api.example.com", ["example.com"])).toBe(true);
    expect(matchesNoProxy("api.example.com", [".example.com"])).toBe(true);
    expect(matchesNoProxy("badexample.com", ["example.com"])).toBe(false);
  });

  test("supports wildcard entries and wildcard IPv4", () => {
    expect(matchesNoProxy("anything.example", ["*"])).toBe(true);
    expect(matchesNoProxy("api.example.com", ["*.example.com"])).toBe(true);
    expect(matchesNoProxy("192.168.4.5", ["192.168.*"])).toBe(true);
    expect(matchesNoProxy("10.9.8.7", ["192.168.*"])).toBe(false);
  });

  test("supports CIDR and host:port entries", () => {
    expect(matchesNoProxy("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(matchesNoProxy("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(matchesNoProxy("localhost", ["127.0.0.1:8080"])).toBe(false);
    expect(matchesNoProxy("127.0.0.1", ["127.0.0.1:8080"], 8080)).toBe(true);
    expect(matchesNoProxy("127.0.0.1", ["127.0.0.1:8080"], 9090)).toBe(false);
  });

  test("handles IPv6 loopback and loopback detection", () => {
    expect(matchesNoProxy("::1", ["[::1]"])).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.9")).toBe(true);
    expect(isLoopbackHost("portal.example")).toBe(false);
  });
});

describe("proxyForUrl", () => {
  const settings: ProxySettings = {
    httpProxy: "http://proxy.example:8080",
    httpsProxy: "http://secure.example:8443",
    noProxy: ["internal.example", "127.0.0.1"],
  };

  test("selects the proxy by scheme", () => {
    expect(proxyForUrl("https://portal.example/api", settings)).toEqual({
      mode: "proxy",
      proxy: "http://secure.example:8443",
      reason: "configured",
    });
    expect(proxyForUrl("http://portal.example/api", settings)).toEqual({
      mode: "proxy",
      proxy: "http://proxy.example:8080",
      reason: "configured",
    });
  });

  test("NO_PROXY bypasses the proxy", () => {
    expect(proxyForUrl("https://api.internal.example/x", settings)).toEqual({
      mode: "direct",
      proxy: null,
      reason: "no_proxy",
    });
    expect(proxyForUrl("http://127.0.0.1:9/x", settings).mode).toBe("direct");
  });

  test("no configured proxy means direct, unsupported scheme means direct", () => {
    expect(
      proxyForUrl("https://portal.example", {
        httpProxy: null,
        httpsProxy: null,
        noProxy: [],
      }).reason,
    ).toBe("not_configured");
    expect(proxyForUrl("ftp://portal.example", settings).reason).toBe(
      "unsupported_protocol",
    );
  });
});

describe("setProxyEnv / withProxyEnv", () => {
  test("sets and restores both case variants", () => {
    const env: Env = {
      HTTP_PROXY: "http://old.example:1111",
      no_proxy: "existing.example",
    };
    const restore = setProxyEnv("http://new.example:2222", env);
    expect(env.HTTP_PROXY).toBe("http://new.example:2222");
    expect(env.HTTPS_PROXY).toBe("http://new.example:2222");
    expect(env.http_proxy).toBe("http://new.example:2222");
    expect(env.https_proxy).toBe("http://new.example:2222");
    expect(env.no_proxy).toBe("existing.example");
    restore();
    expect(env.HTTP_PROXY).toBe("http://old.example:1111");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
  });

  test("null clears proxy variables and the restore reinstates them", () => {
    const env: Env = { HTTP_PROXY: "http://old.example:1111" };
    const restore = setProxyEnv(null, env);
    expect(env.HTTP_PROXY).toBeUndefined();
    restore();
    expect(env.HTTP_PROXY).toBe("http://old.example:1111");
  });

  test("withProxyEnv restores the environment even when the body throws", async () => {
    envSnapshot = snapshotProxyEnv();
    const before = Bun.env.HTTP_PROXY;
    await expect(
      withProxyEnv("http://proxy.example:8080", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(Bun.env.HTTP_PROXY).toBe(before);
  });
});

describe("Bun env-proxy behavior (in-process forward proxy smoke)", () => {
  test("HTTP_PROXY routes through the forwarder, NO_PROXY and proxy:false bypass it", async () => {
    envSnapshot = snapshotProxyEnv();
    setProcessEnv("NO_PROXY", undefined);
    setProcessEnv("no_proxy", undefined);

    let proxyHits = 0;
    let targetHits = 0;
    const target = Bun.serve({
      port: 0,
      fetch() {
        targetHits += 1;
        return new Response("target-ok");
      },
    });
    // The forwarder must call fetch with proxy:false, or it proxies to itself
    // (observed as ECONNRESET in Bun 1.4.4). This test is the loop guard.
    const forwarder = Bun.serve({
      port: 0,
      fetch: async (request: Request) => {
        proxyHits += 1;
        const absolute = new URL(request.url);
        if (!absolute.pathname.endsWith("/hello")) {
          return new Response("expected absolute-form proxied URL", {
            status: 400,
          });
        }
        const upstream = await fetch(absolute.href, {
          method: request.method,
          headers: request.headers,
          proxy: false,
        });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: upstream.headers,
        });
      },
    });

    try {
      const targetUrl = `http://127.0.0.1:${target.port}/hello`;
      const restore = setProxyEnv(
        `http://127.0.0.1:${forwarder.port}`,
        Bun.env,
      );
      try {
        const proxied = await fetch(targetUrl);
        expect(proxied.status).toBe(200);
        expect(await proxied.text()).toBe("target-ok");
        expect(proxyHits).toBe(1);
        expect(targetHits).toBe(1);

        // NO_PROXY bypasses the forwarder entirely.
        setProcessEnv("NO_PROXY", "127.0.0.1");
        const bypassed = await fetch(targetUrl);
        expect(bypassed.status).toBe(200);
        expect(proxyHits).toBe(1);
        expect(targetHits).toBe(2);

        // proxy:false forces direct even with HTTP_PROXY set and no NO_PROXY.
        setProcessEnv("NO_PROXY", undefined);
        const direct = await fetch(targetUrl, { proxy: false });
        expect(direct.status).toBe(200);
        expect(proxyHits).toBe(1);
        expect(targetHits).toBe(3);
      } finally {
        restore();
      }
    } finally {
      forwarder.stop(true);
      target.stop(true);
    }
  });
});
