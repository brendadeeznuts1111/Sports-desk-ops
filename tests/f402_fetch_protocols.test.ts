import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  F402_HTTP_VERSION_ENV,
  F402FetchSessionConfigError,
  type F402FetchSessionInit,
  type F402FetchSessionLike,
  F402FetchSessionPool,
  type F402HttpVersion,
  parseF402HttpVersion,
  resolveF402HttpVersion,
} from "../lib/f402_fetch_sessions.ts";

interface Recorded {
  readonly init: F402FetchSessionInit;
  readonly calls: { url: string; init: RequestInit | undefined }[];
}

function recordingPool(httpVersion?: F402HttpVersion): {
  pool: F402FetchSessionPool;
  created: Recorded[];
  warmed: string[];
} {
  const created: Recorded[] = [];
  const warmed: string[] = [];
  const pool = new F402FetchSessionPool({
    createSession: (init): F402FetchSessionLike => {
      const rec: Recorded = { init, calls: [] };
      created.push(rec);
      return {
        async fetch(url, reqInit) {
          rec.calls.push({ url, init: reqInit });
          return new Response("ok");
        },
        close() {},
      };
    },
    warm: (origin) => warmed.push(origin),
    ...(httpVersion === undefined ? {} : { httpVersion }),
  });
  return { pool, created, warmed };
}

describe("F402 HTTP version config", () => {
  test("parses auto, 1.1 and 2 and refuses anything else by name", () => {
    expect(parseF402HttpVersion("auto")).toBe("auto");
    expect(parseF402HttpVersion(" 1.1 ")).toBe("1.1");
    expect(parseF402HttpVersion("2")).toBe("2");
    for (const bad of ["", "h2", "http2", "1", "3", "2.0", "HTTP/1.1"]) {
      expect(() => parseF402HttpVersion(bad)).toThrow(
        F402FetchSessionConfigError,
      );
    }
  });

  test("reads F402_HTTP_VERSION, defaulting to auto when unset or blank", () => {
    expect(resolveF402HttpVersion({})).toBe("auto");
    expect(resolveF402HttpVersion({ [F402_HTTP_VERSION_ENV]: "  " })).toBe(
      "auto",
    );
    expect(resolveF402HttpVersion({ [F402_HTTP_VERSION_ENV]: "2" })).toBe("2");
    expect(() =>
      resolveF402HttpVersion({ [F402_HTTP_VERSION_ENV]: "h3" }),
    ).toThrow(F402FetchSessionConfigError);
  });

  test("a bad pool option fails at construction", () => {
    expect(
      () =>
        new F402FetchSessionPool({
          httpVersion: "3" as F402HttpVersion,
          warm: () => {},
        }),
    ).toThrow(F402FetchSessionConfigError);
  });

  test("auto sends no protocol; 1.1 and 2 pin it on every request", async () => {
    const cases: [F402HttpVersion, string | undefined][] = [
      ["auto", undefined],
      ["1.1", "http1.1"],
      ["2", "http2"],
    ];
    for (const [version, protocol] of cases) {
      const { pool, created } = recordingPool(version);
      await pool.fetch("https://f402.example/a", {
        method: "POST",
        headers: { "x-k": "v" },
      });
      const sent = created[0]?.calls[0]?.init as
        (RequestInit & { protocol?: string }) | undefined;
      expect(sent?.protocol).toBe(protocol);
      expect(sent?.method).toBe("POST");
      expect(sent?.headers).toEqual({ "x-k": "v" });
      if (protocol === undefined)
        expect(sent && "protocol" in sent).toBe(false);
    }
  });

  test("refuses a per-request protocol", async () => {
    const { pool, created } = recordingPool("auto");
    const init = { protocol: "http2" } as RequestInit;
    await expect(pool.fetch("https://f402.example/a", init)).rejects.toThrow(
      F402FetchSessionConfigError,
    );
    expect(created).toHaveLength(0);
  });

  test("HTTP/2 on an http: origin is refused before a session exists (Bun has no h2c)", async () => {
    const { pool, created } = recordingPool("2");
    const error = await pool
      .fetch("http://f402.example/a")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(F402FetchSessionConfigError);
    expect((error as Error).message).toContain("h2c");
    expect(created).toHaveLength(0);
  });

  test("http: and https: on one host get separate sessions; only https: has a TLS context", async () => {
    const { pool, created } = recordingPool("1.1");
    await pool.fetch("http://f402.example/a");
    await pool.fetch("https://f402.example/a");
    await pool.fetch("http://f402.example:8080/a");
    expect(pool.origins()).toEqual([
      "http://f402.example",
      "https://f402.example",
      "http://f402.example:8080",
    ]);
    expect(created.map((s) => s.init)).toEqual([
      {},
      { tls: { rejectUnauthorized: true } },
      {},
    ]);
  });

  test("configure sets version and prefetch before first use, and refuses after", async () => {
    const { pool, created, warmed } = recordingPool();
    pool.configure({ httpVersion: "1.1", dnsPrefetch: false });
    expect(pool.httpVersion).toBe("1.1");
    await pool.fetch("https://f402.example/a");
    expect(warmed).toEqual([]);
    expect(
      (created[0]?.calls[0]?.init as { protocol?: string } | undefined)
        ?.protocol,
    ).toBe("http1.1");
    expect(() => pool.configure({ httpVersion: "2" })).toThrow(
      F402FetchSessionConfigError,
    );
    expect(() => pool.configure({ dnsPrefetch: true })).toThrow(
      F402FetchSessionConfigError,
    );
    pool.configure({ httpVersion: "1.1", dnsPrefetch: false });
    expect(pool.httpVersion).toBe("1.1");
  });

  test("an unconfigured pool reads F402_HTTP_VERSION on first use and fails loudly on a bad value", async () => {
    const lib = JSON.stringify(
      join(import.meta.dir, "../lib/f402_fetch_sessions.ts"),
    );
    const script = `
      const { F402FetchSessionPool } = await import(${lib});
      const pool = new F402FetchSessionPool({ warm: () => {}, createSession: () => ({ fetch: async () => new Response("ok"), close() {} }) });
      const e = await pool.fetch("https://f402.example/a").then(() => "ok", (e) => e.name);
      console.log(e, pool.size);
    `;
    const proc = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...Bun.env, [F402_HTTP_VERSION_ENV]: "h2" },
    });
    expect(proc.stdout.toString().trim()).toBe("F402FetchSessionConfigError 0");
  });
});

