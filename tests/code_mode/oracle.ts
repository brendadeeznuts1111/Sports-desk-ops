/**
 * FROZEN ORACLE — Code Mode profile query contract.
 *
 * Derived only from the profile schema (field `clv` | `vol` | `sharp`, `flags: string[]`) and the
 * committed 31-profile snapshot (`data/profile-snapshot.json`). No implementation file was read
 * while writing it: the invariants below are the contract the tool must satisfy.
 *
 *   (a) every returned value is a finite number;
 *   (b) sentinel rows are excluded unless `includeSentinels === true` (strict identity);
 *   (c) rows are sorted descending by the requested field;
 *   (d) every row carries `flags: string[]` and `sentinel: boolean`;
 *   (e) the limit is clamped to MAX_LIMIT and `truncated` is true only when the requested limit
 *       exceeded MAX_LIMIT.
 *
 * The snapshot is frozen here: a changed profile count or sentinel id set throws at import time,
 * forcing a deliberate re-freeze instead of a silently weakened suite.
 */

import { readFileSync } from "node:fs";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = MAX_LIMIT;

/** Re-freeze deliberately when the snapshot changes; the suite must not follow the data. */
export const EXPECTED_PROFILE_COUNT = 31;
export const EXPECTED_SENTINEL_IDS: readonly string[] = Object.freeze([
  "SYNTH_01",
  "SYNTH_02",
  "SYNTH_03",
  "SYNTH_04",
]);

export type ProfileField = "clv" | "vol" | "sharp";

export interface OracleProfile {
  readonly id: string;
  readonly vol: number;
  readonly clv: number;
  readonly sharp: number;
  readonly flags: readonly string[];
}

export interface OracleRow {
  readonly id: string;
  readonly value: number;
  readonly flags: readonly string[];
  readonly sentinel: boolean;
}

export interface OracleQueryResult {
  readonly field: ProfileField;
  readonly rows: readonly OracleRow[];
  readonly truncated: boolean;
}

export type OracleOutcome =
  | { readonly ok: true; readonly result: OracleQueryResult }
  | { readonly ok: false; readonly reason: string };

export interface OracleProfileResult {
  readonly id: string;
  readonly vol: number;
  readonly clv: number;
  readonly sharp: number;
  readonly flags: readonly string[];
}

export interface OracleSummary {
  readonly deltaVol: number;
  readonly deltaNet: number;
}

const FIELDS: Readonly<
  Record<ProfileField, (profile: OracleProfile) => number>
> = Object.freeze({
  clv: (profile) => profile.clv,
  vol: (profile) => profile.vol,
  sharp: (profile) => profile.sharp,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Own data property only, read once: inherited keys and getter re-reads are not arguments. */
const ownValue = (source: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(source, key) ? source[key] : undefined;

const isField = (value: unknown): value is ProfileField =>
  typeof value === "string" && Object.hasOwn(FIELDS, value);

const finite = (value: unknown, where: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`oracle snapshot: ${where} is not a finite number`);
  }
  return value;
};

const strings = (value: unknown, where: string): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`oracle snapshot: ${where} is not a string array`);
  }
  return Object.freeze(
    value.filter((entry): entry is string => typeof entry === "string"),
  );
};

const parseProfiles = (raw: unknown): readonly OracleProfile[] => {
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) {
    throw new Error("oracle snapshot: missing profiles array");
  }
  const profiles = raw.profiles.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
      throw new Error(`oracle snapshot: profile #${index} has no id`);
    }
    const profile: OracleProfile = Object.freeze({
      id: entry.id,
      vol: finite(entry.vol, `${entry.id}.vol`),
      clv: finite(entry.clv, `${entry.id}.clv`),
      sharp: finite(entry.sharp, `${entry.id}.sharp`),
      flags: strings(entry.flags, `${entry.id}.flags`),
    });
    return profile;
  });
  return Object.freeze(profiles);
};

const SNAPSHOT: readonly OracleProfile[] = parseProfiles(
  JSON.parse(
    readFileSync(
      new URL("../../data/profile-snapshot.json", import.meta.url),
      "utf8",
    ),
  ),
);

