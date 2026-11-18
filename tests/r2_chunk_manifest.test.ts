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
  loadStreamTelemetry,
  LocalDirManifestStore,
  ManifestInvalid,
  manifestKey,
  ManifestStoreError,
  NO_ACTIVE_STREAM,
  readLatestStream,
  S3ManifestStore,
  sealChunkWithManifest,
  writeChunkManifest,
  type ManifestStore,
  type S3ManifestBackend,
  type SealedChunk,
} from "../lib/r2_chunk_manifest.ts";
import type { CasR2ClientLike } from "../lib/r2_manifest_cas.ts";
import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
} from "../services/blob_and_live_bets_server.ts";

const PREFIX = "manifests/live-bets";
const SHA = "a".repeat(64);
const TS = 1_731_900_000_123_456_789n;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function localStore(): LocalDirManifestStore {
  const dir = mkdtempSync(join(tmpdir(), "sd-chunk-manifest-"));
  dirs.push(dir);
  return new LocalDirManifestStore(dir);
}

function chunk(overrides: Partial<SealedChunk> = {}): SealedChunk {
  return {
    channel: "live-bets",
    slot: "slot-7",
    timestamp_ns: TS,
    chunk_key: `chunks/${SHA}.bin`,
    sha256: SHA,
    bytes: 2048,
    wager_count: 12,
    ...overrides,
  };
}

class FakeS3Backend implements S3ManifestBackend {
  readonly objects = new Map<string, string>();
  readonly writes: { path: string; type: string | undefined }[] = [];
  failWrites = false;

  async write(
    path: string,
    data: string,
    options?: { readonly type?: string },
  ): Promise<number> {
    if (this.failWrites) throw new Error("S3 503 SlowDown");
    this.writes.push({ path, type: options?.type });
    this.objects.set(path, data);
    return data.length;
  }

  file(path: string): {
    exists(): Promise<boolean>;
    stream(): ReadableStream<Uint8Array>;
  } {
    return {
      exists: async () => this.objects.has(path),
      stream: () => new Response(this.objects.get(path) ?? "").body!,
    };
  }
}

