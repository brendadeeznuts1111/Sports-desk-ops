import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { uploadScreenshotToGateway } from "../lib/blob_upload.ts";
import { collectDeskHealth } from "../lib/desk_health.ts";
import {
  fetchWithProxyPolicy,
  R2ProxyTunnelError,
  R2ProxyUrlError,
  resolveR2Proxy,
  toR2ProxyTunnelError,
} from "../lib/desk_fetch_proxy.ts";
import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";
import {
  type ConnectProxy,
  startConnectProxy,
} from "./support/connect_proxy.ts";
import { createTlsFixture, type TlsFixture } from "./support/tls_fixture.ts";

const PROXY_TOKEN = "Bearer test-proxy-token";

let fixture: TlsFixture | null = null;
let ca = "";
let target: ReturnType<typeof Bun.serve> | null = null;
let origin = "";
const targetSaw: Headers[] = [];
let proxy: ConnectProxy;

beforeAll(async () => {
  proxy = await startConnectProxy();
  fixture = await createTlsFixture("localhost");
  if (fixture === null) return;
  ca = await Bun.file(fixture.caPath).text();
  target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: {
      key: await Bun.file(fixture.keyPath).text(),
      cert: await Bun.file(fixture.certPath).text(),
    },
    fetch(request) {
      targetSaw.push(new Headers(request.headers));
      return new Response(request.method === "HEAD" ? null : "ok", {
        headers: { etag: '"e1"' },
      });
    },
  });
  origin = `https://localhost:${target.port}`;
});

afterAll(() => {
  target?.stop(true);
  proxy.close();
  fixture?.cleanup();
});

const trusted = (input: string, init: BunFetchRequestInit) =>
  fetch(input, { ...init, tls: { ca }, keepalive: false });

const backend = {} as R2S3ClientBackend;

function clientFor(proxyOption?: {
  url: string;
  headers?: Record<string, string>;
}) {
  return R2S3Client.fromOptions(
    {
      bucket: "bucket",
      endpoint: origin === "" ? "https://localhost:1" : origin,
      accessKeyId: "a",
      secretAccessKey: "s",
      publicBase: "https://pub.test",
      ...(proxyOption === undefined ? {} : { proxy: proxyOption }),
    },
    backend,
  );
}

describe("resolveR2Proxy", () => {
  test("undefined and false resolve to a direct connection", () => {
    expect(resolveR2Proxy(undefined)).toBe(false);
    expect(resolveR2Proxy(false)).toBe(false);
  });

  test("a URL with user:pass@ is rejected without echoing the secret", () => {
    const attempt = () =>
      resolveR2Proxy({ url: "http://desk:hunter2@127.0.0.1:3128" });
    expect(attempt).toThrow(R2ProxyUrlError);
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(R2ProxyUrlError);
      expect((error as R2ProxyUrlError).reason).toBe("credentials");
      expect((error as Error).message).not.toContain("hunter2");
    }
    expect(() =>
      resolveR2Proxy({ url: "http://token@127.0.0.1:3128" }),
    ).toThrow(R2ProxyUrlError);
  });

  test("the client refuses a credentialed proxy at construction", () => {
    expect(() => clientFor({ url: "http://u:p@127.0.0.1:3128" })).toThrow(
      R2ProxyUrlError,
    );
  });

  test("non-http schemes and garbage are rejected", () => {
    expect(() => resolveR2Proxy({ url: "socks5://127.0.0.1:1080" })).toThrow(
      R2ProxyUrlError,
    );
    expect(() => resolveR2Proxy({ url: "not a url" })).toThrow(R2ProxyUrlError);
  });

  test("headers are copied, not shared", () => {
    const headers = { "Proxy-Authorization": PROXY_TOKEN };
    const resolved = resolveR2Proxy({ url: "http://127.0.0.1:3128", headers });
    expect(resolved).toEqual({ url: "http://127.0.0.1:3128/", headers });
    expect(resolved === false ? null : resolved.headers).not.toBe(headers);
  });
});

