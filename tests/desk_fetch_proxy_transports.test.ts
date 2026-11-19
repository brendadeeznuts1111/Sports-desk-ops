import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  DEFAULT_DESK_FETCH_TIMEOUT_MS,
  DeskNetworkError,
  DeskTimeoutError,
  resolveDeskTimeoutMs,
  R2ProxyConfigError,
  R2ProxyUrlError,
} from "../lib/desk_fetch_proxy.ts";
import { fetchPortalArtifactBytes } from "../lib/f402_portal_bundle_fetch.ts";
import { fetchLiveVersionJs } from "../lib/f402_portal_version_pin.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";
import { fetchManagerJson, postManagerJson } from "../lib/manager_fetch.ts";
import {
  type ConnectProxy,
  startConnectProxy,
} from "./support/connect_proxy.ts";

let origin: ReturnType<typeof Bun.serve> | null = null;
let originBase = "";
let hang: ReturnType<typeof Bun.serve> | null = null;
let hangBase = "";
let proxy: ConnectProxy;
beforeAll(async () => {
  proxy = await startConnectProxy();
  origin = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        path.endsWith("/app/setting/version.js") ||
        path.endsWith("/app/manager/manager.js")
      ) {
        return new Response("portal-ok", {
          headers: { "content-type": "text/javascript" },
        });
      }
      return Response.json({ ok: true, path, method: request.method });
    },
  });
  originBase = `http://127.0.0.1:${origin.port}`;
  hang = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Promise(() => {});
    },
  });
  hangBase = `http://127.0.0.1:${hang.port}`;
});

afterAll(() => {
  origin?.stop(true);
  hang?.stop(true);
  proxy.close();
});

/** Built at runtime so the repo-wide credential-URL audit never sees a literal. */
function credentialedProxyUrl(username: string, password = ""): string {
  const url = new URL("http://127.0.0.1:3128");
  url.username = username;
  url.password = password;
  return url.href;
}

const emptyEnv = {
  F402_REPLAY_PROXY_URL: "",
  F402_COOKIE: "",
} as const;

async function replay(
  options?: Parameters<typeof createF402ReplayTransport>[0],
) {
  return createF402ReplayTransport({
    env: { ...emptyEnv },
    readSession: () => ({
      cookieHeader: "session=test",
      cookieNames: ["session"],
      obtainedAtIso: new Date().toISOString(),
      expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    ...options,
  });
}

interface ChildResult {
  readonly kind: string;
  readonly status: number;
  readonly body: string;
}

async function runChild(kind: string, url: string): Promise<ChildResult> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(Bun.env)) {
    if (value !== undefined && !/proxy/i.test(name)) env[name] = value;
  }
  env.HTTP_PROXY = proxy.url;
  env.HTTPS_PROXY = proxy.url;
  env.http_proxy = proxy.url;
  env.https_proxy = proxy.url;
  env.ALL_PROXY = proxy.url;
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "support", "desk_fetch_transports_child.ts"),
      kind,
      url,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`child ${kind} exited ${code}: ${stderr || stdout}`);
  }
  return JSON.parse(stdout) as ChildResult;
}

describe("resolveDeskTimeoutMs", () => {
  test("defaults to 30s and rejects non-positive values", () => {
    expect(resolveDeskTimeoutMs(undefined)).toBe(DEFAULT_DESK_FETCH_TIMEOUT_MS);
    expect(DEFAULT_DESK_FETCH_TIMEOUT_MS).toBe(30_000);
    expect(resolveDeskTimeoutMs(1.2)).toBe(2);
    expect(() => resolveDeskTimeoutMs(0)).toThrow(RangeError);
    expect(() => resolveDeskTimeoutMs(-5)).toThrow(RangeError);
  });
});

describe("proxy env vars are ignored by default", () => {
  test("manager, portal, and replay fetches go direct when HTTP(S)_PROXY is set", async () => {
    const start = proxy.heads.length;
    const manager = await runChild("manager", `${originBase}/json`);
    expect(manager.status).toBe(200);
    expect(JSON.parse(manager.body)).toMatchObject({ ok: true, path: "/json" });

    const posted = await runChild("manager-post", `${originBase}/json`);
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body)).toMatchObject({ method: "POST" });

    const version = await runChild("portal-version", originBase);
    expect(version.status).toBe(200);
    expect(version.body).toBe("portal-ok");

    const bundle = await runChild("portal-bundle", originBase);
    expect(bundle.status).toBe(200);
    expect(bundle.body).toBe("portal-ok");

    const session = await runChild("replay-session", `${originBase}/replay`);
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toMatchObject({ path: "/replay" });

    const local = await runChild("replay-local-proxy", originBase);
    expect(local.status).toBe(200);

    expect(proxy.heads.length).toBe(start);
  });
});

