/**
 * GSLive steam proximity index keyed by rotation (Partner 118 `timeUntilScore`).
 *
 * Maps to the bitwise steam layer (Word 0 mask 0x00006000 — |t| ≤ 15s / ≤ 5s) used when
 * full `GsLivePackedEventMarketWord64` feeds are unavailable.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface GsliveSteamEntry {
  readonly rotationKey: string;
  readonly timeUntilScoreSec: number;
  readonly partnerUserId: string | null;
  readonly logTimeMs: number | null;
}

export interface GsliveSteamFlags {
  readonly within15s: boolean;
  readonly within5s: boolean;
  /** Analog of `(flags32 & 0x00006000) !== 0` on the packed live word. */
  readonly word0SteamMask: number;
}

export interface GsliveSteamHit {
  readonly entry: GsliveSteamEntry;
  readonly flags: GsliveSteamFlags;
}

export interface GsliveSteamIndex {
  lookup(rotationKey: string): GsliveSteamHit | null;
}

export function steamFlagsFromTimeUntilScoreSec(
  timeUntilScoreSec: number,
): GsliveSteamFlags {
  const abs = Math.abs(timeUntilScoreSec);
  const within15s = abs <= 15;
  const within5s = abs <= 5;
  let word0SteamMask = 0;
  if (within15s) word0SteamMask |= 0x2000;
  if (within5s) word0SteamMask |= 0x4000;
  return { within15s, within5s, word0SteamMask };
}

function normalizeRotationKey(key: string): string {
  const trimmed = key.trim().toUpperCase();
  if (trimmed.startsWith("ROT ")) return trimmed;
  const digits = trimmed.match(/\d{3,5}/);
  return digits !== null ? `ROT ${digits[0]}` : trimmed;
}

export async function loadGsliveSteamIndexFromJson(
  path: string,
): Promise<GsliveSteamIndex> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`GSLive steam index missing: ${absolute}`);
  }
  const parsed = (await Bun.file(absolute).json()) as unknown;
  const byRot = new Map<string, GsliveSteamEntry>();

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (value === null || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const timeUntilScoreSec = Number(record.timeUntilScoreSec);
      if (!Number.isFinite(timeUntilScoreSec)) continue;
      const rotationKey = normalizeRotationKey(key);
      byRot.set(rotationKey, {
        rotationKey,
        timeUntilScoreSec,
        partnerUserId:
          typeof record.partnerUserId === "string"
            ? record.partnerUserId
            : null,
        logTimeMs:
          typeof record.logTimeMs === "number" ? record.logTimeMs : null,
      });
    }
  }

  return {
    lookup(rotationKey: string): GsliveSteamHit | null {
      const entry = byRot.get(normalizeRotationKey(rotationKey));
      if (entry === undefined) return null;
      return {
        entry,
        flags: steamFlagsFromTimeUntilScoreSec(entry.timeUntilScoreSec),
      };
    },
  };
}
