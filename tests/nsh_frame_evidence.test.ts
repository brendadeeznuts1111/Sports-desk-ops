/**
 * @file tests/nsh_frame_evidence.test.ts
 * @description Evidence for the NSH frame layout, not a re-test of it:
 *   - committed golden vectors, pinned by SHA-256
 *   - the descriptor tiles the frame with no gap or overlap
 *   - N-1 matrix: how older and unrecognised frames fail
 *   - property round-trip over a deterministic corpus
 *   - field isolation: one changed input moves only its own bytes
 *   - mutational fuzz: only `NshFrameCodecError` may escape the parser
 *   - reader throughput and allocation behaviour
 *   - differential agreement with the independent Python decoder (when python3 exists)
 */
import { describe, expect, it, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  NshFrameCodecError,
  NshFrameWriter,
  createNshFrameTarget,
  packNshBinaryFrame,
  readNshBinaryFrame,
  readNshBinaryFrameInto,
  type NshMatchFrameInput,
} from "../lib/nsh_frame_codec.ts";
import {
  NSH_FRAME_BYTE_LENGTH,
  NSH_FRAME_FIELD_SPEC,
  NSH_FRAME_LAYOUT,
} from "../lib/nsh_frame_schema.ts";
import { OriginDomainWireId, WriterLaneWireId } from "../lib/domain-enums.ts";
import {
  ORIGIN_DOMAIN_BY_WIRE_ID,
  ORIGIN_DOMAIN_WIRE_ID,
  SENTINEL_CHANNEL_BY_WIRE_ID,
  SENTINEL_CHANNEL_WIRE_ID,
  WRITER_LANE_BY_WIRE_ID,
  WRITER_LANE_WIRE_ID,
  originDomainIdOfWireId,
  writerLaneIdOfWireId,
} from "../lib/domain-enums.ts";
import {
  ORIGIN_DOMAIN_REGISTRY,
  SENTINEL_CHANNEL_REGISTRY,
  WRITER_LANE_REGISTRY,
} from "../lib/domain_venue_registry.ts";
import { buildCorpus } from "../scripts/nsh_frame_differential.ts";

const FIXTURE_DIR = new URL("./fixtures/nsh_frames/", import.meta.url);
const LOCK = (await Bun.file(
  new URL("golden.lock.json", FIXTURE_DIR),
).json()) as Record<string, { bytes: number; sha256: string; hex: string }>;

const BASE: NshMatchFrameInput = {
  channelId: 5,
  slaDivide10Ms: 50,
  rowIndex: 0xabcde,
  betGroupId: 42n,
  stakeUsdc: 1250.5,
  bookOdds: 1.85,
  polyAvgPrice: 0.52,
  liabilityDelta: -120.25,
  originDomainWireId: OriginDomainWireId.GSLIVE_118,
  writerLaneWireId: WriterLaneWireId.GSLIVE,
  flags: 0b101,
  slippageBps: 12,
  timestampMs: 1_700_000_000_000,
};

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("golden vectors", () => {
  test("every committed .hex still matches the writer and its pinned SHA-256", async () => {
    const writer = new NshFrameWriter();
    const names = Object.keys(LOCK);
    expect(names.length).toBeGreaterThanOrEqual(3);

    for (const name of names) {
      const lockEntry = LOCK[name]!;
      const fileHex = (
        await Bun.file(new URL(`${name}.hex`, FIXTURE_DIR)).text()
      ).trim();
      const bytes = Uint8Array.from(
        fileHex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
      );

      expect(bytes.byteLength).toBe(NSH_FRAME_BYTE_LENGTH);
      expect(bytes.byteLength).toBe(lockEntry.bytes);
      expect(sha256Of(bytes)).toBe(lockEntry.sha256);
      expect(fileHex).toBe(lockEntry.hex);

      // The committed bytes are exactly what today's writer produces.
      const decoded = readNshBinaryFrame(bytes);
      const reencoded = writer.write({
        ...decoded,
        timestampMs: decoded.timestampMs,
      });
      expect(hexOf(reencoded)).toBe(fileHex);
    }
  });
});

