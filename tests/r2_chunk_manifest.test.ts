import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BlobLiveConfigInvalid,
  loadBlobLiveConfig,
  parseBlobLiveConfig,
} from "../lib/blob_live_config.ts";
import {
  latestPointerKey,
  LIVE_STREAM_IDS,
  LiveStreamConsumer,
  loadStreamTelemetry,
  ManifestInvalid,
  manifestKey,
  ManifestStoreError,
  NO_ACTIVE_STREAM,
  readLatestPointer,
  sealChunkWithManifest,
  writeChunkManifest,
  type ManifestR2Client,
  type SealedChunk,
} from "../lib/r2_chunk_manifest.ts";
import { R2ManifestCasError } from "../lib/r2_manifest_cas.ts";
import {
  R2PreconditionFailedError,
  R2S3Client,
  type R2GetObjectResult,
  type R2S3ClientBackend,
} from "../lib/r2_s3_client.ts";
import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
} from "../services/blob_and_live_bets_server.ts";

const SHA = "a".repeat(64);
const TS = 1_731_900_000_123_456_789n;
const TICKER = "f402-bet-ticker" as const;
const TALLY = "gslive-tally" as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function chunk(overrides: Partial<SealedChunk> = {}): SealedChunk {
  return {
    stream_id: TICKER,
    slot: "slot-7",
    timestamp_ns: TS,
    chunk_key: `chunks/${SHA}.bin`,
    sha256: SHA,
    bytes: 2048,
    wager_count: 12,
    ...overrides,
  };
}

const encoder = new TextEncoder();

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

/** In-memory R2 with strong ETags and If-Match / If-None-Match semantics. */
class FakeR2 implements ManifestR2Client {
  readonly objects = new Map<
    string,
    { body: Uint8Array; etag: string; type: string | undefined }
  >();
  readonly gets: string[] = [];
  readonly casWrites: {
    key: string;
    ifMatch?: string;
    ifNoneMatch?: string;
  }[] = [];
  beforeGetResolves: ((key: string) => Promise<void>) | undefined;
  failGets = false;
  #nextEtag = 0;

  put(key: string, data: Uint8Array | string, type?: string): void {
    this.#nextEtag += 1;
    this.objects.set(key, {
      body: toBytes(data),
      etag: `"etag-${this.#nextEtag}"`,
      type,
    });
  }

  text(key: string): string | undefined {
    const object = this.objects.get(key);
    return object === undefined
      ? undefined
      : new TextDecoder().decode(object.body);
  }

  async headEtag(key: string): Promise<string | null> {
    return this.objects.get(key)?.etag ?? null;
  }

  async write(
    key: string,
    data: Uint8Array | string,
    options?: { readonly type?: string },
  ): Promise<number> {
    this.put(key, data, options?.type);
    return toBytes(data).byteLength;
  }

  async writeWithMetadata(
    key: string,
    data: Uint8Array | string,
    options: {
      readonly type?: string;
      readonly ifMatch?: string;
      readonly ifNoneMatch?: string;
    } = {},
  ): Promise<number> {
    this.casWrites.push({
      key,
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.ifNoneMatch === undefined
        ? {}
        : { ifNoneMatch: options.ifNoneMatch }),
    });
    const current = this.objects.get(key);
    if (options.ifNoneMatch === "*" && current !== undefined) {
      throw new R2PreconditionFailedError(key);
    }
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) {
      throw new R2PreconditionFailedError(key);
    }
    return this.write(key, data, options);
  }

  file(key: string): {
    text(): Promise<string>;
    bytes(): Promise<Uint8Array>;
  } {
    return {
      text: async () => this.text(key) ?? "",
      bytes: async () => this.objects.get(key)?.body ?? new Uint8Array(0),
    };
  }

  async stat(key: string): Promise<{ etag?: string; size?: number }> {
    const object = this.objects.get(key);
    return object === undefined
      ? {}
      : { etag: object.etag, size: object.body.byteLength };
  }

  async getObject(key: string): Promise<R2GetObjectResult> {
    this.gets.push(key);
    if (this.failGets) throw new Error("R2 GET 503 SlowDown");
    await this.beforeGetResolves?.(key);
    const object = this.objects.get(key);
    if (object === undefined) return { status: 404, etag: null, body: null };
    return { status: 200, etag: object.etag, body: object.body };
  }
}

