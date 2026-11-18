/**
 * MCP-style profile query tools over a frozen, committed snapshot.
 *
 * Contract (frozen by `tests/code_mode/oracle.ts`):
 *   - fields `clv` | `vol` | `sharp`;
 *   - rows carry `flags: string[]` and `sentinel: boolean`; sentinels are synthetic profiles and are
 *     omitted unless `includeSentinels === true` (strict identity);
 *   - rows sort descending by the requested field;
 *   - `limit` is a positive integer clamped to `MAX_LIMIT`, and `truncated` is true only when the
 *     requested limit exceeded `MAX_LIMIT`.
 *
 * The snapshot is committed (`data/profile-snapshot.json`) because the operator book it is derived
 * from (`data/customer-profiles.json`) is gitignored and therefore absent in CI.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type ProfileField,
} from "./profile_query_schema.ts";

export { DEFAULT_LIMIT, MAX_LIMIT, type ProfileField };

export interface ProfileRecord {
  readonly id: string;
  readonly vol: number;
  readonly clv: number;
  readonly sharp: number;
  readonly flags: readonly string[];
}

export interface ProfileQueryRow {
  readonly id: string;
  readonly value: number;
  readonly flags: readonly string[];
  readonly sentinel: boolean;
}

export interface ProfileQueryResult {
  readonly field: ProfileField;
  readonly rows: readonly ProfileQueryRow[];
  readonly truncated: boolean;
}

export interface ProfileSummary {
  readonly deltaVol: number;
  readonly deltaNet: number;
}

export class ToolError extends Error {
  readonly toolError = true as const;
}

export function isToolError(value: unknown): value is ToolError {
  return (
    value instanceof ToolError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { toolError?: unknown }).toolError === true)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown, where: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`profile snapshot: ${where} is not a finite number`);
  }
  return value;
};

const stringFlags = (value: unknown, where: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`profile snapshot: ${where} is not a string array`);
  }
  const flags: string[] = [];
  for (const flag of value) {
    if (typeof flag !== "string") {
      throw new Error(`profile snapshot: ${where} is not a string array`);
    }
    flags.push(flag);
  }
  return Object.freeze(flags);
};

/** Only own data properties are read: inherited keys and prototype traps are ignored. */
const ownValue = (source: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(source, key) ? source[key] : undefined;

/**
 * Parse and freeze a snapshot document. Exported so the loader's rejection paths are testable
 * without shipping a malformed committed snapshot.
 */
export function parseProfileSnapshot(raw: unknown): readonly ProfileRecord[] {
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) {
    throw new Error("profile snapshot: missing profiles array");
  }
  if (raw.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `profile snapshot: unsupported schemaVersion ${String(raw.schemaVersion)}`,
    );
  }
  const seen = new Set<string>();
  const profiles = raw.profiles.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
      throw new Error(`profile snapshot: profile #${index} has no id`);
    }
    if (entry.id !== entry.id.trim()) {
      throw new Error(
        `profile snapshot: profile #${index} id has surrounding whitespace`,
      );
    }
    if (seen.has(entry.id)) {
      throw new Error(`profile snapshot: duplicate id ${entry.id}`);
    }
    seen.add(entry.id);
    return Object.freeze({
      id: entry.id,
      vol: finite(entry.vol, `${entry.id}.vol`),
      clv: finite(entry.clv, `${entry.id}.clv`),
      sharp: finite(entry.sharp, `${entry.id}.sharp`),
      flags: stringFlags(entry.flags, `${entry.id}.flags`),
    });
  });
  return Object.freeze(profiles);
}

const SNAPSHOT_SCHEMA_VERSION = 1;

const SNAPSHOT_ENV = (process.env.PROFILE_SNAPSHOT_PATH ?? "").trim();
const SNAPSHOT_PATH: string | URL =
  SNAPSHOT_ENV !== ""
    ? resolve(SNAPSHOT_ENV)
    : new URL("../data/profile-snapshot.json", import.meta.url);

let cachedSnapshot: readonly ProfileRecord[] | undefined;

/**
 * Loaded on first use: importing the module never fails on a deployment that has no snapshot, and
 * a local operator can point PROFILE_SNAPSHOT_PATH at a real projection of the book.
 */
