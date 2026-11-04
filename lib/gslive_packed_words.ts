/**
 * GSLive Partner 118 packed market words (Word0 steam mask + signed time-until-score byte).
 */
import {
  steamFlagsFromTimeUntilScoreSec,
  type GsliveSteamFlags,
} from "./gslive_steam_index.ts";

/** Word0 bits used for score-proximity steam (spec mask 0x00006E00 includes 0x2000 | 0x4000). */
export const GSLIVE_WORD0_STEAM_MASK = 0x0000_6000;

export interface GslivePackedWord0Parse {
  readonly word0: bigint;
  readonly flags32: number;
  readonly steamFlags: GsliveSteamFlags;
  readonly signedTimeUntilScore8: number;
}

export function signedTimeUntilScoreFromWord2(word2: bigint | number): number {
  const w =
    typeof word2 === "bigint" ? Number(word2 & 0xffn) : (word2 >>> 0) & 0xff;
  return w >= 128 ? w - 256 : w;
}

export function parseGsLivePackedWord0(word0: bigint | number): GslivePackedWord0Parse {
  const w0 = typeof word0 === "bigint" ? word0 : BigInt(word0 >>> 0);
  const flags32 = Number(w0 & 0xffff_ffffn) >>> 0;
  const tusByte = signedTimeUntilScoreFromWord2(w0 >> 32n);
  const maskBits = flags32 & GSLIVE_WORD0_STEAM_MASK;
  const fromTus = steamFlagsFromTimeUntilScoreSec(tusByte);
  const steamFlags: GsliveSteamFlags =
    maskBits !== 0
      ? {
          within15s: (maskBits & 0x2000) !== 0,
          within5s: (maskBits & 0x4000) !== 0,
          word0SteamMask: maskBits,
        }
      : fromTus;
  return {
    word0: w0,
    flags32,
    steamFlags,
    signedTimeUntilScore8: tusByte,
  };
}

export function loadGslivePackedWordIndexFromJson(
  parsed: unknown,
): { lookup(rotationKey: string): GslivePackedWord0Parse | null } {
  const byRot = new Map<string, GslivePackedWord0Parse>();
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      let word0: bigint | null = null;
      if (typeof record.word0 === "string") {
        word0 = BigInt(record.word0);
      } else if (typeof record.word0Hex === "string") {
        word0 = BigInt(record.word0Hex);
      } else if (typeof record.word0 === "number") {
        word0 = BigInt(record.word0 >>> 0);
      }
      if (word0 === null) {
        const tus = Number(record.timeUntilScoreSec);
        if (Number.isFinite(tus)) {
          const flags = steamFlagsFromTimeUntilScoreSec(tus);
          const flags32 = flags.word0SteamMask;
          word0 = (BigInt(tus & 0xff) << 32n) | BigInt(flags32 >>> 0);
        } else {
          continue;
        }
      }
      const rot = key.trim().toUpperCase().startsWith("ROT ")
        ? key.trim().toUpperCase()
        : `ROT ${key.trim()}`;
      byRot.set(rot, parseGsLivePackedWord0(word0));
    }
  }
  return {
    lookup(rotationKey: string): GslivePackedWord0Parse | null {
      const norm = rotationKey.trim().toUpperCase();
      return byRot.get(norm) ?? null;
    },
  };
}
