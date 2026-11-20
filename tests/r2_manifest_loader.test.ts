import { describe, expect, test } from "bun:test";
import { S3Client } from "bun";
import { inspect as utilInspect } from "node:util";
import {
  assertNoSecretLeak,
  createScopedR2Client,
  createSealedR2ManifestClient,
  loadVerifiedR2Manifest,
  R2ManifestError,
  SealedR2ManifestClient,
  SecretLeakError,
  type R2ManifestClient,
  type R2ManifestErrorCode,
} from "../src/utils/r2_manifest_loader.ts";
import { YamlGuardError } from "../src/utils/hardened_yaml.ts";

function makeMockClient(
  payload: Uint8Array,
  overrides?: {
    reportedSize?: number;
    chunkSize?: number;
    onStat?: () => void;
    onStream?: () => void;
    onCancel?: (reason: unknown) => void;
  },
): R2ManifestClient {
  return {
    async stat() {
      overrides?.onStat?.();
      return {
        size: overrides?.reportedSize ?? payload.byteLength,
        etag: '"mock-etag-001"',
        lastModified: new Date("2026-11-20T00:00:00.000Z"),
      };
    },
    file() {
      return {
        stream() {
          overrides?.onStream?.();
          const step = overrides?.chunkSize;
          let offset = 0;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (step === undefined || step <= 0) {
                if (offset === 0) {
                  offset = payload.byteLength;
                  controller.enqueue(payload);
                }
                controller.close();
                return;
              }
              if (offset >= payload.byteLength) {
                controller.close();
                return;
              }
              const nextEnd = Math.min(offset + step, payload.byteLength);
              controller.enqueue(payload.subarray(offset, nextEnd));
              offset = nextEnd;
              if (offset >= payload.byteLength) {
                controller.close();
              }
            },
            cancel(reason) {
              overrides?.onCancel?.(reason);
            },
          });
        },
      };
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function expectR2Code(
  fn: () => Promise<unknown>,
  code: R2ManifestErrorCode,
): Promise<void> {
  try {
    await fn();
    expect.unreachable(`Expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(R2ManifestError);
    expect((err as R2ManifestError).code).toBe(code);
  }
}

describe("loadVerifiedR2Manifest", () => {
  test("verifies HEAD size, GET length, SHA-256, and parses hardened YAML", async () => {
    const raw = new TextEncoder().encode(
      'schemaVersion: "1.0.0"\nbucket: sportsdesk-ops-reports\n',
    );
    const digest = sha256(raw);
    const client = makeMockClient(raw);

    const res = await loadVerifiedR2Manifest(client, "manifests/live.yaml", {
      expectedSha256: digest,
      expectedBytes: raw.byteLength,
      requiredPrefix: "manifests/",
    });

    expect(res.key).toBe("manifests/live.yaml");
    expect(res.sha256).toBe(digest);
    expect(res.byteLength).toBe(raw.byteLength);
    expect(res.etag).toBe('"mock-etag-001"');
    expect(res.manifest).toEqual({
      schemaVersion: "1.0.0",
      bucket: "sportsdesk-ops-reports",
    });
  });

  test("aborts on HEAD size ceiling without opening GET stream", async () => {
    let streamOpened = false;
    const raw = new TextEncoder().encode("a: 1\n");
    const client = makeMockClient(raw, {
      reportedSize: 2_000_000,
      onStream: () => {
        streamOpened = true;
      },
    });

    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(client, "manifests/big.yaml", {
          expectedSha256: sha256(raw),
          maxBytes: 1024,
        }),
      "ERR_R2_BYTE_LIMIT",
    );
    expect(streamOpened).toBe(false);
  });

  test("catches TOCTOU stream overflow when GET exceeds maxBytes despite small HEAD", async () => {
    const oversized = new Uint8Array(2048).fill(0x61);
    const client = makeMockClient(oversized, { reportedSize: 64 });

    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(client, "manifests/race.yaml", {
          expectedSha256: sha256(oversized),
          maxBytes: 512,
        }),
      "ERR_R2_BYTE_LIMIT",
    );
  });

  test("rejects tampered bytes with ERR_R2_SHA256_MISMATCH before YAML parse", async () => {
    const raw = new TextEncoder().encode("invalid: yaml: : : [\n");
    const wrongDigest = "0".repeat(64);
    const client = makeMockClient(raw);

    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(client, "manifests/tampered.yaml", {
          expectedSha256: wrongDigest,
        }),
      "ERR_R2_SHA256_MISMATCH",
    );
  });

  test("rejects invalid UTF-8 bytes even when SHA-256 matches", async () => {
    const badUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    const client = makeMockClient(badUtf8);

    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(client, "manifests/bad-utf8.yaml", {
          expectedSha256: sha256(badUtf8),
        }),
      "ERR_R2_INVALID_UTF8",
    );
  });

  test("propagates YamlGuardError on verified cyclic YAML", async () => {
    const cyclic = new TextEncoder().encode("node: &self\n  ref: *self\n");
    const client = makeMockClient(cyclic);

    try {
      await loadVerifiedR2Manifest(client, "manifests/cyclic.yaml", {
        expectedSha256: sha256(cyclic),
      });
      expect.unreachable("Expected YamlGuardError");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlGuardError);
      expect((err as YamlGuardError).code).toBe("ERR_YAML_CYCLIC_GRAPH");
    }
  });

  test("fails Stage 0 preflight on unsafe keys or malformed digests before any HEAD/GET I/O", async () => {
    let statCalled = false;
    let streamCalled = false;
    const raw = new TextEncoder().encode("ok: true\n");
    const validSha = sha256(raw);
    const client = makeMockClient(raw, {
      onStat: () => {
        statCalled = true;
      },
      onStream: () => {
        streamCalled = true;
      },
    });

    for (const badKey of [
      "",
      "/manifests/a.yaml",
      "manifests/../secret.yaml",
      "manifests\\win.yaml",
      "manifests/bad\0key.yaml",
    ]) {
      await expectR2Code(
        () =>
          loadVerifiedR2Manifest(client, badKey, {
            expectedSha256: validSha,
          }),
        "ERR_R2_INVALID_KEY",
      );
    }

    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(client, "other/live.yaml", {
          expectedSha256: validSha,
          requiredPrefix: "manifests/",
        }),
      "ERR_R2_INVALID_KEY",
    );

    for (const badSha of ["abc", "z".repeat(64), "0".repeat(63)]) {
      await expectR2Code(
        () =>
          loadVerifiedR2Manifest(client, "manifests/live.yaml", {
            expectedSha256: badSha,
          }),
        "ERR_R2_INVALID_DIGEST",
      );
    }

    expect(statCalled).toBe(false);
    expect(streamCalled).toBe(false);
  });

  test("rejects Stage 1 empty objects and HEAD size mismatches before opening GET stream", async () => {
    let streamCalled = false;
    const raw = new TextEncoder().encode("k: v\n");
    const digest = sha256(raw);

    const emptyClient = makeMockClient(new Uint8Array(0), {
      reportedSize: 0,
      onStream: () => {
        streamCalled = true;
      },
    });
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(emptyClient, "manifests/empty.yaml", {
          expectedSha256: digest,
        }),
      "ERR_R2_EMPTY_OBJECT",
    );

    const mismatchClient = makeMockClient(raw, {
      reportedSize: raw.byteLength + 10,
      onStream: () => {
        streamCalled = true;
      },
    });
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(mismatchClient, "manifests/mismatch.yaml", {
          expectedSha256: digest,
          expectedBytes: raw.byteLength,
        }),
      "ERR_R2_SIZE_MISMATCH",
    );

    expect(streamCalled).toBe(false);
  });

  test("handles multi-chunk streams, uppercase hex digests, TOCTOU truncation, and multi-chunk cancellation", async () => {
    const raw = new TextEncoder().encode("env: prod\ncount: 42\n");
    const upperDigest = sha256(raw).toUpperCase();
    const chunkedClient = makeMockClient(raw, { chunkSize: 5 });

    const res = await loadVerifiedR2Manifest(
      chunkedClient,
      "manifests/chunked.yaml",
      {
        expectedSha256: upperDigest,
        expectedBytes: raw.byteLength,
      },
    );
    expect(res.sha256).toBe(upperDigest.toLowerCase());
    expect(res.manifest).toEqual({ env: "prod", count: 42 });

    // TOCTOU shrink between HEAD and GET
    const shrunkClient = makeMockClient(raw.subarray(0, 6), {
      reportedSize: raw.byteLength,
    });
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(shrunkClient, "manifests/shrunk.yaml", {
          expectedSha256: sha256(raw),
        }),
      "ERR_R2_SIZE_MISMATCH",
    );

    // Multi-chunk TOCTOU overflow triggers reader cancellation
    let cancelledReason: unknown;
    const huge = new Uint8Array(600).fill(0x61);
    const overflowClient = makeMockClient(huge, {
      reportedSize: 128,
      chunkSize: 150,
      onCancel: (reason) => {
        cancelledReason = reason;
      },
    });
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(overflowClient, "manifests/overflow.yaml", {
          expectedSha256: sha256(huge),
          maxBytes: 256,
        }),
      "ERR_R2_BYTE_LIMIT",
    );
    expect(cancelledReason).toBe("ERR_R2_BYTE_LIMIT");
  });

  test("propagates YamlGuardError for multi-document and alias-bomb payloads after SHA verification", async () => {
    const multiDoc = new TextEncoder().encode("a: 1\n---\nb: 2\n");
    const multiClient = makeMockClient(multiDoc);
    try {
      await loadVerifiedR2Manifest(multiClient, "manifests/multi.yaml", {
        expectedSha256: sha256(multiDoc),
      });
      expect.unreachable("Expected YamlGuardError");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlGuardError);
      expect((err as YamlGuardError).code).toBe("ERR_YAML_MULTI_DOCUMENT");
    }

    const bomb = new TextEncoder().encode(
      [
        "a: &a [1, 2, 3, 4, 5]",
        "b: &b [*a, *a, *a, *a, *a]",
        "c: &c [*b, *b, *b, *b, *b]",
      ].join("\n"),
    );
    const bombClient = makeMockClient(bomb);
    try {
      await loadVerifiedR2Manifest(bombClient, "manifests/bomb.yaml", {
        expectedSha256: sha256(bomb),
        yamlOptions: { maxNodes: 50 },
      });
      expect.unreachable("Expected YamlGuardError");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlGuardError);
      expect((err as YamlGuardError).code).toBe("ERR_YAML_ALIAS_BOMB");
    }
  });

  test("createScopedR2Client constructs an S3Client instance compatible with R2ManifestClient", () => {
    const client = createScopedR2Client({
      endpoint: "https://example.r2.cloudflarestorage.com",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const typed: R2ManifestClient = client;
    expect(client).toBeInstanceOf(S3Client);
    expect(typeof typed.stat).toBe("function");
    expect(typeof typed.file).toBe("function");
  });

  test("seals R2 credentials across Bun.inspect, Bun.inspect.table, util.inspect (showHidden/getters/customInspect:false), JSON.stringify, and reflection", () => {
    const accessKey = "r2-sentinel-access-001";
    const secretKey = "r2-sentinel-secret+002/=";
    const sessionToken = "r2-sentinel-session-003";
    const activeSecrets = [accessKey, secretKey, sessionToken];

    const client = createSealedR2ManifestClient({
      bucket: "sportsdesk-ops-reports",
      endpoint: "https://example.r2.cloudflarestorage.com",
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken,
    });
    const rawS3 = createScopedR2Client({
      bucket: "sportsdesk-ops-reports",
      endpoint: "https://example.r2.cloudflarestorage.com",
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken,
    });

    const fileHandle = client.file("manifests/live.yaml");
    const surfaces: readonly {
      readonly label: string;
      readonly value: string;
    }[] = [
      {
        label: "Bun.s3.bunInspect",
        value: Bun.inspect(Bun.s3, { depth: Infinity }),
      },
      {
        label: "Bun.s3.utilInspect",
        value: utilInspect(Bun.s3, { showHidden: true, depth: null }),
      },
      {
        label: "S3Client.bunInspect",
        value: Bun.inspect(rawS3, { depth: Infinity }),
      },
      {
        label: "S3Client.utilInspect",
        value: utilInspect(rawS3, { showHidden: true, depth: null }),
      },
      {
        label: "SealedR2ManifestClient.bunInspect",
        value: Bun.inspect(client, { depth: Infinity }),
      },
      {
        label: "SealedR2ManifestClient.bunInspectFull",
        value: Bun.inspect(client, {
          depth: Infinity,
          sorted: true,
          colors: true,
        }),
      },
      {
        label: "SealedR2ManifestClient.utilInspect",
        value: utilInspect(client, { showHidden: true, depth: null }),
      },
      {
        label: "SealedR2ManifestClient.utilInspectGetters",
        value: utilInspect(client, {
          showHidden: true,
          depth: null,
          getters: true,
        }),
      },
      {
        label: "SealedR2ManifestClient.utilInspectRaw",
        value: utilInspect(client, {
          showHidden: true,
          depth: null,
          customInspect: false,
          getters: true,
        }),
      },
      {
        label: "SealedR2ManifestClient.inspectTable",
        value: Bun.inspect.table([client]),
      },
      {
        label: "SealedR2ManifestClient.json",
        value: JSON.stringify(client),
      },
      {
        label: "SealedR2ManifestClient.toString",
        value: String(client),
      },
      {
        label: "SealedR2ManifestClient.file.bunInspect",
        value: Bun.inspect(fileHandle, { depth: Infinity }),
      },
      {
        label: "SealedR2ManifestClient.file.utilInspect",
        value: utilInspect(fileHandle, { showHidden: true, depth: null }),
      },
    ];

    for (const surface of surfaces) {
      assertNoSecretLeak(surface.value, surface.label, activeSecrets);
    }

    expect(client).toBeInstanceOf(SealedR2ManifestClient);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Reflect.ownKeys(client)).toEqual([]);
    expect(Object.keys(Object.getOwnPropertyDescriptors(client))).toEqual([]);
    expect(client.endpointHost).toBe("example.r2.cloudflarestorage.com");
    expect(Object.prototype.toString.call(client)).toBe(
      "[object SealedR2ManifestClient]",
    );
    expect(Bun.inspect(client, { depth: Infinity })).toContain(
      'credentials: "[REDACTED]"',
    );
    expect(utilInspect(client, { showHidden: true, depth: null })).toBe(
      Bun.inspect(client, { depth: Infinity }),
    );

    // ES #private brand check blocks spoofed-this method calls
    expect(() =>
      SealedR2ManifestClient.prototype.file.call(
        {} as SealedR2ManifestClient,
        "a",
      ),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(
        Object.getOwnPropertyDescriptor(
          SealedR2ManifestClient.prototype,
          "endpointHost",
        )!.get!,
        {},
        [],
      ),
    ).toThrow(TypeError);
  });

  test("assertNoSecretLeak detects raw, url-encoded, base64, base64url, hex, and ANSI-split leaks", () => {
    const secret = "tok+slash/eq=99";
    const encoded = encodeURIComponent(secret);
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const b64u = Buffer.from(secret, "utf8").toString("base64url");
    const hexUpper = Buffer.from(secret, "utf8").toString("hex").toUpperCase();
    const ansiSplit = `\u001b[31m${secret.slice(0, 6)}\u001b[0m${secret.slice(6)}`;

    for (const candidate of [secret, encoded, b64, b64u, hexUpper, ansiSplit]) {
      expect(() =>
        assertNoSecretLeak(`payload=${candidate}`, "probe", [secret]),
      ).toThrow(SecretLeakError);
    }
  });

  test("rejects unsafe endpoints/credentials and scrubs secrets from rejected errors & hostile transport errors", async () => {
    const urlPass = "urlpass+99/secret";
    const querySig = "querysig+88/secret";
    const accessKey = "ak+77/secret";
    const secretKey = "sk+66/secret";
    const activeSecrets = [urlPass, querySig, accessKey, secretKey];

    for (const badEndpoint of [
      `https://op:${urlPass}@example.r2.cloudflarestorage.com`,
      `https://example.r2.cloudflarestorage.com/p?sig=${querySig}`,
      `https://example.r2.cloudflarestorage.com#${querySig}`,
      "http://example.r2.cloudflarestorage.com",
      "not a url",
    ]) {
      try {
        createSealedR2ManifestClient({
          endpoint: badEndpoint,
          accessKeyId: accessKey,
          secretAccessKey: secretKey,
        });
        expect.unreachable(
          `Expected ERR_R2_INVALID_ENDPOINT for ${badEndpoint}`,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(R2ManifestError);
        expect((err as R2ManifestError).code).toBe("ERR_R2_INVALID_ENDPOINT");
        assertNoSecretLeak(
          Bun.inspect(err, { depth: Infinity }),
          "endpointErr.bun",
          activeSecrets,
        );
        assertNoSecretLeak(
          utilInspect(err, { showHidden: true, depth: null }),
          "endpointErr.util",
          activeSecrets,
        );
      }
    }

    await expectR2Code(
      async () =>
        createSealedR2ManifestClient({
          endpoint: "https://example.r2.cloudflarestorage.com",
          accessKeyId: "  padded  ",
          secretAccessKey: secretKey,
        }),
      "ERR_R2_INVALID_CREDENTIALS",
    );

    const encodedSecret = encodeURIComponent(secretKey);
    const b64Secret = Buffer.from(secretKey, "utf8").toString("base64");
    const hexSecret = Buffer.from(secretKey, "utf8")
      .toString("hex")
      .toUpperCase();
    const hostileBackend: R2ManifestClient = {
      async stat() {
        throw new Error(
          `connect failed for https://u:${urlPass}@example.r2.cloudflarestorage.com raw=${accessKey} url=${encodedSecret} b64=${b64Secret} hex=\u001b[31m${hexSecret}\u001b[0m`,
        );
      },
      file() {
        return {
          stream() {
            throw new Error(`stream failed: ${secretKey}`);
          },
        };
      },
    };
    const sealed = SealedR2ManifestClient.fromBackend(hostileBackend, {
      endpoint: "https://example.r2.cloudflarestorage.com",
      activeSecrets,
    });

    try {
      await sealed.stat("manifests/live.yaml");
      expect.unreachable("Expected ERR_R2_TRANSPORT_ERROR");
    } catch (err) {
      expect(err).toBeInstanceOf(R2ManifestError);
      expect((err as R2ManifestError).code).toBe("ERR_R2_TRANSPORT_ERROR");
      assertNoSecretLeak(
        Bun.inspect(err, { depth: Infinity }),
        "statTransportErr.bun",
        activeSecrets,
      );
      assertNoSecretLeak(
        utilInspect(err, { showHidden: true, depth: null }),
        "statTransportErr.util",
        activeSecrets,
      );
    }

    try {
      sealed.file("manifests/live.yaml").stream();
      expect.unreachable("Expected ERR_R2_TRANSPORT_ERROR");
    } catch (err) {
      expect(err).toBeInstanceOf(R2ManifestError);
      expect((err as R2ManifestError).code).toBe("ERR_R2_TRANSPORT_ERROR");
      assertNoSecretLeak(
        Bun.inspect(err, { depth: Infinity }),
        "streamTransportErr.bun",
        activeSecrets,
      );
      assertNoSecretLeak(
        utilInspect(err, { showHidden: true, depth: null }),
        "streamTransportErr.util",
        activeSecrets,
      );
    }
  });

  test("Bun.inspect and util.inspect redact active S3 env credentials on Bun.s3", () => {
    const childAccess = "r2-child-env-access-101";
    const childSecret = "r2-child-env-secret-102";
    const childToken = "r2-child-env-session-103";
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        [
          'import { inspect } from "node:util";',
          "console.log(Bun.inspect(Bun.s3, { depth: Infinity }));",
          'console.log("---UTIL---");',
          "console.log(inspect(Bun.s3, { showHidden: true, depth: null }));",
        ].join("\n"),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          S3_ACCESS_KEY_ID: childAccess,
          S3_SECRET_ACCESS_KEY: childSecret,
          S3_SESSION_TOKEN: childToken,
        },
      },
    );
    expect(proc.exitCode).toBe(0);
    const output = proc.stdout.toString();
    assertNoSecretLeak(output, "Bun.s3.inspect.env", [
      childAccess,
      childSecret,
      childToken,
    ]);
    expect(output).toContain('accessKeyId: "[REDACTED]"');
    expect(output).toContain('secretAccessKey: "[REDACTED]"');
  });

  test("enforces deep Stage 0 key hardening and Stage 1 metadata/ETag/staleness gates", async () => {
    let streamCalled = false;
    const raw = new TextEncoder().encode("env: prod\n");
    const digest = sha256(raw);

    for (const badKey of [
      "manifests/%2e%2e/secret.yaml",
      "manifests/%2Fsecret.yaml",
      "manifests/%5csecret.yaml",
      "manifests/bad%00.yaml",
      "manifests//double.yaml",
      "manifests/",
      "a".repeat(1025),
    ]) {
      const client = makeMockClient(raw, {
        onStream: () => {
          streamCalled = true;
        },
      });
      await expectR2Code(
        () =>
          loadVerifiedR2Manifest(client, badKey, {
            expectedSha256: digest,
          }),
        "ERR_R2_INVALID_KEY",
      );
    }

    for (const badSize of [Number.NaN, -1, Infinity, 12.5]) {
      const client = makeMockClient(raw, {
        reportedSize: badSize,
        onStream: () => {
          streamCalled = true;
        },
      });
      await expectR2Code(
        () =>
          loadVerifiedR2Manifest(client, "manifests/bad-size.yaml", {
            expectedSha256: digest,
          }),
        "ERR_R2_SIZE_MISMATCH",
      );
    }

    const etagClient: R2ManifestClient = {
      async stat() {
        return {
          size: raw.byteLength,
          etag: 'W/"weak-etag"',
          lastModified: new Date("2026-11-20T12:00:00.000Z"),
        };
      },
      file() {
        return {
          stream() {
            streamCalled = true;
            return new ReadableStream();
          },
        };
      },
    };
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(etagClient, "manifests/etag.yaml", {
          expectedSha256: digest,
          expectedEtag: '"strong-etag"',
        }),
      "ERR_R2_ETAG_MISMATCH",
    );

    const staleClient = makeMockClient(raw);
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(staleClient, "manifests/stale.yaml", {
          expectedSha256: digest,
          maxAgeMs: 60_000,
          nowMs: Date.parse("2026-11-20T00:05:00.000Z"),
        }),
      "ERR_R2_STALE_OBJECT",
    );

    expect(streamCalled).toBe(false);
  });

  test("defeats shared-buffer mutation TOCTOU, zero-byte chunk floods, stream timeouts, BOMs, and parser-differential YAML", async () => {
    // 1. Producer mutates chunk 0's backing buffer on next tick after delivering chunk 0 to consumer
    const validText = new TextEncoder().encode("env: prod\nstep: 1\n");
    const expectedSha = sha256(validText);
    const sharedClient: R2ManifestClient = {
      async stat() {
        return {
          size: validText.byteLength,
          etag: '"shared-buf"',
          lastModified: new Date("2026-11-20T00:00:00.000Z"),
        };
      },
      file() {
        return {
          stream() {
            const split = 10;
            const scratch = new Uint8Array(validText.byteLength);
            let step = 0;
            return new ReadableStream<Uint8Array>({
              pull(controller): Promise<void> {
                if (step === 0) {
                  step = 1;
                  scratch.set(validText.subarray(0, split), 0);
                  controller.enqueue(scratch.subarray(0, split));
                  return Promise.resolve();
                }
                if (step === 1) {
                  step = 2;
                  return new Promise<void>((resolve) => {
                    setTimeout(() => {
                      // Mutate chunk 0's backing buffer after consumer has received chunk 0
                      scratch.fill(0x58);
                      controller.enqueue(validText.subarray(split));
                      controller.close();
                      resolve();
                    }, 5);
                  });
                }
                return Promise.resolve();
              },
            });
          },
        };
      },
    };
    const verified = await loadVerifiedR2Manifest(
      sharedClient,
      "manifests/shared.yaml",
      { expectedSha256: expectedSha },
    );
    expect(verified.manifest).toEqual({ env: "prod", step: 1 });

    // 2. Zero-byte chunk flood trips maxChunks and cancels stream
    let floodCancelReason: unknown;
    const zeroFloodClient: R2ManifestClient = {
      async stat() {
        return {
          size: 4,
          etag: '"flood"',
          lastModified: new Date("2026-11-20T00:00:00.000Z"),
        };
      },
      file() {
        return {
          stream() {
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(0));
              },
              cancel(reason) {
                floodCancelReason = reason;
              },
            });
          },
        };
      },
    };
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(zeroFloodClient, "manifests/flood.yaml", {
          expectedSha256: "0".repeat(64),
          maxChunks: 8,
        }),
      "ERR_R2_BYTE_LIMIT",
    );
    expect(floodCancelReason).toBe("ERR_R2_BYTE_LIMIT");

    // 3. Stalled slowloris stream trips timeoutMs and cancels stream
    let timeoutCancelReason: unknown;
    const stallClient: R2ManifestClient = {
      async stat() {
        return {
          size: 16,
          etag: '"stall"',
          lastModified: new Date("2026-11-20T00:00:00.000Z"),
        };
      },
      file() {
        return {
          stream() {
            return new ReadableStream<Uint8Array>({
              pull() {
                return new Promise(() => {
                  // Deliberately never resolves
                });
              },
              cancel(reason) {
                timeoutCancelReason = reason;
              },
            });
          },
        };
      },
    };
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(stallClient, "manifests/stall.yaml", {
          expectedSha256: "0".repeat(64),
          timeoutMs: 25,
        }),
      "ERR_R2_TIMEOUT",
    );
    expect(timeoutCancelReason).toBe("ERR_R2_TIMEOUT");

    // 4. UTF-16 LE BOM rejected with ERR_R2_INVALID_UTF8
    const utf16Bom = new Uint8Array([0xff, 0xfe, 0x61, 0x00]);
    await expectR2Code(
      () =>
        loadVerifiedR2Manifest(makeMockClient(utf16Bom), "manifests/bom.yaml", {
          expectedSha256: sha256(utf16Bom),
        }),
      "ERR_R2_INVALID_UTF8",
    );

    // 5. Duplicate-key & tag-smuggled YAML rejected with YamlGuardError after valid SHA-256
    const dupYaml = new TextEncoder().encode("role: viewer\nrole: admin\n");
    try {
      await loadVerifiedR2Manifest(
        makeMockClient(dupYaml),
        "manifests/dup.yaml",
        {
          expectedSha256: sha256(dupYaml),
        },
      );
      expect.unreachable("Expected YamlGuardError");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlGuardError);
      expect((err as YamlGuardError).code).toBe("ERR_YAML_DUPLICATE_KEY");
    }
  });
});
