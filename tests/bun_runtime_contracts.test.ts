/**
 * @file tests/bun_runtime_contracts.test.ts
 * @description Pins the fail-closed contracts of the Bun APIs the ops surfaces
 * feed unhydrated handles and unvalidated ports into.
 *
 * Every assertion here was measured on the pinned runtime
 * (`Bun 1.4.4+38afee6c8`, 2026-11-17) and passes as written. These are
 * regression locks, not behaviour changes: `Bun.hash`, `Bun.CryptoHasher`,
 * `Bun.TOML.parse` and `Bun.indexOfLine` already reject the bad inputs, and
 * `Bun.gzipSync` already validates `memLevel` / `strategy`.
 *
 * What this file does NOT claim: that an empty-input digest
 * (`e3b0c442…`) or a silent `{}` parse was ever reachable on this pin. It was
 * not — the handle is rejected before a digest or a document exists. Add an
 * assertion here only with the measurement that justifies it.
 *
 * @see https://bun.com/reference/bun
 */

import { describe, expect, test } from "bun:test";

/** `Bun.SHA256` ships at runtime but is absent from the 1.4.4 type surface. */
const sha256 = (
  Bun as unknown as { SHA256: { hash: (data: unknown) => string } }
).SHA256;

describe("Bun runtime fail-closed contracts (measured on 1.4.4)", () => {
  test("hashing rejects null, undefined and unhydrated file handles", () => {
    const handle = Bun.file(import.meta.path);

    expect(() => Bun.hash(undefined as unknown as Uint8Array)).toThrow(
      TypeError,
    );
    expect(() => Bun.hash(null as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => Bun.hash(handle as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => Bun.hash.crc32(undefined as unknown as Uint8Array)).toThrow(
      TypeError,
    );
    expect(() => sha256.hash(handle)).toThrow(TypeError);
    expect(() =>
      Bun.CryptoHasher.hash("sha256", handle as unknown as Uint8Array),
    ).toThrow(TypeError);

    // The hydrated path is the only one that yields a digest.
    expect(
      Bun.CryptoHasher.hash("sha256", new Uint8Array([1]), "hex"),
    ).toHaveLength(64);
  });

  test("TOML and YAML parse reject unhydrated file handles", () => {
    const handle = Bun.file(import.meta.path);

    expect(() => Bun.TOML.parse(handle as unknown as string)).toThrow(
      TypeError,
    );
    expect(() => Bun.YAML.parse(handle as unknown as string)).toThrow(
      TypeError,
    );

    expect(Bun.TOML.parse("a = 1")).toEqual({ a: 1 });
    expect(Bun.YAML.parse("a: 1")).toEqual({ a: 1 });
  });

  test("Bun.YAML.parse(undefined) stringifies instead of throwing", () => {
    // Documented fail-open, measured on 1.4.4: the literal string "undefined"
    // comes back, not null, not a TypeError. Bun.TOML.parse(undefined) throws.
    expect(Bun.YAML.parse(undefined as unknown as string)).toBe("undefined");
    expect(() => Bun.TOML.parse(undefined as unknown as string)).toThrow(
      TypeError,
    );
  });

  test("Bun.Archive: re-serialising drops a lazy Blob handle, parsing throws", async () => {
    // The asymmetry is method-dependent, not absolute. Bun.hash, Bun.SHA256,
    // Bun.CryptoHasher, Bun.TOML.parse and Bun.YAML.parse all reject an
    // unhydrated handle with "File blob cannot be used here" (pinned above).
    // Bun.Archive splits by method, because `Blob` is a legal ArchiveInput
    // (bun-types 1.4.4) and `S3File extends Blob` (bun.com/docs/runtime/s3):
    //   bytes() / blob()    -> re-serialise the member set: 0 bytes, no error
    //   files() / extract() -> parse the wrapped bytes and fail closed
    // So the silent-empty hazard is only reachable through the re-serialising
    // methods. A caller that forgets `await handle.bytes()` and reaches for
    // `.bytes()` on the archive gets 0 bytes; one that parses gets an error.
    const localHandle = Bun.file(import.meta.path);
    expect(() => new Bun.Archive(localHandle as never)).not.toThrow();

    expect(await new Bun.Archive(localHandle as never).bytes()).toHaveLength(0);
    await expect(new Bun.Archive(localHandle as never).files()).rejects.toThrow(
      "Unrecognized archive format",
    );
    await expect(
      new Bun.Archive(localHandle as never).extract(
        `${Bun.env.TMPDIR ?? "/tmp"}/unused-archive-extract`,
      ),
    ).rejects.toThrow();
  });

  test("Bun.s3.file is a lazy Blob whose size is not synchronously available", () => {
    // Docs: "Like Bun.file(path), the S3Client's file method is synchronous. It
    // makes no network requests until you call a method that needs one", and
    // "Size is not synchronously available because it requires a network
    // request." Measured: NaN, not 0 — so `size === 0` is never a safe test for
    // "empty object" on a handle; only stat()/bytes() answer that.
    const s3file = Bun.s3.file("bucket/key.json");
    expect(s3file).toBeInstanceOf(Blob);
    expect(Number.isNaN(s3file.size)).toBe(true);
    // Same silent-empty behaviour as the local handle above.
    return expect(
      new Bun.Archive(s3file as never).bytes(),
    ).resolves.toHaveLength(0);
  });

  test("Bun.indexOfLine rejects strings and reports the newline offset", () => {
    expect(() =>
      Bun.indexOfLine("header\npayload\n" as unknown as Uint8Array, 0),
    ).toThrow(TypeError);

    const bytes = new TextEncoder().encode("header\npayload\n");
    expect(Bun.indexOfLine(bytes, 0)).toBe(6);
    expect(Bun.indexOfLine(bytes, 7)).toBe(14);
  });

  test("Bun.dns.prefetch requires an integer port in range", () => {
    for (const port of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      443.5,
      65536,
      -1,
    ]) {
      expect(() => Bun.dns.prefetch("localhost", port)).toThrow(RangeError);
    }
    // Port 0 is inside Bun's accepted range, so prefetchDns skips it instead.
    expect(() => Bun.dns.prefetch("localhost", 65535)).not.toThrow();
  });

  test("Bun.gzipSync validates memLevel 1..9 and strategy 0..4", () => {
    const data = new Uint8Array(4096).fill(0x41);

    for (const memLevel of [0, 10, 12]) {
      expect(() => Bun.gzipSync(data, { level: 6, memLevel } as never)).toThrow(
        RangeError,
      );
    }
    for (const strategy of [5, 9]) {
      expect(() => Bun.gzipSync(data, { level: 6, strategy } as never)).toThrow(
        RangeError,
      );
    }

    for (const memLevel of [1, 9]) {
      expect(
        Bun.gzipSync(data, { level: 6, memLevel } as never).length,
      ).toBeGreaterThan(0);
    }
    for (const strategy of [0, 1, 2, 3, 4]) {
      expect(
        Bun.gzipSync(data, { level: 6, strategy } as never).length,
      ).toBeGreaterThan(0);
    }
    // Strategy is honoured, not ignored: Huffman-only and fixed-Huffman
    // produce bytes that differ from the default.
    const baseline = Bun.gzipSync(data, { level: 6 } as never).length;
    expect(
      Bun.gzipSync(data, { level: 6, strategy: 2 } as never).length,
    ).not.toBe(baseline);
  });
});
