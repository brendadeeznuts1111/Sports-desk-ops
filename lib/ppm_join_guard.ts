/**
 * @file lib/ppm_join_guard.ts
 * @description Hard gates between feeds that look joinable but are not.
 *
 * Two identity spaces in this system are traps:
 *
 *  1. **Slates.** The fixture snapshot and the odds feed are joined on
 *     `event_id` (unique leaf, no dedupe needed). The *board* additionally
 *     groups by the feed's outer bucket. If the odds payload used a different
 *     bucket space, every priced row would land on a board row the snapshot
 *     never produced — and nothing would error, because the leaf join would
 *     still succeed.
 *  2. **Leagues.** `eventsMetadata` carries 9,456 league ids that do not agree
 *     with the snapshot's league ids (14 of 308 pairs match, and the matches are
 *     wrong). Sport ids do agree, so sports may be joined — but only through
 *     this check, not by assumption.
 *
 * Fail closed: a warning would be skipped, a throw is what keeps a silent
 * mismatch out.
 */

export type PpmJoinErrorCode =
  "slate_id_space_mismatch" | "sport_id_space_mismatch";

export class PpmJoinError extends Error {
  readonly code: PpmJoinErrorCode;

  constructor(code: PpmJoinErrorCode, message: string) {
    super(message);
    this.name = "PpmJoinError";
    this.code = code;
  }
}

export interface IdSpaceOverlap {
  readonly overlap: number;
  readonly total: number;
  readonly ratio: number;
}

/** Former name, kept so existing callers and tests compile. */
export type SlateSpaceOverlap = IdSpaceOverlap;

function measureOverlap(
  knownIds: Iterable<number>,
  incomingIds: Iterable<number>,
): IdSpaceOverlap {
  const known = new Set<number>(knownIds);
  const incoming = new Set<number>(incomingIds);
  if (incoming.size === 0) return { overlap: 0, total: 0, ratio: 1 };

  let overlap = 0;
  for (const id of incoming) if (known.has(id)) overlap += 1;
  return { overlap, total: incoming.size, ratio: overlap / incoming.size };
}

function assertSpace(
  code: PpmJoinErrorCode,
  label: string,
  knownIds: Iterable<number>,
  incomingIds: Iterable<number>,
  minOverlap: number,
): IdSpaceOverlap {
  if (!(minOverlap > 0 && minOverlap <= 1)) {
    throw new RangeError(`minOverlap must be in (0, 1] (got ${minOverlap})`);
  }
  const result = measureOverlap(knownIds, incomingIds);
  if (result.ratio < minOverlap) {
    throw new PpmJoinError(
      code,
      `ERR_${code.toUpperCase()}: ${result.overlap}/${result.total} ${label} ids appear in the reference set (${(result.ratio * 100).toFixed(1)}% < ${(minOverlap * 100).toFixed(0)}%)`,
    );
  }
  return result;
}

/**
 * Snapshot slate ids vs odds slate ids. Empty odds input is a no-op: there is
 * nothing to reconcile yet.
 */
export function assertSlateSpaceOverlap(
  snapshotSlateIds: Iterable<number>,
  oddsSlateIds: Iterable<number>,
  minOverlap = 0.95,
): IdSpaceOverlap {
  return assertSpace(
    "slate_id_space_mismatch",
    "odds slate",
    snapshotSlateIds,
    oddsSlateIds,
    minOverlap,
  );
}

/**
 * Metadata sport ids (the reference) vs the snapshot's sport ids (the incoming
 * set). Measures the share of *snapshot* sports the metadata can name — the
 * metadata carries 279 sports against the snapshot's 35, so the direction
 * matters. Passes 35/35 today; exists so a future feed swap cannot silently
 * rename the board.
 */
export function assertSportIdSpaceOverlap(
  metadataSportIds: Iterable<number>,
  snapshotSportIds: Iterable<number>,
  minOverlap = 0.95,
): IdSpaceOverlap {
  return assertSpace(
    "sport_id_space_mismatch",
    "snapshot sport",
    metadataSportIds,
    snapshotSportIds,
    minOverlap,
  );
}
