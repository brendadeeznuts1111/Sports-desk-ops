import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  promoteCanonicalManifestWithCas,
  R2ManifestCasError,
} from "../lib/r2_manifest_cas.ts";
import {
  R2NetworkError,
  R2S3Client,
  type R2S3ClientBackend,
  R2TimeoutError,
} from "../lib/r2_s3_client.ts";

interface StoredObject {
  body: string;
  etag: string;
}

type PutHook = (key: string, body: string) => Promise<"apply" | "skip">;

/** Local stand-in for R2 path-style PUT/HEAD with If-Match / If-None-Match. */
class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  readonly seen: Array<{ method: string; key: string; headers: Headers }> = [];
  putHook: PutHook | null = null;
  headDelayMs = 0;
  omitPutEtag = false;
  private generation = 0;
  server: ReturnType<typeof Bun.serve> | null = null;

  start(): string {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.handle(request),
    });
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server?.stop(true);
  }

  reset(): void {
    this.objects.clear();
    this.seen.length = 0;
    this.putHook = null;
    this.headDelayMs = 0;
    this.omitPutEtag = false;
  }

  store(key: string, body: string): string {
    this.generation += 1;
    const etag = `"g${this.generation}"`;
    this.objects.set(key, { body, etag });
    return etag;
  }

  count(method: string, key: string): number {
    return this.seen.filter((r) => r.method === method && r.key === key).length;
  }

  private async handle(request: Request): Promise<Response> {
    const key = decodeURIComponent(
      new URL(request.url).pathname.replace(/^\/bucket\//, ""),
    );
    this.seen.push({
      method: request.method,
      key,
      headers: new Headers(request.headers),
    });
    if (request.method === "HEAD") {
      if (this.headDelayMs > 0) await Bun.sleep(this.headDelayMs);
      const object = this.objects.get(key);
      if (object === undefined) return new Response(null, { status: 404 });
      const identity = request.headers.get("accept-encoding") === "identity";
      return new Response(null, {
        headers: {
          etag: identity ? object.etag : `${object.etag.slice(0, -1)}+gzip"`,
        },
      });
    }
    const body = await request.text();
    const current = this.objects.get(key);
    const ifMatch = request.headers.get("if-match");
    const ifNoneMatch = request.headers.get("if-none-match");
    if (
      (ifMatch !== null && ifMatch !== current?.etag) ||
      (ifNoneMatch === "*" && current !== undefined)
    ) {
      return new Response(null, { status: 412 });
    }
    if (this.putHook !== null && (await this.putHook(key, body)) === "skip") {
      return new Response(null, { status: 503 });
    }
    const etag = this.store(key, body);
    return new Response(null, {
      headers: this.omitPutEtag ? {} : { etag },
    });
  }
}

const r2 = new FakeR2();
let endpoint = "";

beforeAll(() => {
  endpoint = r2.start();
});

afterAll(() => {
  r2.stop();
});

function backendFor(store: FakeR2): R2S3ClientBackend {
  return {
    async write(key: string, data: Uint8Array | string) {
      const body =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      store.store(key, body);
      return new TextEncoder().encode(body).byteLength;
    },
    file(key: string) {
      return {
        async bytes() {
          const object = store.objects.get(key);
          if (object === undefined) throw new Error(`NoSuchKey: ${key}`);
          return new TextEncoder().encode(object.body);
        },
        async text() {
          const object = store.objects.get(key);
          if (object === undefined) throw new Error(`NoSuchKey: ${key}`);
          return object.body;
        },
      };
    },
  } as unknown as R2S3ClientBackend;
}

