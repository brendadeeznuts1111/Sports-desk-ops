import { describe, expect, test } from "bun:test";

import { assertSafeTar, assertSafeTarGz } from "../lib/eod_archive.ts";

/**
 * `Bun.Archive.extract()` contains `../` and absolute paths, but follows symlink entries:
 * a tar with `link -> /outside` plus `link/evil` writes outside the destination (measured on
 * 1.4.4). EOD verification therefore rejects links before extracting. These tests build the
 * hostile headers directly so the guard does not depend on a tar CLI.
 */

type Entry = {
  name: string;
  type: string;
  data?: string;
  link?: string;
};

function header(entry: Entry): Uint8Array {
  const bytes = new Uint8Array(512);
  const encoder = new TextEncoder();
  const data = encoder.encode(entry.data ?? "");
  bytes.set(encoder.encode(entry.name).subarray(0, 100), 0);
  bytes.set(encoder.encode("0000644\0"), 100);
  bytes.set(encoder.encode("0000000\0"), 108);
  bytes.set(encoder.encode("0000000\0"), 116);
  bytes.set(
    encoder.encode(`${data.length.toString(8).padStart(11, "0")}\0`),
    124,
  );
  bytes.set(encoder.encode("00000000000\0"), 136);
  bytes.set(encoder.encode("        "), 148);
  bytes[156] = entry.type.charCodeAt(0);
  if (entry.link !== undefined) {
    bytes.set(encoder.encode(entry.link).subarray(0, 100), 157);
  }
  bytes.set(encoder.encode("ustar\0" + "00"), 257);
  return bytes;
}

function tar(entries: readonly Entry[]): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    blocks.push(header(entry));
    const data = encoder.encode(entry.data ?? "");
    if (data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

describe("EOD archive safety guard", () => {
  test("accepts normal Bun.Archive tar and gzip", async () => {
    const plain = await new Bun.Archive({ "safe/ok.txt": "hi" }).bytes();
    expect(() => assertSafeTar(plain)).not.toThrow();

    const gzip = await new Bun.Archive(
      { "safe/ok.txt": "hi" },
      { compress: "gzip" },
    ).bytes();
    expect(() => assertSafeTarGz(gzip)).not.toThrow();
  });

  test("accepts long names encoded by the tar writer", async () => {
    const longName = `safe/${"a".repeat(120)}.txt`;
    const bytes = await new Bun.Archive({ [longName]: "x" }).bytes();
    expect(() => assertSafeTar(bytes)).not.toThrow();
  });

  test("rejects traversal names", async () => {
    const plain = await new Bun.Archive({ "../escape.txt": "x" }).bytes();
    expect(() => assertSafeTar(plain)).toThrow(/unsafe tar entry/);

    const gzip = await new Bun.Archive(
      { "../../escape.txt": "x" },
      { compress: "gzip" },
    ).bytes();
    expect(() => assertSafeTarGz(gzip)).toThrow(/unsafe tar entry/);
  });

  test("rejects absolute names", () => {
    const bytes = tar([{ name: "/tmp/evil.txt", type: "0", data: "x" }]);
    expect(() => assertSafeTar(bytes)).toThrow(/unsafe tar entry/);
  });

  test("rejects symlink and hardlink entries", () => {
    const symlink = tar([
      { name: "link", type: "2", link: "/tmp/outside" },
      { name: "link/evil.txt", type: "0", data: "pwn" },
    ]);
    expect(() => assertSafeTar(symlink)).toThrow(/unsupported tar entry type/);

    const hardlink = tar([{ name: "link", type: "1", link: "safe/ok.txt" }]);
    expect(() => assertSafeTar(hardlink)).toThrow(/unsupported tar entry type/);
  });
});