const SENTINEL_SET: ReadonlySet<string> = new Set(EXPECTED_SENTINEL_IDS);

if (SNAPSHOT.length !== EXPECTED_PROFILE_COUNT) {
  throw new Error(
    `ORACLE FROZEN: snapshot has ${SNAPSHOT.length} profiles, oracle froze ${EXPECTED_PROFILE_COUNT}. Re-freeze oracle.ts deliberately.`,
  );
}

const observedSentinels = SNAPSHOT.filter((profile) =>
  profile.id.startsWith("SYNTH_"),
)
  .map((profile) => profile.id)
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
if (
  observedSentinels.length !== EXPECTED_SENTINEL_IDS.length ||
  observedSentinels.some((id, index) => id !== EXPECTED_SENTINEL_IDS[index])
) {
  throw new Error(
    `ORACLE FROZEN: sentinel ids changed (observed ${observedSentinels.join(",")}). Re-freeze oracle.ts deliberately.`,
  );
}

export function snapshotProfiles(): readonly OracleProfile[] {
  return SNAPSHOT;
}

/** The first non-sentinel profile, for tests that need a concrete id without hardcoding one. */
export function firstRegularProfile(): OracleProfile {
  const profile = SNAPSHOT.find((entry) => !entry.id.startsWith("SYNTH_"));
  if (profile === undefined) {
    throw new Error("oracle snapshot has no regular profile");
  }
  return profile;
}

export function isSentinelProfile(id: string): boolean {
  return SENTINEL_SET.has(id);
}

const resolveLimit = (
  value: unknown,
):
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly reason: string } => {
  if (value === undefined) return { ok: true, limit: DEFAULT_LIMIT };
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return {
      ok: false,
      reason: `limit must be a positive integer, received ${String(value)}`,
    };
  }
  return { ok: true, limit: Math.min(value, MAX_LIMIT) };
};

