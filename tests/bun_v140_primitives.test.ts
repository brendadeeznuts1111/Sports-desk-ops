import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readF402TickerJsonl } from "../lib/f402_bet_ticker_jsonl.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bun-v140-"));
  dirs.push(dir);
  return dir;
}
async function compress(
  text: string,
  format: "gzip" | "zstd",
): Promise<Uint8Array> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("Bun v1.4.0 primitives", () => {
  test("reads .jsonl.gz and .jsonl.zst through DecompressionStream + parseChunk", async () => {
    const dir = await tempDir();
    const row = JSON.stringify({
      Login: "x",
      WagerNumber: 7,
      InsertDateTime: "2026-11-03T00:00:00Z",
    });
    const text = `${row}\n`;
    for (const format of ["gzip", "zstd"] as const) {
      const path = join(
        dir,
        `f402-bets.jsonl.${format === "gzip" ? "gz" : "zst"}`,
      );
      await writeFile(path, await compress(text, format));
      const result = await readF402TickerJsonl(path);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.wagerNumber).toBe("7");
      expect(result.skippedLines).toBe(0);
    }
  });

  test("ANSI-aware terminal helpers", () => {
    const sliceAnsi = (
      Bun as unknown as {
        sliceAnsi: (
          input: string,
          start?: number,
          end?: number,
          ellipsis?: string,
        ) => string;
      }
    ).sliceAnsi;
    expect(sliceAnsi("\x1b[31mhello\x1b[39m", 1, 4)).toBe(
      "\x1b[31mell\x1b[39m",
    );
    expect(sliceAnsi("unicorn", 0, 4, "…")).toBe("uni…");
    expect(sliceAnsi("unicorn", -4, undefined, "…")).toBe("…orn");
    expect(Bun.stringWidth("hello")).toBe(5);
    expect(Bun.stringWidth("\x1b[31mhello\x1b[0m")).toBe(5);
    expect(Bun.stringWidth("\x1b[5A")).toBe(0);
    expect(Bun.stringWidth("👨‍👩‍👧")).toBe(2);
    expect(Bun.stringWidth("🇺🇸")).toBe(2);
    expect(Bun.stringWidth("\x1b]8;;https://bun.sh\x07Bun\x1b]8;;\x07")).toBe(
      3,
    );
    expect(Bun.stringWidth("\u00ad")).toBe(0);
    expect(Bun.stringWidth("e\u0301")).toBe(1);
    expect(Bun.stringWidth("👍🏽")).toBe(2);
    expect(Bun.stringWidth("1️⃣")).toBe(2);
    expect(Bun.stringWidth("中文")).toBe(4);
    expect(Bun.wrapAnsi("The quick brown fox", 10)).toBe(
      "The quick\nbrown fox",
    );
    expect(Bun.wrapAnsi("\x1b[31mThe quick brown fox\x1b[39m", 10)).toBe(
      "\x1b[31mThe quick\x1b[39m\n\x1b[31mbrown fox\x1b[39m",
    );
  });

  test("CompressionStream gzip/zstd/brotli round-trips", async () => {
    const text = "hello gzip zstd brotli";
    for (const format of [
      "gzip",
      "deflate",
      "deflate-raw",
      "zstd",
      "brotli",
    ] as const) {
      const compressed = await new Response(
        new Blob([text])
          .stream()
          .pipeThrough(new CompressionStream(format as never)),
      ).arrayBuffer();
      expect(compressed.byteLength).toBeGreaterThan(0);
      const out = await new Response(
        new Blob([compressed])
          .stream()
          .pipeThrough(new DecompressionStream(format as never)),
      ).text();
      expect(out).toBe(text);
    }
  });

  test("Bun.Archive round-trips from/write/extract", async () => {
    const dir = await tempDir();
    const path = join(dir, "a.tar.gz");
    const archive = new Bun.Archive({
      "hello.txt": "Hello",
      "data.json": '{"a":1}',
    });
    await Bun.Archive.write(path, archive, { compress: "gzip" });
    expect((await readFile(path)).byteLength).toBeGreaterThan(0);
    const out = join(dir, "out");
    await archive.extract(out);
    expect(await readFile(join(out, "hello.txt"), "utf8")).toBe("Hello");
  });

  test("Response.textStream strips BOM and reassembles multibyte characters", async () => {
    const body = new Uint8Array([
      0xef, 0xbb, 0xbf, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x8c, 0x8d,
    ]);
    const chunks: string[] = [];
    for await (const chunk of new Response(body).textStream())
      chunks.push(chunk);
    expect(chunks.join("")).toBe("€🌍");
  });

  test("URLPattern matches the blob route", () => {
    const pattern = new URLPattern({ pathname: "/api/v1/blobs/:key" });
    expect(pattern.test("https://example.test/api/v1/blobs/feed.json")).toBe(
      true,
    );
    expect(
      pattern.exec("https://example.test/api/v1/blobs/feed.json")?.pathname
        .groups.key,
    ).toBe("feed.json");
    expect(pattern.test("https://example.test/api/v1/live-bets")).toBe(false);
  });

  test("node:crypto PQC imports JWK/PEM/DER/encrypted PKCS#8 and ML-KEM keypairs", async () => {
    const { generateKeyPairSync, createPrivateKey, createPublicKey } =
      await import("node:crypto");
    const dsa = generateKeyPairSync("ml-dsa-65");
    const jwk = dsa.publicKey.export({ format: "jwk" }) as {
      kty: string;
      alg: string;
      pub: string;
    };
    expect(jwk.kty).toBe("AKP");
    expect(jwk.alg).toBe("ML-DSA-65");
    expect(typeof jwk.pub).toBe("string");
    const pem = dsa.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string;
    expect(createPrivateKey(pem).asymmetricKeyType).toBe("ml-dsa-65");
    expect(createPublicKey({ key: jwk, format: "jwk" }).asymmetricKeyType).toBe(
      "ml-dsa-65",
    );
    const der = dsa.privateKey.export({
      format: "der",
      type: "pkcs8",
    }) as Buffer;
    expect(
      createPrivateKey({ key: der, format: "der", type: "pkcs8" })
        .asymmetricKeyType,
    ).toBe("ml-dsa-65");
    const encrypted = dsa.privateKey.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: "pw",
    }) as string;
    expect(
      createPrivateKey({ key: encrypted, format: "pem", passphrase: "pw" })
        .asymmetricKeyType,
    ).toBe("ml-dsa-65");
    const kem = generateKeyPairSync("ml-kem-768");
    expect(
      (kem.publicKey.export({ format: "jwk" }) as { kty: string }).kty,
    ).toBe("AKP");
  });

  test("Request.textStream decodes UTF-8 and strips BOM", async () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, 0xe2, 0x82, 0xac]);
    const request = new Request("http://example.test", {
      method: "POST",
      body,
    });
    let text = "";
    for await (const chunk of request.textStream()) text += chunk;
    expect(text).toBe("\u20ac");
  });

  test("PQC key export/import round-trips jwk, raw-public, and raw-seed", async () => {
    const kem = await crypto.subtle.generateKey("ML-KEM-768", true, [
      "encapsulateBits",
      "decapsulateBits",
    ]);
    const pubJwk = await crypto.subtle.exportKey("jwk", kem.publicKey);
    expect((pubJwk as { kty: string }).kty).toBe("AKP");
    expect(
      (
        await crypto.subtle.importKey("jwk", pubJwk, "ML-KEM-768", true, [
          "encapsulateBits",
        ])
      ).type,
    ).toBe("public");
    const rawPublic = await crypto.subtle.exportKey(
      "raw-public",
      kem.publicKey,
    );
    expect(rawPublic.byteLength).toBeGreaterThan(0);
    expect(
      (
        await crypto.subtle.importKey(
          "raw-public",
          rawPublic,
          "ML-KEM-768",
          true,
          ["encapsulateBits"],
        )
      ).type,
    ).toBe("public");
    const rawSeed = await crypto.subtle.exportKey("raw-seed", kem.privateKey);
    expect(rawSeed.byteLength).toBe(64);
    expect(
      (
        await crypto.subtle.importKey("raw-seed", rawSeed, "ML-KEM-768", true, [
          "decapsulateBits",
        ])
      ).type,
    ).toBe("private");
    const clone = structuredClone(kem.publicKey);
    expect(clone.type).toBe("public");
  });

  test("ML-KEM-768 encapsulateKey/decapsulateKey produce matching AES-GCM keys", async () => {
    const kem = await crypto.subtle.generateKey("ML-KEM-768", true, [
      "encapsulateKey",
      "decapsulateKey",
    ]);
    const sharedAlg = { name: "AES-GCM", length: 256 };
    const { sharedKey, ciphertext } = await crypto.subtle.encapsulateKey(
      { name: "ML-KEM-768" },
      kem.publicKey,
      sharedAlg,
      true,
      ["encrypt", "decrypt"],
    );
    const recovered = await crypto.subtle.decapsulateKey(
      { name: "ML-KEM-768" },
      kem.privateKey,
      ciphertext,
      sharedAlg,
      true,
      ["encrypt", "decrypt"],
    );
    const left = new Uint8Array(
      await crypto.subtle.exportKey("raw", sharedKey),
    );
    const right = new Uint8Array(
      await crypto.subtle.exportKey("raw", recovered),
    );
    expect(sharedKey.type).toBe("secret");
    expect(left.byteLength).toBe(32);
    expect(left).toEqual(right);
  });

  test("crypto.subtle ML-DSA-65 signs/verifies and keys survive structuredClone", async () => {
    const data = new TextEncoder().encode("hello");
    const kp = (await crypto.subtle.generateKey("ML-DSA-65", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const sig = await crypto.subtle.sign(
      { name: "ML-DSA-65" },
      kp.privateKey,
      data,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ML-DSA-65" },
        kp.publicKey,
        sig,
        data,
      ),
    ).toBe(true);
    const clone = structuredClone(kp.publicKey);
    expect(clone.type).toBe("public");
    const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as {
      kty: string;
    };
    expect(jwk.kty).toBe("AKP");
  });

  test("Bun.JSONL.parseChunk byte offsets survive multi-byte UTF-8 across chunk splits", async () => {
    const encoder = new TextEncoder();
    const records = [
      {
        Login: "スナイパー",
        CustomerID: "CUST-1",
        WagerNumber: 1,
        ShortDesc: "Football",
        InsertDateTime: "2026-11-03T00:00:00Z",
        AmountWagered: 100,
      },
      {
        Login: "🌍 visitor",
        CustomerID: "CUST-2",
        WagerNumber: 2,
        ShortDesc: "Tennis",
        InsertDateTime: "2026-11-03T00:00:01Z",
        AmountWagered: 200,
      },
      {
        Login: "plain",
        CustomerID: "CUST-3",
        WagerNumber: 3,
        ShortDesc: "Soccer",
        InsertDateTime: "2026-11-03T00:00:02Z",
        AmountWagered: 300,
      },
    ];
    const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const bytes = encoder.encode(text);
    const byteOffsetOf = (needle: string): number =>
      encoder.encode(text.slice(0, text.indexOf(needle))).length;
    const splitOffsets = [
      1,
      // Inside the three-byte "ス" sequence of the first record.
      byteOffsetOf("ス") + 1,
      // Inside the four-byte "🌍" sequence of the second record.
      byteOffsetOf("🌍") + 2,
      // The newline that terminates the final record.
      bytes.length - 1,
    ];

    // `read` counts bytes for Uint8Array input and characters for string input. Both leave the
    // delimiter newline after the last record unread; the difference must be the UTF-8 overhead.
    const fromBytes = Bun.JSONL.parseChunk(bytes);
    const fromString = Bun.JSONL.parseChunk(text);
    expect(fromBytes.error).toBeNull();
    expect(fromString.error).toBeNull();
    expect(fromBytes.values).toEqual(records);
    expect(fromString.values).toEqual(records);
    expect(fromBytes.read).toBe(bytes.length - 1);
    expect(fromString.read).toBe(text.length - 1);
    expect(bytes.length - text.length).toBeGreaterThan(0);
    expect(fromBytes.read - fromString.read).toBe(bytes.length - text.length);

    // Drive a byte cursor over each split. If `read` were treated as a character count, the
    // cursor would land inside a multi-byte sequence and the next record would decode corrupt.
    for (const split of splitOffsets) {
      const values: unknown[] = [];
      let consumed = 0;
      const ends = [...new Set([split, bytes.length])].sort((a, b) => a - b);
      for (const end of ends) {
        if (end <= consumed) continue;
        const chunk = Bun.JSONL.parseChunk(bytes.subarray(consumed, end));
        expect(chunk.error).toBeNull();
        values.push(...chunk.values);
        let next = consumed + chunk.read;
        while (next < end && bytes[next] === 0x0a) next += 1;
        consumed = next;
      }
      expect(values).toEqual(records);
      expect(consumed).toBe(bytes.length);
    }

    // The real reader must resume on the same byte offsets when a write lands inside a
    // multi-byte character: the partial record is held back, then completed by the next read.
    const dir = await tempDir();
    const path = join(dir, "f402-bets.jsonl");
    const expectedLogins = records.map((record) => record.Login);
    for (const split of splitOffsets) {
      await writeFile(path, bytes.subarray(0, split));
      const first = await readF402TickerJsonl(path, {
        windowBytes: 10_000_000,
      });
      await appendFile(path, bytes.subarray(split));
      const second = await readF402TickerJsonl(path, { state: first.state });
      const rows = [...first.rows, ...second.rows];
      expect(rows.map((row) => row.login)).toEqual(expectedLogins);
      expect(rows.map((row) => row.wagerNumber)).toEqual(["1", "2", "3"]);
      expect(second.state.offset).toBe(bytes.length);
      expect(first.skippedLines + second.skippedLines).toBe(0);
    }

    // A full read consumes exactly the file's bytes: the recorded offset is the first unread byte.
    await writeFile(path, bytes);
    const whole = await readF402TickerJsonl(path, { windowBytes: 10_000_000 });
    expect(whole.rows.map((row) => row.login)).toEqual(expectedLogins);
    expect(whole.state.offset).toBe(bytes.length);

    // An initial window that starts inside a multi-byte character drops the line fragment only.
    const start = byteOffsetOf("🌍") + 2;
    const windowed = await readF402TickerJsonl(path, {
      windowBytes: bytes.length - start,
    });
    expect(windowed.reset).toBe("initial");
    expect(windowed.rows.map((row) => row.login)).toEqual(["plain"]);
    expect(windowed.state.offset).toBe(bytes.length);
    expect(windowed.skippedLines).toBe(0);
  });

  test("ML-KEM-768 encapsulates and decapsulates; node:crypto ML-DSA-65 signs and verifies", async () => {
    const kem = await crypto.subtle.generateKey("ML-KEM-768", true, [
      "encapsulateBits",
      "decapsulateBits",
    ]);
    const { sharedKey, ciphertext } = await crypto.subtle.encapsulateBits(
      { name: "ML-KEM-768" },
      kem.publicKey,
    );
    const recovered = await crypto.subtle.decapsulateBits(
      { name: "ML-KEM-768" },
      kem.privateKey,
      ciphertext,
    );
    expect(new Uint8Array(recovered)).toEqual(new Uint8Array(sharedKey));
    const { generateKeyPairSync, sign, verify } = await import("node:crypto");
    const dsa = generateKeyPairSync("ml-dsa-65");
    const sig = sign(undefined, Buffer.from("hello"), dsa.privateKey);
    expect(verify(undefined, Buffer.from("hello"), dsa.publicKey, sig)).toBe(
      true,
    );
    expect(
      (dsa.publicKey.export({ format: "jwk" }) as { kty: string }).kty,
    ).toBe("AKP");
  });
});