describe("explicit proxy is validated", () => {
  test("socks5 and credentialed URLs throw R2ProxyUrlError before fetch", async () => {
    const socks = { url: "socks5://127.0.0.1:1080" };
    const creds = { url: credentialedProxyUrl("desk", "hunter2") };

    await expect(
      fetchManagerJson(`${originBase}/json`, "GSID=x", { proxy: socks }),
    ).rejects.toThrow(R2ProxyUrlError);
    await expect(
      fetchLiveVersionJs(originBase, "1.0.280", { proxy: socks }),
    ).rejects.toThrow(R2ProxyUrlError);
    await expect(
      fetchPortalArtifactBytes(`${originBase}/app/setting/version.js`, {
        proxy: socks,
      }),
    ).rejects.toThrow(R2ProxyUrlError);
    const transport = await replay({ proxy: socks });
    await expect(transport.fetch(`${originBase}/x`, {})).rejects.toThrow(
      R2ProxyUrlError,
    );
    await transport.close();

    try {
      await postManagerJson(
        `${originBase}/json`,
        "GSID=x",
        {},
        { proxy: creds },
      );
      throw new Error("expected R2ProxyUrlError");
    } catch (error) {
      expect(error).toBeInstanceOf(R2ProxyUrlError);
      expect((error as R2ProxyUrlError).reason).toBe("credentials");
      expect((error as Error).message).not.toContain("hunter2");
    }
  });

  test("an explicit HTTP proxy is accepted and passed through to fetch", async () => {
    const seen: BunFetchRequestInit[] = [];
    const fetchImpl = async (_input: string, init: BunFetchRequestInit) => {
      seen.push(init);
      return Response.json({ ok: true });
    };
    const proxyOption = {
      url: proxy.url,
      headers: { "X-Proxy-Region": "desk" },
    };
    await fetchManagerJson(`${originBase}/json`, "GSID=x", {
      proxy: proxyOption,
      fetchImpl,
    });
    await fetchLiveVersionJs(originBase, "1.0.280", {
      proxy: proxyOption,
      fetchImpl,
    });
    const bundle = await fetchPortalArtifactBytes(
      `${originBase}/app/setting/version.js`,
      { proxy: proxyOption, fetchImpl },
    );
    expect(bundle.kind).toBe("ok");
    const transport = await replay({ proxy: proxyOption, fetchImpl });
    await transport.fetch(`${originBase}/x`, {});
    await transport.close();
    expect(seen.length).toBe(4);
    for (const init of seen) {
      expect(init.proxy).toEqual({
        url: `${proxy.url}/`,
        headers: { "X-Proxy-Region": "desk" },
      });
    }
  });
});


describe("proxy configuration failures preserve their error identity", () => {
  test("manager, portal, and both replay transports reject before network I/O", async () => {
    const invalidProxy = {
      url: proxy.url,
      headers: { "X-Desk-Region": "do-not-echo\r\nX-Injected: 1" },
    };
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return Response.json({ unexpected: true });
    };
    const assertConfigError = async (
      op: () => Promise<unknown>,
    ): Promise<void> => {
      let error: unknown;
      try {
        await op();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(R2ProxyConfigError);
      const config = error as R2ProxyConfigError;
      expect(config).toMatchObject({
        name: "R2ProxyConfigError",
        code: "ERR_R2_PROXY_CONFIG",
        reason: "header-value-crlf",
      });
      expect(config.message).not.toContain("do-not-echo");
      expect(config.cause).toBeUndefined();
    };

    await assertConfigError(() =>
      fetchManagerJson(`${originBase}/json`, "GSID=x", {
        proxy: invalidProxy,
        fetchImpl,
      }),
    );
    await assertConfigError(() =>
      postManagerJson(`${originBase}/json`, "GSID=x", {}, {
        proxy: invalidProxy,
        fetchImpl,
      }),
    );
    await assertConfigError(() =>
      fetchLiveVersionJs(originBase, "1.0.280", {
        proxy: invalidProxy,
        fetchImpl,
      }),
    );
    await assertConfigError(() =>
      fetchPortalArtifactBytes(
        `${originBase}/app/setting/version.js`,
        { proxy: invalidProxy, fetchImpl },
      ),
    );

    const session = await replay({ proxy: invalidProxy, fetchImpl });
    try {
      await assertConfigError(() => session.fetch(`${originBase}/x`, {}));
    } finally {
      await session.close();
    }
    const local = await replay({
      proxy: invalidProxy,
      proxyUrl: originBase,
    });
    try {
      await assertConfigError(() => local.fetch(`${originBase}/x`, {}));
    } finally {
      await local.close();
    }
    expect(calls).toBe(0);
  });
});

describe("timeouts raise DeskTimeoutError", () => {
  test("manager, portal, and replay time out with the named error", async () => {
    const timeoutMs = 40;
    const manager = await fetchManagerJson(`${hangBase}/slow`, "GSID=x", {
      timeoutMs,
    }).catch((error: unknown) => error);
    expect(manager).toBeInstanceOf(DeskTimeoutError);
    expect(manager).toMatchObject({
      name: "DeskTimeoutError",
      ms: timeoutMs,
      url: `${hangBase}/slow`,
    });
    expect((manager as Error).cause).toMatchObject({ name: "TimeoutError" });

    const version = await fetchLiveVersionJs(hangBase, "1.0.280", {
      timeoutMs,
    }).catch((error: unknown) => error);
    expect(version).toBeInstanceOf(DeskTimeoutError);
    expect((version as DeskTimeoutError).ms).toBe(timeoutMs);

    const bundle = await fetchPortalArtifactBytes(
      `${hangBase}/app/setting/version.js`,
      {
        timeoutMs,
      },
    );
    expect(bundle).toMatchObject({ kind: "network" });
    expect((bundle as { error: string }).error).toContain("DeskTimeoutError");

    const transport = await replay({ timeoutMs });
    const replayError = await transport
      .fetch(`${hangBase}/slow`, {})
      .catch((error: unknown) => error);
    expect(replayError).toBeInstanceOf(DeskTimeoutError);
    await transport.close();
  });
});

describe("non-retryable network errors are named", () => {
  test("ECONNREFUSED becomes DeskNetworkError with transient false", async () => {
    const url = "http://127.0.0.1:1/refused";
    const error = await fetchManagerJson(url, "GSID=x", {
      timeoutMs: 1_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeskNetworkError);
    expect(error).toMatchObject({
      name: "DeskNetworkError",
      url,
      transient: false,
    });
    expect((error as DeskNetworkError).code).toBe("ECONNREFUSED");
  });
});
