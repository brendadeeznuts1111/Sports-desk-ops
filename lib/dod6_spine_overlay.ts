/**
 * DOD6 v5.4 spine overlays for sharp-tier automation (header + lifetime CSV export).
 *
 * The on-disk `.dodbin` customer columnar sections are not fully decoded here; production
 * cross-grades use the lifetime CSV export paired with the 64-byte envelope header
 * (`scripts/live_positions_cron.ts`). This module centralizes that boundary.
 */
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";

/** Locked v5.4 gate from the weight engine spec (spread/ML CLV legs). */
export const SHARP_CAND_MIN_CLV_LEGS_V54 = 3;

export interface Dod6SpineHeader {
  readonly path: string;
  readonly magic: string;
  readonly version: number;
  readonly sectionCount: number;
  readonly customerCount: number;
  readonly asOfEpochDays: number;
}

export interface DodCustomerLifetimeMeta {
  readonly canonicalCustomer: string;
  readonly lifetimeBets: number;
  readonly lifetimeStakedCents: number;
  readonly settledStakedCents: number;
  readonly settledNetCents: number;
  readonly clvLegs: number;
  readonly avgClvPoints: number;
}

export interface Dod6LifetimeLookup {
  readonly clvBps: number | null;
  readonly sharpScore: number | null;
  readonly lifetimeNetUsd: number | null;
  readonly clvLegs: number;
  readonly avgClvPoints: number | null;
  readonly sharpCandidateGatePassed: boolean;
  readonly source: "lifetime_csv" | "json_book" | "merged" | "dodbin_columnar";
}

export interface Dod6SpineOverlay {
  readonly header: Dod6SpineHeader | null;
  lookup(login: string): Dod6LifetimeLookup | null;
}

export function normalizeCanonicalCustomer(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s === "") return "";
  const noTrailingDots = s.replace(/\.+$/, "");
  const match = /^([A-Z0-9]+?)_[0-9]+$/.exec(noTrailingDots);
  return match ? match[1]! : noTrailingDots;
}

export function readDod6SpineHeader(path: string): Dod6SpineHeader | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(64);
    const bytesRead = readSync(fd, buf, 0, 64, 0);
    if (bytesRead < 64) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const magicU32 = dv.getUint32(0, true);
    const magic =
      magicU32 === 0x444f4436
        ? "DOD6"
        : new TextDecoder().decode(buf.subarray(0, 4));
    return {
      path,
      magic,
      version: dv.getUint32(4, true),
      sectionCount: dv.getUint32(36, true),
      customerCount: dv.getUint32(8, true),
      asOfEpochDays: dv.getUint32(28, true),
    };
  } finally {
    closeSync(fd);
  }
}

export async function loadDodCustomerLifetimeMap(
  csvPath: string,
): Promise<ReadonlyMap<string, DodCustomerLifetimeMeta>> {
  const map = new Map<string, DodCustomerLifetimeMeta>();
  if (!existsSync(csvPath)) return map;
  const text = await Bun.file(csvPath).text();
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === "") continue;
    const cols = line.split(",");
    if (cols.length < 12) continue;
    const canonical = normalizeCanonicalCustomer(cols[0] ?? "");
    if (canonical === "") continue;
    const lifetimeBets = Number(cols[1]) || 0;
    const lifetimeStakedCents = Math.round((Number(cols[2]) || 0) * 100);
    const settledNetCents = Math.round((Number(cols[8]) || 0) * 100);
    const clvLegs = Number(cols[10]) || 0;
    const avgClvPoints = Number(cols[11]) || 0;
    const settledStakedCents =
      cols.length >= 13 && cols[12]?.trim() !== ""
        ? Math.round((Number(cols[12]) || 0) * 100)
        : lifetimeStakedCents;

    const prev = map.get(canonical);
    if (prev === undefined) {
      map.set(canonical, {
        canonicalCustomer: canonical,
        lifetimeBets,
        lifetimeStakedCents,
        settledStakedCents,
        settledNetCents,
        clvLegs,
        avgClvPoints,
      });
    } else {
      const totalClvLegs = prev.clvLegs + clvLegs;
      const mergedClv =
        totalClvLegs > 0
          ? (prev.clvLegs * prev.avgClvPoints + clvLegs * avgClvPoints) /
            totalClvLegs
          : 0;
      map.set(canonical, {
        canonicalCustomer: canonical,
        lifetimeBets: prev.lifetimeBets + lifetimeBets,
        lifetimeStakedCents: prev.lifetimeStakedCents + lifetimeStakedCents,
        settledStakedCents: prev.settledStakedCents + settledStakedCents,
        settledNetCents: prev.settledNetCents + settledNetCents,
        clvLegs: totalClvLegs,
        avgClvPoints: Number(mergedClv.toFixed(2)),
      });
    }
  }
  return map;
}

