/**
 * @file src/lib/portal_taxonomy_normalizer.ts
 * @description Dense portal-taxonomy lookup for F402 sport/subSport pairs and the 15-bit
 * subSport combo key. Manifest-driven (DOD-DEHARDCODE-02); resolution on the hot path scans
 * the input strings in place (no trim/toLowerCase allocations).
 */

/** 15-bit combo key (0..32767). Kept as a named alias for call-site clarity. */
export type SubSportComboPackedKey15 = number;

export const SUBSPORT_UNKNOWN_CODE6 = 0 as const;

export const MARKET_KIND_BITS = 2 as const;
export const PERIOD_BITS = 4 as const;
export const WAGER_TYPE_BITS = 3 as const;
export const SUB_SPORT_BITS = 6 as const;

export const MARKET_KIND_SHIFT = 0 as const;
export const PERIOD_SHIFT = (MARKET_KIND_SHIFT + MARKET_KIND_BITS) as 2; // [5:2]
export const WAGER_TYPE_SHIFT = (PERIOD_SHIFT + PERIOD_BITS) as 6; // [8:6]
export const SUB_SPORT_SHIFT = (WAGER_TYPE_SHIFT + WAGER_TYPE_BITS) as 9; // [14:9]

export const MARKET_KIND_MASK = ((1 << MARKET_KIND_BITS) - 1) as 0x03; // [1:0]
export const PERIOD_MASK = ((1 << PERIOD_BITS) - 1) as 0x0f; // [5:2]
export const WAGER_TYPE_MASK = ((1 << WAGER_TYPE_BITS) - 1) as 0x07; // [8:6]
export const SUB_SPORT_MASK = ((1 << SUB_SPORT_BITS) - 1) as 0x3f; // [14:9]
export const SUBSPORT_FIELD_MASK = SUB_SPORT_MASK;
export const COMBO_KEY15_BITS = (SUB_SPORT_BITS +
  WAGER_TYPE_BITS +
  PERIOD_BITS +
  MARKET_KIND_BITS) as 15;
export const COMBO_KEY15_MASK = ((1 << COMBO_KEY15_BITS) - 1) as 0x7fff;

export interface PortalTaxonomyEntry {
  readonly sport: string;
  readonly subSport: string;
  readonly denseCode6: number;
  readonly aliases?: readonly string[];
}

export interface PortalTaxonomyManifest {
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly r2_published_at_epoch_ms: number;
  readonly entries: readonly PortalTaxonomyEntry[];
}

export interface PortalTaxonomyR2Client {
  file(key: string): {
    stat(): Promise<{ readonly etag?: string } | undefined>;
    text(): Promise<string>;
  };
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isBlank(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (!isWhitespaceCode(value.charCodeAt(i))) return false;
  }
  return true;
}

/** Lowercase + trim for stored keys only (construction, not the hot path). */
function normalizeForStorage(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isWhitespaceCode(value.charCodeAt(start))) start += 1;
  while (end > start && isWhitespaceCode(value.charCodeAt(end - 1))) end -= 1;
  let out = "";
  for (let i = start; i < end; i += 1) {
    let code = value.charCodeAt(i);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    out += String.fromCharCode(code);
  }
  return out;
}

