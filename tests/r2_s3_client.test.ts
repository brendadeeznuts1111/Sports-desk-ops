import { afterEach, describe, expect, test } from "bun:test";

import {
  R2S3Client,
  type R2S3ClientBackend,
  resolveR2S3Options,
  sha256Hex,
} from "../lib/r2_s3_client.ts";

class FakeBackend implements R2S3ClientBackend {
  readonly writes: { key: string; type: string | undefined }[] = [];
  readonly presigns: { key: string; method: string | undefined }[] = [];
  readonly deletes: string[] = [];

  file(): Bun.S3File {
    return undefined as unknown as Bun.S3File;
  }

  async write(
    path: string,
    data: Uint8Array | string,
    options?: Bun.S3Options,
  ): Promise<number> {
    this.writes.push({ key: path, type: options?.type });
    return typeof data === "string"
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength;
  }

  presign(path: string, options?: Bun.S3FilePresignOptions): string {
    this.presigns.push({ key: path, method: options?.method });
    return `https://r2.test/${path}?sig=test`;
  }

  async stat(): Promise<Bun.S3Stats> {
    return {
      size: 42,
      lastModified: new Date(0),
      etag: "etag",
      type: "image/webp",
    };
  }

  async exists(): Promise<boolean> {
    return true;
  }

  async size(): Promise<number> {
    return 42;
  }

  async list(): Promise<Bun.S3ListObjectsResponse> {
    return { contents: [], isTruncated: false };
  }

  async delete(path: string): Promise<void> {
    this.deletes.push(path);
  }

  async unlink(path: string): Promise<void> {
    this.deletes.push(path);
  }
}

const openaiEnv = {
  R2_BUCKET_NAME: "bucket",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret",
} as const;

afterEach(() => {
  // restore any fetch stub
  globalThis.fetch = originalFetch;
});
const originalFetch = globalThis.fetch;

describe("resolveR2S3Options", () => {
  test("resolves R2 credentials and derives the R2 endpoint", () => {
    expect(resolveR2S3Options(openaiEnv)).toEqual({
      bucket: "bucket",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "access",
      secretAccessKey: "secret",
      publicBase: "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
    });
  });

  test("falls back to S3_* then AWS_*", () => {
    expect(
      resolveR2S3Options({
        S3_BUCKET: "s3bucket",
        S3_ENDPOINT: "https://s3.example",
        S3_ACCESS_KEY_ID: "s3-access",
        S3_SECRET_ACCESS_KEY: "s3-secret",
      })?.accessKeyId,
    ).toBe("s3-access");
    expect(
      resolveR2S3Options({
        AWS_BUCKET: "awsbucket",
        AWS_ENDPOINT_URL_S3: "https://aws.example",
        AWS_ACCESS_KEY_ID: "aws-access",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      })?.bucket,
    ).toBe("awsbucket");
  });

  test("derives access keys from a Cloudflare R2 API token pair", () => {
    const options = resolveR2S3Options({
      R2_BUCKET_NAME: "bucket",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_R2_TOKEN_ID: "token-id",
      CLOUDFLARE_R2_API_TOKEN: "token-value",
    });
    expect(options?.accessKeyId).toBe("token-id");
    expect(options?.secretAccessKey).toBe(sha256Hex("token-value"));
  });

  test("returns null when bucket, endpoint or credentials are missing", () => {
    expect(resolveR2S3Options({})).toBeNull();
    expect(
      resolveR2S3Options({ R2_BUCKET_NAME: "bucket", R2_ACCESS_KEY_ID: "a" }),
    ).toBeNull();
  });
});

describe("R2S3Client uploads", () => {
  test("writeWithMetadata presigns a PUT and sends x-amz-meta-* headers", async () => {
    const backend = new FakeBackend();
    const client = R2S3Client.fromOptions(
      {
        bucket: "bucket",
        endpoint: "https://r2.test",
        accessKeyId: "a",
        secretAccessKey: "s",
        publicBase: "https://pub.test",
      },
      backend,
    );
    let captured:
      | {
          readonly url: string;
          readonly method: string;
          readonly headers: Headers;
        }
      | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      };
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const bytes = new Uint8Array([1, 2, 3]);
    const written = await client.writeWithMetadata("blobs/k.webp", bytes, {
      type: "image/webp",
      metadata: { surface: "blob", Author: "desk" },
    });

    expect(written).toBe(3);
    expect(backend.presigns).toEqual([{ key: "blobs/k.webp", method: "PUT" }]);
    expect(captured?.method).toBe("PUT");
    expect(captured?.url).toContain("blobs/k.webp");
    expect(captured?.headers.get("x-amz-meta-surface")).toBe("blob");
    expect(captured?.headers.get("x-amz-meta-author")).toBe("desk");
    expect(captured?.headers.get("content-type")).toBe("image/webp");
  });

  test("write delegates to S3Client.write with the content type", async () => {
    const backend = new FakeBackend();
    const client = R2S3Client.fromOptions(
      {
        bucket: "bucket",
        endpoint: "https://r2.test",
        accessKeyId: "a",
        secretAccessKey: "s",
        publicBase: "https://pub.test",
      },
      backend,
    );
    await client.write("a.txt", "hello", "text/plain");
    expect(backend.writes).toEqual([{ key: "a.txt", type: "text/plain" }]);
  });

  test("forwards stat/exists/size/list/presign/delete/unlink/file", async () => {
    const backend = new FakeBackend();
    const client = R2S3Client.fromOptions(
      {
        bucket: "bucket",
        endpoint: "https://r2.test",
        accessKeyId: "a",
        secretAccessKey: "s",
        publicBase: "https://pub.test",
      },
      backend,
    );
    expect((await client.stat("x")).size).toBe(42);
    expect(await client.exists("x")).toBe(true);
    expect(await client.size("x")).toBe(42);
    expect((await client.list()).contents).toEqual([]);
    expect(client.presign("x", { expiresIn: 60 })).toContain("x");
    await client.delete("x");
    await client.unlink("y");
    expect(backend.deletes).toEqual(["x", "y"]);
  });
});
