/**
 * @file tests/runtime_preflight_tls_ciphers.test.ts
 * @description The preflight's AEAD-only TLS 1.2 pin reaches both `fetch` and `Bun.S3Client`.
 * Loopback only: local TLS listeners with a throwaway CA, placeholder S3 credentials, and a child
 * process so the pin and `NODE_EXTRA_CA_CERTS` never leak into other test files.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import tls from "node:tls";
import { join } from "node:path";
import {
  AEAD_TLS12_CIPHERS,
  runRuntimePreflightAudit,
} from "../src/telemetry/runtime-preflight.ts";
import { createTlsFixture, type TlsFixture } from "./support/tls_fixture.ts";

type Outcome =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly code: string };
type ProbeResult = Record<string, { fetch: Outcome; s3: Outcome }>;

const PROBE = join(import.meta.dir, "support", "tls_cipher_probe.ts");

let fixture: TlsFixture | null = null;
const servers: tls.Server[] = [];
const ports = { cbc12: 0, gcm12: 0, tls13: 0 };

function listen(options: tls.TlsOptions): Promise<number> {
  const server = tls.createServer(options, (socket) => {
    const negotiated = socket.getCipher()?.name ?? "";
    socket.once("data", () => {
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-length: ${negotiated.length}\r\nconnection: close\r\n\r\n${negotiated}`,
      );
    });
  });
  server.on("tlsClientError", () => {});
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
}

async function probe(mode: "pin" | "default"): Promise<ProbeResult> {
  if (fixture === null) throw new Error("TLS fixture missing");
  const proc = Bun.spawn(
    [
      process.execPath,
      PROBE,
      mode,
      String(ports.cbc12),
      String(ports.gcm12),
      String(ports.tls13),
    ],
    {
      env: { PATH: Bun.env.PATH ?? "", NODE_EXTRA_CA_CERTS: fixture.caPath },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout) as ProbeResult;
}

beforeAll(async () => {
  fixture = await createTlsFixture("localhost");
  if (fixture === null) return;
  const key = await Bun.file(fixture.keyPath).text();
  const cert = await Bun.file(fixture.certPath).text();
  const base = { key, cert };
  ports.cbc12 = await listen({
    ...base,
    ciphers: "ECDHE-RSA-AES128-SHA",
    maxVersion: "TLSv1.2",
  });
  ports.gcm12 = await listen({
    ...base,
    ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
    maxVersion: "TLSv1.2",
  });
  ports.tls13 = await listen({ ...base, minVersion: "TLSv1.3" });
});

afterAll(() => {
  for (const server of servers) server.close();
  fixture?.cleanup();
});

describe("runtime preflight TLS 1.2 cipher pin", () => {
  test("the preflight report carries the AEAD-only list", () => {
    const before = tls.DEFAULT_CIPHERS;
    try {
      expect(runRuntimePreflightAudit().tls12Ciphers).toBe(AEAD_TLS12_CIPHERS);
      const suites = tls.DEFAULT_CIPHERS.split(":");
      expect(suites.filter((suite) => !suite.startsWith("TLS_"))).toEqual(
        AEAD_TLS12_CIPHERS.split(":"),
      );
      expect(suites.some((suite) => suite.startsWith("TLS_"))).toBe(true);
    } finally {
      tls.DEFAULT_CIPHERS = before;
    }
  });

  test("without the pin, fetch and S3Client negotiate a CBC suite", async () => {
    if (fixture === null) return;
    const result = await probe("default");
    const cbc = result[String(ports.cbc12)]!;
    expect(cbc.fetch).toEqual({ ok: true, body: "ECDHE-RSA-AES128-SHA" });
    expect(cbc.s3).toEqual({ ok: true, body: "ECDHE-RSA-AES128-SHA" });
  });

  test("with the pin, both refuse CBC and keep AEAD TLS 1.2 and TLS 1.3", async () => {
    if (fixture === null) return;
    const result = await probe("pin");
    const cbc = result[String(ports.cbc12)]!;
    expect(cbc.fetch.ok).toBe(false);
    expect(cbc.s3.ok).toBe(false);
    const gcm = result[String(ports.gcm12)]!;
    expect(gcm.fetch).toEqual({
      ok: true,
      body: "ECDHE-RSA-AES128-GCM-SHA256",
    });
    expect(gcm.s3).toEqual({ ok: true, body: "ECDHE-RSA-AES128-GCM-SHA256" });
    const tls13 = result[String(ports.tls13)]!;
    for (const outcome of [tls13.fetch, tls13.s3]) {
      expect(outcome.ok && outcome.body).toMatch(/^TLS_(AES|CHACHA20)_/);
    }
  });
});
