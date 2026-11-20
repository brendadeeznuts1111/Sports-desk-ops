/**
 * @file tests/bun_websocket_options.test.ts
 * @description Measured `Bun.WebSocketOptions` contract across `protocols`/`protocol`, `headers`,
 * `perMessageDeflate`, `tls` (`ca`, `rejectUnauthorized`, `servername`, `checkServerIdentity`), and
 * HTTP/HTTPS `proxy` tunneling (`proxy.tls` isolation).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: websocket-client-options

interface ProbeResult {
  readonly ok: boolean;
  readonly protocol?: string;
  readonly reply?: string;
  readonly err?: string;
  readonly targetHeaders: Record<string, string>;
}

interface CaAndLeaf {
  readonly caKey: string;
  readonly caCert: string;
  readonly leafKey: string;
  readonly leafCert: string;
}

interface ProxyInstance {
  readonly listener: Bun.TCPSocketListener<ProxyClientState>;
  readonly requests: { readonly head: string }[];
}

interface ProxyClientState {
  buf: Buffer;
  upgraded: boolean;
  upstream: Bun.Socket<undefined> | null;
  pending: Uint8Array[];
}

let tmpDir = "";
let targetPki: CaAndLeaf;
let targetSniLeaf: { readonly leafKey: string; readonly leafCert: string };
let proxyPki: CaAndLeaf;

let wsPlainServer: Bun.Server<undefined>;
let wssIpServer: Bun.Server<undefined>;
let wssSniServer: Bun.Server<undefined>;
let httpProxyServer: ProxyInstance;
let httpsProxyServer: ProxyInstance;

let lastTargetHeaders: Record<string, string> = {};

function runOpenSsl(cwd: string, args: readonly string[]): void {
  const res = Bun.spawnSync(["openssl", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `openssl ${args[0] ?? ""} failed (${res.exitCode}): ${res.stderr.toString()}`,
    );
  }
}

function makeCaAndLeaf(
  cwd: string,
  prefix: string,
  cn: string,
  san: string,
): CaAndLeaf {
  const caKey = join(cwd, `${prefix}-ca.key`);
  const caCert = join(cwd, `${prefix}-ca.pem`);
  const leafKey = join(cwd, `${prefix}-leaf.key`);
  const leafCsr = join(cwd, `${prefix}-leaf.csr`);
  const leafCert = join(cwd, `${prefix}-leaf.pem`);
  const ext = join(cwd, `${prefix}-ext.cnf`);

  runOpenSsl(cwd, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCert,
    "-days",
    "1",
    "-subj",
    `/CN=${prefix}-ca`,
  ]);
  runOpenSsl(cwd, [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    leafKey,
    "-out",
    leafCsr,
    "-subj",
    `/CN=${cn}`,
  ]);
  writeFileSync(
    ext,
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  );
  runOpenSsl(cwd, [
    "x509",
    "-req",
    "-in",
    leafCsr,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    leafCert,
    "-days",
    "1",
    "-extfile",
    ext,
  ]);
  return { caKey, caCert, leafKey, leafCert };
}

function makeLeafFromCa(
  cwd: string,
  caCert: string,
  caKey: string,
  prefix: string,
  cn: string,
  san: string,
): { readonly leafKey: string; readonly leafCert: string } {
  const leafKey = join(cwd, `${prefix}-leaf.key`);
  const leafCsr = join(cwd, `${prefix}-leaf.csr`);
  const leafCert = join(cwd, `${prefix}-leaf.pem`);
  const ext = join(cwd, `${prefix}-ext.cnf`);

  runOpenSsl(cwd, [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    leafKey,
    "-out",
    leafCsr,
    "-subj",
    `/CN=${cn}`,
  ]);
  writeFileSync(
    ext,
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  );
  runOpenSsl(cwd, [
    "x509",
    "-req",
    "-in",
    leafCsr,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    leafCert,
    "-days",
    "1",
    "-extfile",
    ext,
  ]);
  return { leafKey, leafCert };
}

function startEchoServer(tls?: {
  key: string;
  cert: string;
}): Bun.Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...(tls ? { tls } : {}),
    fetch(req, server) {
      lastTargetHeaders = Object.fromEntries(req.headers.entries());
      const protoHeader = req.headers.get("sec-websocket-protocol");
      const chosen = protoHeader?.split(",")[0]?.trim();
      const upgraded = server.upgrade(
        req,
        chosen ? { headers: { "Sec-WebSocket-Protocol": chosen } } : undefined,
      );
      return upgraded
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, msg) {
        ws.send(`ok:${String(msg)}`);
      },
    },
  });
}

function startConnectProxy(tls?: { key: string; cert: string }): ProxyInstance {
  const requests: { readonly head: string }[] = [];
  const listener = Bun.listen<ProxyClientState>({
    hostname: "127.0.0.1",
    port: 0,
    ...(tls ? { tls } : {}),
    socket: {
      open(sock) {
        sock.data = {
          buf: Buffer.alloc(0),
          upgraded: false,
          upstream: null,
          pending: [],
        };
      },
      data(sock, chunk) {
        const state = sock.data;
        if (state.upgraded) {
          if (state.upstream) {
            state.upstream.write(chunk);
          } else {
            state.pending.push(new Uint8Array(chunk));
          }
          return;
        }
        state.buf = Buffer.concat([state.buf, Buffer.from(chunk)]);
        const headerEnd = state.buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const head = state.buf.subarray(0, headerEnd).toString("latin1");
        const rest = state.buf.subarray(headerEnd + 4);
        requests.push({ head });

        const requestLine = head.split("\r\n")[0] ?? "";
        const target = requestLine.split(" ")[1] ?? "";
        const colon = target.lastIndexOf(":");
        const port = Number(colon === -1 ? "0" : target.slice(colon + 1));

        state.upgraded = true;
        if (rest.length > 0) {
          state.pending.push(new Uint8Array(rest));
        }

        Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(up) {
              state.upstream = up;
              sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
              for (const queued of state.pending) {
                up.write(queued);
              }
              state.pending = [];
            },
            data(_up, upChunk) {
              sock.write(upChunk);
            },
            close() {
              sock.end();
            },
            error() {
              sock.end();
            },
          },
        }).catch(() => {
          sock.end();
        });
      },
      close(sock) {
        sock.data?.upstream?.end();
      },
      error(sock) {
        sock.data?.upstream?.end();
      },
    },
  });
  return { listener, requests };
}

async function openAndEcho(
  url: string | URL,
  opts?: Bun.WebSocketOptions,
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const ws =
      opts === undefined ? new WebSocket(url) : new WebSocket(url, opts);
    const timer = setTimeout(() => {
      ws.close();
      finish({
        ok: false,
        err: "timeout",
        targetHeaders: { ...lastTargetHeaders },
      });
    }, 3_000);

    ws.addEventListener("open", () => {
      ws.send("ping-msg");
    });
    ws.addEventListener("message", (ev) => {
      const reply = String(ev.data);
      const protocol = ws.protocol;
      ws.close();
      finish({
        ok: true,
        protocol,
        reply,
        targetHeaders: { ...lastTargetHeaders },
      });
    });
    ws.addEventListener("error", (ev) => {
      const errMsg = (ev as ErrorEvent).message || "error";
      finish({ ok: false, err: errMsg, targetHeaders: {} });
    });
    ws.addEventListener("close", (ev) => {
      finish({
        ok: false,
        err: `close:${ev.code}:${ev.reason}`,
        targetHeaders: {},
      });
    });
  });
}

function mustPort(port: number | undefined): number {
  if (port === undefined) {
    throw new Error("Expected bound port");
  }
  return port;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bun-ws-opts-"));
  targetPki = makeCaAndLeaf(
    tmpDir,
    "target",
    "ws-target.local",
    "DNS:ws-target.local,IP:127.0.0.1",
  );
  targetSniLeaf = makeLeafFromCa(
    tmpDir,
    targetPki.caCert,
    targetPki.caKey,
    "target-sni",
    "sni-alias.local",
    "DNS:sni-alias.local",
  );
  proxyPki = makeCaAndLeaf(
    tmpDir,
    "proxy",
    "proxy.local",
    "DNS:proxy.local,IP:127.0.0.1",
  );

  wsPlainServer = startEchoServer();
  wssIpServer = startEchoServer({
    key: readFileSync(targetPki.leafKey, "utf8"),
    cert: readFileSync(targetPki.leafCert, "utf8"),
  });
  wssSniServer = startEchoServer({
    key: readFileSync(targetSniLeaf.leafKey, "utf8"),
    cert: readFileSync(targetSniLeaf.leafCert, "utf8"),
  });
  httpProxyServer = startConnectProxy();
  httpsProxyServer = startConnectProxy({
    key: readFileSync(proxyPki.leafKey, "utf8"),
    cert: readFileSync(proxyPki.leafCert, "utf8"),
  });
});

afterAll(() => {
  wsPlainServer?.stop(true);
  wssIpServer?.stop(true);
  wssSniServer?.stop(true);
  httpProxyServer?.listener.stop(true);
  httpsProxyServer?.listener.stop(true);
  if (tmpDir.length > 0) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("Bun.WebSocketOptions: protocols, headers, and compression", () => {
  test("accepts URL instances and honors protocols array/string, protocol, and precedence", async () => {
    const wsUrl = `ws://127.0.0.1:${mustPort(wsPlainServer.port)}/chat`;

    const arrRes = await openAndEcho(new URL(wsUrl), {
      protocols: ["p1", "p2"],
    });
    expect(arrRes.ok).toBe(true);
    expect(arrRes.protocol).toBe("p1");
    expect(arrRes.reply).toBe("ok:ping-msg");
    expect(arrRes.targetHeaders["sec-websocket-protocol"]).toBe("p1, p2");

    const strRes = await openAndEcho(wsUrl, { protocols: "single-p" });
    expect(strRes.ok).toBe(true);
    expect(strRes.protocol).toBe("single-p");
    expect(strRes.targetHeaders["sec-websocket-protocol"]).toBe("single-p");

    const soloRes = await openAndEcho(wsUrl, { protocol: "solo-p" });
    expect(soloRes.ok).toBe(true);
    expect(soloRes.protocol).toBe("solo-p");
    expect(soloRes.targetHeaders["sec-websocket-protocol"]).toBe("solo-p");

    const bothRes = await openAndEcho(wsUrl, {
      protocols: ["arr-p"],
      protocol: "str-p",
    } as unknown as Bun.WebSocketOptions);
    expect(bothRes.ok).toBe(true);
    expect(bothRes.protocol).toBe("arr-p");
    expect(bothRes.targetHeaders["sec-websocket-protocol"]).toBe("arr-p");
  });

  test("forwards headers from OutgoingHttpHeaders objects, Headers instances, and tuples", async () => {
    const wsUrl = `ws://127.0.0.1:${mustPort(wsPlainServer.port)}/headers`;

    const objRes = await openAndEcho(wsUrl, {
      headers: {
        "X-Custom": "abc",
        "X-Arr": ["1", "2"],
        Cookie: "a=b",
      },
    });
    expect(objRes.ok).toBe(true);
    expect(objRes.targetHeaders["x-custom"]).toBe("abc");
    expect(objRes.targetHeaders["x-arr"]).toBe("1,2");
    expect(objRes.targetHeaders.cookie).toBe("a=b");

    const instRes = await openAndEcho(wsUrl, {
      headers: new Headers([["x-h", "v1"]]),
    });
    expect(instRes.ok).toBe(true);
    expect(instRes.targetHeaders["x-h"]).toBe("v1");

    const tupRes = await openAndEcho(wsUrl, {
      headers: [
        ["X-Tup", "t1"],
        ["X-Tup", "t2"],
      ],
    });
    expect(tupRes.ok).toBe(true);
    expect(tupRes.targetHeaders["x-tup"]).toBe("t1, t2");
  });

  test("perMessageDeflate advertises extension by default and suppresses it on any falsy value", async () => {
    const wsUrl = `ws://127.0.0.1:${mustPort(wsPlainServer.port)}/deflate`;

    const omitted = await openAndEcho(wsUrl);
    expect(omitted.targetHeaders["sec-websocket-extensions"]).toBe(
      "permessage-deflate; client_max_window_bits",
    );

    const emptyOpts = await openAndEcho(wsUrl, {});
    expect(emptyOpts.targetHeaders["sec-websocket-extensions"]).toBe(
      "permessage-deflate; client_max_window_bits",
    );

    const explicitTrue = await openAndEcho(wsUrl, { perMessageDeflate: true });
    expect(explicitTrue.targetHeaders["sec-websocket-extensions"]).toBe(
      "permessage-deflate; client_max_window_bits",
    );

    const falsyCases: readonly unknown[] = [
      { perMessageDeflate: false },
      { perMessageDeflate: null },
      { perMessageDeflate: 0 },
      { perMessageDeflate: "" },
      { perMessageDeflate: undefined },
    ];
    for (const falsyOpts of falsyCases) {
      const res = await openAndEcho(wsUrl, falsyOpts as Bun.WebSocketOptions);
      expect(res.ok).toBe(true);
      expect(res.targetHeaders["sec-websocket-extensions"]).toBeUndefined();
    }
  });
});

describe("Bun.WebSocketOptions: TLS and checkServerIdentity", () => {
  test("verifies ca inputs, rejectUnauthorized, servername/serverName, and checkServerIdentity", async () => {
    const ipUrl = `wss://127.0.0.1:${mustPort(wssIpServer.port)}/ws`;
    const sniUrl = `wss://127.0.0.1:${mustPort(wssSniServer.port)}/ws`;

    const untrusted = await openAndEcho(ipUrl);
    expect(untrusted.ok).toBe(false);
    expect(untrusted.err).toContain("unable to verify the first certificate");

    const caFile = await openAndEcho(ipUrl, {
      tls: { ca: Bun.file(targetPki.caCert) },
    });
    expect(caFile.ok).toBe(true);
    expect(caFile.reply).toBe("ok:ping-msg");

    const caBuf = await openAndEcho(ipUrl, {
      tls: { ca: readFileSync(targetPki.caCert) },
    });
    expect(caBuf.ok).toBe(true);

    const caStr = await openAndEcho(ipUrl, {
      tls: { ca: readFileSync(targetPki.caCert, "utf8") },
    });
    expect(caStr.ok).toBe(true);

    const unauthFalse = await openAndEcho(ipUrl, {
      tls: { rejectUnauthorized: false },
    });
    expect(unauthFalse.ok).toBe(true);

    const sniMismatch = await openAndEcho(sniUrl, {
      tls: { ca: Bun.file(targetPki.caCert) },
    });
    expect(sniMismatch.ok).toBe(false);
    expect(sniMismatch.err).toContain("does not match certificate's altnames");

    const lowerSni = await openAndEcho(sniUrl, {
      tls: { ca: Bun.file(targetPki.caCert), servername: "sni-alias.local" },
    });
    expect(lowerSni.ok).toBe(true);

    const camelSni = await openAndEcho(sniUrl, {
      tls: { ca: Bun.file(targetPki.caCert), serverName: "sni-alias.local" },
    });
    expect(camelSni.ok).toBe(true);

    let capturedHostname = "";
    let capturedCn: string | string[] | undefined;
    let capturedSan: string | undefined;
    let hadIssuerCert = true;
    const csiAllow = await openAndEcho(sniUrl, {
      tls: {
        ca: Bun.file(targetPki.caCert),
        checkServerIdentity(hostname, cert) {
          capturedHostname = hostname;
          capturedCn = cert.subject?.CN;
          capturedSan = cert.subjectaltname;
          hadIssuerCert = "issuerCertificate" in cert;
          return undefined;
        },
      },
    });
    expect(csiAllow.ok).toBe(true);
    expect(capturedHostname).toBe("127.0.0.1");
    expect(capturedCn).toBe("sni-alias.local");
    expect(capturedSan).toBe("DNS:sni-alias.local");
    expect(hadIssuerCert).toBe(false);

    const csiDeny = await openAndEcho(ipUrl, {
      tls: {
        ca: Bun.file(targetPki.caCert),
        checkServerIdentity: () => new Error("custom-deny"),
      },
    });
    expect(csiDeny.ok).toBe(false);

    const csiAsyncReject = await openAndEcho(ipUrl, {
      tls: {
        ca: Bun.file(targetPki.caCert),
        checkServerIdentity: (async () => undefined) as unknown as NonNullable<
          NonNullable<Bun.WebSocketOptionsTLS["tls"]>["checkServerIdentity"]
        >,
      },
    });
    expect(csiAsyncReject.ok).toBe(false);

    let ranUnderRejectFalse = false;
    const csiUnderRejectFalse = await openAndEcho(ipUrl, {
      tls: {
        ca: Bun.file(targetPki.caCert),
        rejectUnauthorized: false,
        checkServerIdentity() {
          ranUnderRejectFalse = true;
          return new Error("ignored");
        },
      },
    });
    expect(csiUnderRejectFalse.ok).toBe(true);
    expect(ranUnderRejectFalse).toBe(true);
  });
});

describe("Bun.WebSocketOptions: HTTP and HTTPS proxy tunneling", () => {
  test("tunnels ws:// and wss:// via HTTP CONNECT with URLs, credentials, and proxy-only headers", async () => {
    const proxyPort = mustPort(httpProxyServer.listener.port);
    const httpProxyUrl = `http://127.0.0.1:${proxyPort}`;
    const wsHostUrl = `ws://ws-target.local:${mustPort(wsPlainServer.port)}/ws`;
    const wssHostUrl = `wss://ws-target.local:${mustPort(wssIpServer.port)}/ws`;

    const plainViaProxy = await openAndEcho(wsHostUrl, { proxy: httpProxyUrl });
    expect(plainViaProxy.ok).toBe(true);
    expect(httpProxyServer.requests.at(-1)?.head).toContain(
      `CONNECT ws-target.local:${mustPort(wsPlainServer.port)} HTTP/1.1`,
    );

    const wssViaProxyStr = await openAndEcho(wssHostUrl, {
      proxy: httpProxyUrl,
      tls: { ca: Bun.file(targetPki.caCert) },
    });
    expect(wssViaProxyStr.ok).toBe(true);
    expect(httpProxyServer.requests.at(-1)?.head).toContain(
      `CONNECT ws-target.local:${mustPort(wssIpServer.port)} HTTP/1.1`,
    );

    const wssViaProxyUrl = await openAndEcho(wssHostUrl, {
      proxy: new URL(httpProxyUrl),
      tls: { ca: Bun.file(targetPki.caCert) },
    });
    expect(wssViaProxyUrl.ok).toBe(true);

    const credsViaProxy = await openAndEcho(wssHostUrl, {
      proxy: `http://alice:s3cr3t@127.0.0.1:${proxyPort}`,
      tls: { ca: Bun.file(targetPki.caCert) },
    });
    expect(credsViaProxy.ok).toBe(true);
    expect(httpProxyServer.requests.at(-1)?.head).toContain(
      "Proxy-Authorization: Basic YWxpY2U6czNjcjN0",
    );

    const objHdrsRes = await openAndEcho(wssHostUrl, {
      proxy: {
        url: httpProxyUrl,
        headers: {
          "Proxy-Authorization": "Bearer tok1",
          "X-Proxy-Only": "p1",
        },
      },
      tls: { ca: Bun.file(targetPki.caCert) },
    });
    expect(objHdrsRes.ok).toBe(true);
    const objHead = httpProxyServer.requests.at(-1)?.head ?? "";
    expect(objHead).toContain("Proxy-Authorization: Bearer tok1");
    expect(objHead).toContain("X-Proxy-Only: p1");
    expect(objHdrsRes.targetHeaders["proxy-authorization"]).toBeUndefined();
    expect(objHdrsRes.targetHeaders["x-proxy-only"]).toBeUndefined();

    const headersInstRes = await openAndEcho(wssHostUrl, {
      proxy: {
        url: new URL(httpProxyUrl),
        headers: new Headers({ "Proxy-Authorization": "Bearer tok2" }),
      },
      tls: { ca: Bun.file(targetPki.caCert) },
    });
    expect(headersInstRes.ok).toBe(true);
    expect(httpProxyServer.requests.at(-1)?.head).toContain(
      "Proxy-Authorization: Bearer tok2",
    );
  });

  test("enforces HTTPS proxy.tls isolation and shared CA fallback semantics", async () => {
    const httpsProxyUrl = `https://127.0.0.1:${mustPort(httpsProxyServer.listener.port)}`;
    const wssHostUrl = `wss://ws-target.local:${mustPort(wssIpServer.port)}/ws`;

    const seenCsi: string[] = [];
    const separateRes = await openAndEcho(wssHostUrl, {
      proxy: {
        url: httpsProxyUrl,
        tls: {
          ca: Bun.file(proxyPki.caCert),
          checkServerIdentity(hostname, cert) {
            seenCsi.push(`proxy:${hostname}:${cert.subject?.CN}`);
            return undefined;
          },
        },
      },
      tls: {
        ca: Bun.file(targetPki.caCert),
        checkServerIdentity(hostname, cert) {
          seenCsi.push(`target:${hostname}:${cert.subject?.CN}`);
          return undefined;
        },
      },
    });
    expect(separateRes.ok).toBe(true);
    expect(seenCsi).toEqual([
      "proxy:127.0.0.1:proxy.local",
      "target:ws-target.local:ws-target.local",
    ]);

    const seenSharedCsi: string[] = [];
    const bothCas = [
      readFileSync(targetPki.caCert),
      readFileSync(proxyPki.caCert),
    ];
    const sharedRes = await openAndEcho(wssHostUrl, {
      proxy: httpsProxyUrl,
      tls: {
        ca: bothCas,
        checkServerIdentity(hostname, cert) {
          seenSharedCsi.push(`top:${hostname}:${cert.subject?.CN}`);
          return undefined;
        },
      },
    });
    expect(sharedRes.ok).toBe(true);
    expect(seenSharedCsi).toEqual(["top:ws-target.local:ws-target.local"]);

    const emptyIsoRes = await openAndEcho(wssHostUrl, {
      proxy: { url: httpsProxyUrl, tls: {} },
      tls: { ca: bothCas },
    });
    expect(emptyIsoRes.ok).toBe(false);
    expect(emptyIsoRes.err).toContain("unable to verify the first certificate");

    const trueIsoRes = await openAndEcho(wssHostUrl, {
      proxy: { url: httpsProxyUrl, tls: true },
      tls: { ca: bothCas },
    });
    expect(trueIsoRes.ok).toBe(false);
    expect(trueIsoRes.err).toContain("unable to verify the first certificate");
  });
});
