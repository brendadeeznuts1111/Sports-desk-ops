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

export function parseGsLivePackedWord0(
  word0: bigint | number,
): GslivePackedWord0Parse {
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