const compareRows = (left: OracleRow, right: OracleRow): number => {
  if (left.value !== right.value) return right.value - left.value;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/** Reference result for a valid request; invalid arguments yield `{ ok: false }`. */
export function oracleQuery(args: unknown): OracleOutcome {
  if (!isRecord(args))
    return { ok: false, reason: "arguments must be an object" };
  const fieldValue = ownValue(args, "field");
  if (!isField(fieldValue)) return { ok: false, reason: "unknown field" };
  const field = fieldValue;
  const limitValue = ownValue(args, "limit");
  const limit = resolveLimit(limitValue);
  if (!limit.ok) return { ok: false, reason: limit.reason };
  const includeSentinels = ownValue(args, "includeSentinels") === true;
  const resolve = FIELDS[field];

  const rows: OracleRow[] = [];
  for (const profile of SNAPSHOT) {
    const sentinel = isSentinelProfile(profile.id);
    if (sentinel && !includeSentinels) continue;
    rows.push({
      id: profile.id,
      value: resolve(profile),
      flags: profile.flags,
      sentinel,
    });
  }
  rows.sort(compareRows);

  const requested = typeof limitValue === "number" ? limitValue : DEFAULT_LIMIT;
  return {
    ok: true,
    result: {
      field,
      rows: rows.slice(0, limit.limit),
      truncated: requested > MAX_LIMIT,
    },
  };
}

export function oracleGetProfile(
  id: unknown,
): OracleProfileResult | { readonly error: true } {
  if (typeof id !== "string" || id.trim() === "") return { error: true };
  const needle = id.trim();
  const profile = SNAPSHOT.find((entry) => entry.id === needle);
  if (profile === undefined) return { error: true };
  return {
    id: profile.id,
    vol: profile.vol,
    clv: profile.clv,
    sharp: profile.sharp,
    flags: profile.flags,
  };
}

/** Desk-book totals: sentinel (synthetic) rows are excluded. */
export function oracleSummary(): OracleSummary {
  let deltaVol = 0;
  let deltaNet = 0;
  for (const profile of SNAPSHOT) {
    if (isSentinelProfile(profile.id)) continue;
    deltaVol += profile.vol;
    deltaNet += profile.clv;
  }
  return { deltaVol, deltaNet };
}

export const isToolErrorLike = (value: unknown): boolean =>
  value instanceof Error &&
  Object.getOwnPropertyDescriptor(value, "toolError")?.value === true;

/**
 * Invariants (a)-(e) for a result the tool actually returned. Throws with the first violation.
 * The oracle outcome is checked separately by `assertMatchesOracle`.
 */
export function assertQueryInvariants(
  result: unknown,
  args: unknown,
): asserts result is OracleQueryResult {
  if (!isRecord(result)) throw new Error("result is not an object");
  const requestedField = isRecord(args) ? ownValue(args, "field") : undefined;
  if (result.field !== requestedField) {
    throw new Error(
      `result.field ${String(result.field)} does not echo the requested field`,
    );
  }
  if (typeof result.truncated !== "boolean")
    throw new Error("result.truncated is not boolean");
  if (!Array.isArray(result.rows))
    throw new Error("result.rows is not an array");

  const requested = isRecord(args) ? ownValue(args, "limit") : undefined;
  if (requested === undefined) {
    if (result.truncated)
      throw new Error("truncated is true without a requested limit");
  } else if (typeof requested === "number" && Number.isFinite(requested)) {
    if (result.truncated !== requested > MAX_LIMIT) {
      throw new Error(
        `truncated must be ${requested > MAX_LIMIT} for limit ${requested}`,
      );
    }
  }
  if (result.rows.length > MAX_LIMIT) throw new Error("rows exceed MAX_LIMIT");

  const includeSentinels =
    isRecord(args) && ownValue(args, "includeSentinels") === true;
  let previous: number | null = null;
  for (const [index, row] of result.rows.entries()) {
    if (!isRecord(row)) throw new Error(`row #${index} is not an object`);
    if (typeof row.id !== "string" || row.id === "")
      throw new Error(`row #${index} has no id`);
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
      throw new Error(
        `row #${index} value ${String(row.value)} is not a finite number`,
      );
    }
    if (typeof row.sentinel !== "boolean")
      throw new Error(`row #${index} sentinel is not boolean`);
    if (
      !Array.isArray(row.flags) ||
      row.flags.some((flag) => typeof flag !== "string")
    ) {
      throw new Error(`row #${index} flags is not string[]`);
    }
    if (row.sentinel && !includeSentinels) {
      throw new Error(
        `row #${index} (${row.id}) is a sentinel but includeSentinels is not true`,
      );
    }
    if (previous !== null && row.value > previous) {
      throw new Error(`rows are not sorted descending at #${index}`);
    }
    previous = row.value;
  }
}

/** Exact comparison with the reference query; a mismatch names the first differing field. */
export function assertMatchesOracle(actual: unknown, args: unknown): void {
  // Normalize once so the oracle and the invariant checker see the same read of every argument.
  const normalized = isRecord(args)
    ? {
        field: ownValue(args, "field"),
        limit: ownValue(args, "limit"),
        includeSentinels: ownValue(args, "includeSentinels"),
      }
    : args;
  const expected = oracleQuery(normalized);
  if (!expected.ok) {
    if (!isToolErrorLike(actual)) {
      throw new Error(
        `expected a ToolError for invalid args (${expected.reason}), got ${String(actual)}`,
      );
    }
    return;
  }
  if (isToolErrorLike(actual))
    throw new Error("valid request returned a ToolError");
  assertQueryInvariants(actual, normalized);
  if (actual.truncated !== expected.result.truncated) {
    throw new Error(
      `truncated: expected ${expected.result.truncated}, got ${actual.truncated}`,
    );
  }
  if (actual.rows.length !== expected.result.rows.length) {
    throw new Error(
      `row count: expected ${expected.result.rows.length}, got ${actual.rows.length}`,
    );
  }
  for (const [index, want] of expected.result.rows.entries()) {
    const got = actual.rows[index];
    if (got === undefined) throw new Error(`row #${index} is missing`);
    if (
      got.id !== want.id ||
      got.value !== want.value ||
      got.sentinel !== want.sentinel ||
      got.flags.length !== want.flags.length ||
      got.flags.some((flag, flagIndex) => flag !== want.flags[flagIndex])
    ) {
      throw new Error(
        `row #${index}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
  }
}