describe("chunk manifests with a CAS latest pointer", () => {
  test("writes YAML next to the chunk and a JSON pointer at manifests/<stream_id>/latest", async () => {
    const r2 = new FakeR2();
    const written = await writeChunkManifest(r2, chunk());
    expect(written.manifestKey).toBe(
      `manifests/${TICKER}/slot-7/${TS.toString()}.yaml`,
    );
    expect(written.latestKey).toBe(`manifests/${TICKER}/latest`);
    expect(written).toMatchObject({ generation_u32: 1, latestAdvanced: true });

    const yaml = Bun.YAML.parse(r2.text(written.manifestKey)!) as Record<
      string,
      unknown
    >;
    expect(yaml.timestamp_ns).toBe(TS.toString());
    expect(r2.objects.get(written.manifestKey)?.type).toBe("application/yaml");

    const pointer = JSON.parse(r2.text(written.latestKey)!) as Record<
      string,
      unknown
    >;
    expect(pointer).toEqual({
      version: 1,
      stream_id: TICKER,
      generation_u32: 1,
      manifest_key: written.manifestKey,
      manifest: written.manifest,
    });
    expect("bodyUsed" in pointer).toBe(false);
    expect(r2.casWrites).toEqual([
      { key: written.latestKey, ifNoneMatch: "*" },
    ]);
    expect(
      [...r2.objects.keys()].filter((key) =>
        key.startsWith(`generations/${TICKER}/gen-1-`),
      ),
    ).toHaveLength(1);
  });

  test("the next write promotes with If-Match on the prior ETag", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk({ timestamp_ns: "100" }));
    const firstEtag = r2.objects.get(latestPointerKey(TICKER))!.etag;
    const second = await writeChunkManifest(
      r2,
      chunk({ slot: "slot-8", timestamp_ns: "200" }),
    );
    expect(second.generation_u32).toBe(2);
    expect(r2.casWrites.at(-1)).toEqual({
      key: latestPointerKey(TICKER),
      ifMatch: firstEtag,
    });
  });

  test("a concurrent pointer write gets 412 and fails loudly with the CAS error", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk({ timestamp_ns: "100" }));

    let arrivals = 0;
    const { promise: bothRead, resolve: releaseReads } =
      Promise.withResolvers<void>();
    r2.beforeGetResolves = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseReads();
      await bothRead;
    };
    const results = await Promise.allSettled([
      writeChunkManifest(r2, chunk({ slot: "a", timestamp_ns: "200" })),
      writeChunkManifest(r2, chunk({ slot: "b", timestamp_ns: "300" })),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(R2ManifestCasError);
    expect((error as R2ManifestCasError).code).toBe(
      "ERR_R2_MANIFEST_CAS_REJECTED",
    );
    expect((error as R2ManifestCasError).cause).toBeInstanceOf(
      R2PreconditionFailedError,
    );

    r2.beforeGetResolves = undefined;
    const read = await readLatestPointer(r2, TICKER);
    expect(read.state === "ok" && read.pointer.generation_u32).toBe(2);
  });

  test("two first writers race on If-None-Match:* and one gets 412", async () => {
    const r2 = new FakeR2();
    const results = await Promise.allSettled([
      writeChunkManifest(r2, chunk({ slot: "a" })),
      writeChunkManifest(r2, chunk({ slot: "b" })),
    ]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "R2ManifestCasError",
      code: "ERR_R2_MANIFEST_CAS_REJECTED",
    });
  });

  test("an out-of-order chunk does not move the latest pointer back", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk({ timestamp_ns: "200" }));
    const late = await writeChunkManifest(
      r2,
      chunk({ slot: "old", timestamp_ns: "100" }),
    );
    expect(late).toMatchObject({ latestAdvanced: false, generation_u32: 1 });
    expect(r2.casWrites).toHaveLength(1);
    expect(r2.objects.has(late.manifestKey)).toBe(true);
    const read = await readLatestPointer(r2, TICKER);
    expect(read.state === "ok" && read.pointer.manifest.timestamp_ns).toBe(
      "200",
    );
  });

  test("stream ids are limited to the existing published streams", async () => {
    expect(LIVE_STREAM_IDS).toEqual([TICKER, TALLY]);
    const r2 = new FakeR2();
    for (const bad of [
      chunk({ stream_id: "live-bets" }),
      chunk({ stream_id: "Live/Bets" }),
      chunk({ wager_count: -1 }),
      chunk({ bytes: -5 }),
      chunk({ wager_count: 1.5 }),
      chunk({ timestamp_ns: "1.7e18" }),
      chunk({ slot: "../x" }),
      chunk({ sha256: "nothex" }),
    ]) {
      await expect(writeChunkManifest(r2, bad)).rejects.toBeInstanceOf(
        ManifestInvalid,
      );
    }
    expect(r2.objects.size).toBe(0);
    expect(manifestKey(TALLY, "s2", "42")).toBe(
      "manifests/gslive-tally/s2/42.yaml",
    );
  });

  test("a corrupt pointer blocks the writer instead of being overwritten", async () => {
    const r2 = new FakeR2();
    r2.put(latestPointerKey(TICKER), "{not json");
    await expect(writeChunkManifest(r2, chunk())).rejects.toBeInstanceOf(
      ManifestInvalid,
    );
    expect(r2.casWrites).toHaveLength(0);
  });

  test("backend failures surface as ManifestStoreError", async () => {
    const r2 = new FakeR2();
    r2.failGets = true;
    const error = await writeChunkManifest(r2, chunk()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ManifestStoreError);
    expect((error as ManifestStoreError).operation).toBe("get");
    expect((error as Error).message).toContain("R2 GET 503 SlowDown");
  });

  test("sealChunkWithManifest uploads the chunk then its manifest and pointer", async () => {
    const r2 = new FakeR2();
    const payload = encoder.encode('{"wager":1}\n{"wager":2}\n');
    const sha = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    const written = await sealChunkWithManifest(r2, {
      bytes: payload,
      stream_id: TALLY,
      slot: "s9",
      timestamp_ns: TS,
      wager_count: 2,
    });
    expect(r2.objects.has(`chunks/${sha}.bin`)).toBe(true);
    expect(written.manifest).toEqual({
      version: 1,
      stream_id: TALLY,
      slot: "s9",
      timestamp_ns: TS.toString(),
      chunk_key: `chunks/${sha}.bin`,
      sha256: sha,
      bytes: payload.byteLength,
      wager_count: 2,
    });
    expect(written.latestKey).toBe("manifests/gslive-tally/latest");

    const before = r2.objects.size;
    await expect(
      sealChunkWithManifest(r2, {
        bytes: payload,
        stream_id: TALLY,
        slot: "s9",
        timestamp_ns: TS,
        wager_count: -1,
      }),
    ).rejects.toBeInstanceOf(ManifestInvalid);
    expect(r2.objects.size).toBe(before);
  });
});