describe("chunk manifests", () => {
  test("round-trip keeps timestamp_ns a string and reports ACTIVE", async () => {
    const store = localStore();
    const written = await writeChunkManifest(store, PREFIX, chunk());
    expect(written.manifestKey).toBe(
      `${PREFIX}/live-bets/slot-7/${TS.toString()}.yaml`,
    );
    expect(written.latestKey).toBe(`${PREFIX}/live-bets/latest.yaml`);
    expect(written.latestAdvanced).toBe(true);

    const raw = await Bun.file(join(store.root, written.manifestKey)).text();
    const parsed = Bun.YAML.parse(raw) as Record<string, unknown>;
    expect(parsed.timestamp_ns).toBe(TS.toString());
    expect(typeof parsed.timestamp_ns).toBe("string");

    const state = await readLatestStream(store, PREFIX, "live-bets");
    expect(state).toEqual({ status: "active", manifest: written.manifest });
    expect(await loadStreamTelemetry(store, PREFIX, ["live-bets"])).toEqual([
      {
        channel: "live-bets",
        status: "ACTIVE",
        slot: "slot-7",
        timestamp_ns: TS.toString(),
        wager_count: 12,
        bytes: 2048,
      },
    ]);
  });

  test("a missing manifest shows NO ACTIVE STREAM", async () => {
    const store = localStore();
    expect(await loadStreamTelemetry(store, PREFIX, ["live-bets"])).toEqual([
      { channel: "live-bets", status: NO_ACTIVE_STREAM, reason: "missing" },
    ]);

    const written = await writeChunkManifest(store, PREFIX, chunk());
    rmSync(join(store.root, written.manifestKey));
    expect(await readLatestStream(store, PREFIX, "live-bets")).toEqual({
      status: "missing",
    });
  });

  test("a body that was already used shows NO ACTIVE STREAM", async () => {
    const backing = localStore();
    await writeChunkManifest(backing, PREFIX, chunk());
    const consumed: ManifestStore = {
      put: (key, yaml) => backing.put(key, yaml),
      async get(key) {
        const response = await backing.get(key);
        if (response === null) return null;
        await response.text();
        return response;
      },
    };
    expect(await loadStreamTelemetry(consumed, PREFIX, ["live-bets"])).toEqual([
      { channel: "live-bets", status: NO_ACTIVE_STREAM, reason: "body-used" },
    ]);
  });

  test("channels and slots come from the chunk, one key per chunk", async () => {
    const store = localStore();
    const a = await writeChunkManifest(store, PREFIX, chunk());
    const b = await writeChunkManifest(
      store,
      PREFIX,
      chunk({ channel: "gslive-wagers", slot: "s2", timestamp_ns: "42" }),
    );
    const c = await writeChunkManifest(
      store,
      PREFIX,
      chunk({ slot: "slot-8", timestamp_ns: TS + 1n }),
    );
    expect([a.manifestKey, b.manifestKey, c.manifestKey]).toEqual([
      manifestKey(PREFIX, "live-bets", "slot-7", TS.toString()),
      `${PREFIX}/gslive-wagers/s2/42.yaml`,
      `${PREFIX}/live-bets/slot-8/${(TS + 1n).toString()}.yaml`,
    ]);
    expect(latestPointerKey(PREFIX, "gslive-wagers")).toBe(b.latestKey);

    const view = await loadStreamTelemetry(store, PREFIX, [
      "live-bets",
      "gslive-wagers",
      "idle",
    ]);
    expect(view.map((entry) => [entry.channel, entry.status])).toEqual([
      ["live-bets", "ACTIVE"],
      ["gslive-wagers", "ACTIVE"],
      ["idle", NO_ACTIVE_STREAM],
    ]);
    expect(view[0]).toMatchObject({ slot: "slot-8" });
    expect(view[1]).toMatchObject({ slot: "s2", timestamp_ns: "42" });
  });

  test("an out-of-order chunk does not move the latest pointer back", async () => {
    const store = localStore();
    await writeChunkManifest(store, PREFIX, chunk({ timestamp_ns: "200" }));
    const late = await writeChunkManifest(
      store,
      PREFIX,
      chunk({ slot: "old", timestamp_ns: "100" }),
    );
    expect(late.latestAdvanced).toBe(false);
    const state = await readLatestStream(store, PREFIX, "live-bets");
    expect(state.status === "active" && state.manifest.timestamp_ns).toBe(
      "200",
    );
  });

  test("rejects negative counts, numeric timestamps and bad keys", async () => {
    const store = localStore();
    for (const bad of [
      chunk({ wager_count: -1 }),
      chunk({ bytes: -5 }),
      chunk({ wager_count: 1.5 }),
      chunk({ timestamp_ns: "1.7e18" }),
      chunk({ channel: "Live/Bets" }),
      chunk({ slot: "../x" }),
      chunk({ sha256: "nothex" }),
    ]) {
      await expect(
        writeChunkManifest(store, PREFIX, bad),
      ).rejects.toBeInstanceOf(ManifestInvalid);
    }
    await expect(
      writeChunkManifest(store, "../up", chunk()),
    ).rejects.toBeInstanceOf(ManifestInvalid);
  });

  test("a corrupt or mismatched manifest fails loudly", async () => {
    const store = localStore();
    const written = await writeChunkManifest(store, PREFIX, chunk());
    await store.put(written.manifestKey, "version: 1\nwager_count: -3\n");
    await expect(
      readLatestStream(store, PREFIX, "live-bets"),
    ).rejects.toBeInstanceOf(ManifestInvalid);
    await store.put(written.latestKey, "[unterminated");
    await expect(
      readLatestStream(store, PREFIX, "live-bets"),
    ).rejects.toBeInstanceOf(ManifestInvalid);
  });
});

