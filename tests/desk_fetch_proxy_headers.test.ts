import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  fetchWithProxyPolicy,
  type R2Proxy,
  R2ProxyConfigError,
  type R2ProxyConfigErrorReason,
  R2ProxyUrlError,
  resolveR2Proxy,
  toR2ProxyConfigError,
} from "../lib/desk_fetch_proxy.ts";
import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";
import type {
  ProxyHeaderCase,
  ProxyHeaderProbe,
} from "./support/proxy_headers_child.ts";
import { createTlsFixture, type TlsFixture } from "./support/tls_fixture.ts";

const PROXY_URL = "http://127.0.0.1:3128";
const SECRET = "Bearer do-not-echo-0451";

function configError(headers: unknown): R2ProxyConfigError {
  try {
    resolveR2Proxy({ url: PROXY_URL, headers } as R2Proxy);
  } catch (error) {
    if (error instanceof R2ProxyConfigError) return error;
    throw error;
  }
  throw new Error("expected R2ProxyConfigError");
}

describe("R2Proxy header validation", () => {
  const rejected: Array<[string, unknown, R2ProxyConfigErrorReason]> = [
    ["space in name", { [`bad name ${SECRET}`]: "x" }, "header-name"],
    [
      "colon in name",
      { [`Proxy-Authorization: ${SECRET}`]: "x" },
      "header-name",
    ],
    ["empty name", { "": SECRET }, "header-name"],
    ["non-ASCII name", { "X-Bad\u00e9": SECRET }, "header-name"],
    [
      "CRLF in value",
      { "X-Proxy-Region": `${SECRET}\r\nX-Injected: 1` },
      "header-value-crlf",
    ],
    [
      "bare LF in value",
      { "X-Proxy-Region": `${SECRET}\nX` },
      "header-value-crlf",
    ],
    [
      "bare CR in value",
      { "X-Proxy-Region": `${SECRET}\rX` },
      "header-value-crlf",
    ],
    [
      "NUL in value",
      { "X-Proxy-Region": `${SECRET}\u0000` },
      "header-value-non-ascii",
    ],
    [
      "DEL in value",
      { "X-Proxy-Region": `${SECRET}\u007f` },
      "header-value-non-ascii",
    ],
    [
      "Latin-1 value",
      { "X-Proxy-Region": `${SECRET}\u00e9` },
      "header-value-non-ascii",
    ],
    [
      "non-Latin-1 value",
      { "Proxy-Authorization": `${SECRET}\u20ac` },
      "header-value-non-ascii",
    ],
    ["non-string value", { "X-Proxy-Region": 1 }, "header-value-type"],
    [
      "case-insensitive duplicate",
      { "Proxy-Authorization": SECRET, "proxy-authorization": SECRET },
      "header-duplicate",
    ],
    [
      "Headers instance",
      new Headers({ "Proxy-Authorization": SECRET }),
      "headers-shape",
    ],
    ["array of pairs", [["Proxy-Authorization", SECRET]], "headers-shape"],
    ["Map", new Map([["Proxy-Authorization", SECRET]]), "headers-shape"],
    ["null", null, "headers-shape"],
    ["string", SECRET, "headers-shape"],
  ];

  for (const [label, headers, reason] of rejected) {
    test(`${label} -> ${reason}, value never echoed`, () => {
      const error = configError(headers);
      expect(error.name).toBe("R2ProxyConfigError");
      expect(error.code).toBe("ERR_R2_PROXY_CONFIG");
      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain("do-not-echo");
      expect(error.cause).toBeUndefined();
      expect(
        JSON.stringify({ ...error, message: error.message }),
      ).not.toContain("do-not-echo");
    });
  }

  test("an invalid name is reported by position only", () => {
    const error = configError({ "X-Ok": "1", "bad name": "x" });
    expect(error.index).toBe(1);
    expect(error.header).toBeNull();
    expect(error.message).not.toContain("bad name");
  });

  test("a bad value names its (valid) header and position", () => {
    const error = configError({ "X-Ok": "1", "X-Proxy-Region": "a\r\nb" });
    expect(error.index).toBe(1);
    expect(error.header).toBe("X-Proxy-Region");
  });

  test("valid object headers are accepted and copied; tab and padding pass through", () => {
    const headers = {
      "Proxy-Authorization": "Bearer ok",
      "X-Proxy-Region": "a\tb",
      "X-Pad": "  desk  ",
      "X-Token-Chars": "!#$%&'*+-.^_`|~",
    };
    const resolved = resolveR2Proxy({ url: PROXY_URL, headers });
    expect(resolved).toEqual({ url: `${PROXY_URL}/`, headers });
    expect(resolved === false ? null : resolved.headers).not.toBe(headers);
  });

  test("empty and null-prototype objects are accepted", () => {
    expect(resolveR2Proxy({ url: PROXY_URL, headers: {} })).toEqual({
      url: `${PROXY_URL}/`,
      headers: {},
    });
    const bare = Object.assign(Object.create(null) as Record<string, string>, {
      "Proxy-Authorization": "Bearer ok",
    });
    expect(resolveR2Proxy({ url: PROXY_URL, headers: bare })).toEqual({
      url: `${PROXY_URL}/`,
      headers: { "Proxy-Authorization": "Bearer ok" },
    });
  });

  test("URL credentials are still rejected before headers are looked at", () => {
    const url = new URL(PROXY_URL);
    url.username = "desk";
    url.password = "hunter2";
    expect(() =>
      resolveR2Proxy({ url: url.href, headers: { "bad name": "x" } }),
    ).toThrow(R2ProxyUrlError);
  });

  test("R2S3Client refuses invalid proxy headers at construction", () => {
    expect(() =>
      R2S3Client.fromOptions(
        {
          bucket: "bucket",
          endpoint: "https://localhost:1",
          accessKeyId: "a",
          secretAccessKey: "s",
          publicBase: "https://pub.test",
          proxy: { url: PROXY_URL, headers: { "X-Proxy-Region": "a\r\nb" } },
        },
        {} as R2S3ClientBackend,
      ),
    ).toThrow(R2ProxyConfigError);
  });
});