describe("single-GET reads and per-consumer generations", () => {
  test("a pointer read is one GET with no exists() round trip", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk());
    r2.gets.length = 0;
    const consumer = new LiveStreamConsumer(r2);
    expect(await consumer.poll(TICKER)).toMatchObject({
      status: "active",
      generation_u32: 1,
    });
    expect(r2.gets).toEqual([latestPointerKey(TICKER)]);
  });

  test("a delete during the read is NO ACTIVE STREAM (missing), not a thrown error", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk());
    r2.beforeGetResolves = async (key) => {
      r2.objects.delete(key);
    };
    const consumer = new LiveStreamConsumer(r2);
    expect(await consumer.poll(TICKER)).toEqual({ status: "missing" });
    expect(await loadStreamTelemetry(consumer, [TICKER])).toEqual([
      { stream_id: TICKER, status: NO_ACTIVE_STREAM, reason: "missing" },
    ]);
  });

  test("corrupt pointers are NO ACTIVE STREAM (corrupt)", async () => {
    const r2 = new FakeR2();
    const consumer = new LiveStreamConsumer(r2);
    for (const body of [
      "[unterminated",
      '{"version":1}',
      new Uint8Array([0xff, 0xfe, 0x00]),
    ]) {
      r2.put(latestPointerKey(TICKER), body);
      const state = await consumer.poll(TICKER);
      expect(state.status).toBe("corrupt");
      expect(state.status === "corrupt" && state.error).toBeInstanceOf(
        ManifestInvalid,
      );
    }
    const written = await writeChunkManifest(r2, chunk({ stream_id: TALLY }));
    r2.put(latestPointerKey(TICKER), r2.text(written.latestKey)!);
    expect((await consumer.poll(TICKER)).status).toBe("corrupt");
  });

  test("two consumers do not blank each other; each sees stale only for itself", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk({ timestamp_ns: "100" }));
    const desk = new LiveStreamConsumer(r2);
    const board = new LiveStreamConsumer(r2);

    expect((await desk.poll(TICKER)).status).toBe("active");
    expect((await board.poll(TICKER)).status).toBe("active");
    expect(await desk.poll(TICKER)).toEqual({
      status: "stale",
      generation_u32: 1,
    });
    expect(await loadStreamTelemetry(desk, [TICKER])).toEqual([
      { stream_id: TICKER, status: NO_ACTIVE_STREAM, reason: "stale" },
    ]);

    await writeChunkManifest(
      r2,
      chunk({ slot: "slot-8", timestamp_ns: "200" }),
    );
    expect(await desk.poll(TICKER)).toMatchObject({
      status: "active",
      generation_u32: 2,
    });
    expect(board.lastConsumedGeneration(TICKER)).toBe(1);
    expect(await board.poll(TICKER)).toMatchObject({
      status: "active",
      generation_u32: 2,
    });
    expect(r2.casWrites.every((write) => write.key.endsWith("/latest"))).toBe(
      true,
    );
    expect(r2.casWrites).toHaveLength(2);
  });

  test("telemetry reports ACTIVE with the generation and NO ACTIVE STREAM when missing", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk());
    expect(
      await loadStreamTelemetry(new LiveStreamConsumer(r2), [TICKER, TALLY]),
    ).toEqual([
      {
        stream_id: TICKER,
        status: "ACTIVE",
        generation_u32: 1,
        slot: "slot-7",
        timestamp_ns: TS.toString(),
        wager_count: 12,
        bytes: 2048,
      },
      { stream_id: TALLY, status: NO_ACTIVE_STREAM, reason: "missing" },
    ]);
  });
});