function snapshot(): readonly ProfileRecord[] {
  if (cachedSnapshot !== undefined) return cachedSnapshot;
  let text: string;
  try {
    text = readFileSync(SNAPSHOT_PATH, "utf8");
  } catch {
    throw new Error(
      "profile snapshot: cannot read " +
        String(SNAPSHOT_PATH) +
        " — set PROFILE_SNAPSHOT_PATH to a production snapshot",
    );
  }
  cachedSnapshot = parseProfileSnapshot(JSON.parse(text));
  return cachedSnapshot;
}

const FIELD_NAMES: ReadonlySet<string> = new Set(["clv", "vol", "sharp"]);
const SENTINEL_PREFIX = "SYNTH_";

const isProfileField = (value: unknown): value is ProfileField =>
  typeof value === "string" && FIELD_NAMES.has(value);

/** Sentinel state is a property of the profile id, never inferred from its sort value. */
export function isProfileSentinel(profile: ProfileRecord): boolean {
  return profile.id.startsWith(SENTINEL_PREFIX);
}

function sortValue(profile: ProfileRecord, field: ProfileField): number {
  switch (field) {
    case "clv":
      return profile.clv;
    case "vol":
      return profile.vol;
    case "sharp":
      return profile.sharp;
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new ToolError("query_profiles: limit must be a positive integer");
  }
  return value;
}

/**
 * Pure query core. Exported so properties can run over generated snapshots, not only the frozen
 * 31-row one; `queryProfiles` is this function bound to the committed snapshot.
 */
export function querySnapshot(
  snapshot: readonly ProfileRecord[],
  args: unknown,
): ProfileQueryResult {
  if (!isRecord(args)) {
    throw new ToolError("query_profiles: field required (clv|vol|sharp)");
  }
  // Read each argument exactly once: a getter cannot return a valid field for the check and a
  // different value for the query, and an inherited property is not an argument.
  const field = ownValue(args, "field");
  if (!isProfileField(field)) {
    throw new ToolError("query_profiles: field required (clv|vol|sharp)");
  }
  const requested = parseLimit(ownValue(args, "limit"));
  const includeSentinels = ownValue(args, "includeSentinels") === true;
  const effective = Math.min(requested, MAX_LIMIT);

  const ranked: ProfileQueryRow[] = [];
  for (const profile of snapshot) {
    const sentinel = isProfileSentinel(profile);
    if (sentinel && !includeSentinels) continue;
    ranked.push(
      Object.freeze({
        id: profile.id,
        value: sortValue(profile, field),
        flags: Object.freeze([...profile.flags]),
        sentinel,
      }),
    );
  }

  ranked.sort((left, right) => {
    if (left.value !== right.value) return right.value - left.value;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  return Object.freeze({
    field,
    rows: Object.freeze(ranked.slice(0, effective)),
    truncated: requested > MAX_LIMIT,
  });
}

/** Sync core shared by the MCP tool wrapper and the QuickJS bridge. */
export function queryProfiles(args: unknown): ProfileQueryResult {
  return querySnapshot(snapshot(), args);
}

export function getProfile(args: unknown): ProfileRecord {
  if (!isRecord(args)) {
    throw new ToolError("get_profile: id required");
  }
  const rawId = ownValue(args, "id");
  if (typeof rawId !== "string" || rawId.trim() === "") {
    throw new ToolError("get_profile: id required");
  }
  const id = rawId.trim();
  const found = snapshot().find((profile) => profile.id === id);
  if (found === undefined) {
    throw new ToolError(`get_profile: unknown id ${id}`);
  }
  return found;
}

/** Desk-book totals: the synthetic (sentinel) rows are excluded. */
export function getSummary(args: unknown): ProfileSummary {
  if (args !== undefined && args !== null && !isRecord(args)) {
    throw new ToolError("get_profile_summary: args must be an object");
  }
  let deltaVol = 0;
  let deltaNet = 0;
  for (const profile of snapshot()) {
    if (isProfileSentinel(profile)) continue;
    deltaVol += profile.vol;
    deltaNet += profile.clv;
  }
  return Object.freeze({ deltaVol, deltaNet });
}

export const queryProfilesTool = {
  async execute(args: unknown): Promise<ProfileQueryResult> {
    return queryProfiles(args);
  },
};

export const getProfileTool = {
  async execute(args: unknown): Promise<ProfileRecord> {
    return getProfile(args);
  },
};

export const getSummaryTool = {
  async execute(args: unknown): Promise<ProfileSummary> {
    return getSummary(args);
  },
};