function lifetimeToLookup(meta: DodCustomerLifetimeMeta): Dod6LifetimeLookup {
  const clvBps =
    meta.avgClvPoints !== 0 ? Math.round(meta.avgClvPoints * 100) : null;
  return {
    clvBps,
    sharpScore: null,
    lifetimeNetUsd: meta.settledNetCents / 100,
    clvLegs: meta.clvLegs,
    avgClvPoints: meta.avgClvPoints,
    sharpCandidateGatePassed: meta.clvLegs >= SHARP_CAND_MIN_CLV_LEGS_V54,
    source: "lifetime_csv",
  };
}

export async function createDod6SpineOverlay(options: {
  readonly dodbinPath?: string;
  readonly lifetimeCsvPath?: string;
  readonly jsonBookPath?: string;
}): Promise<Dod6SpineOverlay> {
  const dodbinPath = options.dodbinPath ?? "";
  const header =
    dodbinPath !== "" ? readDod6SpineHeader(resolve(dodbinPath)) : null;

  let columnarLookup: ((login: string) => Dod6LifetimeLookup | null) | null =
    null;
  if (dodbinPath !== "") {
    const { createDod6V54LifetimeReader } =
      await import("./dod6_v54_lifetime_reader.ts");
    const reader = await createDod6V54LifetimeReader(resolve(dodbinPath));
    if (reader !== null) {
      columnarLookup = (login: string) => {
        const row = reader.lookup(login);
        return row === null ? null : { ...row, source: "dodbin_columnar" };
      };
    }
  }

  const lifetimeMap =
    options.lifetimeCsvPath !== undefined && options.lifetimeCsvPath !== ""
      ? await loadDodCustomerLifetimeMap(resolve(options.lifetimeCsvPath))
      : new Map<string, DodCustomerLifetimeMeta>();

  let jsonLookup: ((login: string) => Dod6LifetimeLookup | null) | null = null;
  if (options.jsonBookPath !== undefined && options.jsonBookPath !== "") {
    const { loadDod6BookOverlayFromJson } =
      await import("./weight_tier_signal_enrichment.ts");
    const book = loadDod6BookOverlayFromJson(options.jsonBookPath);
    jsonLookup = (login: string) => {
      const row = book.lookup(login);
      if (row === null) return null;
      return {
        clvBps: row.clvBps,
        sharpScore: row.sharpScore,
        lifetimeNetUsd: row.lifetimeNetUsd,
        clvLegs: 0,
        avgClvPoints: row.clvBps !== null ? row.clvBps / 100 : null,
        sharpCandidateGatePassed: false,
        source: "json_book",
      };
    };
  }

  return {
    header,
    lookup(login: string): Dod6LifetimeLookup | null {
      const fromColumnar = columnarLookup?.(login) ?? null;
      const canonical = normalizeCanonicalCustomer(login);
      const fromCsv = lifetimeMap.get(canonical);
      if (fromColumnar !== null) {
        const fromJson = jsonLookup?.(login);
        if (fromJson === null || fromJson === undefined) return fromColumnar;
        return {
          clvBps: fromJson.clvBps ?? fromColumnar.clvBps,
          sharpScore: fromJson.sharpScore ?? fromColumnar.sharpScore,
          lifetimeNetUsd:
            fromJson.lifetimeNetUsd ?? fromColumnar.lifetimeNetUsd,
          clvLegs: fromColumnar.clvLegs,
          avgClvPoints: fromColumnar.avgClvPoints,
          sharpCandidateGatePassed: fromColumnar.sharpCandidateGatePassed,
          source: "merged",
        };
      }
      if (fromCsv !== undefined) {
        const base = lifetimeToLookup(fromCsv);
        const fromJson = jsonLookup?.(login);
        if (fromJson === null || fromJson === undefined) return base;
        return {
          clvBps: fromJson.clvBps ?? base.clvBps,
          sharpScore: fromJson.sharpScore ?? base.sharpScore,
          lifetimeNetUsd: fromJson.lifetimeNetUsd ?? base.lifetimeNetUsd,
          clvLegs: base.clvLegs,
          avgClvPoints: base.avgClvPoints,
          sharpCandidateGatePassed: base.sharpCandidateGatePassed,
          source: "merged",
        };
      }
      return jsonLookup?.(login) ?? null;
    },
  };
}