class NoopBackend implements R2S3ClientBackend {
  readonly writes = new Map<string, Uint8Array>();
  file(): never {
    throw new Error("backend file() not used");
  }
  async write(path: string, data: Uint8Array | string): Promise<number> {
    this.writes.set(path, toBytes(data));
    return toBytes(data).byteLength;
  }
  presign(): string {
    return "";
  }
  stat(): never {
    throw new Error("backend stat() not used");
  }
  async exists(): Promise<boolean> {
    return false;
  }
  async size(): Promise<number> {
    return 0;
  }
  list(): never {
    throw new Error("backend list() not used");
  }
  async delete(): Promise<void> {}
  async unlink(): Promise<void> {}
}

/** Local fetch stub emulating R2's signed HEAD/GET/PUT with CAS, keyed by URL path. */
function r2HttpStub() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  const requests: { method: string; path: string; signed: boolean }[] = [];
  let version = 0;
  let onRequest: ((method: string, path: string) => Promise<void>) | undefined;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: url.pathname,
      signed:
        headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256") ?? false,
    });
    await onRequest?.(method, url.pathname);
    const current = objects.get(url.pathname);
    if (method === "PUT") {
      const ifMatch = headers.get("if-match");
      const ifNoneMatch = headers.get("if-none-match");
      if (
        (ifNoneMatch === "*" && current !== undefined) ||
        (ifMatch !== null && current?.etag !== ifMatch)
      ) {
        return new Response("PreconditionFailed", { status: 412 });
      }
      version += 1;
      objects.set(url.pathname, {
        body: toBytes(init?.body as Uint8Array),
        etag: `"v${version}"`,
      });
      return new Response(null, { status: 200 });
    }
    const object = current;
    if (object === undefined) {
      return new Response("<Error><Code>NoSuchKey</Code></Error>", {
        status: 404,
      });
    }
    return new Response(method === "HEAD" ? null : object.body, {
      status: 200,
      headers: { etag: object.etag },
    });
  }) as unknown as typeof fetch;
  return {
    objects,
    requests,
    fetchImpl,
    setOnRequest(hook: typeof onRequest) {
      onRequest = hook;
    },
  };
}

