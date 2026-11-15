/**
 * @file scripts/nsh_frame_golden.ts
 * @description Generates and verifies the committed golden vectors for the
 * 64-byte NSH frame. The `.hex` fixtures are the artifact of record; the lock
 * file pins their SHA-256 so a layout change cannot pass review silently.
 *
 *   bun scripts/nsh_frame_golden.ts            # verify against the lock
 *   bun scripts/nsh_frame_golden.ts --write    # regenerate fixtures + lock
 *
 * Every value here is a literal: the vectors must not depend on `Date.now()`,
 * the provenance palette, or any table that can move.
 */
import { createHash } from "node:crypto";
import {
  NshFrameWriter,
  packNshBinaryFrame,
  type NshMatchFrameInput,
} from "../lib/nsh_frame_codec.ts";
import { OriginDomainWireId, WriterLaneWireId } from "../lib/domain-enums.ts";

export interface GoldenVector {
  readonly name: string;
  readonly input: NshMatchFrameInput;
}

/** Three vectors: the happy path, the all-ones bounds, and a signed liability. */
export const GOLDEN_VECTORS: readonly GoldenVector[] = [
  {
    name: "ticker-match-gslive",
    input: {
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
    },
  },
  {
    name: "bounds-all-ones",
    input: {
      messageType: 3,
      channelId: 0xf,
      slaDivide10Ms: 0xff,
      rowIndex: 0xfffff,
      betGroupId: 0xffffffffffffffffn,
      stakeUsdc: 500,
      bookOdds: 73.3453,
      polyAvgPrice: 0.999999,
      liabilityDelta: 2700,
      originDomainWireId: OriginDomainWireId.HOST_NSH_DESK_LOCAL,
      writerLaneWireId: WriterLaneWireId.BLOCKED,
      flags: 0xffff,
      slippageBps: 0xff,
      timestampMs: 1_700_000_123_456,
    },
  },
  {
    name: "liability-negative-f402",
    input: {
      channelId: 3,
      slaDivide10Ms: 25,
      rowIndex: 168,
      betGroupId: 9001n,
      stakeUsdc: 2500,
      bookOdds: 1.91,
      polyAvgPrice: 0.51,
      liabilityDelta: -2275,
      originDomainWireId: OriginDomainWireId.F402,
      writerLaneWireId: WriterLaneWireId.ALERT,
      flags: 0x0001,
      slippageBps: 18,
      timestampMs: 1_700_000_002_000,
    },
  },
];

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const FIXTURE_DIR = new URL("../tests/fixtures/nsh_frames/", import.meta.url);
const LOCK_FILE = new URL("golden.lock.json", FIXTURE_DIR);

interface LockEntry {
  readonly bytes: number;
  readonly sha256: string;
  readonly hex: string;
}

async function writeFixtures(): Promise<void> {
  const lock: Record<string, LockEntry> = {};
  for (const vector of GOLDEN_VECTORS) {
    const bytes = packNshBinaryFrame(vector.input);
    const hex = hexOf(bytes);
    lock[vector.name] = {
      bytes: bytes.byteLength,
      sha256: sha256Of(bytes),
      hex,
    };
    await Bun.write(new URL(`${vector.name}.hex`, FIXTURE_DIR), `${hex}\n`);
  }
  await Bun.write(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `wrote ${GOLDEN_VECTORS.length} golden vectors to tests/fixtures/nsh_frames/`,
  );
}

async function verifyFixtures(): Promise<number> {
  const lock = (await Bun.file(LOCK_FILE).json()) as Record<string, LockEntry>;
  let failures = 0;
  const writer = new NshFrameWriter();
  for (const vector of GOLDEN_VECTORS) {
    const bytes = writer.write(vector.input);
    const expected = lock[vector.name];
    if (!expected) {
      console.error(`MISSING lock entry: ${vector.name}`);
      failures += 1;
      continue;
    }
    const actualHex = hexOf(bytes);
    const actualSha = sha256Of(bytes);
    const fileHex = (
      await Bun.file(new URL(`${vector.name}.hex`, FIXTURE_DIR)).text()
    ).trim();
    if (actualHex !== expected.hex || actualSha !== expected.sha256) {
      console.error(
        `DRIFT ${vector.name}: sha256 ${actualSha} != ${expected.sha256}`,
      );
      failures += 1;
    } else if (fileHex !== actualHex) {
      console.error(
        `DRIFT ${vector.name}: fixture file differs from the writer`,
      );
      failures += 1;
    } else {
      console.log(`ok ${vector.name} ${actualSha.slice(0, 16)}…`);
    }
  }
  return failures;
}

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    await writeFixtures();
  } else {
    const failures = await verifyFixtures();
    if (failures > 0) {
      console.error(`${failures} golden vector(s) drifted`);
      process.exit(1);
    }
    console.log("golden vectors match");
  }
}