function client(timeoutMs?: number, url = endpoint): R2S3Client {
  return R2S3Client.fromOptions(
    {
      bucket: "bucket",
      endpoint: url,
      accessKeyId: "fake-access",
      secretAccessKey: "fake-secret",
      publicBase: "https://pub.test",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    backendFor(r2),
  );
}

function networkFailure(code: string): TypeError {
  return Object.assign(new TypeError(`${code}: stubbed connect failure`), {
    code,
  });
}

function stubFetch(
  outcomes: ReadonlyArray<() => Response | Promise<Response>>,
): { fetchImpl: typeof fetch; calls: BunFetchRequestInit[] } {
  const calls: BunFetchRequestInit[] = [];
  const fetchImpl = (async (_input: string, init: BunFetchRequestInit) => {
    calls.push(init);
    const outcome = outcomes[Math.min(calls.length, outcomes.length) - 1];
    if (outcome === undefined) throw new Error("no stubbed outcome");
    return outcome();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const MANIFEST = "manifests/test-sink/latest";

function promote(
  c: R2S3Client,
  prevETag: string | null,
  generation: number,
  manifest: unknown,
) {
  return promoteCanonicalManifestWithCas({
    client: c,
    sinkId: "test-sink",
    prevETag,
    nextGenerationU32: generation,
    merkleRootSha256: "a".repeat(64),
    manifest,
  });
}

describe("signed R2 fetch timeouts", () => {
  test("a HEAD past timeoutMs rejects with R2TimeoutError(key, method, ms)", async () => {
    r2.reset();
    r2.store("slow", "x");
    r2.headDelayMs = 1_000;
    const error = await client(150)
      .headEtag("slow")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2TimeoutError);
    expect(error).toMatchObject({ key: "slow", method: "HEAD", ms: 150 });
    expect((error as Error).cause).toMatchObject({ name: "TimeoutError" });
  });

  test("a per-call timeoutMs overrides the client default", async () => {
    r2.reset();
    r2.store("slow", "x");
    r2.headDelayMs = 1_000;
    const error = await client(60_000)
      .headEtag("slow", { timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "R2TimeoutError", ms: 30 });
  });

  test("the caller's signal is combined with the timeout and its abort is not renamed", async () => {
    r2.reset();
    r2.store("slow", "x");
    r2.headDelayMs = 1_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const error = await client(60_000)
      .headEtag("slow", { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(R2TimeoutError);
    expect(error).toMatchObject({ name: "AbortError" });

    const { fetchImpl, calls } = stubFetch([() => new Response(null)]);
    await client().headEtag("k", { fetchImpl, signal: controller.signal });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal).not.toBe(controller.signal);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  test("timeoutMs must be positive", () => {
    expect(() => client(0)).toThrow(RangeError);
    expect(() => client(Number.NaN)).toThrow(RangeError);
  });

  test("a plain metadata PUT retries a timeout", async () => {
    r2.reset();
    let calls = 0;
    r2.putHook = async () => {
      calls += 1;
      if (calls === 1) await Bun.sleep(1_000);
      return "apply";
    };
    await client(150).writeWithMetadata("plain", "v", {
      metadata: { source: "test" },
      retry: 2,
      retryDelayMs: 0,
    });
    expect(r2.count("PUT", "plain")).toBe(2);
  });
});

describe("timed-out CAS PUT", () => {
  test("is not retried; an unchanged generation surfaces ERR_R2_MANIFEST_CAS_TIMEOUT", async () => {
    r2.reset();
    const prev = r2.store(MANIFEST, '{"generation":1}');
    r2.putHook = async (key) => {
      if (key === MANIFEST) await Bun.sleep(1_000);
      return "skip";
    };
    const error = await promote(client(150), prev, 2, { generation: 2 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(R2ManifestCasError);
    expect(error).toMatchObject({
      code: "ERR_R2_MANIFEST_CAS_TIMEOUT",
      exitCode: 75,
    });
    expect((error as Error).cause).toBeInstanceOf(R2TimeoutError);
    expect(r2.count("PUT", MANIFEST)).toBe(1);
    expect(r2.count("HEAD", MANIFEST)).toBe(1);
    expect(r2.objects.get(MANIFEST)?.etag).toBe(prev);
  });

  test("a PUT that landed before the timeout resolves to its ETag on re-read", async () => {
    r2.reset();
    const prev = r2.store(MANIFEST, '{"generation":1}');
    r2.putHook = async (key, body) => {
      if (key !== MANIFEST) return "apply";
      r2.store(key, body);
      await Bun.sleep(1_000);
      return "skip";
    };
    const result = await promote(client(150), prev, 2, { generation: 2 });
    expect(result.newETag).toBe(r2.objects.get(MANIFEST)?.etag ?? "missing");
    expect(result.newETag).not.toBe(prev);
    expect(r2.count("PUT", MANIFEST)).toBe(1);
  });

  test("another writer moving the generation during the timeout is a CAS rejection", async () => {
    r2.reset();
    const prev = r2.store(MANIFEST, '{"generation":1}');
    r2.putHook = async (key) => {
      if (key !== MANIFEST) return "apply";
      r2.store(key, '{"generation":2,"writer":"other"}');
      await Bun.sleep(1_000);
      return "skip";
    };
    const error = await promote(client(150), prev, 2, { generation: 2 }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "ERR_R2_MANIFEST_CAS_REJECTED" });
    expect(r2.count("PUT", MANIFEST)).toBe(1);
  });
});

describe("connect-failure codes", () => {
  test("transient codes are retried and the PUT succeeds", async () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT"]) {
      const { fetchImpl, calls } = stubFetch([
        () => {
          throw networkFailure(code);
        },
        () => new Response(null, { headers: { etag: '"ok"' } }),
      ]);
      const result = await client().writeWithMetadataResult("k", "v", {
        retry: 2,
        retryDelayMs: 0,
        fetchImpl,
      });
      expect(result.etag).toBe('"ok"');
      expect(calls).toHaveLength(2);
    }
  });

  test("non-transient codes become R2NetworkError with code and cause, no retry", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "CERT_HAS_EXPIRED"]) {
      const failure = networkFailure(code);
      const { fetchImpl, calls } = stubFetch([
        () => {
          throw failure;
        },
      ]);
      const error = await client()
        .writeWithMetadata("k", "v", { retry: 3, retryDelayMs: 0, fetchImpl })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(R2NetworkError);
      expect(error).toMatchObject({ code, method: "PUT", key: "k" });
      expect((error as Error).cause).toBe(failure);
      expect(calls).toHaveLength(1);
    }
  });

  test("an error without a code is an R2NetworkError with code null, no retry", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => {
        throw new Error("opaque");
      },
    ]);
    const error = await client()
      .writeWithMetadata("k", "v", { retry: 3, retryDelayMs: 0, fetchImpl })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "R2NetworkError", code: null });
    expect(calls).toHaveLength(1);
  });

  test("a real refused connection maps to ECONNREFUSED", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const closedPort = listener.port;
    listener.stop(true);
    const error = await client(2_000, `http://127.0.0.1:${closedPort}`)
      .headEtag("k")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: "R2NetworkError",
      code: "ECONNREFUSED",
      method: "HEAD",
    });
  });

  test("a conditional PUT never retries a transient failure, even with retry > 0", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => {
        throw networkFailure("ECONNRESET");
      },
      () => new Response(null),
    ]);
    const error = await client()
      .writeWithMetadata("k", "v", {
        ifMatch: '"g1"',
        retry: 3,
        retryDelayMs: 0,
        fetchImpl,
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "R2NetworkError", code: "ECONNRESET" });
    expect(calls).toHaveLength(1);
  });

  test("the CAS promote sends exactly one PUT on a transient failure", async () => {
    r2.reset();
    const prev = r2.store(MANIFEST, '{"generation":1}');
    let puts = 0;
    const fetchImpl = (async (input: string, init: BunFetchRequestInit) => {
      if (init.method === "PUT") {
        puts += 1;
        throw networkFailure("ECONNRESET");
      }
      return fetch(input, init);
    }) as unknown as typeof fetch;
    const error = await promoteCanonicalManifestWithCas({
      client: client(),
      sinkId: "test-sink",
      prevETag: prev,
      nextGenerationU32: 2,
      merkleRootSha256: "a".repeat(64),
      manifest: { generation: 2 },
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ERR_R2_SINK_BACKPRESSURE" });
    expect(puts).toBe(1);
  });
});

