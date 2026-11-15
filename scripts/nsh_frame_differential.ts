/**
 * @file scripts/nsh_frame_differential.ts
 * @description Differential test: encode a deterministic corpus with the
 * TypeScript writer, decode it with the independent Python reference decoder,
 * and compare every field. Agreement over the corpus is the evidence; the two
 * implementations share no code.
 *
 *   bun scripts/nsh_frame_differential.ts [frameCount]
 */
import {
  packNshBinaryFrame,
  type NshMatchFrameInput,
} from "../lib/nsh_frame_codec.ts";
import { OriginDomainWireId, WriterLaneWireId } from "../lib/domain-enums.ts";

const FRAME_COUNT = Number(process.argv[2] ?? 500);

/** Deterministic xorshift32 so the corpus is reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Wire id 0 (`UNSET`) is not a valid frame value: a frame must name its domain. */
const ORIGIN_IDS = Object.values(OriginDomainWireId).filter(
  (id) => id !== OriginDomainWireId.UNSET,
);
const LANE_IDS = Object.values(WriterLaneWireId);

export function buildCorpus(count: number): NshMatchFrameInput[] {
  const rng = makeRng(0x5eed_1234);
  const frames: NshMatchFrameInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(rng() * values.length)]!;
    frames.push({
      messageType: 1 + Math.floor(rng() * 3),
      channelId: Math.floor(rng() * 16),
      slaDivide10Ms: Math.floor(rng() * 256),
      rowIndex: Math.floor(rng() * 0x100000),
      betGroupId: BigInt(Math.floor(rng() * Number.MAX_SAFE_INTEGER)),
      stakeUsdc: Math.round(rng() * 5_000_000) / 100,
      bookOdds: 1 + Math.round(rng() * 100_000) / 1000,
      polyAvgPrice: Math.round(rng() * 10_000) / 10_000,
      liabilityDelta: -Math.round(rng() * 5_000_000) / 100,
      originDomainWireId: pick(ORIGIN_IDS),
      writerLaneWireId: pick(LANE_IDS),
      flags: Math.floor(rng() * 0x10000),
      slippageBps: Math.floor(rng() * 256),
      timestampMs: 1_700_000_000_000 + Math.floor(rng() * 1_000_000_000),
    });
  }
  return frames;
}

if (import.meta.main) {
  const frames = buildCorpus(FRAME_COUNT);
  const hexLines = frames.map((f) => {
    const bytes = packNshBinaryFrame(f);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  });

  const decoder = new URL(
    "../tests/fixtures/nsh_frames/reference_decoder.py",
    import.meta.url,
  ).pathname;

  const proc = Bun.spawnSync({
    cmd: ["python3", decoder],
    stdin: Buffer.from(`${hexLines.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(1);
  }

  const decoded = JSON.parse(proc.stdout.toString()) as Array<
    Record<string, unknown>
  >;
  if (decoded.length !== frames.length) {
    console.error(`length mismatch: ${decoded.length} != ${frames.length}`);
    process.exit(1);
  }

  let compared = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const expected = packNshBinaryFrame(frames[i]!);
    const actual = decoded[i]!;
    const view = new DataView(expected.buffer, expected.byteOffset, 64);
    const handle = view.getUint32(4, true);
    const want = {
      messageType: expected[2],
      channelId: (handle >>> 28) & 0xf,
      slaDivide10Ms: (handle >>> 20) & 0xff,
      rowIndex: handle & 0xfffff,
      betGroupId: view.getBigUint64(8, true).toString(),
      stakeUsdc: view.getFloat64(16, true),
      bookOdds: view.getFloat64(24, true),
      polyAvgPrice: view.getFloat64(32, true),
      liabilityDelta: view.getFloat64(40, true),
      timestampMs: Number(view.getBigUint64(48, true)),
      originDomainWireId: expected[56],
      writerLaneWireId: expected[57],
      flags: view.getUint16(59, true),
      slippageBps: expected[61],
    };
    for (const [key, value] of Object.entries(want)) {
      compared += 1;
      if (actual[key] !== value) {
        console.error(
          `DIVERGENCE frame ${i} field ${key}: typescript=${String(value)} python=${String(actual[key])}`,
        );
        process.exit(1);
      }
    }
  }
  console.log(
    `agreement: ${frames.length} frames, ${compared} field comparisons, 0 divergences`,
  );
}
