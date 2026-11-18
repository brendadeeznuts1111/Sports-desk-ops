import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { F402FetchSessionPool } from "../lib/f402_fetch_sessions.ts";
import {
  applyF402NetOptions,
  applyHostOverride,
  assertBunNetworkEnv,
  BUN_DISABLE_IPV4_ENV,
  BUN_DISABLE_IPV6_ENV,
  BUN_DNS_TTL_ENV,
  bunNetworkEnvChanges,
  effectiveBunDnsTtlSeconds,
  effectiveBunFamily,
  F402_ALLOWED_HOSTS,
  F402BunLaunchEnvError,
  F402_DNS_CACHE_TTL_ENV,
  F402_DNS_PREFETCH_ENV,
  F402_HOST_ENV,
  F402_IP_FAMILY_ENV,
  type F402NetOptions,
  F402NetOptionsError,
  f402NetReport,
  isF402LoopbackHost,
  parseF402Host,
  resolveF402NetOptions,
} from "../lib/f402_net_options.ts";
import {
  F402PullerError,
  resolveF402PortalOrigin,
} from "../lib/f402_readonly_puller.ts";
import {
  alpnWireFormat,
  probeTls,
  PROBE_TLS_DEFAULT_ALPN,
} from "../lib/tls_provenance.ts";
import {
  ProbeUsageError,
  parseProbeArgs,
} from "../scripts/capture/probe_f402_protocol_matrix.ts";

const root = join(import.meta.dir, "..");

function opts(partial: Partial<F402NetOptions> = {}): F402NetOptions {
  return {
    host: null,
    dnsPrefetch: true,
    dnsCacheTtlSeconds: null,
    family: "auto",
    httpVersion: "auto",
    verbose: false,
    ...partial,
  };
}

describe("parseF402Host", () => {
  test("accepts allowlisted hostnames and loopback literals, lowercased", () => {
    expect(parseF402Host("WWW.Fantasy402.com")).toBe("www.fantasy402.com");
    expect(parseF402Host(" cdn.fastassets.io ")).toBe("cdn.fastassets.io");
    expect(parseF402Host("fantasy402.com")).toBe("fantasy402.com");
    expect(parseF402Host("127.0.0.1")).toBe("127.0.0.1");
    expect(parseF402Host("127.9.8.7")).toBe("127.9.8.7");
    expect(parseF402Host("localhost")).toBe("localhost");
    expect(parseF402Host("[::1]")).toBe("[::1]");
  });

  test("the allowlist is the portal, its apex and its CDN", () => {
    expect([...F402_ALLOWED_HOSTS]).toEqual([
      "fantasy402.com",
      "www.fantasy402.com",
      "cdn.fastassets.io",
    ]);
  });

  test("refuses hosts off the allowlist by name, including look-alikes", () => {
    for (const bad of [
      "cdn.example",
      "evil.example",
      "fantasy402.com.evil.example",
      "evilfantasy402.com",
      "api.fantasy402.com",
      "localhost.example",
      "128.0.0.1",
      "10.0.0.1",
      "[::2]",
      "[::ffff:127.0.0.1]",
    ]) {
      expect(() => parseF402Host(bad)).toThrow(F402NetOptionsError);
      expect(() => parseF402Host(bad, "F402_HOST")).toThrow(/^F402_HOST: /);
    }
  });

  test("isF402LoopbackHost covers localhost, 127.0.0.0/8 and [::1] only", () => {
    for (const ok of ["localhost", "127.0.0.1", "127.255.255.255", "[::1]"])
      expect(isF402LoopbackHost(ok)).toBe(true);
    for (const no of [
      "127.0.0",
      "127.0.0.256",
      "::1",
      "0.0.0.0",
      "www.fantasy402.com",
    ])
      expect(isF402LoopbackHost(no)).toBe(false);
  });

  test("refuses schemes, ports, paths, credentials and junk by name", () => {
    for (const bad of [
      "",
      "https://www.fantasy402.com",
      "www.fantasy402.com:443",
      "www.fantasy402.com/cloud",
      "user@www.fantasy402.com",
      "user:pw@host",
      "host?x=1",
      "host#f",
      "a b",
      "::1",
      "[::1]:443",
      "1.2.3",
      "bücher.example",
      "a\\b",
      "%41.example",
      "x".repeat(254),
    ]) {
      expect(() => parseF402Host(bad)).toThrow(F402NetOptionsError);
    }
  });

  test("the host override keeps the base URL's scheme and port", () => {
    expect(
      applyHostOverride("https://www.fantasy402.com", "fantasy402.com"),
    ).toBe("https://fantasy402.com");
    expect(applyHostOverride("https://f402.example:8443", "127.0.0.1")).toBe(
      "https://127.0.0.1:8443",
    );
    expect(applyHostOverride("https://f402.example", null)).toBe(
      "https://f402.example",
    );
  });
});