const openssl = Bun.which("openssl");

describe.skipIf(openssl === null)(
  "HTTP/1.1 and HTTP/2 over local servers",
  () => {
    let dir = "";
    let certPath = "";
    let h2Server: http2.Http2SecureServer | undefined;
    let h2Base = "";
    let h1Tls: ReturnType<typeof Bun.serve> | undefined;
    let h1TlsBase = "";
    let h1Plain: ReturnType<typeof Bun.serve> | undefined;
    let h1PlainBase = "";

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "f402-proto-"));
      certPath = join(dir, "cert.pem");
      const keyPath = join(dir, "key.pem");
      const made = Bun.spawnSync([
        openssl!,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ]);
      if (made.exitCode !== 0)
        throw new Error("openssl could not make a test cert");
      const key = await Bun.file(keyPath).text();
      const cert = await Bun.file(certPath).text();

      h2Server = http2.createSecureServer(
        { key, cert, allowHTTP1: true },
        (req, res) => {
          res.end(
            JSON.stringify({
              httpVersion: req.httpVersion,
              alpn: (req.socket as { alpnProtocol?: unknown }).alpnProtocol,
            }),
          );
        },
      );
      await new Promise<void>((resolve) =>
        h2Server!.listen(0, "127.0.0.1", resolve),
      );
      const address = h2Server.address();
      if (address === null || typeof address === "string")
        throw new Error("no h2 port");
      h2Base = `https://localhost:${address.port}`;

      h1Tls = Bun.serve({
        port: 0,
        hostname: "localhost",
        tls: { key, cert },
        fetch: () => Response.json({ httpVersion: "1.1" }),
      });
      h1TlsBase = `https://localhost:${h1Tls.port}`;
      h1Plain = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (req) => Response.json({ path: new URL(req.url).pathname }),
      });
      h1PlainBase = `http://127.0.0.1:${h1Plain.port}`;
    });

    afterAll(async () => {
      h1Tls?.stop(true);
      h1Plain?.stop(true);
      await new Promise<void>((resolve) =>
        h2Server === undefined ? resolve() : h2Server.close(() => resolve()),
      );
      rmSync(dir, { recursive: true, force: true });
    });

    async function runClient(
      version: F402HttpVersion,
      url: string,
      env: Record<string, string> = {},
      trustCert = true,
    ): Promise<string> {
      const lib = JSON.stringify(
        join(import.meta.dir, "../lib/f402_fetch_sessions.ts"),
      );
      const script = `
      const { F402FetchSessionPool } = await import(${lib});
      const pool = new F402FetchSessionPool({ warm: () => {}, httpVersion: ${JSON.stringify(version)} });
      try {
        const res = await pool.fetch(${JSON.stringify(url)});
        console.log(res.status + " " + (await res.text()));
      } catch (e) {
        console.log(e.name + " " + (e.code ?? "") + " " + (e.cause?.code ?? ""));
      }
    `;
      const childEnv: Record<string, string | undefined> = {
        ...Bun.env,
        ...env,
      };
      delete childEnv["BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT"];
      delete childEnv[F402_HTTP_VERSION_ENV];
      if (trustCert) childEnv["NODE_EXTRA_CA_CERTS"] = certPath;
      else delete childEnv["NODE_EXTRA_CA_CERTS"];
      Object.assign(childEnv, env);
      const proc = Bun.spawn([process.execPath, "-e", script], {
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      expect(await proc.exited).toBe(0);
      return out;
    }

    test("auto stays on HTTP/1.1: Bun offers only http/1.1 in ALPN by default", async () => {
      expect(await runClient("auto", `${h2Base}/x`)).toBe(
        '200 {"httpVersion":"1.1","alpn":"http/1.1"}',
      );
    });

    test("2 negotiates h2 with a verified certificate", async () => {
      expect(await runClient("2", `${h2Base}/x`)).toBe(
        '200 {"httpVersion":"2.0","alpn":"h2"}',
      );
    });

    test("1.1 pins HTTP/1.1 against an h2-capable server", async () => {
      expect(await runClient("1.1", `${h2Base}/x`)).toBe(
        '200 {"httpVersion":"1.1","alpn":"http/1.1"}',
      );
    });

    test("auto follows BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT; 1.1 overrides it", async () => {
      const flag = { BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT: "1" };
      expect(await runClient("auto", `${h2Base}/x`, flag)).toBe(
        '200 {"httpVersion":"2.0","alpn":"h2"}',
      );
      expect(await runClient("1.1", `${h2Base}/x`, flag)).toBe(
        '200 {"httpVersion":"1.1","alpn":"http/1.1"}',
      );
    });

    test("2 against an HTTP/1.1-only server is a named F402HttpVersionError", async () => {
      expect(await runClient("2", `${h1TlsBase}/x`)).toBe(
        "F402HttpVersionError  HTTP2Unsupported",
      );
      expect(await runClient("auto", `${h1TlsBase}/x`)).toBe(
        '200 {"httpVersion":"1.1"}',
      );
    });

    test("certificate verification stays on for HTTP/2 and HTTP/1.1", async () => {
      for (const version of ["2", "1.1", "auto"] as const) {
        expect(await runClient(version, `${h2Base}/x`, {}, false)).toBe(
          "F402TlsVerificationError DEPTH_ZERO_SELF_SIGNED_CERT DEPTH_ZERO_SELF_SIGNED_CERT",
        );
      }
    });

    test("plain http works on auto and 1.1, in a session without TLS", async () => {
      const pool = new F402FetchSessionPool({
        warm: () => {},
        httpVersion: "1.1",
      });
      const res = await pool.fetch(`${h1PlainBase}/p`);
      expect(await res.json()).toEqual({ path: "/p" });
      expect(pool.origins()).toEqual([h1PlainBase]);
      pool.closeIdle();
      expect(await runClient("auto", `${h1PlainBase}/q`)).toBe(
        '200 {"path":"/q"}',
      );
    });

    test("Bun contract: protocol http2 on http: fails with HTTP2Unsupported (no h2c)", async () => {
      using session = new Bun.FetchSession({});
      const error = await session
        .fetch(`${h1PlainBase}/x`, { protocol: "http2" })
        .catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("HTTP2Unsupported");
    });

    test("Bun contract: Response does not expose the negotiated HTTP version", async () => {
      using session = new Bun.FetchSession({});
      const res = await session.fetch(`${h1PlainBase}/x`);
      await res.arrayBuffer();
      const names = new Set<string>([
        ...Object.keys(res),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(res)),
      ]);
      for (const name of [
        "httpVersion",
        "protocol",
        "alpnProtocol",
        "nextHopProtocol",
      ]) {
        expect(names.has(name)).toBe(false);
      }
    });
  },
);