function hashNormalizedPart(value: string, seed: number): number {
  let h = seed;
  let start = 0;
  let end = value.length;
  while (start < end && isWhitespaceCode(value.charCodeAt(start))) start += 1;
  while (end > start && isWhitespaceCode(value.charCodeAt(end - 1))) end -= 1;
  for (let i = start; i < end; i += 1) {
    let code = value.charCodeAt(i);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    h ^= code;
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

function hashPair(sport: string, subSport: string): number {
  let h = 0x811c9dc5;
  h = hashNormalizedPart(sport, h);
  h ^= 0x1f; // delimiter between the two fields; avoids FOOT/BALL vs FOO/TBALL
  h = Math.imul(h, 0x01000193);
  h = hashNormalizedPart(subSport, h);
  return h >>> 0;
}

/** Case-insensitive, outer-whitespace-insensitive compare without allocating. */
function equalsNormalizedInput(input: string, storedLower: string): boolean {
  let start = 0;
  let end = input.length;
  while (start < end && isWhitespaceCode(input.charCodeAt(start))) start += 1;
  while (end > start && isWhitespaceCode(input.charCodeAt(end - 1))) end -= 1;
  if (end - start !== storedLower.length) return false;
  for (let i = start, j = 0; i < end; i += 1, j += 1) {
    let code = input.charCodeAt(i);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    if (code !== storedLower.charCodeAt(j)) return false;
  }
  return true;
}

function rangeError(detail: string): Error {
  return new Error(`ERR_DOD_BITFIELD_RANGE_OVERFLOW: ${detail}`);
}

function assertField(name: string, value: number, mask: number): void {
  if (!Number.isInteger(value) || value < 0 || value > mask) {
    throw rangeError(`${name}=${String(value)} outside 0..${mask}`);
  }
}

/** Packs [14:9] subSport6 | [8:6] wagerType3 | [5:2] period4 | [1:0] marketKind2. */
export function packSubSportComboKey15(
  subSport6: number,
  wagerType3: number,
  period4: number,
  marketKind2: number,
): SubSportComboPackedKey15 {
  assertField("subSport6", subSport6, SUB_SPORT_MASK);
  assertField("wagerType3", wagerType3, WAGER_TYPE_MASK);
  assertField("period4", period4, PERIOD_MASK);
  assertField("marketKind2", marketKind2, MARKET_KIND_MASK);
  return (
    ((subSport6 & SUB_SPORT_MASK) << SUB_SPORT_SHIFT) |
    ((wagerType3 & WAGER_TYPE_MASK) << WAGER_TYPE_SHIFT) |
    ((period4 & PERIOD_MASK) << PERIOD_SHIFT) |
    ((marketKind2 & MARKET_KIND_MASK) << MARKET_KIND_SHIFT)
  );
}

export class DenseSubSportLookupTable {
  readonly generationU32: number;
  private readonly capacity: number;
  private readonly mask: number;
  private readonly sports: string[];
  private readonly subs: string[];
  private readonly codes: Uint8Array;

  constructor(manifest: PortalTaxonomyManifest) {
    if (
      !Number.isInteger(manifest.generation_u32) ||
      manifest.generation_u32 < 0
    ) {
      throw rangeError(
        `generation_u32=${String(manifest.generation_u32)} is not an unsigned integer`,
      );
    }
    this.generationU32 = manifest.generation_u32;

    const entries = manifest.entries;
    if (!Array.isArray(entries)) {
      throw rangeError("manifest.entries is not an array");
    }

    const seenCodes = new Set<number>();
    let keyCount = 0;
    for (const entry of entries) {
      const code = entry.denseCode6;
      if (!Number.isInteger(code) || code <= 0 || code > SUB_SPORT_MASK) {
        throw rangeError(
          `denseCode6=${String(code)} outside 1..${SUB_SPORT_MASK}`,
        );
      }
      if (seenCodes.has(code)) {
        throw rangeError(`Duplicate denseCode6=${code}`);
      }
      seenCodes.add(code);
      keyCount += 1 + (entry.aliases?.length ?? 0);
    }

    let capacity = 16;
    while (capacity < keyCount * 2) capacity *= 2;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.sports = Array.from({ length: capacity }, () => "");
    this.subs = Array.from({ length: capacity }, () => "");
    this.codes = new Uint8Array(capacity);

    for (const entry of entries) {
      const sport = normalizeForStorage(entry.sport);
      const subSport = normalizeForStorage(entry.subSport);
      this.insert(sport, subSport, entry.denseCode6, "canonical");
      for (const alias of entry.aliases ?? []) {
        this.insert(
          sport,
          normalizeForStorage(alias),
          entry.denseCode6,
          "alias",
        );
      }
    }
  }

  private insert(
    sport: string,
    subSport: string,
    code: number,
    kind: "canonical" | "alias",
  ): void {
    let index = hashPair(sport, subSport) & this.mask;
    for (let step = 0; step < this.capacity; step += 1) {
      const existingCode = this.codes[index]!;
      if (existingCode === 0) {
        this.sports[index] = sport;
        this.subs[index] = subSport;
        this.codes[index] = code;
        return;
      }
      if (this.sports[index] === sport && this.subs[index] === subSport) {
        if (existingCode === code) return;
        throw rangeError(
          `Conflicting ${kind === "alias" ? "alias" : "taxonomy"} mapping for ${sport}/${subSport} (${existingCode} vs ${code})`,
        );
      }
      index = (index + 1) & this.mask;
    }
    throw rangeError("Taxonomy lookup table is full");
  }

  /**
   * Resolve a canonical or alias subSport to its dense 6-bit code.
   *
   * `null`/`undefined`/blank subSport is the unknown code 0. A non-blank subSport that is not
   * in the manifest fails closed, as does an empty sport with a non-blank subSport.
   */
  resolveDenseSubSportCode6(
    sport: string | null | undefined,
    subSport: string | null | undefined,
  ): number {
    if (subSport == null || typeof subSport !== "string" || isBlank(subSport)) {
      return SUBSPORT_UNKNOWN_CODE6;
    }
    if (sport == null || typeof sport !== "string" || isBlank(sport)) {
      throw rangeError(
        `Unmapped F402 taxonomy pair (<empty>/${String(subSport)})`,
      );
    }

    let index = hashPair(sport, subSport) & this.mask;
    for (let step = 0; step < this.capacity; step += 1) {
      const code = this.codes[index]!;
      if (code === 0) break;
      if (
        equalsNormalizedInput(sport, this.sports[index]!) &&
        equalsNormalizedInput(subSport, this.subs[index]!)
      ) {
        return code;
      }
      index = (index + 1) & this.mask;
    }
    throw rangeError(`Unmapped F402 taxonomy pair (${sport}/${subSport})`);
  }
}

function assertManifest(
  value: unknown,
): asserts value is PortalTaxonomyManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("ERR_DOD_INVALID_SPINE_MAGIC: manifest is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.generation_u32) ||
    typeof record.merkle_root_sha256 !== "string" ||
    !Number.isFinite(record.r2_published_at_epoch_ms) ||
    !Array.isArray(record.entries)
  ) {
    throw new Error(
      "ERR_DOD_INVALID_SPINE_MAGIC: generation_u32, merkle_root_sha256, r2_published_at_epoch_ms and entries are required",
    );
  }
  for (const entry of record.entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("ERR_DOD_INVALID_SPINE_MAGIC: entry is not an object");
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.sport !== "string" ||
      typeof row.subSport !== "string" ||
      !Number.isInteger(row.denseCode6) ||
      (row.aliases !== undefined &&
        (!Array.isArray(row.aliases) ||
          !row.aliases.every((alias) => typeof alias === "string")))
    ) {
      throw new Error(
        "ERR_DOD_INVALID_SPINE_MAGIC: entry requires sport/subSport strings, an integer denseCode6 and string aliases",
      );
    }
  }
}

/** Fetch and validate the taxonomy manifest from R2, returning the table and its ETag. */
export async function hydratePortalTaxonomyFromR2(
  r2: PortalTaxonomyR2Client,
): Promise<{ table: DenseSubSportLookupTable; eTag: string }> {
  const key = "manifests/portal-taxonomy/latest";
  const file = r2.file(key);
  const [stat, text] = await Promise.all([file.stat(), file.text()]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `ERR_DOD_INVALID_SPINE_MAGIC: manifest is not JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
      { cause: error },
    );
  }
  assertManifest(parsed);
  return {
    table: new DenseSubSportLookupTable(parsed),
    eTag: stat?.etag ?? "",
  };
}