describe("resolveF402NetOptions", () => {
  test("defaults", () => {
    expect(resolveF402NetOptions({}, {})).toEqual(opts());
  });

  test("flag beats env beats default, for every option", () => {
    const env = {
      [F402_HOST_ENV]: "fantasy402.com",
      [F402_DNS_PREFETCH_ENV]: "0",
      [F402_DNS_CACHE_TTL_ENV]: "7",
      [F402_IP_FAMILY_ENV]: "6",
      F402_HTTP_VERSION: "1.1",
    };
    expect(resolveF402NetOptions({}, env)).toEqual(
      opts({
        host: "fantasy402.com",
        dnsPrefetch: false,
        dnsCacheTtlSeconds: 7,
        family: "6",
        httpVersion: "1.1",
      }),
    );
    expect(
      resolveF402NetOptions(
        {
          host: "www.fantasy402.com",
          "dns-prefetch": true,
          "dns-cache-ttl": "0",
          family: "4",
          "http-version": "2",
          verbose: true,
        },
        env,
      ),
    ).toEqual(
      opts({
        host: "www.fantasy402.com",
        dnsPrefetch: true,
        dnsCacheTtlSeconds: 0,
        family: "4",
        httpVersion: "2",
        verbose: true,
      }),
    );
    expect(
      resolveF402NetOptions(
        { "no-dns-prefetch": true },
        { [F402_DNS_PREFETCH_ENV]: "true" },
      ).dnsPrefetch,
    ).toBe(false);
  });

  test("invalid values are named F402NetOptionsError naming the flag or env", () => {
    const cases: [Record<string, unknown>, Record<string, string>, string][] = [
      [{ "dns-prefetch": true, "no-dns-prefetch": true }, {}, "--dns-prefetch"],
      [{ "dns-cache-ttl": "off" }, {}, "--dns-cache-ttl"],
      [{ "dns-cache-ttl": "-1" }, {}, "--dns-cache-ttl"],
      [{ "dns-cache-ttl": "1.5" }, {}, "--dns-cache-ttl"],
      [{ "dns-cache-ttl": "4294967296" }, {}, "--dns-cache-ttl"],
      [{}, { [F402_DNS_CACHE_TTL_ENV]: "abc" }, F402_DNS_CACHE_TTL_ENV],
      [{ family: "5" }, {}, "--family"],
      [{ family: "ipv4" }, {}, "--family"],
      [{}, { [F402_IP_FAMILY_ENV]: "0" }, F402_IP_FAMILY_ENV],
      [{ "http-version": "h2" }, {}, "--http-version"],
      [{}, { F402_HTTP_VERSION: "3" }, "F402_HTTP_VERSION"],
      [{}, { [F402_DNS_PREFETCH_ENV]: "yes" }, F402_DNS_PREFETCH_ENV],
      [{ host: "h:1" }, {}, "--host"],
      [{}, { [F402_HOST_ENV]: "a/b" }, F402_HOST_ENV],
    ];
    for (const [values, env, option] of cases) {
      const error = (() => {
        try {
          resolveF402NetOptions(values, env);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(F402NetOptionsError);
      expect((error as F402NetOptionsError).option).toBe(option);
    }
  });
});

describe("Bun launch env for DNS TTL and family", () => {
  test("reads the effective values the way Bun does", () => {
    expect(effectiveBunDnsTtlSeconds({})).toBe(30);
    expect(effectiveBunDnsTtlSeconds({ [BUN_DNS_TTL_ENV]: "5" })).toBe(5);
    expect(effectiveBunDnsTtlSeconds({ [BUN_DNS_TTL_ENV]: "-1" })).toBe(30);
    expect(effectiveBunFamily({})).toBe("auto");
    expect(effectiveBunFamily({ [BUN_DISABLE_IPV6_ENV]: "1" })).toBe("4");
    expect(effectiveBunFamily({ [BUN_DISABLE_IPV4_ENV]: "true" })).toBe("6");
    expect(effectiveBunFamily({ [BUN_DISABLE_IPV4_ENV]: "0" })).toBe("auto");
    expect(
      effectiveBunFamily({
        [BUN_DISABLE_IPV4_ENV]: "1",
        [BUN_DISABLE_IPV6_ENV]: "1",
      }),
    ).toBe("4");
  });

  test("computes only the changes the launch env lacks", () => {
    expect(bunNetworkEnvChanges(opts(), {})).toBeNull();
    expect(
      bunNetworkEnvChanges(opts({ dnsCacheTtlSeconds: 5 }), {
        [BUN_DNS_TTL_ENV]: "5",
      }),
    ).toBeNull();
    expect(bunNetworkEnvChanges(opts({ dnsCacheTtlSeconds: 0 }), {})).toEqual({
      [BUN_DNS_TTL_ENV]: "0",
    });
    expect(
      bunNetworkEnvChanges(opts({ family: "6" }), {
        [BUN_DISABLE_IPV6_ENV]: "1",
      }),
    ).toEqual({
      [BUN_DISABLE_IPV6_ENV]: undefined,
      [BUN_DISABLE_IPV4_ENV]: "1",
    });
    expect(
      bunNetworkEnvChanges(opts({ family: "auto" }), {
        [BUN_DISABLE_IPV6_ENV]: "1",
      }),
    ).toBeNull();
  });

  test("passes when the launch env matches, else fails with the exact relaunch assignment", () => {
    expect(() => assertBunNetworkEnv(opts(), {}, ["x"])).not.toThrow();
    expect(() =>
      assertBunNetworkEnv(
        opts({ dnsCacheTtlSeconds: 5, family: "4" }),
        { [BUN_DNS_TTL_ENV]: "5", [BUN_DISABLE_IPV6_ENV]: "1" },
        ["x"],
      ),
    ).not.toThrow();
    let error: unknown;
    try {
      assertBunNetworkEnv(
        opts({ family: "4", dnsCacheTtlSeconds: 3 }),
        { [BUN_DISABLE_IPV4_ENV]: "1", KEEP: "k" },
        ["bun", "scripts/f402_readonly_pull.ts", "census", "--note", "a b"],
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(F402BunLaunchEnvError);
    expect(error).toBeInstanceOf(F402NetOptionsError);
    const launch = error as F402BunLaunchEnvError;
    expect(launch.name).toBe("F402BunLaunchEnvError");
    expect(launch.assignments).toEqual({
      [BUN_DNS_TTL_ENV]: "3",
      [BUN_DISABLE_IPV6_ENV]: "1",
      [BUN_DISABLE_IPV4_ENV]: undefined,
    });
    expect(launch.relaunchCommand).toBe(
      `env -u ${BUN_DISABLE_IPV4_ENV} ${BUN_DNS_TTL_ENV}=3 ${BUN_DISABLE_IPV6_ENV}=1 bun scripts/f402_readonly_pull.ts census --note 'a b'`,
    );
    expect(launch.message).toContain(launch.relaunchCommand);
    expect(() =>
      assertBunNetworkEnv(opts({ dnsCacheTtlSeconds: 5 }), {}, ["bun", "s.ts"]),
    ).toThrow(`${BUN_DNS_TTL_ENV}=5 bun s.ts`);
  });

  test("applies http version and prefetch to the pool, and reports effective values", async () => {
    const warmed: string[] = [];
    const pool = new F402FetchSessionPool({
      warm: (o) => warmed.push(o),
      createSession: () => ({
        fetch: async () => new Response("ok"),
        close() {},
      }),
    });
    applyF402NetOptions(opts({ httpVersion: "1.1", dnsPrefetch: false }), pool);
    await pool.fetch("https://f402.example/a");
    expect(pool.httpVersion).toBe("1.1");
    expect(warmed).toEqual([]);
    const report = f402NetReport(opts({ host: "h.example" }), {
      [BUN_DNS_TTL_ENV]: "9",
      [BUN_DISABLE_IPV6_ENV]: "1",
    });
    expect(report).toMatchObject({
      kind: "f402-net",
      host: "h.example",
      dnsCacheTtlSeconds: 9,
      family: "4",
      httpVersion: "auto",
    });
    expect(report.dnsCacheStats).not.toBeNull();
    expect(Object.keys(report.dnsCacheStats ?? {}).sort()).toEqual([
      "cacheHitsCompleted",
      "cacheHitsInflight",
      "cacheMisses",
      "errors",
      "size",
      "totalCount",
    ]);
  });
});

describe("launch env takes effect in Bun (local only)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "f402-net-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function runScript(
    body: string,
    args: string[],
    env: Record<string, string | undefined> = {},
  ): Promise<string> {
    const script = join(dir, `s-${Bun.hash(body + args.join(" "))}.ts`);
    await Bun.write(
      script,
      `import { assertBunNetworkEnv, resolveF402NetOptions } from ${JSON.stringify(join(root, "lib/f402_net_options.ts"))};
import { parseArgs } from "node:util";
import { F402_NET_ARG_OPTIONS } from ${JSON.stringify(join(root, "lib/f402_net_options.ts"))};
const { values } = parseArgs({ args: process.argv.slice(2), options: F402_NET_ARG_OPTIONS, strict: true });
const net = resolveF402NetOptions(values);
try { assertBunNetworkEnv(net); } catch (e) { console.error(e.message); process.exit(2); }
${body}
`,
    );
    const childEnv: Record<string, string | undefined> = { ...Bun.env };
    for (const k of [
      BUN_DNS_TTL_ENV,
      BUN_DISABLE_IPV4_ENV,
      BUN_DISABLE_IPV6_ENV,
      F402_IP_FAMILY_ENV,
      F402_DNS_CACHE_TTL_ENV,
    ])
      delete childEnv[k];
    Object.assign(childEnv, env);
    const proc = Bun.spawn([process.execPath, script, ...args], {
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    return out;
  }

  const ttlBody = `
Bun.dns.prefetch("localhost", 443);
await Bun.sleep(200);
await Bun.sleep(2300);
Bun.dns.prefetch("localhost", 443);
await Bun.sleep(200);
const s = Bun.dns.getCacheStats();
console.log(process.env.BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS ?? "unset", s.cacheMisses);
`;

  test("--dns-cache-ttl 0 makes a 2.5 s old entry miss; the default keeps it", async () => {
    const [withTtl, without] = await Promise.all([
      runScript(ttlBody, ["--dns-cache-ttl", "0"], { [BUN_DNS_TTL_ENV]: "0" }),
      runScript(ttlBody, []),
    ]);
    expect(withTtl).toBe("0 2");
    expect(without).toBe("unset 1");
  });

  test("writing process.env at runtime does not change Bun's TTL (why the CLI needs it at launch)", async () => {
    const out = await runScript(
      `process.env.BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS = "0";\n${ttlBody}`,
      [],
    );
    expect(out).toBe("0 1");
  });

  test("--family 4 and 6 restrict fetch connections to that family", async () => {
    const body = `
const v4 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("v4") });
const v6 = Bun.serve({ port: 0, hostname: "::1", fetch: () => new Response("v6") });
const get = async (p) => { try { return await (await fetch("http://localhost:" + p + "/")).text(); } catch (e) { return e.code; } };
console.log(await get(v4.port), await get(v6.port));
v4.stop(true); v6.stop(true);
`;
    const [auto, four, six] = await Promise.all([
      runScript(body, []),
      runScript(body, ["--family", "4"], { [BUN_DISABLE_IPV6_ENV]: "1" }),
      runScript(body, ["--family", "6"], { [BUN_DISABLE_IPV4_ENV]: "1" }),
    ]);
    expect(auto).toBe("v4 v6");
    expect(four).toBe("v4 ECONNREFUSED");
    expect(six).toBe("ECONNREFUSED v6");
  });
});

describe("CLI usage errors exit 2", () => {
  function run(args: string[]): { code: number; stderr: string } {
    const env: Record<string, string | undefined> = { ...Bun.env };
    for (const k of [
      F402_HOST_ENV,
      F402_IP_FAMILY_ENV,
      F402_DNS_CACHE_TTL_ENV,
      "F402_BASE_URL",
      BUN_DNS_TTL_ENV,
      BUN_DISABLE_IPV4_ENV,
      BUN_DISABLE_IPV6_ENV,
    ])
      delete env[k];
    const proc = Bun.spawnSync([process.execPath, ...args], {
      cwd: root,
      env,
    });
    return { code: proc.exitCode, stderr: proc.stderr.toString() };
  }

  test("puller", () => {
    for (const bad of [
      ["--family", "5"],
      ["--host", "www.fantasy402.com:443"],
      ["--dns-cache-ttl", "off"],
      ["--http-version", "3"],
      ["--dns-prefetch", "--no-dns-prefetch"],
      ["--host", "evil.example"],
    ]) {
      const r = run([
        "scripts/f402_readonly_pull.ts",
        "census",
        "--agent-id",
        "TEST",
        ...bad,
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(bad[0]!);
    }
  });

  test("probe", () => {
    for (const bad of [
      ["--family", "6x"],
      ["--host", "https://x"],
      ["--base-url", "http://www.fantasy402.com"],
      ["--base-url", "https://evil.example"],
      ["--host", "evil.example"],
      ["--bogus"],
    ]) {
      const r = run(["scripts/capture/probe_f402_protocol_matrix.ts", ...bad]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("capture:protocol-matrix:");
    }
  });
});

describe("CLI base URL and launch env refusals exit 2 before any request", () => {
  function run(args: string[]): { code: number; stderr: string } {
    const env: Record<string, string | undefined> = { ...Bun.env };
    for (const k of [
      F402_HOST_ENV,
      F402_IP_FAMILY_ENV,
      F402_DNS_CACHE_TTL_ENV,
      "F402_BASE_URL",
      BUN_DNS_TTL_ENV,
      BUN_DISABLE_IPV4_ENV,
      BUN_DISABLE_IPV6_ENV,
    ])
      delete env[k];
    const proc = Bun.spawnSync([process.execPath, ...args], {
      cwd: root,
      env,
    });
    return { code: proc.exitCode, stderr: proc.stderr.toString() };
  }
  const puller = [
    "scripts/f402_readonly_pull.ts",
    "census",
    "--agent-id",
    "TEST",
  ];

  test("puller refuses non-loopback http and off-allowlist bases", () => {
    for (const bad of [
      ["--base-url", "http://www.fantasy402.com"],
      ["--base-url", "http://192.0.2.1:8080"],
      ["--base-url", "https://evil.example"],
      ["--base-url", "http://127.0.0.1:8080", "--host", "www.fantasy402.com"],
    ]) {
      const r = run([...puller, ...bad]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("f402-pull base-url:");
    }
  });

  test("puller and probe print the exact relaunch assignment for a TTL/family the launch env lacks", () => {
    const p = run([...puller, "--dns-cache-ttl", "5", "--family", "4"]);
    expect(p.code).toBe(2);
    expect(p.stderr).toContain(
      `${BUN_DNS_TTL_ENV}=5 ${BUN_DISABLE_IPV6_ENV}=1 bun scripts/f402_readonly_pull.ts census --agent-id TEST --dns-cache-ttl 5 --family 4`,
    );
    const q = run([
      "scripts/capture/probe_f402_protocol_matrix.ts",
      "--family",
      "6",
    ]);
    expect(q.code).toBe(2);
    expect(q.stderr).toContain(
      `${BUN_DISABLE_IPV4_ENV}=1 bun scripts/capture/probe_f402_protocol_matrix.ts --family 6`,
    );
    expect(q.stderr).toContain("capture:protocol-matrix:");
  });
});

describe("resolveF402PortalOrigin", () => {
  test("allows the allowlist over https and loopback over http or https", () => {
    expect(resolveF402PortalOrigin("https://www.fantasy402.com", null)).toBe(
      "https://www.fantasy402.com",
    );
    expect(
      resolveF402PortalOrigin(
        "https://www.fantasy402.com:8443",
        "fantasy402.com",
      ),
    ).toBe("https://fantasy402.com:8443");
    expect(resolveF402PortalOrigin("https://cdn.fastassets.io", null)).toBe(
      "https://cdn.fastassets.io",
    );
    expect(resolveF402PortalOrigin("http://127.0.0.1:9", null)).toBe(
      "http://127.0.0.1:9",
    );
    expect(resolveF402PortalOrigin("http://localhost:9", null)).toBe(
      "http://localhost:9",
    );
    expect(resolveF402PortalOrigin("http://[::1]:9", null)).toBe(
      "http://[::1]:9",
    );
    expect(
      resolveF402PortalOrigin("https://www.fantasy402.com:8443", "127.0.0.1"),
    ).toBe("https://127.0.0.1:8443");
  });

  test("refuses off-allowlist hosts and http to a non-loopback host as config errors", () => {
    for (const [base, host] of [
      ["https://evil.example", null],
      ["https://www.fantasy402.com.evil.example", null],
      ["http://www.fantasy402.com", null],
      ["http://192.0.2.1:80", null],
      ["http://127.0.0.1:9", "www.fantasy402.com"],
      ["http://localhost:9", "cdn.fastassets.io"],
    ] as const) {
      let error: unknown;
      try {
        resolveF402PortalOrigin(base, host);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(F402PullerError);
      expect((error as F402PullerError).code).toBe("config");
    }
  });
});

describe("probe base URL resolution matches the puller", () => {
  test("flag > F402_BASE_URL > https://www.fantasy402.com, then --host", () => {
    expect(parseProbeArgs([], {}).base).toBe("https://www.fantasy402.com");
    expect(
      parseProbeArgs([], { F402_BASE_URL: "https://fantasy402.com" }).base,
    ).toBe("https://fantasy402.com");
    expect(
      parseProbeArgs(["--base-url", "https://www.fantasy402.com:8443"], {
        F402_BASE_URL: "https://fantasy402.com",
      }).base,
    ).toBe("https://www.fantasy402.com:8443");
    expect(parseProbeArgs(["--base", "http://127.0.0.1:8080"], {}).base).toBe(
      "http://127.0.0.1:8080",
    );
    expect(
      parseProbeArgs(["--host", "fantasy402.com"], {
        F402_BASE_URL: "https://www.fantasy402.com:8443",
      }).base,
    ).toBe("https://fantasy402.com:8443");
  });

  test("refuses both base flags, http bases and unknown flags by name", () => {
    expect(() =>
      parseProbeArgs(["--base", "https://a", "--base-url", "https://b"], {}),
    ).toThrow(ProbeUsageError);
    expect(() =>
      parseProbeArgs(["--base-url", "http://www.fantasy402.com"], {}),
    ).toThrow(F402PullerError);
    expect(() =>
      parseProbeArgs(["--base-url", "https://evil.example"], {}),
    ).toThrow(F402PullerError);
    expect(() =>
      parseProbeArgs([], { F402_BASE_URL: "https://evil.example" }),
    ).toThrow(F402PullerError);
    expect(() =>
      parseProbeArgs(
        ["--base-url", "http://127.0.0.1:8080", "--host", "fantasy402.com"],
        {},
      ),
    ).toThrow(F402PullerError);
    expect(() => parseProbeArgs(["--host", "evil.example"], {})).toThrow(
      F402NetOptionsError,
    );
    expect(() => parseProbeArgs(["--nope"], {})).toThrow(ProbeUsageError);
    expect(() => parseProbeArgs(["--backend", "lynx"], {})).toThrow(
      ProbeUsageError,
    );
  });
});

const openssl = Bun.which("openssl");

describe.skipIf(openssl === null)("probeTls offers ALPN", () => {
  let dir = "";
  let h2Server: http2.Http2SecureServer | undefined;
  let h2Port = 0;
  let h1: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "f402-alpn-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
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
      (_req, res) => res.end("ok"),
    );
    await new Promise<void>((resolve) =>
      h2Server!.listen(0, "127.0.0.1", resolve),
    );
    const address = h2Server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port");
    h2Port = address.port;
    h1 = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { key, cert },
      fetch: () => new Response("ok"),
    });
  });

  afterAll(async () => {
    h1?.stop(true);
    await new Promise<void>((resolve) =>
      h2Server === undefined ? resolve() : h2Server.close(() => resolve()),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("wire format is RFC 7301 length-prefixed", () => {
    expect([...alpnWireFormat(PROBE_TLS_DEFAULT_ALPN)]).toEqual([
      2, 104, 50, 8, 104, 116, 116, 112, 47, 49, 46, 49,
    ]);
    expect(() => alpnWireFormat([""])).toThrow(RangeError);
  });

  test("records h2 from an h2 server, http/1.1 when only that is offered, and empty from a server without ALPN", async () => {
    const h2 = await probeTls({
      host: "127.0.0.1",
      port: h2Port,
      servername: "localhost",
    });
    expect(h2.alpn).toBe("h2");
    const pinned = await probeTls({
      host: "127.0.0.1",
      port: h2Port,
      servername: "localhost",
      alpn: ["http/1.1"],
    });
    expect(pinned.alpn).toBe("http/1.1");
    const none = await probeTls({
      host: "127.0.0.1",
      port: h1!.port ?? 0,
      servername: "localhost",
    });
    expect(none.alpn).toBe("");
  });
});
