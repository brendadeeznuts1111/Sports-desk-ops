/**
 * @file tests/bun_modules_surface.test.ts
 * @description Evidence for the canonical `Modules / Bun` surface (the 109-member list).
 *
 * The shape catalogue derives membership from production usage, so a canonical member the
 * desk does not call yet still needs a resolvable `test:` evidence ref. These cases touch the
 * primitives directly and assert behaviour where it is cheap; they never snapshot vendor
 * output bytes (hash and UUID values are checked by shape, not by literal).
 */

import { describe, expect, test } from "bun:test";

const DIGESTS = [
  Bun.MD4,
  Bun.MD5,
  Bun.SHA1,
  Bun.SHA224,
  Bun.SHA256,
  Bun.SHA384,
  Bun.SHA512,
  Bun.SHA512_256,
] as const;

describe("canonical Bun module surface", () => {
  test("digest classes produce hex digests", () => {
    for (const Digest of DIGESTS) {
      const digest = new Digest().update("sportsdesk").digest("hex");
      expect(digest).toMatch(/^[0-9a-f]+$/);
    }
  });

  test("zstd round-trips through the async decompressor", async () => {
    const compressed = Bun.zstdCompressSync("sportsdesk-zstd");
    const plain = await Bun.zstdDecompress(compressed);
    expect(new TextDecoder().decode(plain)).toBe("sportsdesk-zstd");
  });

  test("readableStreamToArray consumes a response body", async () => {
    const chunks = await Bun.readableStreamToArray(
      new Response("stream-payload").body!,
    );
    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks
      .map((chunk) =>
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      )
      .join("");
    expect(text).toBe("stream-payload");
  });

  test("readableStreamToFormData parses a multipart body", async () => {
    const boundary = "sportsdesk-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="stream"',
      "",
      "gslive-tally",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const form = await Bun.readableStreamToFormData(
      new Response(body).body!,
      boundary,
    );
    expect(form.get("stream")).toBe("gslive-tally");
  });

  test("randomUUIDv5 is deterministic per namespace", () => {
    const first = Bun.randomUUIDv5("www.example.com", "url");
    expect(first).toBe(Bun.randomUUIDv5("www.example.com", "url"));
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("peek and ModuleGraph are present on this build", () => {
    expect(Bun.peek(Promise.resolve(1))).toBeDefined();
    expect(typeof Bun.ModuleGraph).toBe("function");
  });

  test("remaining canonical value modules are present on this build", () => {
    expect(typeof Bun.deepMatch).toBe("function");
    expect(typeof Bun.deflateSync).toBe("function");
    expect(Array.isArray(Bun.embeddedFiles)).toBe(true);
    expect(typeof Bun.FileSystemRouter).toBe("function");
    expect(typeof Bun.inflateSync).toBe("function");
    expect(typeof Bun.isMainThread).toBe("boolean");
    expect(typeof Bun.mmap).toBe("function");
    expect(typeof Bun.plugin).toBe("function");
    expect(typeof Bun.redis).toBe("object");
    expect(typeof Bun.resolve).toBe("function");
    expect(typeof Bun.sha).toBe("function");
    expect(typeof Bun.stderr).toBe("object");
    expect(typeof Bun.unsafe).toBe("object");
  });

  test("generateHeapSnapshot is available without writing a snapshot", () => {
    expect(typeof Bun.generateHeapSnapshot).toBe("function");
  });
});