function stubbedClient(): R2S3Client {
  return R2S3Client.fromOptions(
    {
      bucket: "bucket",
      endpoint: "https://r2.test",
      accessKeyId: "a",
      secretAccessKey: "s",
      publicBase: "https://pub.test",
    },
    new NoopBackend(),
  );
}

describe("R2S3Client.getObject and the CAS path over a local fetch stub", () => {
  test("getObject is one signed GET returning status, ETag and body", async () => {
    const stub = r2HttpStub();
    const client = stubbedClient();
    expect(
      await client.getObject("manifests/f402-bet-ticker/latest", {
        fetchImpl: stub.fetchImpl,
      }),
    ).toEqual({ status: 404, etag: null, body: null });

    await client.writeWithMetadata("manifests/f402-bet-ticker/latest", "{}", {
      type: "application/json",
      ifNoneMatch: "*",
      fetchImpl: stub.fetchImpl,
    });
    stub.requests.length = 0;
    const read = await client.getObject("manifests/f402-bet-ticker/latest", {
      fetchImpl: stub.fetchImpl,
    });
    expect(read.status).toBe(200);
    expect(read.etag).toBe('"v1"');
    expect(new TextDecoder().decode(read.body!)).toBe("{}");
    expect(stub.requests).toEqual([
      {
        method: "GET",
        path: "/bucket/manifests/f402-bet-ticker/latest",
        signed: true,
      },
    ]);
  });

  test("getObject throws on non-404 failures", async () => {
    const client = stubbedClient();
    const failing = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(client.getObject("k", { fetchImpl: failing })).rejects.toThrow(
      "R2 GET k failed (503)",
    );
  });

  test("a concurrent pointer write returns HTTP 412 and the CAS error", async () => {
    const stub = r2HttpStub();
    const client = stubbedClient();
    const options = { fetchImpl: stub.fetchImpl };
    await writeChunkManifest(client, chunk({ timestamp_ns: "100" }), options);

    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    stub.setOnRequest(async (method, path) => {
      if (method !== "PUT" || !path.endsWith("/latest")) return;
      stub.setOnRequest(undefined);
      arrived.resolve();
      await release.promise;
    });
    const slow = writeChunkManifest(
      client,
      chunk({ slot: "b", timestamp_ns: "300" }),
      options,
    );
    await arrived.promise;
    const fast = await writeChunkManifest(
      client,
      chunk({ slot: "a", timestamp_ns: "200" }),
      options,
    );
    expect(fast.generation_u32).toBe(2);
    release.resolve();

    const error = await slow.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(R2ManifestCasError);
    expect((error as R2ManifestCasError).code).toBe(
      "ERR_R2_MANIFEST_CAS_REJECTED",
    );
    const pointerPuts = stub.requests.filter(
      (request) => request.method === "PUT" && request.path.endsWith("/latest"),
    );
    expect(pointerPuts).toHaveLength(3);
    const read = await readLatestPointer(client, TICKER, options);
    expect(read.state === "ok" && read.pointer.manifest.slot).toBe("a");
  });

  test("a delete while the GET is in flight reads as missing", async () => {
    const stub = r2HttpStub();
    const client = stubbedClient();
    const options = { fetchImpl: stub.fetchImpl };
    await writeChunkManifest(client, chunk(), options);
    stub.setOnRequest(async (method, path) => {
      if (method === "GET") stub.objects.delete(path);
    });
    const consumer = new LiveStreamConsumer(client, options);
    expect(await consumer.poll(TICKER)).toEqual({ status: "missing" });
  });
});