describe("S3ManifestStore over a mocked Bun.S3Client", () => {
  test("writes YAML objects at the chunk and latest keys and reads them back", async () => {
    const backend = new FakeS3Backend();
    const store = new S3ManifestStore(backend);
    const written = await writeChunkManifest(store, PREFIX, chunk());
    expect(backend.writes).toEqual([
      { path: written.manifestKey, type: "application/yaml" },
      { path: written.latestKey, type: "application/yaml" },
    ]);
    expect(Bun.YAML.parse(backend.objects.get(written.latestKey)!)).toEqual({
      version: 1,
      channel: "live-bets",
      slot: "slot-7",
      timestamp_ns: TS.toString(),
      manifest_key: written.manifestKey,
    });
    expect(await readLatestStream(store, PREFIX, "live-bets")).toEqual({
      status: "active",
      manifest: written.manifest,
    });
    expect(await store.get("nope.yaml")).toBeNull();
  });

  test("backend failures surface as ManifestStoreError", async () => {
    const backend = new FakeS3Backend();
    backend.failWrites = true;
    const error = await writeChunkManifest(
      new S3ManifestStore(backend),
      PREFIX,
      chunk(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManifestStoreError);
    expect((error as ManifestStoreError).operation).toBe("put");
    expect((error as Error).message).toContain("S3 503 SlowDown");
  });

  test("sealChunkWithManifest uploads the chunk then its manifest", async () => {
    const chunkObjects = new Map<string, Uint8Array>();
    const cas: CasR2ClientLike = {
      headEtag: async (key) => (chunkObjects.has(key) ? '"etag-1"' : null),
      write: async (key, data) => {
        const bytes =
          typeof data === "string" ? new TextEncoder().encode(data) : data;
        chunkObjects.set(key, bytes);
        return bytes.byteLength;
      },
      writeWithMetadata: async () => 0,
      file: () => ({
        text: async () => "",
        bytes: async () => new Uint8Array(0),
      }),
      stat: async () => ({}),
    };
    const backend = new FakeS3Backend();
    const payload = new TextEncoder().encode('{"wager":1}\n{"wager":2}\n');
    const sha = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    const written = await sealChunkWithManifest(
      cas,
      new S3ManifestStore(backend),
      PREFIX,
      {
        bytes: payload,
        channel: "gslive-wagers",
        slot: "s9",
        timestamp_ns: TS,
        wager_count: 2,
      },
    );
    expect([...chunkObjects.keys()]).toEqual([`chunks/${sha}.bin`]);
    expect(written.manifest).toEqual({
      version: 1,
      channel: "gslive-wagers",
      slot: "s9",
      timestamp_ns: TS.toString(),
      chunk_key: `chunks/${sha}.bin`,
      sha256: sha,
      bytes: payload.byteLength,
      wager_count: 2,
    });

    await expect(
      sealChunkWithManifest(cas, new S3ManifestStore(backend), PREFIX, {
        bytes: payload,
        channel: "gslive-wagers",
        slot: "s9",
        timestamp_ns: TS,
        wager_count: -1,
      }),
    ).rejects.toBeInstanceOf(ManifestInvalid);
    expect(chunkObjects.size).toBe(1);
  });
});

describe("config/blob-live.yaml", () => {
  test("the committed config parses with Bun.YAML", async () => {
    const config = await loadBlobLiveConfig();
    expect(config.channels.length).toBeGreaterThan(0);
    expect(config.hostname).toBe("127.0.0.1");
    expect(typeof config.port).toBe("number");
    expect(config.bucket.length).toBeGreaterThan(0);
    expect(config.manifest_prefix.length).toBeGreaterThan(0);
  });

  test("invalid config is rejected by name", () => {
    expect(() => parseBlobLiveConfig("port: [")).toThrow(BlobLiveConfigInvalid);
    expect(() =>
      parseBlobLiveConfig(
        "port: 1\nhostname: h\nchannels: []\nbucket: bkt\nmanifest_prefix: p\n",
      ),
    ).toThrow(BlobLiveConfigInvalid);
    expect(() =>
      parseBlobLiveConfig(
        "port: 1\nhostname: h\nchannels: [a]\nbucket: bkt\nmanifest_prefix: p\nsecret: x\n",
      ),
    ).toThrow(BlobLiveConfigInvalid);
  });
});

describe("/health streams telemetry", () => {
  test("reports NO ACTIVE STREAM per channel without a manifest", async () => {
    const store = localStore();
    await writeChunkManifest(store, PREFIX, chunk());
    const streamTelemetry = await loadStreamTelemetry(store, PREFIX, [
      "live-bets",
      "gslive-wagers",
    ]);
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
        streams: { channel: string; status: string }[];
      };
      expect(body.streams.map((entry) => entry.status)).toEqual([
        "ACTIVE",
        NO_ACTIVE_STREAM,
      ]);
    } finally {
      close(true);
    }
  });
});
