/**
 * Evidence artifacts for the queue bridge. Coverage and representativeness are deliberately
 * separate files: a measured 3.94% coverage must never be presented as a measured study, and a
 * missing study must not erase a coverage number that was actually measured.
 *
 * `reports/security/bridge-coverage.json` counts the join. `reports/security/
 * bridge-representativeness.json` is the study; the readiness gate reads `representative` and
 * refuses when it is false or missing. The reader also verifies `representative` against the two
 * Wilson intervals, so a hand-written `true` cannot open the gate on divergent arms.
 */
import { join } from "node:path";

export const QUEUE_BRIDGE_COVERAGE_REL_PATH =
  "reports/security/bridge-coverage.json";
export const QUEUE_BRIDGE_STUDY_REL_PATH =
  "reports/security/bridge-representativeness.json";
export const QUEUE_BRIDGE_SCHEMA_VERSION = 1 as const;
export const QUEUE_BRIDGE_COVERAGE_KIND = "queue-bridge-coverage" as const;
export const QUEUE_BRIDGE_STUDY_KIND =
  "queue-bridge-representativeness" as const;

export interface QueueBridgeCoverage {
  readonly measuredAt: string;
  readonly population: string;
  readonly matched: number;
  readonly total: number;
  /** matched / total; the only coverage number the queue reports. */
  readonly value: number;
  readonly source: string | null;
}

/**
 * Last committed coverage measurement. `reports/` is gitignored, so a fresh checkout has no
 * coverage artifact; reporting null there would erase a number that was measured. The artifact,
 * when present, overrides this baseline. The timestamp travels with the value.
 */
export const QUEUE_BRIDGE_COVERAGE_BASELINE: QueueBridgeCoverage = {
  measuredAt: "2026-11-05T05:50:00.006Z",
  population: "gslive-accounts",
  matched: 102,
  total: 2586,
  value: 102 / 2586,
  source: "committed baseline measurement (live F402 namespace)",
};

export interface QueueBridgeArm {
  readonly n: number;
  readonly precision: number;
  /** Wilson interval as [low, high], both in [0, 1]. */
  readonly wilson: readonly [number, number];
}

export interface QueueBridgeStudy {
  readonly measuredAt: string;
  readonly corpusSha: string;
  readonly covered: QueueBridgeArm;
  readonly uncovered: QueueBridgeArm;
  /** The study's conclusion; the gate does not recompute it. */
  readonly representative: boolean;
  readonly method: string | null;
}

export interface BridgeArtifactRead<T> {
  readonly path: string;
  readonly present: boolean;
  readonly artifact: T | null;
  /** Missing, unreadable, or invalid: why the artifact cannot be used. */
  readonly reason: string | null;
}

type JsonObjectLoad =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