describe("config/blob-live.yaml", () => {
  test("the committed config loads through the yaml import", () => {
    const config = loadBlobLiveConfig();
    expect(config.streams).toEqual([TICKER, TALLY]);
    expect(config.hostname).toBe("127.0.0.1");
    expect(typeof config.port).toBe("number");
  });

  test("loadBlobLiveConfig works when cwd is not the repo root", () => {
    const cwd = mkdtempSync(join(tmpdir(), "blob-live-cwd-"));
    dirs.push(cwd);
    const modulePath = join(import.meta.dir, "../lib/blob_live_config.ts");
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `import { loadBlobLiveConfig } from ${JSON.stringify(modulePath)};
process.stdout.write(JSON.stringify(loadBlobLiveConfig()));`,
      ],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({
      exitCode: proc.exitCode,
      stderr: proc.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    const config = JSON.parse(proc.stdout.toString()) as {
      hostname: string;
      port: number;
      streams: string[];
    };
    expect(config.hostname).toBe("127.0.0.1");
    expect(typeof config.port).toBe("number");
    expect(config.streams).toEqual([TICKER, TALLY]);
  });

  test("invalid config is rejected by name", () => {
    expect(() => parseBlobLiveConfig("port: [")).toThrow(BlobLiveConfigInvalid);
    for (const text of [
      "port: 1\nhostname: h\nstreams: []\n",
      "port: 1\nhostname: h\nstreams: [live-bets]\n",
      "port: 1\nhostname: h\nstreams: [gslive-tally, gslive-tally]\n",
      "port: 1\nhostname: h\nstreams: [gslive-tally]\nsecret: x\n",
      "port: 1\nhostname: h\nstreams: [gslive-tally]\nbucket: b\n",
    ]) {
      expect(() => parseBlobLiveConfig(text)).toThrow(BlobLiveConfigInvalid);
    }
  });
});

describe("/health streams telemetry", () => {
  test("reports NO ACTIVE STREAM per stream without a pointer", async () => {
    const r2 = new FakeR2();
    await writeChunkManifest(r2, chunk());
    const streamTelemetry = await loadStreamTelemetry(
      new LiveStreamConsumer(r2),
      [TICKER, TALLY],
    );
    const { server, close } = createBlobLiveBetsServer({
      blobs: new MemoryBlobStore(),
      apiToken: "t",
      ticketSecret: "s",
      port: 0,
      hostname: "127.0.0.1",
      streamTelemetry,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      const body = (await response.json()) as {
        streams: { stream_id: string; status: string }[];
      };
      expect(
        body.streams.map((entry) => [entry.stream_id, entry.status]),
      ).toEqual([
        [TICKER, "ACTIVE"],
        [TALLY, NO_ACTIVE_STREAM],
      ]);
    } finally {
      close(true);
    }
  });
});
