import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchAssetOutcome } from "../lib/f402_cdn_pin.ts";
import {
  F402_FETCH_SESSION_TLS,
  F402FetchSessionConfigError,
  type F402FetchSessionLike,
  F402FetchSessionPool,
  F402TlsVerificationError,
  f402FetchOrigin,
  f402FetchSessions,
  tlsErrorCode,
} from "../lib/f402_fetch_sessions.ts";
import { probeF402BetTicker } from "../lib/f402_ingest.ts";
import { fetchPortalArtifactBytes } from "../lib/f402_portal_bundle_fetch.ts";
import { fetchLiveVersionJs } from "../lib/f402_portal_version_pin.ts";
import {
  F402PullClient,
  F402PullerError,
} from "../lib/f402_readonly_puller.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";
import type { F402Session } from "../lib/f402_session.ts";

interface FakeSession extends F402FetchSessionLike {
  readonly tls: unknown;
  readonly urls: string[];
  closes: number;
}

function fakePool(): {
  pool: F402FetchSessionPool;
  created: FakeSession[];
  warmed: string[];
} {
  const created: FakeSession[] = [];
  const warmed: string[] = [];
  const pool = new F402FetchSessionPool({
    createSession: (init) => {
      const session: FakeSession = {
        tls: init.tls,
        urls: [],
        closes: 0,
        async fetch(url) {
          session.urls.push(url);
          return new Response("ok");
        },
        close() {
          session.closes += 1;
        },
      };
      created.push(session);
      return session;
    },
    warm: (origin) => warmed.push(origin),
  });
  return { pool, created, warmed };
}

const session: F402Session = {
  cookieHeader: "s=1",
  cookieNames: ["s"],
  authorizationHeader: "Bearer test-token",
  obtainedAtIso: new Date().toISOString(),
  expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
};