describe("PUT response ETag", () => {
  test("writeWithMetadataResult returns the PUT response ETag", async () => {
    r2.reset();
    const result = await client().writeWithMetadataResult("obj", "body", {
      metadata: { source: "test" },
    });
    expect(result).toEqual({
      bytes: 4,
      etag: r2.objects.get("obj")?.etag ?? "",
    });
    expect(r2.count("HEAD", "obj")).toBe(0);
  });

  test("the CAS promote keeps its own ETag when a racing writer lands before any HEAD", async () => {
    r2.reset();
    const prev = r2.store(MANIFEST, '{"generation":1}');
    let ours: string | null = null;
    const racingFetch = (async (input: string, init: BunFetchRequestInit) => {
      const response = await fetch(input, init);
      if (init.method === "PUT" && new URL(input).pathname.endsWith("latest")) {
        ours = response.headers.get("etag");
        r2.store(MANIFEST, '{"generation":3,"writer":"racer"}');
      }
      return response;
    }) as unknown as typeof fetch;
    const result = await promoteCanonicalManifestWithCas({
      client: client(),
      sinkId: "test-sink",
      prevETag: prev,
      nextGenerationU32: 2,
      merkleRootSha256: "a".repeat(64),
      manifest: { generation: 2 },
      fetchImpl: racingFetch,
    });
    expect(ours).not.toBeNull();
    expect(result.newETag).toBe(ours);
    expect(result.newETag).not.toBe(r2.objects.get(MANIFEST)?.etag ?? null);
    expect(r2.count("HEAD", MANIFEST)).toBe(0);
  });

  test("falls back to HEAD only when the PUT response has no ETag", async () => {
    r2.reset();
    r2.omitPutEtag = true;
    const result = await promote(client(), null, 1, { generation: 1 });
    expect(result.newETag).toBe(r2.objects.get(MANIFEST)?.etag ?? "missing");
    expect(r2.count("HEAD", MANIFEST)).toBe(1);
  });
});

describe("identity-encoded pointer HEAD", () => {
  test("signs accept-encoding: identity, disables decompression, and returns the stored ETag", async () => {
    r2.reset();
    const stored = r2.store("ptr", "{}");
    const inits: BunFetchRequestInit[] = [];
    const spy = (async (input: string, init: BunFetchRequestInit) => {
      inits.push(init);
      return fetch(input, init);
    }) as unknown as typeof fetch;
    expect(await client().headEtag("ptr", { fetchImpl: spy })).toBe(stored);
    expect(inits[0]?.decompress).toBe(false);
    const seen = r2.seen.find((r) => r.method === "HEAD")?.headers;
    expect(seen?.get("accept-encoding")).toBe("identity");
    expect(seen?.get("authorization")).toMatch(
      /SignedHeaders=accept-encoding;host;/,
    );
  });
});
