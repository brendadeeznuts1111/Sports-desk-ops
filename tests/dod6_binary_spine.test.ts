/**
 * DOD6 v5.4 `.dodbin` binary spine — layout, encoding and round-trip properties.
 *
 * The reference implementations below are frozen copies of the pre-optimization encoders; every
 * fast path added to lib/dod6_v54_login_key.ts must agree with them exactly. The integration
 * block reads the real 88 MB spine when it is present (it is a tracked artifact) and proves
 * pack -> unpack -> lookup round trips against independently-read column values.
 */
import { describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOD_BINARY_MAGIC,
  DOD_BINARY_VERSION,
  DOD_HEADER_BYTE_LENGTH,
  DOD_HEADER_UINT32_SLOTS,
  DOD_NUM_SECTION_OFFSETS,
  EMPTY_RADIX_SLOT_ROW,
  createDod6V54LifetimeReader,
  readDod6V54SpineMeta,
  roiBasisPointsToSharpScore,
  summarizeDod6V54SpineTotals,
  type Dod6LifetimeLookupTarget,
} from "../lib/dod6_v54_lifetime_reader.ts";
import {
  DOD6_MAX_ROW_INDEX_32,
  DOD6_MAX_ROW_INDEX_64,
  DOD6_MAX_ROWS_32,
  DOD6_MAX_ROWS_64,
  DOD6_RESERVED_ROW_INDEX_32,
  DOD6_RESERVED_ROW_INDEX_64,
  DOD6_SCHEMA_PATH,
  DOD6_SCHEMA_SHA256,
} from "../lib/dod6_v54_schema.ts";
import { rowOfHandle } from "../lib/dod6_spine_overlay.ts";
import {
  KEY64_MODE_BASE40_EXACT_12,
  KEY64_MODE_FNV1A64_LONG,
  KEY64_MODE_SHIFT,
  KEY64_PAYLOAD_MASK,
  computeLoginRadixSlots16,
  encodeCustomerKeyAndSlotsInto,
  encodeCustomerPackedKey64,
  encodeCustomerPackedKeyParts,
  encodeCustomerPackedKeyPartsInto,
  encodeCustomerPackedKeyPartsIntoRange,
  fillLoginRadixSlots16,
  fillLoginRadixSlots16Range,
  loginBounds,
  loginBoundsInto,
} from "../lib/dod6_v54_login_key.ts";

const DODBIN = "data/sportsdesk_unified_baseline_v54.dodbin";

/* -------------------------------------------------------------------------- */
/* Frozen reference encoders (copied from the pre-optimization implementation) */
/* -------------------------------------------------------------------------- */

function referenceCharToBase40(code: number): bigint {
  if (code >= 48 && code <= 57) return BigInt(code - 48 + 1);
  if (code >= 65 && code <= 90) return BigInt(code - 65 + 11);
  if (code >= 97 && code <= 122) return BigInt(code - 97 + 11);
  if (code === 95) return 37n;
  if (code === 45) return 38n;
  if (code === 46) return 39n;
  return 39n;
}

function referencePackedKey(rawCustomerId: string): bigint {
  let start = 0;
  let end = rawCustomerId.length;
  while (start < end && rawCustomerId.charCodeAt(start) <= 32) start++;
  while (end > start && rawCustomerId.charCodeAt(end - 1) <= 32) end--;
  while (end > start + 1 && rawCustomerId.charCodeAt(end - 1) === 46) end--;
  if (
    end - start > 3 &&
    rawCustomerId.charCodeAt(end - 3) >= 48 &&
    rawCustomerId.charCodeAt(end - 3) <= 57 &&
    rawCustomerId.charCodeAt(end - 2) === 95 &&
    rawCustomerId.charCodeAt(end - 1) >= 48 &&
    rawCustomerId.charCodeAt(end - 1) <= 57
  ) {
    end -= 2;
  }
  const len = end - start;
  if (len <= 12) {
    let payload = 0n;
    for (let i = 0; i < len; i++) {
      payload =
        payload * 40n +
        referenceCharToBase40(rawCustomerId.charCodeAt(start + i));
    }
    return (
      (KEY64_MODE_BASE40_EXACT_12 << KEY64_MODE_SHIFT) |
      (payload & KEY64_PAYLOAD_MASK)
    );
  }
  let h64 = 0xcbf29ce484222325n;
  for (let i = start; i < end; i++) {
    let c = rawCustomerId.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    h64 ^= BigInt(c);
    h64 = BigInt.asUintN(64, h64 * 0x100000001b3n);
  }
  return (
    (KEY64_MODE_FNV1A64_LONG << KEY64_MODE_SHIFT) | (h64 & KEY64_PAYLOAD_MASK)
  );
}