describe("layout descriptor", () => {
  test("fields tile 0..63 with no gap or overlap", () => {
    let cursor = 0;
    for (const field of NSH_FRAME_FIELD_SPEC) {
      expect(field.offset as number).toBe(cursor);
      cursor += field.size;
    }
    expect(cursor).toBe(NSH_FRAME_BYTE_LENGTH);
  });

  test("declared wire type matches declared size", () => {
    const width = { u8: 1, u16: 2, u32: 4, u64: 8, f64: 8 } as const;
    for (const field of NSH_FRAME_FIELD_SPEC) {
      expect(field.size).toBe(width[field.type]);
    }
  });

  test("NSH_FRAME_LAYOUT is derived from the spec, not a second table", () => {
    expect(Object.keys(NSH_FRAME_LAYOUT).sort()).toEqual(
      NSH_FRAME_FIELD_SPEC.map((f) => f.key).sort(),
    );
    for (const field of NSH_FRAME_FIELD_SPEC) {
      expect(NSH_FRAME_LAYOUT[field.key]).toEqual({
        offset: field.offset,
        size: field.size,
      });
    }
  });
});

describe("N-1 matrix", () => {
  test("v5 frames are rejected, not reinterpreted", () => {
    const bytes = packNshBinaryFrame(BASE);
    bytes[1] = 5;
    expect(() => readNshBinaryFrame(bytes)).toThrow(/ERR_FRAME_V5_DEPRECATED/);
  });

  test("a pre-change v6 frame (RGB24 in 56..58) fails closed", () => {
    const bytes = packNshBinaryFrame(BASE);
    bytes[56] = 0x28; // GSLIVE #28a745's R byte is not a valid origin id
    bytes[57] = 0xa7;
    bytes[58] = 0x00; // keep the reserved byte clean so the origin check is reached
    try {
      readNshBinaryFrame(bytes);
      throw new Error("expected the legacy frame to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(NshFrameCodecError);
      // 0x28 = 40 is not a registered origin domain; the frame must not decode
      // into a plausible row with a garbage provenance.
      expect((error as NshFrameCodecError).code).toBe("invalid_origin_domain");
    }
  });

  test("unknown version and truncated frames are rejected by code", () => {
    const future = packNshBinaryFrame(BASE);
    future[1] = 7;
    expect(() => readNshBinaryFrame(future)).toThrow(
      /unsupported NSH frame version 7/,
    );
    expect(() => readNshBinaryFrame(new Uint8Array(63))).toThrow(
      /needs 64 bytes/,
    );
  });
});

describe("property round-trip", () => {
  test("1000 generated frames survive encode/decode field for field", () => {
    const writer = new NshFrameWriter();
    const target = createNshFrameTarget();
    for (const input of buildCorpus(1000)) {
      const bytes = writer.write(input);
      const decoded = readNshBinaryFrameInto(bytes, target);
      expect(decoded.channelId).toBe(input.channelId);
      expect(decoded.slaDivide10Ms).toBe(input.slaDivide10Ms);
      expect(decoded.rowIndex).toBe(input.rowIndex);
      expect(decoded.betGroupId).toBe(BigInt(input.betGroupId));
      expect(decoded.stakeUsdc).toBe(input.stakeUsdc);
      expect(decoded.bookOdds).toBe(input.bookOdds);
      expect(decoded.polyAvgPrice).toBe(input.polyAvgPrice);
      expect(decoded.liabilityDelta).toBe(input.liabilityDelta);
      expect(decoded.originDomainWireId).toBe(input.originDomainWireId);
      expect(Number(decoded.writerLaneWireId)).toBe(
        Number(input.writerLaneWireId),
      );
      expect(decoded.flags).toBe(input.flags);
      expect(decoded.slippageBps).toBe(input.slippageBps);
      expect(decoded.timestampMs).toBe(Number(input.timestampMs));
    }
  });
});

describe("field isolation", () => {
  const FIELD_FOR_INPUT: Readonly<Record<string, string>> = {
    messageType: "HEADER_MSG_TYPE",
    channelId: "PACKED_HANDLE_32",
    slaDivide10Ms: "PACKED_HANDLE_32",
    rowIndex: "PACKED_HANDLE_32",
    betGroupId: "BET_GROUP_ID_64",
    stakeUsdc: "STAKE_USDC",
    bookOdds: "BOOK_ODDS",
    polyAvgPrice: "POLY_AVG_PRICE",
    liabilityDelta: "LIABILITY_DELTA",
    originDomainWireId: "ORIGIN_DOMAIN_8",
    writerLaneWireId: "WRITER_LANE_8",
    flags: "FLAGS_BIT_SET_16",
    slippageBps: "SLIPPAGE_BPS_8",
    timestampMs: "TIMESTAMP_EPOCH_MS",
  };

  const VARIANTS: Readonly<Record<string, Partial<NshMatchFrameInput>>> = {
    messageType: { messageType: 2 },
    channelId: { channelId: 9 },
    slaDivide10Ms: { slaDivide10Ms: 51 },
    rowIndex: { rowIndex: 0xabcdf },
    betGroupId: { betGroupId: 43n },
    stakeUsdc: { stakeUsdc: 1250.75 },
    bookOdds: { bookOdds: 1.86 },
    polyAvgPrice: { polyAvgPrice: 0.53 },
    liabilityDelta: { liabilityDelta: -120.5 },
    originDomainWireId: { originDomainWireId: OriginDomainWireId.F402 },
    writerLaneWireId: { writerLaneWireId: WriterLaneWireId.ALERT },
    flags: { flags: 0b110 },
    slippageBps: { slippageBps: 13 },
    timestampMs: { timestampMs: 1_700_000_000_001 },
  };

  for (const [inputKey, fieldKey] of Object.entries(FIELD_FOR_INPUT)) {
    test(`${inputKey} moves only ${fieldKey}`, () => {
      const slot = NSH_FRAME_LAYOUT[fieldKey as keyof typeof NSH_FRAME_LAYOUT]!;
      const before = packNshBinaryFrame(BASE);
      const after = packNshBinaryFrame({
        ...BASE,
        ...VARIANTS[inputKey]!,
      });
      const changed: number[] = [];
      for (let i = 0; i < NSH_FRAME_BYTE_LENGTH; i += 1) {
        if (before[i] !== after[i]) changed.push(i);
      }
      expect(changed.length).toBeGreaterThan(0);
      for (const index of changed) {
        expect(index).toBeGreaterThanOrEqual(slot.offset);
        expect(index).toBeLessThan(slot.offset + slot.size);
      }
    });
  }
});

describe("mutational fuzz", () => {
  test("only NshFrameCodecError escapes the parser", () => {
    let state = 0xc0ffee;
    const rand = (): number => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    };

    const seed = packNshBinaryFrame(BASE);
    let decoded = 0;
    let rejected = 0;
    for (let i = 0; i < 2000; i += 1) {
      const mutated = Uint8Array.from(seed);
      const flips = 1 + (rand() % 8);
      for (let f = 0; f < flips; f += 1) {
        mutated[rand() % NSH_FRAME_BYTE_LENGTH] = rand() & 0xff;
      }
      try {
        readNshBinaryFrame(mutated);
        decoded += 1;
      } catch (error) {
        rejected += 1;
        expect(error).toBeInstanceOf(NshFrameCodecError);
      }
    }
    // Neither branch may be empty: mutations must sometimes still be valid.
    expect(decoded).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  test("random 64-byte buffers never crash the parser", () => {
    let state = 0xdeadbeef;
    for (let i = 0; i < 1000; i += 1) {
      const buffer = new Uint8Array(NSH_FRAME_BYTE_LENGTH);
      for (let b = 0; b < buffer.length; b += 1) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        buffer[b] = state & 0xff;
      }
      try {
        readNshBinaryFrame(buffer);
      } catch (error) {
        expect(error).toBeInstanceOf(NshFrameCodecError);
      }
    }
  });
});

describe("reader throughput and allocation", () => {
  test("Into-reader returns the same object and does not grow the heap", () => {
    const bytes = packNshBinaryFrame(BASE);
    const target = createNshFrameTarget();
    expect(readNshBinaryFrameInto(bytes, target)).toBe(target);

    const iterations = 200_000;
    for (let i = 0; i < 20_000; i += 1) readNshBinaryFrameInto(bytes, target);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const t0 = Bun.nanoseconds();
    let sink = 0;
    for (let i = 0; i < iterations; i += 1) {
      sink += readNshBinaryFrameInto(bytes, target).channelId;
    }
    const t1 = Bun.nanoseconds();
    const heapDelta = process.memoryUsage().heapUsed - before;
    const nsPerFrame = (t1 - t0) / iterations;

    expect(sink).toBe(5 * iterations);
    // GC noise across 200k iterations is tens of KB; a per-frame object would be MBs.
    expect(heapDelta).toBeLessThan(1_000_000);
    expect(nsPerFrame).toBeLessThan(2_000);
    console.log(
      `reader: ${nsPerFrame.toFixed(1)} ns/frame, heap delta ${heapDelta} bytes over ${iterations} decodes`,
    );
  });
});

describe("cross-implementation differential", () => {
  const python = Bun.which("python3");
  it.skipIf(python === null)(
    "TypeScript and Python decoders agree over 500 frames",
    () => {
      const proc = Bun.spawnSync({
        cmd: ["bun", "scripts/nsh_frame_differential.ts", "500"],
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain("0 divergences");
    },
  );
});

describe("wire id tables are locked to the registry", () => {
  test("origin ids cover the registry exactly and 0 stays unwritable", () => {
    expect(Object.keys(ORIGIN_DOMAIN_WIRE_ID).sort()).toEqual(
      Object.keys(ORIGIN_DOMAIN_REGISTRY).sort(),
    );
    expect(Object.values(ORIGIN_DOMAIN_WIRE_ID).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    for (const [registryId, wireId] of Object.entries(ORIGIN_DOMAIN_WIRE_ID)) {
      expect(String(ORIGIN_DOMAIN_BY_WIRE_ID[wireId])).toBe(registryId);
    }
    expect(originDomainIdOfWireId(OriginDomainWireId.UNSET)).toBeNull();
  });

  test("lane and sentinel wire ids cover their registries and round-trip", () => {
    expect(Object.keys(WRITER_LANE_WIRE_ID).sort()).toEqual(
      Object.keys(WRITER_LANE_REGISTRY).sort(),
    );
    // Bytes 1..6 remain the writable lanes; 0, 7 and 8 are sentinel classes.
    expect(Object.values(WRITER_LANE_WIRE_ID).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    for (const [registryId, wireId] of Object.entries(WRITER_LANE_WIRE_ID)) {
      expect(String(WRITER_LANE_BY_WIRE_ID[wireId])).toBe(registryId);
    }
    expect(Object.keys(SENTINEL_CHANNEL_WIRE_ID).sort()).toEqual(
      Object.keys(SENTINEL_CHANNEL_REGISTRY).sort(),
    );
    expect(
      (Object.values(SENTINEL_CHANNEL_WIRE_ID) as number[]).sort(
        (a, b) => a - b,
      ),
    ).toEqual([0, 1, 7, 8]);
    for (const [sentinelId, wireId] of Object.entries(
      SENTINEL_CHANNEL_WIRE_ID,
    )) {
      // Byte 1 aliases the mirror lane, so it decodes as the LANE.
      if (wireId === 1) {
        expect(writerLaneIdOfWireId(wireId)).toBe("inet_mirror");
        continue;
      }
      expect(String(SENTINEL_CHANNEL_BY_WIRE_ID[wireId])).toBe(sentinelId);
    }
    expect(writerLaneIdOfWireId(0)).toBe("unknown");
    expect(writerLaneIdOfWireId(99)).toBeNull();
  });
});