describe("F402FetchSessionPool", () => {
  test("reuses one session per origin and keys by origin, not path", async () => {
    const { pool, created } = fakePool();
    await pool.fetch("https://f402.example/cloud/api/Manager/a");
    await pool.fetch("https://f402.example/cloud/api/Manager/b?x=1");
    expect(created).toHaveLength(1);
    expect(created[0]?.urls).toEqual([
      "https://f402.example/cloud/api/Manager/a",
      "https://f402.example/cloud/api/Manager/b?x=1",
    ]);
    expect(pool.sessionFor("https://f402.example/other")).toBe(created[0]!);
  });

  test("gives each host, scheme and port its own session", async () => {
    const { pool, created } = fakePool();
    await pool.fetch("https://f402.example/a");
    await pool.fetch("https://cdn.f402.example/a.js");
    await pool.fetch("https://f402.example:8443/a");
    await pool.fetch("http://f402.example/a");
    expect(created).toHaveLength(4);
    expect(new Set(created).size).toBe(4);
    expect(pool.origins()).toEqual([
      "https://f402.example",
      "https://cdn.f402.example",
      "https://f402.example:8443",
      "http://f402.example",
    ]);
  });

  test("warms each origin exactly once, on first use", async () => {
    const { pool, warmed } = fakePool();
    expect(warmed).toEqual([]);
    for (let i = 0; i < 3; i += 1) {
      await pool.fetch("https://f402.example/a");
      await pool.fetch("https://cdn.f402.example/b");
    }
    expect(warmed).toEqual([
      "https://f402.example",
      "https://cdn.f402.example",
    ]);
  });

  test("every session is created with rejectUnauthorized: true", async () => {
    const { pool, created } = fakePool();
    await pool.fetch("https://f402.example/a");
    await pool.fetch("https://cdn.f402.example/a");
    for (const s of created) {
      expect(s.tls).toEqual({ rejectUnauthorized: true });
    }
    expect(Object.isFrozen(F402_FETCH_SESSION_TLS)).toBe(true);
    expect(() => {
      (
        F402_FETCH_SESSION_TLS as { rejectUnauthorized: boolean }
      ).rejectUnauthorized = false;
    }).toThrow(TypeError);
  });

  test("refuses a per-request tls, which would replace the session's verification", async () => {
    const { pool, created } = fakePool();
    const init = { tls: { ca: "-----BEGIN CERTIFICATE-----" } } as RequestInit;
    await expect(pool.fetch("https://f402.example/a", init)).rejects.toThrow(
      F402FetchSessionConfigError,
    );
    expect(created).toHaveLength(0);
  });

  test("refuses relative and non-http(s) URLs by name", () => {
    expect(() => f402FetchOrigin("/cloud/api/x")).toThrow(
      F402FetchSessionConfigError,
    );
    expect(() => f402FetchOrigin("file:///etc/hosts")).toThrow(
      F402FetchSessionConfigError,
    );
    expect(f402FetchOrigin("https://F402.example:443/a")).toBe(
      "https://f402.example",
    );
  });

  test("closeIdle closes every session and keeps them in the pool", async () => {
    const { pool, created } = fakePool();
    await pool.fetch("https://f402.example/a");
    await pool.fetch("https://cdn.f402.example/a");
    pool.closeIdle();
    expect(created.map((s) => s.closes)).toEqual([1, 1]);
    expect(pool.size).toBe(2);
  });

  test("a non-TLS error passes through unchanged", async () => {
    const boom = new TypeError("connection refused");
    const pool = new F402FetchSessionPool({
      createSession: () => ({
        fetch: async () => {
          throw boom;
        },
        close() {},
      }),
      warm: () => {},
    });
    await expect(pool.fetch("https://f402.example/a")).rejects.toBe(boom);
  });

  test("tlsErrorCode only recognizes certificate and handshake codes", () => {
    expect(tlsErrorCode({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe(
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    );
    expect(tlsErrorCode({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    expect(tlsErrorCode({ code: "ConnectionRefused" })).toBeNull();
    expect(tlsErrorCode(new Error("x"))).toBeNull();
    expect(tlsErrorCode(null)).toBeNull();
  });
});

describe("F402FetchSessionPool over real Bun.FetchSession", () => {
  test("reuses the session across requests to a local server", async () => {
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new Response(new URL(req.url).pathname),
    });
    const warmed: string[] = [];
    const pool = new F402FetchSessionPool({
      warm: (origin) => warmed.push(origin),
    });
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await pool.fetch(`${base}/a`)).text()).toBe("/a");
    expect(await (await pool.fetch(`${base}/b`)).text()).toBe("/b");
    expect(pool.size).toBe(1);
    expect(warmed).toEqual([base]);
    pool.closeIdle();
  });
});

const openssl = Bun.which("openssl");

describe.skipIf(openssl === null)("certificate verification", () => {
  let dir = "";
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "f402-tls-"));
    const made = Bun.spawnSync([
      openssl!,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ]);
    if (made.exitCode !== 0)
      throw new Error("openssl could not make a test cert");
    server = Bun.serve({
      port: 0,
      hostname: "localhost",
      tls: {
        key: Bun.file(join(dir, "key.pem")),
        cert: Bun.file(join(dir, "cert.pem")),
      },
      fetch: () => Response.json({ LIST: [] }),
    });
    base = `https://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a self-signed certificate is a named F402TlsVerificationError", async () => {
    const pool = new F402FetchSessionPool({ warm: () => {} });
    const error = await pool.fetch(`${base}/x`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(F402TlsVerificationError);
    const tlsError = error as F402TlsVerificationError;
    expect(tlsError.name).toBe("F402TlsVerificationError");
    expect(tlsError.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(tlsError.origin).toBe(base);
    expect(tlsError.cause).toBeInstanceOf(Error);
  });

  test("NODE_TLS_REJECT_UNAUTHORIZED=0 does not turn session verification off", async () => {
    const script = `
      import { F402FetchSessionPool } from ${JSON.stringify(join(import.meta.dir, "../lib/f402_fetch_sessions.ts"))};
      const pool = new F402FetchSessionPool({ warm: () => {} });
      const e = await pool.fetch(${JSON.stringify(`${base}/x`)}).catch((e) => e);
      console.log(e?.name ?? "no-error");
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...Bun.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect(out).toBe("F402TlsVerificationError");
  });

  test("the puller's default transport fails with code tls", async () => {
    const before = f402FetchSessions.size;
    const client = new F402PullClient({
      session,
      baseUrl: base,
      intervalMs: 0,
      maxRetries: 3,
    });
    const error = await client.post("getPlayers", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(F402PullerError);
    expect((error as F402PullerError).code).toBe("tls");
    expect((error as F402PullerError).cause).toBeInstanceOf(
      F402TlsVerificationError,
    );
    expect(f402FetchSessions.origins()).toContain(base);
    expect(f402FetchSessions.size).toBeGreaterThanOrEqual(before);
  });

  test("the bet ticker probe reports the named TLS failure", async () => {
    const probe = await probeF402BetTicker(session, {
      baseUrl: base,
      agentId: "TEST",
      timeoutMs: 5_000,
    });
    expect(probe.httpStatus).toBe(0);
    expect(probe.error).toContain("TLS verification failed");
    expect(probe.error).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  test("CDN and portal bundle fetches classify it as tls_trust", async () => {
    const cdn = await fetchAssetOutcome(`${base}/a.js`);
    expect(cdn.kind).toBe("tls_trust");
    const bundle = await fetchPortalArtifactBytes(`${base}/b.js`);
    expect(bundle.kind).toBe("tls_trust");
  });

  test("the version pin fetch throws it by name", async () => {
    await expect(fetchLiveVersionJs(base)).rejects.toBeInstanceOf(
      F402TlsVerificationError,
    );
  });
});

describe("fetchImpl injection still wins", () => {
  test("the puller uses an injected fetchImpl and leaves the pool alone", async () => {
    const before = f402FetchSessions.origins();
    const urls: string[] = [];
    const client = new F402PullClient({
      session,
      baseUrl: "https://f402.invalid",
      intervalMs: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        return Response.json({ ok: true });
      },
    });
    await client.post("getPlayers", {}).catch(() => {});
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toStartWith("https://f402.invalid/cloud/api/");
    expect(f402FetchSessions.origins()).toEqual(before);
  });

  test("the probe uses an injected fetchImpl", async () => {
    let called = 0;
    await probeF402BetTicker(session, {
      baseUrl: "https://f402.invalid",
      agentId: "TEST",
      fetchImpl: async () => {
        called += 1;
        return Response.json({ LIST: [] });
      },
    });
    expect(called).toBe(1);
  });

  test("the replay transport routes through its pool, and fetchImpl bypasses it", async () => {
    const env = { F402_REPLAY_PROXY_URL: "", F402_COOKIE: "" };
    const readSession = () => session;
    const viaPool = fakePool();
    const pooled = await createF402ReplayTransport({
      env,
      readSession,
      sessions: viaPool.pool,
    });
    await pooled.fetch("https://f402.example/cloud/api/x", {});
    expect(viaPool.created).toHaveLength(1);
    expect(viaPool.created[0]?.urls).toEqual([
      "https://f402.example/cloud/api/x",
    ]);
    await pooled.close();
    expect(viaPool.created[0]?.closes).toBe(1);

    const bypass = fakePool();
    let injected = 0;
    const direct = await createF402ReplayTransport({
      env,
      readSession,
      sessions: bypass.pool,
      fetchImpl: async () => {
        injected += 1;
        return new Response("ok");
      },
    });
    await direct.fetch("https://f402.example/cloud/api/x", {});
    expect(injected).toBe(1);
    expect(bypass.created).toHaveLength(0);
  });

  test("the replay proxy path never touches the pool", async () => {
    using proxy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new Response(req.headers.get("x-f402-upstream") ?? ""),
    });
    const { pool, created } = fakePool();
    const transport = await createF402ReplayTransport({
      env: { F402_COOKIE: "" },
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      sessions: pool,
    });
    expect(transport.label).toBe("proxy");
    const res = await transport.fetch("https://f402.example/cloud/api/x", {});
    expect(await res.text()).toBe("https://f402.example/cloud/api/x");
    expect(created).toHaveLength(0);
  });
});