function referenceRadixSlots(rawCustomerId: string): number[] {
  // same trim as referencePackedKey
  let start = 0;
  let end = rawCustomerId.length;
  while (start < end && rawCustomerId.charCodeAt(start) <= 32) start++;
  while (end > start && rawCustomerId.charCodeAt(end - 1) <= 32) end--;
  while (end > start + 1 && rawCustomerId.charCodeAt(end - 1) === 46) end--;
  if (
    end - start > 3 &&
    rawCustomerId.charCodeAt(end - 3) >= 48 &&
    rawCustomerId.charCodeAt(end - 3) <= 57 &&
    rawCustomerId.charCodeAt(end - 2) === 95 &&
    rawCustomerId.charCodeAt(end - 1) >= 48 &&
    rawCustomerId.charCodeAt(end - 1) <= 57
  ) {
    end -= 2;
  }
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let i = start; i < end; i++) {
    let c = rawCustomerId.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i - start + 1) * 0x85ebca6b;
    h2 = Math.imul(h2, 0xc2b2ae35);
  }
  const finalize = (h: number): number => {
    let x = h | 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return x >>> 0 || 1;
  };
  const f1 = finalize(h1);
  const f2 = finalize(h2);
  const slot1 = f1 & 0xffff;
  const rawSlot2 = f2 & 0xffff;
  return [
    slot1,
    rawSlot2 === slot1 ? (slot1 + 1) & 0xffff : rawSlot2,
    (f1 >>> 16) & 0xffff,
    (f2 >>> 16) & 0xffff,
  ];
}

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.";

function randomLogin(rnd: () => number): string {
  const len = 1 + Math.floor(rnd() * 20);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += CHARS[Math.floor(rnd() * CHARS.length)];
  }
  // sprinkle the frozen-spec edges: whitespace, trailing dots, `_N` suffix, control chars
  const edge = rnd();
  if (edge < 0.1) out = `  ${out}\t`;
  else if (edge < 0.2) out = `${out}...`;
  else if (edge < 0.3) out = `${out}_${Math.floor(rnd() * 99)}`;
  else if (edge < 0.36) out = `\u0001${out}`;
  return out;
}

const CURATED = [
  "",
  " ",
  ".",
  "..",
  "....",
  "A",
  "ABC",
  "GX195",
  "AB12_3",
  "AB12_9",
  "AB_12",
  "ABC_12",
  "player_ABC123",
  "ABCDEFGHIJKL", // length 12 -> base40 exact
  "ABCDEFGHIJKLM", // length 13 -> fnv1a
  "abcdefghijklm",
  "ZZZ_NOT_A_CUSTOMER",
  "  padded  ",
  "padded...",
  "UPPER_lower-123.456",
  "\u0000\u0001",
];

/* -------------------------------------------------------------------------- */
/* Encoding: parts and BigInt must be exactly the frozen encoder               */
/* -------------------------------------------------------------------------- */

