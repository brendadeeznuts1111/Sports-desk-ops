import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