async function loadJsonObject(path: string): Promise<JsonObjectLoad> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { ok: false, reason: "missing" };
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (error) {
    return {
      ok: false,
      reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "unreadable: expected a JSON object" };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function invalid<T>(path: string, reason: string): BridgeArtifactRead<T> {
  return { path, present: false, artifact: null, reason };
}

export async function readQueueBridgeCoverage(
  root: string,
): Promise<BridgeArtifactRead<QueueBridgeCoverage>> {
  const path = join(root, QUEUE_BRIDGE_COVERAGE_REL_PATH);
  const loaded = await loadJsonObject(path);
  if (!loaded.ok) return invalid(path, loaded.reason);
  const row = loaded.value;
  if (row["schemaVersion"] !== QUEUE_BRIDGE_SCHEMA_VERSION) {
    return invalid(
      path,
      `schemaVersion must be ${QUEUE_BRIDGE_SCHEMA_VERSION}`,
    );
  }
  if (row["kind"] !== QUEUE_BRIDGE_COVERAGE_KIND) {
    return invalid(path, `kind must be "${QUEUE_BRIDGE_COVERAGE_KIND}"`);
  }
  const measuredAt = parseTimestamp(row["measuredAt"]);
  if (measuredAt === null) {
    return invalid(path, "measuredAt must be an ISO-8601 timestamp");
  }
  const population = nonEmptyText(row["population"]);
  if (population === null) {
    return invalid(path, "population must be a non-empty string");
  }
  const matched = isNonNegativeInteger(row["matched"]) ? row["matched"] : null;
  const total = isNonNegativeInteger(row["total"]) ? row["total"] : null;
  if (matched === null || total === null || total === 0 || matched > total) {
    return invalid(
      path,
      "matched/total must be non-negative integers with 0 <= matched <= total and total > 0",
    );
  }
  const source = nonEmptyText(row["source"]);
  return {
    path,
    present: true,
    reason: null,
    artifact: {
      measuredAt,
      population,
      matched,
      total,
      value: matched / total,
      source,
    },
  };
}

type ArmResult = { readonly arm: QueueBridgeArm } | { readonly reason: string };

function parseArm(value: unknown, label: string): ArmResult {
  if (!isRecord(value)) return { reason: `${label} must be an object` };
  const n = value["n"];
  if (!isNonNegativeInteger(n) || n < 1) {
    return { reason: `${label}.n must be a positive integer` };
  }
  const precision = value["precision"];
  if (!isUnitInterval(precision)) {
    return { reason: `${label}.precision must be within [0, 1]` };
  }
  const wilson = value["wilson"];
  if (!Array.isArray(wilson) || wilson.length !== 2) {
    return { reason: `${label}.wilson must be [low, high]` };
  }
  const [low, high] = wilson;
  if (!isUnitInterval(low) || !isUnitInterval(high) || low > high) {
    return {
      reason: `${label}.wilson must be [low, high] within [0, 1] with low <= high`,
    };
  }
  return { arm: { n, precision, wilson: [low, high] } };
}

export async function readQueueBridgeStudy(
  root: string,
): Promise<BridgeArtifactRead<QueueBridgeStudy>> {
  const path = join(root, QUEUE_BRIDGE_STUDY_REL_PATH);
  const loaded = await loadJsonObject(path);
  if (!loaded.ok) return invalid(path, loaded.reason);
  const row = loaded.value;
  if (row["schemaVersion"] !== QUEUE_BRIDGE_SCHEMA_VERSION) {
    return invalid(
      path,
      `schemaVersion must be ${QUEUE_BRIDGE_SCHEMA_VERSION}`,
    );
  }
  if (row["kind"] !== QUEUE_BRIDGE_STUDY_KIND) {
    return invalid(path, `kind must be "${QUEUE_BRIDGE_STUDY_KIND}"`);
  }
  const measuredAt = parseTimestamp(row["measuredAt"]);
  if (measuredAt === null) {
    return invalid(path, "measuredAt must be an ISO-8601 timestamp");
  }
  const corpusSha = nonEmptyText(row["corpusSha"]);
  if (corpusSha === null || !/^[0-9a-f]{8,64}$/i.test(corpusSha)) {
    return invalid(path, "corpusSha must be an 8-64 character hex digest");
  }
  const covered = parseArm(row["covered"], "covered");
  if ("reason" in covered) return invalid(path, covered.reason);
  const uncovered = parseArm(row["uncovered"], "uncovered");
  if ("reason" in uncovered) return invalid(path, uncovered.reason);
  const representative = row["representative"];
  if (typeof representative !== "boolean") {
    return invalid(path, "representative must be a boolean");
  }
  // The field is a conclusion, not an independent input: covered and uncovered intervals must
  // support it. Otherwise a hand-written `true` opens the gate on divergent arms.
  const overlap =
    covered.arm.wilson[0] <= uncovered.arm.wilson[1] &&
    uncovered.arm.wilson[0] <= covered.arm.wilson[1];
  if (representative !== overlap) {
    return invalid(
      path,
      `representative=${String(representative)} contradicts the Wilson intervals, which ${
        overlap ? "overlap" : "do not overlap"
      }`,
    );
  }
  const method = nonEmptyText(row["method"]);
  return {
    path,
    present: true,
    reason: null,
    artifact: {
      measuredAt,
      corpusSha,
      covered: covered.arm,
      uncovered: uncovered.arm,
      representative,
      method,
    },
  };
}
