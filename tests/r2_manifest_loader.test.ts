import { describe, expect, test } from "bun:test";

import {
  createScopedR2ManifestClient,
  DEFAULT_R2_MANIFEST_BUCKET,
  loadVerifiedR2Manifest,
  R2ManifestError,
  type R2ManifestBackend,
  type R2ManifestClient,
} from "../lib/r2_manifest_loader.ts";
import { YamlGuardError } from "../lib/yaml_guard.ts";

const KEY = "manifests/desk.yaml";

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

class FakeClient implements R2ManifestClient {
  stats = 0;
  gets = 0;
  pulls = 0;
  cancelled = false;

  constructor(
    private readonly headSize: number,
    private readonly chunks: readonly Uint8Array[] | null,
  ) {}

  stat(): Promise<{ size: number }> {
    this.stats += 1;
    return Promise.resolve({ size: this.headSize });
  }

  getStream(): Promise<ReadableStream<Uint8Array>> {
    this.gets += 1;
    if (this.chunks === null) {
      return Promise.reject(new Error("GET opened"));
    }
    const chunks = this.chunks;
    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        pull: (controller) => {
          const chunk = chunks[this.pulls];
          this.pulls += 1;
          if (chunk === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
        cancel: () => {
          this.cancelled = true;
        },
      }),
    );
  }
}

const MANIFEST =
  "kind: r2-manifest\nversion: 1\nobjects:\n  - key: reports/daily.json\n";