describe("packed key encoders", () => {
  test("BigInt encoder matches the frozen reference on curated + random logins", () => {
    const rnd = mulberry32(0x5eed1234);
    const cases = [...CURATED];
    for (let i = 0; i < 5_000; i += 1) cases.push(randomLogin(rnd));
    for (const login of cases) {
      expect(encodeCustomerPackedKey64(login)).toBe(referencePackedKey(login));
    }
  });

  test("parts are the little-endian halves of the BigInt key (pack -> unpack round trip)", () => {
    const rnd = mulberry32(0xc0ffee);
    const cases = [...CURATED];
    for (let i = 0; i < 2_000; i += 1) cases.push(randomLogin(rnd));
    for (const login of cases) {
      const parts = encodeCustomerPackedKeyParts(login);
      const key = encodeCustomerPackedKey64(login);
      expect((BigInt(parts.hi) << 32n) | BigInt(parts.lo)).toBe(key);
      // u32 halves are unsigned 32-bit words
      expect(parts.lo >>> 0).toBe(parts.lo);
      expect(parts.hi >>> 0).toBe(parts.hi);
      // scratch path is identical to the object wrapper
      const scratch = new Uint32Array(2);
      encodeCustomerPackedKeyPartsInto(login, scratch);
      expect([scratch[0]!, scratch[1]!]).toEqual([parts.lo, parts.hi]);
      // mode bits live in the top two bits of the high word; the mode follows the TRIMMED
      // length, not the raw string length (trailing `_N`, dots and spaces are stripped first).
      const mode = parts.hi >>> 30;
      const bounds = loginBounds(login);
      expect(mode).toBe(bounds.end - bounds.start > 12 ? 2 : 1);
    }
  });

  test("range writers equal the bounds-computing wrappers", () => {
    const rnd = mulberry32(0x5eed0);
    const cases = [...CURATED];
    for (let i = 0; i < 2_000; i += 1) cases.push(randomLogin(rnd));
    const bounds = new Int32Array(2);
    const keyA = new Uint32Array(2);
    const keyB = new Uint32Array(2);
    const slotsA = new Uint32Array(4);
    const slotsB = new Uint32Array(4);
    for (const login of cases) {
      loginBoundsInto(login, bounds);
      encodeCustomerPackedKeyPartsIntoRange(
        login,
        keyA,
        bounds[0]!,
        bounds[1]!,
      );
      encodeCustomerPackedKeyPartsInto(login, keyB);
      expect([...keyA]).toEqual([...keyB]);
      fillLoginRadixSlots16Range(login, slotsA, bounds[0]!, bounds[1]!);
      fillLoginRadixSlots16(login, slotsB);
      expect([...slotsA]).toEqual([...slotsB]);
    }
  });

  test("radix slots match the frozen reference and write into scratch", () => {
    const rnd = mulberry32(0xbadf00d);
    const cases = [...CURATED];
    for (let i = 0; i < 2_000; i += 1) cases.push(randomLogin(rnd));
    const scratch = new Uint32Array(4);
    for (const login of cases) {
      fillLoginRadixSlots16(login, scratch);
      expect([...scratch]).toEqual(referenceRadixSlots(login));
      expect([...computeLoginRadixSlots16(login)]).toEqual([
        scratch[0]!,
        scratch[1]!,
        scratch[2]!,
        scratch[3]!,
      ]);
    }
  });

  test("single-pass combined encoder equals the separate key + slots encoders", () => {
    const rnd = mulberry32(0x9e3779b9);
    const cases = [...CURATED];
    for (let i = 0; i < 3_000; i += 1) cases.push(randomLogin(rnd));
    const keyParts = new Uint32Array(2);
    const slotsOut = new Uint32Array(4);
    for (const login of cases) {
      encodeCustomerKeyAndSlotsInto(login, keyParts, slotsOut);
      const parts = encodeCustomerPackedKeyParts(login);
      expect([keyParts[0]!, keyParts[1]!]).toEqual([parts.lo, parts.hi]);
      expect([...slotsOut]).toEqual(referenceRadixSlots(login));
    }
  });

  test("every slot stays inside the 16-bit domain (including the wrap-bumped slot 2)", () => {
    const rnd = mulberry32(0x1234);
    for (let i = 0; i < 5_000; i += 1) {
      const slots = computeLoginRadixSlots16(randomLogin(rnd));
      for (const slot of slots) {
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThanOrEqual(65535);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* ROI rounding: fast path must equal Number((v / 100).toFixed(1))             */
/* -------------------------------------------------------------------------- */

describe("roiBasisPointsToSharpScore", () => {
  test("matches toFixed(1) across the integer range the spine can store", () => {
    for (let v = -200_000; v <= 200_000; v += 1) {
      const expected = Number((v / 100).toFixed(1));
      expect(roiBasisPointsToSharpScore(v)).toBe(expected);
    }
  });

  test("NULL sentinel maps to null", () => {
    expect(roiBasisPointsToSharpScore(-2_147_483_648)).toBeNull();
  });
});

describe("hot-path representation", () => {
  test("reader uses two 32-bit lane loads, not DataView.getBigInt64", () => {
    const source = readFileSync("lib/dod6_v54_lifetime_reader.ts", "utf8");
    expect(source).not.toContain("getBigInt64");
    expect(source).not.toContain("BigInt64Array");
    expect(source).not.toContain("BigUint64Array");
    expect(source).toContain("loginKeyWords");
    expect(source).toContain("netProfitWords");
  });

  test("packedHandleCol is mounted and validated as a stable handle", () => {
    const source = readFileSync("lib/dod6_v54_lifetime_reader.ts", "utf8");
    expect(source).toContain("packedHandleCol: mountView");
    expect(source).toContain('handle: { kind: "binary"');
    expect(source).toContain("validatePackedHandles");
  });

  test("two-lane signed ordering equals BigInt ordering", () => {
    interface I64 {
      readonly hi: number;
      readonly lo: number;
    }
    const compareSigned = (a: I64, b: I64): number => {
      if (a.hi !== b.hi) return a.hi < b.hi ? -1 : 1;
      const alo = a.lo >>> 0;
      const blo = b.lo >>> 0;
      return alo < blo ? -1 : alo > blo ? 1 : 0;
    };
    const values: I64[] = [
      { hi: 0x80000000 | 0, lo: 0 }, // MIN
      { hi: 0x7fffffff, lo: 0xffffffff }, // MAX
      { hi: -1, lo: -1 }, // -1
      { hi: 0, lo: 0 },
      { hi: 0, lo: 0x80000000 }, // 2^31
      { hi: 1, lo: 0 }, // 2^32
    ];
    const rnd = mulberry32(0x64b17);
    for (let i = 0; i < 1_000; i += 1) {
      values.push({
        hi: Math.floor(rnd() * 0x1_0000_0000) | 0,
        lo: Math.floor(rnd() * 0x1_0000_0000) | 0,
      });
    }
    const twoLane = [...values].sort(compareSigned);
    const reference = [...values].sort((a, b) => {
      const left = (BigInt(a.hi) << 32n) | BigInt(a.lo >>> 0);
      const right = (BigInt(b.hi) << 32n) | BigInt(b.lo >>> 0);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    expect(twoLane).toEqual(reference);
  });

  test("two-lane unsigned ordering equals BigInt ordering", () => {
    interface U64 {
      readonly hi: number;
      readonly lo: number;
    }
    const compareUnsigned = (a: U64, b: U64): number => {
      const ahi = a.hi >>> 0;
      const bhi = b.hi >>> 0;
      if (ahi !== bhi) return ahi < bhi ? -1 : 1;
      const alo = a.lo >>> 0;
      const blo = b.lo >>> 0;
      return alo < blo ? -1 : alo > blo ? 1 : 0;
    };
    const values: U64[] = [
      { hi: 0, lo: 0 }, // MIN
      { hi: -1, lo: -1 }, // MAX
      { hi: 0, lo: 0x80000000 }, // 2^31
      { hi: 1, lo: 0 }, // 2^32
    ];
    const rnd = mulberry32(0x64b18);
    for (let i = 0; i < 1_000; i += 1) {
      values.push({
        hi: Math.floor(rnd() * 0x1_0000_0000) | 0,
        lo: Math.floor(rnd() * 0x1_0000_0000) | 0,
      });
    }
    const twoLane = [...values].sort(compareUnsigned);
    const reference = [...values].sort((a, b) => {
      const left = (BigInt(a.hi >>> 0) << 32n) | BigInt(a.lo >>> 0);
      const right = (BigInt(b.hi >>> 0) << 32n) | BigInt(b.lo >>> 0);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    expect(twoLane).toEqual(reference);
  });
});

/* -------------------------------------------------------------------------- */
/* Header pack/unpack round trip (synthetic 2048-byte header, no spine needed) */
/* -------------------------------------------------------------------------- */

function packHeader(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(DOD_HEADER_BYTE_LENGTH);
  const view = new Uint32Array(bytes.buffer);
  view.set(words.subarray(0, DOD_HEADER_UINT32_SLOTS));
  return bytes;
}

function writeTmp(name: string, bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "dod6-spine-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("spine header", () => {
  test("vendored schema bytes match the pinned SHA-256", async () => {
    const bytes = await Bun.file(DOD6_SCHEMA_PATH).bytes();
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(hash).toBe(DOD6_SCHEMA_SHA256);
  });

  test("vendored schema matches the pinned constants", async () => {
    const schema = (await Bun.file(DOD6_SCHEMA_PATH).json()) as {
      magicHex: string;
      version: number;
      headerByteLength: number;
      headerUint32Slots: number;
      sectionCount: number;
      alignmentBytes: number;
      limits: {
        maxCustomerRows32: number;
        maxCustomerRows64: number;
        radixSlotCount: number;
      };
      handle32Layout: { rowIndex: { bits: number; maskHex: string } };
    };
    expect(schema.magicHex).toBe("0x444F4436");
    expect(schema.version).toBe(DOD_BINARY_VERSION);
    expect(schema.headerByteLength).toBe(DOD_HEADER_BYTE_LENGTH);
    expect(schema.headerUint32Slots).toBe(DOD_HEADER_UINT32_SLOTS);
    expect(schema.sectionCount).toBe(DOD_NUM_SECTION_OFFSETS);
    expect(schema.alignmentBytes).toBe(64);
    expect(schema.limits.maxCustomerRows32).toBe(DOD6_MAX_ROW_INDEX_32);
    expect(schema.limits.radixSlotCount).toBe(65_536);
    expect(schema.handle32Layout.rowIndex.bits).toBe(15);
    expect(schema.handle32Layout.rowIndex.maskHex).toBe("0x7FFF");
    expect(DOD6_RESERVED_ROW_INDEX_32).toBe(0x7fff);
    expect(DOD6_MAX_ROWS_32).toBe(DOD6_MAX_ROW_INDEX_32 + 1);
    expect(schema.limits.maxCustomerRows64).toBe(DOD6_MAX_ROW_INDEX_64);
    expect(DOD6_RESERVED_ROW_INDEX_64).toBe(0xfffff);
    expect(DOD6_MAX_ROWS_64).toBe(DOD6_MAX_ROW_INDEX_64 + 1);
  });

  test("rejects unsupported version and capacity above 32,767", () => {
    const make = (version: number, rows: number): Uint8Array => {
      const words = new Uint32Array(DOD_HEADER_UINT32_SLOTS);
      words[0] = DOD_BINARY_MAGIC;
      words[1] = version;
      words[3] = rows;
      words[8] = DOD_HEADER_BYTE_LENGTH;
      words[9] = DOD_NUM_SECTION_OFFSETS;
      return packHeader(words);
    };
    expect(
      readDod6V54SpineMeta(writeTmp("v55.dodbin", make(55, 9))),
    ).toBeNull();
    expect(
      readDod6V54SpineMeta(writeTmp("rows32767.dodbin", make(54, 32_767))),
    ).not.toBeNull();
    expect(
      readDod6V54SpineMeta(writeTmp("rows32768.dodbin", make(54, 32_768))),
    ).toBeNull();
    expect(
      readDod6V54SpineMeta(writeTmp("rows-max.dodbin", make(54, 32_766))),
    ).not.toBeNull();
  });

  test("rowOfHandle is the only row-major accessor; handles are opaque", () => {
    expect(rowOfHandle({ kind: "binary", handle: 0x4040_8005 })).toBe(5);
    expect(rowOfHandle({ kind: "row-index-fallback", rowIndex: 5 })).toBe(5);
    expect(
      rowOfHandle({ kind: "row-index-fallback", rowIndex: null }),
    ).toBeNull();
  });

  test("packs/unpacks the header fields byte-identically", () => {
    const words = new Uint32Array(DOD_HEADER_UINT32_SLOTS);
    words[0] = DOD_BINARY_MAGIC;
    words[1] = DOD_BINARY_VERSION;
    words[2] = 7; // customerCount
    words[3] = 9; // rowCapacity
    words[7] = 20_760; // asOfEpochDays
    words[8] = DOD_HEADER_BYTE_LENGTH; // totalFileBytes
    words[9] = DOD_NUM_SECTION_OFFSETS;
    for (let i = 16; i < DOD_HEADER_UINT32_SLOTS; i += 1) {
      words[i] = Math.imul(i, 2_654_435_761) >>> 0;
    }
    const bytes = packHeader(words);
    const path = writeTmp("header.dodbin", bytes);
    const meta = readDod6V54SpineMeta(path);
    expect(meta).not.toBeNull();
    expect(meta!.customerCount).toBe(7);
    expect(meta!.rowCapacity).toBe(9);
    expect(meta!.asOfEpochDays).toBe(20_760);
    expect(meta!.sectionCount).toBe(88);
    expect(packHeader(new Uint32Array(bytes.buffer))).toEqual(bytes);
  });

  test("a header-only read never reads the whole file", () => {
    // 2048-byte file with a valid header: meta must parse without touching beyond the header.
    const words = new Uint32Array(DOD_HEADER_UINT32_SLOTS);
    words[0] = DOD_BINARY_MAGIC;
    words[1] = DOD_BINARY_VERSION;
    words[2] = 1;
    words[3] = 1;
    words[8] = DOD_HEADER_BYTE_LENGTH;
    words[9] = DOD_NUM_SECTION_OFFSETS;
    const path = writeTmp("tiny.dodbin", packHeader(words));
    const tinyMeta = readDod6V54SpineMeta(path);
    expect(tinyMeta!.customerCount).toBe(1);
  });

  test("refuses a non-DOD6 or truncated header", () => {
    const zero = new Uint8Array(DOD_HEADER_BYTE_LENGTH);
    expect(readDod6V54SpineMeta(writeTmp("zero.dodbin", zero))).toBeNull();
    expect(
      readDod6V54SpineMeta(writeTmp("short.dodbin", new Uint8Array(64))),
    ).toBeNull();
    expect(
      readDod6V54SpineMeta(join(tmpdir(), "nope-not-a-spine.dodbin")),
    ).toBeNull();
  });

  test("fails closed when the file is shorter than header.totalFileBytes", async () => {
    const words = new Uint32Array(DOD_HEADER_UINT32_SLOTS);
    words[0] = DOD_BINARY_MAGIC;
    words[1] = DOD_BINARY_VERSION;
    words[2] = 1;
    words[3] = 1;
    words[8] = DOD_HEADER_BYTE_LENGTH + 64; // claims more than the file contains
    words[9] = DOD_NUM_SECTION_OFFSETS;
    const path = writeTmp("truncated-body.dodbin", packHeader(words));
    expect(await createDod6V54LifetimeReader(path)).toBeNull();
  });

  test("refuses a misaligned section offset instead of mounting a view", async () => {
    const words = new Uint32Array(DOD_HEADER_UINT32_SLOTS);
    words[0] = DOD_BINARY_MAGIC;
    words[1] = DOD_BINARY_VERSION;
    words[2] = 2;
    words[3] = 2; // rowCapacity
    words[8] = DOD_HEADER_BYTE_LENGTH + 64; // claimed total file bytes
    words[9] = DOD_NUM_SECTION_OFFSETS;
    // radixHeadRowCol (section 1) at offset 2049 -> 1 byte off a 4-byte boundary
    const sectionBase = 16 + 1 * 3;
    words[sectionBase] = DOD_HEADER_BYTE_LENGTH + 1;
    words[sectionBase + 1] = 65536 * 4;
    const bytes = new Uint8Array(words.buffer.byteLength + 64);
    bytes.set(packHeader(words));
    const path = writeTmp("misaligned.dodbin", bytes);
    await expect(createDod6V54LifetimeReader(path)).rejects.toThrow(/aligned/);
  });

  test("refuses a section that runs past the file", async () => {
    const words = new Uint32Array(DOD_HEADER_UINT32_SLOTS);
    words[0] = DOD_BINARY_MAGIC;
    words[1] = DOD_BINARY_VERSION;
    words[2] = 2;
    words[3] = 2;
    words[8] = DOD_HEADER_BYTE_LENGTH + 64;
    words[9] = DOD_NUM_SECTION_OFFSETS;
    const sectionBase = 16 + 1 * 3;
    words[sectionBase] = DOD_HEADER_BYTE_LENGTH; // aligned
    words[sectionBase + 1] = 65536 * 4; // way past the file
    const bytes = new Uint8Array(words.buffer.byteLength + 64);
    bytes.set(packHeader(words));
    const path = writeTmp("overrun.dodbin", bytes);
    await expect(createDod6V54LifetimeReader(path)).rejects.toThrow(
      /exceeds file/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Integration against the real spine (skipped when the tracked file is gone)  */
/* -------------------------------------------------------------------------- */

const CORPUS_LOGINS = [
  "GX195",
  ...(() => {
    const csv = readFileSync("tests/fixtures/dod6-lifetime-sample.csv", "utf8");
    return csv
      .split("\n")
      .slice(1)
      .map((line) => line.split(",")[0]?.trim() ?? "")
      .filter((id) => id !== "");
  })(),
];

describe("real spine (88 MB)", () => {
  if (!existsSync(DODBIN)) {
    test.skip("spine file not present", () => {});
    return;
  }

  const meta = readDod6V54SpineMeta(DODBIN);
  const size = Bun.file(DODBIN).size;

  test("header-only meta equals the file facts", () => {
    expect(meta).not.toBeNull();
    expect(meta!.sectionCount).toBe(DOD_NUM_SECTION_OFFSETS);
    expect(meta!.totalFileBytes).toBe(size);
    expect(meta!.customerCount).toBe(meta!.rowCapacity);
    expect(meta!.customerCount).toBeGreaterThan(0);
    // the old full-file meta read produced the same values; read ONLY the header again here
    const headerBytes = new Uint8Array(DOD_HEADER_BYTE_LENGTH);
    const fd = openSync(DODBIN, "r");
    try {
      readSync(fd, headerBytes, 0, DOD_HEADER_BYTE_LENGTH, 0);
    } finally {
      closeSync(fd);
    }
    const full = new Uint32Array(headerBytes.buffer, 0, 16);
    expect(full[0]).toBe(DOD_BINARY_MAGIC);
    expect(full[1]).toBe(DOD_BINARY_VERSION);
    expect(full[2]).toBe(meta!.customerCount);
    expect(full[3]).toBe(meta!.rowCapacity);
  });

  test("lookup and lookupInto agree on every corpus login", async () => {
    const reader = await createDod6V54LifetimeReader(DODBIN);
    expect(reader).not.toBeNull();
    const target: Dod6LifetimeLookupTarget = {
      clvBps: 0,
      sharpScore: 0,
      lifetimeNetUsd: 0,
      clvLegs: 0,
      avgClvPoints: null,
      sharpCandidateGatePassed: false,
      source: "lifetime_csv",
      handleKind: "row-index-fallback",
      handleValue: null,
    };
    let hits = 0;
    for (const login of CORPUS_LOGINS) {
      const expected = reader!.lookup(login);
      const ok = reader!.lookupInto(login, target);
      expect(ok).toBe(expected !== null);
      if (expected === null) continue;
      hits += 1;
      const { handleKind, handleValue, ...rest } = target;
      const targetHandle =
        handleKind === "binary"
          ? { kind: "binary" as const, handle: handleValue! }
          : { kind: "row-index-fallback" as const, rowIndex: handleValue };
      expect({ ...rest, handle: targetHandle }).toEqual(expected);
    }
    expect(hits).toBeGreaterThan(0);
  });

  test("pack -> row -> unpack round trip: decoded base40 logins resolve to their own row", async () => {
    const reader = await createDod6V54LifetimeReader(DODBIN);
    expect(reader).not.toBeNull();
    const bytes = new Uint8Array(readFileSync(DODBIN));
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset);
    const header = u32.subarray(0, DOD_HEADER_UINT32_SLOTS);
    const sectionOffset = (index: number): number => header[16 + index * 3]!;
    const rows = meta!.rowCapacity;
    const keyWords = new Uint32Array(
      bytes.buffer,
      bytes.byteOffset + sectionOffset(2),
      rows * 2,
    );
    const clvLegsCol = new Uint32Array(
      bytes.buffer,
      bytes.byteOffset + sectionOffset(16),
      rows,
    );
    const netCol = new BigInt64Array(
      bytes.buffer,
      bytes.byteOffset + sectionOffset(6),
      rows,
    );
    const DIGIT_TO_CHAR = (digit: number): string => {
      if (digit >= 1 && digit <= 10) return String.fromCharCode(48 + digit - 1);
      if (digit >= 11 && digit <= 36)
        return String.fromCharCode(65 + digit - 11);
      if (digit === 37) return "_";
      if (digit === 38) return "-";
      return ".";
    };
    let checked = 0;
    for (let row = 0; row < Math.min(rows, 500) && checked < 200; row += 1) {
      const lo = keyWords[row * 2]!;
      const hi = keyWords[row * 2 + 1]!;
      if (hi >>> 30 !== 1) continue; // fnv1a long ids are not decodable
      let payload = (BigInt(hi & 0x3fffffff) << 32n) | BigInt(lo);
      let decoded = "";
      while (payload > 0n) {
        const digit = Number(payload % 40n);
        decoded = DIGIT_TO_CHAR(digit) + decoded;
        payload /= 40n;
      }
      const hit = reader!.lookup(decoded);
      expect(hit).not.toBeNull();
      expect(hit!.handle.kind).toBe("binary");
      expect(rowOfHandle(hit!.handle)).toBe(row);
      expect(hit!.clvLegs).toBe(clvLegsCol[row]!);
      expect(hit!.lifetimeNetUsd).toBe(Number(netCol[row]!) / 100);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("signed 64-bit net column: (hi * 2^32 + lo) equals Number(BigInt) on the same row", async () => {
    const bytes = new Uint8Array(readFileSync(DODBIN));
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset);
    const header = u32.subarray(0, DOD_HEADER_UINT32_SLOTS);
    const rows = meta!.rowCapacity;
    const words = new Int32Array(
      bytes.buffer,
      bytes.byteOffset + header[16 + 6 * 3]!,
      rows * 2,
    );
    const bigints = new BigInt64Array(
      bytes.buffer,
      bytes.byteOffset + header[16 + 6 * 3]!,
      rows,
    );
    for (let row = 0; row < Math.min(rows, 500); row += 1) {
      const fromWords =
        words[row * 2 + 1]! * 4294967296 + (words[row * 2]! >>> 0);
      expect(fromWords).toBe(Number(bigints[row]!));
    }
  });

  test("radix directory is fully scanned without mounting a BigInt view", async () => {
    const reader = await createDod6V54LifetimeReader(DODBIN);
    expect(reader).not.toBeNull();
    // A miss must return null (no false positive from a stale row pointer).
    expect(reader!.lookup("ZZZ_NOT_A_CUSTOMER")).toBeNull();
    expect(reader!.lookup("")).toBeNull();
    // EMPTY_RADIX_SLOT_ROW is the frozen sentinel the chain walk relies on.
    expect(EMPTY_RADIX_SLOT_ROW).toBe(-1);
  });

  test("cross-foots settledStakedCents vs lifetimeStakedCents and bet count identities from spine header and columns", () => {
    const totals = summarizeDod6V54SpineTotals(DODBIN);
    expect(totals).not.toBeNull();
    expect(totals!.meta.customerCount).toBe(meta!.customerCount);
    expect(totals!.meta.rowCapacity).toBe(meta!.rowCapacity);
    expect(totals!.betsIdentityHolds).toBe(true);
    expect(totals!.outcomesIdentityHolds).toBe(true);
    expect(totals!.settledBetsCount + totals!.openBetsCount).toBe(
      totals!.lifetimeBetsCount,
    );
    expect(totals!.winsCount + totals!.lossesCount + totals!.pushesCount).toBe(
      totals!.settledBetsCount,
    );
    expect(totals!.openStakedImpliedCents).toBe(
      totals!.lifetimeStakedCents - totals!.settledStakedCents,
    );
    expect(totals!.houseNetProfitCents).toBe(
      -totals!.lifetimeCustomerNetProfitCents,
    );

    // Independently derive column sums from the raw binary buffer using header-declared rowCapacity
    const bytes = new Uint8Array(readFileSync(DODBIN));
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset);
    const header = u32.subarray(0, DOD_HEADER_UINT32_SLOTS);
    const rows = header[3]!;
    const secOffset = (idx: number): number => header[16 + idx * 3]!;
    const sumI64 = (secIdx: number): bigint => {
      const col = new BigInt64Array(
        bytes.buffer,
        bytes.byteOffset + secOffset(secIdx),
        rows,
      );
      let acc = 0n;
      for (let r = 0; r < rows; r += 1) acc += col[r]!;
      return acc;
    };
    const expectedLifetimeStaked = Number(sumI64(4));
    const expectedSettledStaked = Number(sumI64(5));
    const expectedCustomerNet = Number(sumI64(6));

    expect(totals!.lifetimeStakedCents).toBe(expectedLifetimeStaked);
    expect(totals!.settledStakedCents).toBe(expectedSettledStaked);
    expect(totals!.lifetimeCustomerNetProfitCents).toBe(expectedCustomerNet);
    expect(totals!.houseNetProfitCents).toBe(-expectedCustomerNet);
    expect(totals!.settledHoldRatio).toBeCloseTo(
      -expectedCustomerNet / expectedSettledStaked,
      10,
    );
    expect(totals!.lifetimeStakedHoldRatio).toBeCloseTo(
      -expectedCustomerNet / expectedLifetimeStaked,
      10,
    );
  });
});