describe("default proxy:false on desk fetches", () => {
  const capture = () => {
    const inits: BunFetchRequestInit[] = [];
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      inits.push(init ?? {});
      return new Response("{}", {
        headers: { etag: '"e1"', "content-type": "application/json" },
      });
    };
    return { inits, fetchImpl };
  };

  test("R2S3Client signed HEAD and PUT pass proxy:false", async () => {
    const { inits, fetchImpl } = capture();
    const client = clientFor();
    await client.headEtag("k", { fetchImpl: fetchImpl as typeof fetch });
    await client.writeWithMetadata("k", "v", {
      metadata: { a: "b" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(inits.map((init) => init.proxy)).toEqual([false, false]);
  });

  test("blob gateway and desk health pass proxy:false", async () => {
    const { inits, fetchImpl } = capture();
    await collectDeskHealth({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((init) => init.proxy === false)).toBe(true);
    const before = inits.length;
    await uploadScreenshotToGateway(new Uint8Array([1]), "image/png", {
      gatewayUrl: "http://127.0.0.1:1",
      apiToken: "t",
      key: "k",
      fetchImpl,
    }).catch(() => null);
    expect(inits.length).toBeGreaterThan(before);
    expect(inits.slice(before).every((init) => init.proxy === false)).toBe(
      true,
    );
  });

  test("a real fetch with the default policy ignores HTTPS_PROXY, even on a fresh socket", async () => {
    if (fixture === null) return;
    const result = await runKeepaliveChild();
    expect(result.policyDefault).toEqual({ newConnects: 0, viaTunnel: false });
  });
});

describe("explicit object proxy", () => {
  test("Proxy-Authorization and custom headers go on CONNECT; signed headers stay in the tunnel", async () => {
    if (fixture === null) return;
    proxy.mode = "tunnel";
    const start = proxy.heads.length;
    targetSaw.length = 0;
    const client = clientFor({
      url: proxy.url,
      headers: { "Proxy-Authorization": PROXY_TOKEN, "X-Proxy-Region": "desk" },
    });
    expect(
      await client.headEtag("k", { fetchImpl: trusted as typeof fetch }),
    ).toBe('"e1"');
    const heads = proxy.heads.slice(start);
    expect(heads).toHaveLength(1);
    const head = heads[0] ?? "";
    expect(head).toStartWith(`CONNECT localhost:${target?.port}`);
    expect(head.toLowerCase()).toContain(
      `proxy-authorization: ${PROXY_TOKEN.toLowerCase()}`,
    );
    expect(head.toLowerCase()).toContain("x-proxy-region: desk");
    expect(head.toLowerCase()).not.toContain("aws4-hmac-sha256");
    expect(targetSaw[0]?.get("authorization")).toStartWith("AWS4-HMAC-SHA256");
    expect(targetSaw[0]?.get("proxy-authorization")).toBeNull();
  });

  test("a 407 maps to R2ProxyTunnelError and is not retried", async () => {
    if (fixture === null) return;
    proxy.mode = "407";
    const start = proxy.heads.length;
    const client = clientFor({ url: proxy.url });
    let caught: unknown;
    try {
      await client.writeWithMetadata("k", "v", {
        metadata: { a: "b" },
        retry: 2,
        retryDelayMs: 0,
        fetchImpl: trusted as typeof fetch,
      });
    } catch (error) {
      caught = error;
    } finally {
      proxy.mode = "tunnel";
    }
    expect(caught).toBeInstanceOf(R2ProxyTunnelError);
    const tunnel = caught as R2ProxyTunnelError;
    expect(tunnel.status).toBe(407);
    expect(tunnel.proxyAuthenticate).toBe('Bearer realm="desk"');
    expect((tunnel.cause as { code?: string }).code).toBe("ERR_PROXY_TUNNEL");
    expect(proxy.heads.length - start).toBe(1);
  });

  test("other errors pass through unchanged", async () => {
    const boom = new Error("boom");
    expect(toR2ProxyTunnelError(boom)).toBe(boom);
    expect(toR2ProxyTunnelError("x")).toBe("x");
    await expect(
      fetchWithProxyPolicy(
        async () => {
          throw boom;
        },
        "https://localhost:1/",
        {},
        undefined,
      ),
    ).rejects.toBe(boom);
  });
});

interface KeepaliveStep {
  readonly newConnects: number;
  readonly viaTunnel: boolean;
}

interface KeepaliveResult {
  readonly direct: KeepaliveStep;
  readonly envAfterDirect: KeepaliveStep;
  readonly explicit: KeepaliveStep;
  readonly envAfterExplicit: KeepaliveStep;
  readonly directWithEnvSet: KeepaliveStep;
  readonly policyDefault: KeepaliveStep;
}

async function runKeepaliveChild(): Promise<KeepaliveResult> {
  if (fixture === null) throw new Error("no TLS fixture");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(Bun.env)) {
    if (value !== undefined && !/proxy/i.test(name)) env[name] = value;
  }
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "support", "proxy_keepalive_child.ts"),
      fixture.keyPath,
      fixture.certPath,
      fixture.caPath,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`keepalive child exited ${code}: ${stderr}`);
  return JSON.parse(stdout) as KeepaliveResult;
}

describe("Bun 1.4.4 env-proxy keep-alive pin (#393)", () => {
  test("pooled sockets are keyed by route: env HTTPS_PROXY reuses a tunnel, never a direct socket", async () => {
    if (fixture === null) return;
    const r = await runKeepaliveChild();
    const direct = { newConnects: 0, viaTunnel: false };
    const freshTunnel = { newConnects: 1, viaTunnel: true };
    expect(r.direct).toEqual(direct);
    expect(r.envAfterDirect).toEqual(freshTunnel);
    expect(r.explicit).toEqual(freshTunnel);
    // No new CONNECT here: the pooled tunnel from `explicit` is reused, still via the proxy.
    // A CONNECT count alone reads this as a bypass; if this pin changes, revisit #393.
    expect(r.envAfterExplicit).toEqual({ newConnects: 0, viaTunnel: true });
    expect(r.directWithEnvSet).toEqual(direct);
    expect(r.policyDefault).toEqual(direct);
  });
});