describe("Bun header TypeErrors become R2ProxyConfigError", () => {
  const headers = { "X-Proxy-Region": "desk" };

  test("a Bun rejection naming a proxy header is wrapped without the original message", async () => {
    const bun = new TypeError("Header 'x-proxy-region' has invalid value");
    const wrapped = toR2ProxyConfigError(bun, headers);
    expect(wrapped).toBeInstanceOf(R2ProxyConfigError);
    expect((wrapped as R2ProxyConfigError).reason).toBe("runtime");
    expect((wrapped as R2ProxyConfigError).cause).toBeUndefined();
    await expect(
      fetchWithProxyPolicy(
        async () => {
          throw new TypeError("Invalid header name: 'X-Proxy-Region'");
        },
        "https://localhost:1/",
        {},
        { url: PROXY_URL, headers },
      ),
    ).rejects.toBeInstanceOf(R2ProxyConfigError);
  });

  test("header TypeErrors about request headers, or without proxy headers, pass through", () => {
    const requestHeader = new TypeError(
      "Header 'authorization' has invalid value",
    );
    expect(toR2ProxyConfigError(requestHeader, headers)).toBe(requestHeader);
    expect(toR2ProxyConfigError(requestHeader, undefined)).toBe(requestHeader);
    const other = new TypeError("fetch failed");
    expect(toR2ProxyConfigError(other, headers)).toBe(other);
    const plain = new Error("Header 'x-proxy-region' has invalid value");
    expect(toR2ProxyConfigError(plain, headers)).toBe(plain);
  });
});

let fixture: TlsFixture | null = null;
const probes = new Map<ProxyHeaderCase, ProxyHeaderProbe>();

async function runProbe(name: ProxyHeaderCase): Promise<ProxyHeaderProbe> {
  if (fixture === null) throw new Error("no TLS fixture");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined && !/proxy/i.test(key)) env[key] = value;
  }
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "support", "proxy_headers_child.ts"),
      name,
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
  if (code !== 0) throw new Error(`probe ${name} exited ${code}: ${stderr}`);
  return JSON.parse(stdout) as ProxyHeaderProbe;
}

const CASES: ProxyHeaderCase[] = [
  "object",
  "invalid-name",
  "invalid-name-with-auth",
  "crlf-value",
  "lf-value",
  "nul-value",
  "del-value",
  "latin1-value",
  "non-latin1-value",
  "padded-value",
  "headers-instance",
  "array",
  "array-invalid-name",
  "duplicate-object",
  "duplicate-headers",
  "duplicate-array",
  "empty-object",
  "empty-headers",
  "empty-array",
  "env-proxy",
  "env-proxy-userinfo",
  "url-userinfo-and-header",
  "policy-invalid-name",
];

beforeAll(async () => {
  fixture = await createTlsFixture("localhost");
  if (fixture === null) return;
  const results = await Promise.all(CASES.map(runProbe));
  CASES.forEach((name, i) => {
    const result = results[i];
    if (result !== undefined) probes.set(name, result);
  });
});

afterAll(() => fixture?.cleanup());

function probe(name: ProxyHeaderCase): ProxyHeaderProbe | null {
  if (fixture === null) return null;
  const result = probes.get(name);
  if (result === undefined) throw new Error(`no probe result for ${name}`);
  return result;
}

