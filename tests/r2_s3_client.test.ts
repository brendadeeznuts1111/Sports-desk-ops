import { afterEach, describe, expect, test } from "bun:test";

import {
  isS3Error,
  isS3ErrorCode,
  R2S3Client,
  R2_SECRETS_SERVICE,
  resolveR2CredentialsAsync,
  secretSetOptions,
  assertSecretField,
  assertSecretValue,
  type R2S3ClientBackend,
  S3_ERROR_CODES,
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

  test("credential precedence is R2 → token → S3 → AWS", () => {
    const full = {
      R2_BUCKET_NAME: "bucket",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "r2-access",
      R2_SECRET_ACCESS_KEY: "r2-secret",
      CLOUDFLARE_R2_TOKEN_ID: "token-id",
      CLOUDFLARE_R2_API_TOKEN: "token-value",
      S3_ACCESS_KEY_ID: "s3-access",
      S3_SECRET_ACCESS_KEY: "s3-secret",
      AWS_ACCESS_KEY_ID: "aws-access",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    };
    expect(resolveR2S3Options(full)?.accessKeyId).toBe("r2-access");

    const withoutR2 = { ...full };
    delete (withoutR2 as { R2_ACCESS_KEY_ID?: string }).R2_ACCESS_KEY_ID;
    delete (withoutR2 as { R2_SECRET_ACCESS_KEY?: string })
      .R2_SECRET_ACCESS_KEY;
    expect(resolveR2S3Options(withoutR2)?.accessKeyId).toBe("token-id");
    expect(resolveR2S3Options(withoutR2)?.secretAccessKey).toBe(
      sha256Hex("token-value"),
    );

    expect(
      resolveR2S3Options({
        S3_BUCKET: "s3bucket",
        S3_ENDPOINT: "https://s3.example",
        S3_ACCESS_KEY_ID: "s3-access",
        S3_SECRET_ACCESS_KEY: "s3-secret",
        AWS_ACCESS_KEY_ID: "aws-access",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      })?.accessKeyId,
    ).toBe("s3-access");

    expect(
      resolveR2S3Options({
        AWS_BUCKET: "awsbucket",
        AWS_ENDPOINT: "https://aws.example",
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

  test("queries the canonical service and keeps a legacy read fallback", async () => {
    const seen: string[] = [];
    const secrets = {
      async get({ service, name }: { service: string; name: string }) {
        seen.push(service);
        if (service === "sportsdesk-ops" && name === "R2_ACCESS_KEY_ID") {
          return "legacy-access";
        }
        if (
          service === "com.bookdeskops.sportsdesk" &&
          name === "R2_ACCESS_KEY_ID"
        ) {
          return "canonical-access";
        }
        if (name === "R2_SECRET_ACCESS_KEY") return "secret";
        if (name === "R2_BUCKET_NAME") return "bucket";
        if (name === "CLOUDFLARE_ACCOUNT_ID") return "account";
        return null;
      },
    };
    const resolved = await resolveR2CredentialsAsync({}, secrets);
    expect(resolved?.accessKeyId).toBe("canonical-access");
    expect(seen[0]).toBe(R2_SECRETS_SERVICE);
    expect(seen).toContain("sportsdesk-ops");
  });

  test("secret bounds and persist local are enforced", () => {
    expect(() => assertSecretField("x".repeat(256), "service")).toThrow();
    expect(() => assertSecretField("bad\u0000name", "name")).toThrow();
    expect(() => assertSecretValue("x".repeat(2049))).toThrow(/2048/);
    expect(
      secretSetOptions("com.bookdeskops.sportsdesk", "name", "value"),
    ).toEqual({
      service: "com.bookdeskops.sportsdesk",
      name: "name",
      value: "value",
      persist: "local",
    });
  });

  test("falls back to Bun.secrets after env precedence", async () => {
    const secrets = {
      async get({ name }: { service: string; name: string }) {
        const values: Record<string, string> = {
          R2_ACCESS_KEY_ID: "secret-access",
          R2_SECRET_ACCESS_KEY: "secret-secret",
          CLOUDFLARE_ACCOUNT_ID: "secret-account",
          R2_BUCKET_NAME: "secret-bucket",
        };
        return values[name] ?? null;
      },
    };
    const fromSecrets = await resolveR2CredentialsAsync({}, secrets);
    expect(fromSecrets?.accessKeyId).toBe("secret-access");
    expect(fromSecrets?.bucket).toBe("secret-bucket");
    expect(fromSecrets?.endpoint).toBe(
      "https://secret-account.r2.cloudflarestorage.com",
    );

    const envWins = await resolveR2CredentialsAsync(openaiEnv, secrets);
    expect(envWins?.accessKeyId).toBe("access");
    expect(envWins?.bucket).toBe("bucket");
  });

  test("returns null when bucket, endpoint or credentials are missing", () => {
    expect(resolveR2S3Options({})).toBeNull();
    expect(
      resolveR2S3Options({ R2_BUCKET_NAME: "bucket", R2_ACCESS_KEY_ID: "a" }),
    ).toBeNull();
  });
});

describe("R2S3Client uploads", () => {
  test("writeWithMetadata signs a PUT and sends x-amz-meta-* headers", async () => {
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
    expect(backend.presigns).toEqual([]);
    expect(captured?.method).toBe("PUT");
    expect(captured?.url).toBe("https://r2.test/bucket/blobs/k.webp");
    expect(captured?.headers.get("authorization")).toStartWith(
      "AWS4-HMAC-SHA256 Credential=a/",
    );
    expect(captured?.headers.get("x-amz-meta-surface")).toBe("blob");
    expect(captured?.headers.get("x-amz-meta-author")).toBe("desk");
    expect(captured?.headers.get("content-type")).toBe("image/webp");
  });

  test("writeWithMetadata without metadata delegates to S3Client.write", async () => {
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
    await client.writeWithMetadata("a.txt", "hello", { type: "text/plain" });
    expect(backend.writes).toEqual([{ key: "a.txt", type: "text/plain" }]);
  });

  test("redirectResponse wraps the lazy S3File in a Response", async () => {
    const backend = new FakeBackend();
    backend.file = (): Bun.S3File =>
      new Blob(["blob-bytes"], {
        type: "application/octet-stream",
      }) as unknown as Bun.S3File;
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
    const response = client.redirectResponse("blobs/one.webp");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("blob-bytes");
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
    await client.write("a.txt", "hello", { type: "text/plain" });
    expect(backend.writes).toEqual([{ key: "a.txt", type: "text/plain" }]);
  });

  test("sliceBytes reads a range through S3File.slice", async () => {
    const backend = new FakeBackend();
    backend.file = (): Bun.S3File =>
      ({
        slice: (start: number, end?: number) => ({
          arrayBuffer: async () =>
            new TextEncoder().encode("hello-world").slice(start, end).buffer,
        }),
      }) as unknown as Bun.S3File;
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
    expect(new TextDecoder().decode(await client.sliceBytes("x", 6, 11))).toBe(
      "world",
    );
  });

  test("stat never reads the deprecated S3File.size property", async () => {
    const backend = new FakeBackend();
    backend.file = (): Bun.S3File => {
      throw new Error("stat must not touch S3File.size");
    };
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
  });

  test("stat recovers the size when R2 HEAD omits Content-Length", async () => {
    const backend = new FakeBackend();
    backend.stat = async (): Promise<Bun.S3Stats> => ({
      size: 0,
      lastModified: new Date(0),
      etag: "etag",
      type: "application/json",
    });
    backend.file = (): Bun.S3File =>
      new Blob(["forty-two-bytes"], {
        type: "application/json",
      }) as unknown as Bun.S3File;
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
    expect((await client.stat("x")).size).toBe(15);
  });

  test("classifies all six ERR_S3_* codes and S3Error", () => {
    for (const code of S3_ERROR_CODES) {
      expect(isS3ErrorCode(code)).toBe(true);
      const err = Object.assign(new Error("s3 failure"), { code });
      expect(isS3Error(err)).toBe(true);
    }
    const named = Object.assign(new Error("service error"), {
      name: "S3Error",
    });
    expect(isS3Error(named)).toBe(true);
    expect(isS3Error(new Error("plain"))).toBe(false);
    expect(isS3ErrorCode("ERR_NOT_S3")).toBe(false);
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
