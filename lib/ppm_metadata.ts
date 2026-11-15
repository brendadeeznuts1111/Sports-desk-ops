/**
 * @file lib/ppm_metadata.ts
 * @description Name dictionaries from `GET /betLobbyV2/eventsMetadata/`.
 *
 * Only the **sports** dictionary is exposed, deliberately. The response also
 * carries 9,456 leagues, but they are a different identity space from the
 * fixture snapshot: of the snapshot's 308 `(sportId, leagueId)` pairs, 14 match,
 * and the matches are wrong (snapshot `(1, 4)` is not metadata league 4, which
 * is NFL under sport 3). Exposing league names would invite a silent
 * mislabelling, so the parser leaves them out and the guard below catches any
 * sport-id drift instead.
 *
 * Sport ids, unlike league ids, do agree: all 35 sports in the snapshot resolve
 * here (1 Baseball, 93 Table Tennis, 102 College Basketball, …).
 */

export interface PpmMetadata {
  /** sportId -> display name. */
  readonly sportNames: ReadonlyMap<number, string>;
  /** Counts kept for provenance reporting; not used for joins. */
  readonly counts: {
    readonly sports: number;
    /** Entries present in the feed but unusable (no display name). */
    readonly unnamedSports: number;
    readonly leagues: number;
    readonly wagertypes: number;
  };
}

export class PpmMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PpmMetadataError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the sports dictionary; throws if the shape is not recognisable. */
export function parsePpmMetadata(payload: unknown): PpmMetadata {
  if (!isRecord(payload) || !isRecord(payload.sports)) {
    throw new PpmMetadataError("expected { sports: { id: { n } }, ... }");
  }

  const sportNames = new Map<number, string>();
  let unnamedSports = 0;
  for (const [key, entry] of Object.entries(payload.sports)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PpmMetadataError(`sport key is not a positive integer: ${key}`);
    }
    const name = isRecord(entry) ? entry.n : undefined;
    if (typeof name !== "string" || name.length === 0) {
      // The live dictionary contains placeholder entries (e.g. sport 323).
      // They are skipped, not fatal: one nameless entry must not blank the map.
      unnamedSports += 1;
      continue;
    }
    sportNames.set(id, name);
  }

  return {
    sportNames,
    counts: {
      sports: sportNames.size,
      unnamedSports,
      leagues: isRecord(payload.leagues)
        ? Object.keys(payload.leagues).length
        : 0,
      wagertypes: isRecord(payload.wagertypes)
        ? Object.keys(payload.wagertypes).length
        : 0,
    },
  };
}