const BUN_CONNECT_HEADERS = new Set(["proxy-connection", "host"]);
const connectExtras = (p: ProxyHeaderProbe) =>
  p.connectHeaders.filter(
    ([name]) => !BUN_CONNECT_HEADERS.has(name.toLowerCase()),
  );

function expectRejectedBeforeConnect(
  name: ProxyHeaderCase,
  message: string,
): void {
  const p = probe(name);
  if (p === null) return;
  expect(p.thrown).toEqual({ name: "TypeError", code: null, message });
  expect(p.connects).toBe(0);
  expect(p.status).toBeNull();
}

function expectTunnel(
  name: ProxyHeaderCase,
  extras: Array<[string, string]>,
): void {
  const p = probe(name);
  if (p === null) return;
  expect(p.thrown).toBeNull();
  expect(p.status).toBe(200);
  expect(p.connects).toBe(1);
  expect(connectExtras(p)).toEqual(extras);
  expect(p.targetProxyAuthorization).toBeNull();
}

describe(`Bun ${Bun.version} proxy.headers pins (one process per case)`, () => {
  test("object headers go on CONNECT only, after Host and Proxy-Connection", () => {
    expectTunnel("object", [
      ["Proxy-Authorization", "Bearer probe-token"],
      ["X-Proxy-Region", "desk"],
    ]);
    const p = probe("object");
    if (p === null) return;
    expect(p.connectHeaders.map(([name]) => name)).toEqual([
      "Host",
      "Proxy-Connection",
      "Proxy-Authorization",
      "X-Proxy-Region",
    ]);
  });

  test("an invalid name rejects with a bare TypeError before any CONNECT", () => {
    expectRejectedBeforeConnect(
      "invalid-name",
      "Invalid header name: 'bad name'",
    );
  });

  test("one invalid entry rejects the whole fetch; Proxy-Authorization is not sent without it", () => {
    expectRejectedBeforeConnect(
      "invalid-name-with-auth",
      "Invalid header name: 'X-Bad\u00e9'",
    );
  });

  test("CR/LF and NUL in a value reject before CONNECT; the message names the header, never the value", () => {
    for (const name of ["crlf-value", "lf-value", "nul-value"] as const) {
      expectRejectedBeforeConnect(
        name,
        "Header 'X-Proxy-Region' has invalid value",
      );
    }
  });

  test("DEL passes through raw", () => {
    expectTunnel("del-value", [["X-Proxy-Region", "a\u007fb"]]);
  });

  test("a Latin-1 value is sent as one raw byte, a non-Latin-1 value rejects", () => {
    expectTunnel("latin1-value", [["X-Proxy-Region", "caf\u00e9"]]);
    expectRejectedBeforeConnect(
      "non-latin1-value",
      "Header 'X-Proxy-Region' has invalid value",
    );
  });

  test("leading and trailing spaces are trimmed", () => {
    expectTunnel("padded-value", [["X-Proxy-Region", "desk"]]);
  });

  test("Headers instances and arrays are accepted by Bun like objects", () => {
    expectTunnel("headers-instance", [
      ["Proxy-Authorization", "Bearer probe-token"],
    ]);
    expectTunnel("array", [["Proxy-Authorization", "Bearer probe-token"]]);
    expectRejectedBeforeConnect(
      "array-invalid-name",
      "Invalid header name: 'bad name'",
    );
  });

  test("duplicate Proxy-Authorization is merged into one comma-joined line in every form", () => {
    const merged: Array<[string, string]> = [
      ["Proxy-Authorization", "Bearer a, Bearer b"],
    ];
    expectTunnel("duplicate-object", merged);
    expectTunnel("duplicate-headers", merged);
    expectTunnel("duplicate-array", merged);
  });

  test("empty headers send a CONNECT with only Bun's own headers", () => {
    for (const name of [
      "empty-object",
      "empty-headers",
      "empty-array",
    ] as const) {
      expectTunnel(name, []);
    }
  });

  test("env HTTPS_PROXY adds no headers; its userinfo becomes Basic Proxy-Authorization", () => {
    expectTunnel("env-proxy", []);
    expectTunnel("env-proxy-userinfo", [
      ["Proxy-Authorization", `Basic ${btoa("u:p")}`],
    ]);
  });

  test("explicit Proxy-Authorization wins over URL userinfo", () => {
    expectTunnel("url-userinfo-and-header", [
      ["Proxy-Authorization", "Bearer probe-token"],
    ]);
  });

  test("fetchWithProxyPolicy rejects invalid headers with R2ProxyConfigError and no CONNECT", () => {
    const p = probe("policy-invalid-name");
    if (p === null) return;
    expect(p.thrown).toEqual({
      name: "R2ProxyConfigError",
      code: "ERR_R2_PROXY_CONFIG",
      message: "proxy header name is not an HTTP token (entry 0)",
    });
    expect(p.connects).toBe(0);
  });
});