describe("loadVerifiedR2Manifest", () => {
  test("happy path returns the parsed manifest", async () => {
    const bytes = utf8(MANIFEST);
    const client = new FakeClient(bytes.byteLength, [bytes]);
    const loaded = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength,
    });
    expect(loaded).toEqual({
      key: KEY,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      value: {
        kind: "r2-manifest",
        version: 1,
        objects: [{ key: "reports/daily.json" }],
      },
    });
    expect(client.stats).toBe(1);
    expect(client.gets).toBe(1);
  });

  test("HEAD over the byte ceiling does not open GET", async () => {
    const client = new FakeClient(64, null);
    const error = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: "ab".repeat(32),
      expectedBytes: 16,
      maxBytes: 32,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(R2ManifestError);
    expect((error as R2ManifestError).code).toBe("ERR_R2_BYTE_LIMIT");
    expect(client.stats).toBe(1);
    expect(client.gets).toBe(0);
  });

  test("HEAD size mismatch and an empty object do not open GET", async () => {
    const mismatch = new FakeClient(8, null);
    const mismatchError = await loadVerifiedR2Manifest(mismatch, {
      key: KEY,
      expectedSha256: "ab".repeat(32),
      expectedBytes: 4,
      maxBytes: 32,
    }).catch((caught: unknown) => caught);
    expect((mismatchError as R2ManifestError).code).toBe(
      "ERR_R2_SIZE_MISMATCH",
    );
    expect(mismatch.gets).toBe(0);

    const empty = new FakeClient(0, null);
    const emptyError = await loadVerifiedR2Manifest(empty, {
      key: KEY,
      expectedSha256: "ab".repeat(32),
      expectedBytes: 4,
    }).catch((caught: unknown) => caught);
    expect((emptyError as R2ManifestError).code).toBe("ERR_R2_EMPTY_OBJECT");
    expect(empty.gets).toBe(0);
  });

  test("TOCTOU stream growth past maxBytes is a byte limit and stops reading", async () => {
    const head = new Uint8Array(16);
    const overflow = new Uint8Array(64);
    const rest = Array.from({ length: 8 }, () => new Uint8Array(32));
    const client = new FakeClient(16, [head, overflow, ...rest]);
    const error = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: sha256(head),
      expectedBytes: 16,
      maxBytes: 32,
    }).catch((caught: unknown) => caught);
    expect((error as R2ManifestError).code).toBe("ERR_R2_BYTE_LIMIT");
    expect(client.gets).toBe(1);
    expect(client.cancelled).toBe(true);
    // The stream may prefetch one chunk after the overflowing read. It must not
    // drain the rest of the object.
    expect(client.pulls).toBeLessThanOrEqual(3);
  });

  test("TOCTOU growth under the ceiling is a size mismatch", async () => {
    const head = utf8("kind: r2-manifest\n");
    const extra = utf8("version: 2\n");
    const client = new FakeClient(head.byteLength, [head, extra]);
    const error = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: sha256(head),
      expectedBytes: head.byteLength,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);
    expect((error as R2ManifestError).code).toBe("ERR_R2_SIZE_MISMATCH");
  });

  test("tampered sha256 fails before YAML parse", async () => {
    const cyclic = utf8("a: &a\n  self: *a\n");
    const client = new FakeClient(cyclic.byteLength, [cyclic]);
    const error = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: "00".repeat(32),
      expectedBytes: cyclic.byteLength,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(R2ManifestError);
    expect(error).not.toBeInstanceOf(YamlGuardError);
    expect((error as R2ManifestError).code).toBe("ERR_R2_SHA256_MISMATCH");
  });

  test("invalid UTF-8 with a matching digest is ERR_R2_INVALID_UTF8", async () => {
    const bytes = Uint8Array.of(0x80);
    const client = new FakeClient(bytes.byteLength, [bytes]);
    const error = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: sha256(bytes),
      expectedBytes: bytes.byteLength,
    }).catch((caught: unknown) => caught);
    expect((error as R2ManifestError).code).toBe("ERR_R2_INVALID_UTF8");
  });

  test("invalid UTF-8 with a tampered digest fails the digest first", async () => {
    const bytes = Uint8Array.of(0xff, 0xfe);
    const client = new FakeClient(bytes.byteLength, [bytes]);
    const error = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: "11".repeat(32),
      expectedBytes: bytes.byteLength,
    }).catch((caught: unknown) => caught);
    expect((error as R2ManifestError).code).toBe("ERR_R2_SHA256_MISMATCH");
  });

  test("cyclic YAML is YamlGuardError ERR_YAML_CYCLIC_GRAPH", async () => {
    const cyclic = utf8("a: &a\n  self: *a\n");
    const client = new FakeClient(cyclic.byteLength, [cyclic]);
    const error = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: sha256(cyclic),
      expectedBytes: cyclic.byteLength,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(YamlGuardError);
    expect((error as YamlGuardError).code).toBe("ERR_YAML_CYCLIC_GRAPH");
  });

  test("a key outside the prefix or a bad digest never calls the client", async () => {
    const client = new FakeClient(1, null);
    const keyError = await loadVerifiedR2Manifest(client, {
      key: "other/desk.yaml",
      expectedSha256: "ab".repeat(32),
      expectedBytes: 1,
      requiredPrefix: "manifests/",
    }).catch((caught: unknown) => caught);
    expect((keyError as R2ManifestError).code).toBe("ERR_R2_INVALID_KEY");

    const digestError = await loadVerifiedR2Manifest(client, {
      key: KEY,
      expectedSha256: "abcd",
      expectedBytes: 1,
    }).catch((caught: unknown) => caught);
    expect((digestError as R2ManifestError).code).toBe("ERR_R2_INVALID_DIGEST");
    expect(client.stats).toBe(0);
    expect(client.gets).toBe(0);
  });
});

describe("createScopedR2ManifestClient", () => {
  test("defaults the bucket to sportsdesk-ops-reports and can require a prefix", async () => {
    const calls: string[] = [];
    const backend: R2ManifestBackend = {
      stat(bucket, key) {
        calls.push(`stat ${bucket} ${key}`);
        return Promise.resolve({ size: 1 });
      },
      getStream() {
        return Promise.reject(new Error("GET opened"));
      },
    };
    const client = createScopedR2ManifestClient(backend);
    expect(client.bucket).toBe(DEFAULT_R2_MANIFEST_BUCKET);
    expect(client.bucket).toBe("sportsdesk-ops-reports");
    await client.stat(KEY);
    expect(calls).toEqual([`stat sportsdesk-ops-reports ${KEY}`]);

    const scoped = createScopedR2ManifestClient(backend, {
      requiredPrefix: "manifests/",
    });
    const error = await scoped
      .stat("secrets/token")
      .catch((caught: unknown) => caught);
    expect((error as R2ManifestError).code).toBe("ERR_R2_INVALID_KEY");
    expect(calls).toEqual([`stat sportsdesk-ops-reports ${KEY}`]);
  });
});
