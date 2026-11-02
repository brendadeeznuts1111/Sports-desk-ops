/**
 * Load-bearing checks for production oracle fixtures (docs/evidence/manager-boot-har-redaction.md).
 * Gate (d) must pass this before running the portal oracle on GENERAL.
 */

import { assertListAgentsTopLevelKeys } from "./f402_list_agents_envelope_strict.ts";
import {
  trimPaddedField,
  type ListAgentsByAgentGeneralWireRow,
  type ListAgentsByAgentPlayerWireRow,
} from "./f402_list_agents_by_agent.ts";

export const F402_PRODUCTION_FIXTURE_REDACTION_FAILED =
  "F402_PRODUCTION_FIXTURE_REDACTION_FAILED" as const;

/** Spec §2 sentinel (not `<redacted>`). */
export const PRODUCTION_PASSWORD_SENTINEL = "REDACTED_PASSWORD";

/** Spec §5 placeholder pattern for GENERAL AgentID / Login. */
export const PRODUCTION_AGENT_PLACEHOLDER = /^AGENT_L\d+_N\d+$/i;

const META_KEY = "_f402Redaction";

const FORBIDDEN_FILE_PATTERNS: readonly {
  readonly re: RegExp;
  readonly label: string;
}[] = [
  { re: /\bset-cookie\b/i, label: "set-cookie" },
  { re: /\bauthorization\b/i, label: "authorization header name" },
  { re: /\bBearer\s+[A-Za-z0-9._-]{8,}/, label: "Bearer token" },
  { re: /\bcookie\s*:\s*[^<\s]/i, label: "raw Cookie header value" },
];

const ALLOWED_TOP_LEVEL = new Set(["GENERAL", "PLAYERS", "EXTRA", META_KEY]);

export interface ProductionOracleFixtureAttestation {
  readonly specVersion: 1;
  readonly redactedByRole: string;
}

/** Repo oracle fixture after gate (j) redaction rules — trust inside after parse. */
export interface ProductionOracleFixture {
  readonly GENERAL: readonly ListAgentsByAgentGeneralWireRow[];
  readonly PLAYERS: readonly ListAgentsByAgentPlayerWireRow[];
  readonly EXTRA: boolean | undefined;
  readonly _f402Redaction: ProductionOracleFixtureAttestation;
}

export interface ProductionFixtureRedactionViolation {
  readonly code: string;
  readonly detail: string;
}

export class ProductionFixtureRedactionError extends Error {
  readonly signal = F402_PRODUCTION_FIXTURE_REDACTION_FAILED;
  readonly violations: readonly ProductionFixtureRedactionViolation[];

  constructor(violations: readonly ProductionFixtureRedactionViolation[]) {
    super(
      `${F402_PRODUCTION_FIXTURE_REDACTION_FAILED}: ${violations.map((v) => v.detail).join("; ")}`,
    );
    this.name = "ProductionFixtureRedactionError";
    this.violations = violations;
  }
}

export function emitProductionFixtureRedactionFailure(
  violations: readonly ProductionFixtureRedactionViolation[],
): void {
  console.error(
    JSON.stringify({
      signal: F402_PRODUCTION_FIXTURE_REDACTION_FAILED,
      violations,
      spec: "docs/evidence/manager-boot-har-redaction.md",
    }),
  );
}

function walkPasswords(
  value: unknown,
  path: string,
  out: ProductionFixtureRedactionViolation[],
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkPasswords(item, `${path}[${i}]`, out));
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const at = path === "" ? key : `${path}.${key}`;
    if (key === "Password" && typeof val === "string" && val !== "") {
      if (val !== PRODUCTION_PASSWORD_SENTINEL) {
        out.push({
          code: "password_not_sentinel",
          detail: `${at} must be "${PRODUCTION_PASSWORD_SENTINEL}" or omitted (got non-sentinel string)`,
        });
      }
    }
    walkPasswords(val, at, out);
  }
}

function validateGeneralPlaceholders(
  general: readonly ListAgentsByAgentGeneralWireRow[],
): ProductionFixtureRedactionViolation[] {
  const out: ProductionFixtureRedactionViolation[] = [];
  for (let i = 0; i < general.length; i += 1) {
    const row = general[i];
    if (row === undefined) continue;
    for (const field of ["AgentID", "Login"] as const) {
      const raw = row[field];
      if (raw === undefined) continue;
      const trimmed = trimPaddedField(String(raw));
      if (trimmed === "") continue;
      if (trimmed.includes("@")) {
        out.push({
          code: "pii_login_shape",
          detail: `GENERAL[${i}].${field} looks like email/PII`,
        });
        continue;
      }
      if (!PRODUCTION_AGENT_PLACEHOLDER.test(trimmed)) {
        out.push({
          code: "agent_not_placeholder",
          detail: `GENERAL[${i}].${field} must match AGENT_L{level}_N{index} (got ${JSON.stringify(trimmed)})`,
        });
      }
    }
  }
  return out;
}

export function validateProductionOracleFixtureText(
  rawText: string,
  parsed: unknown,
): readonly ProductionFixtureRedactionViolation[] {
  const violations: ProductionFixtureRedactionViolation[] = [];

  for (const { re, label } of FORBIDDEN_FILE_PATTERNS) {
    if (re.test(rawText)) {
      violations.push({
        code: "forbidden_substring",
        detail: `fixture text must not contain ${label} (HAR redaction §3)`,
      });
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    violations.push({
      code: "not_object",
      detail: "fixture must be a JSON object",
    });
    return violations;
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      violations.push({
        code: "extra_top_level_key",
        detail: `top-level key ${JSON.stringify(key)} not allowed (only GENERAL, PLAYERS, EXTRA, ${META_KEY})`,
      });
    }
  }

  const envelope = {
    GENERAL: obj.GENERAL,
    PLAYERS: obj.PLAYERS,
    EXTRA: obj.EXTRA,
  };
  try {
    assertListAgentsTopLevelKeys(envelope);
  } catch (e) {
    violations.push({
      code: "envelope_keys",
      detail: String(e),
    });
    return violations;
  }

  const general = envelope.GENERAL as ListAgentsByAgentGeneralWireRow[];
  const players = envelope.PLAYERS as ListAgentsByAgentPlayerWireRow[];

  if (players.length > 0) {
    violations.push({
      code: "players_non_empty",
      detail:
        "production oracle fixture must use PLAYERS: [] after redaction (spec §2 — no player PII in repo)",
    });
  }

  violations.push(...validateGeneralPlaceholders(general));
  walkPasswords(parsed, "", violations);

  const meta = obj[META_KEY];
  if (meta !== undefined) {
    if (typeof meta !== "object" || meta === null) {
      violations.push({
        code: "meta_shape",
        detail: `${META_KEY} must be an object when present`,
      });
    } else {
      const m = meta as Record<string, unknown>;
      if (m.specVersion !== 1) {
        violations.push({
          code: "meta_spec_version",
          detail: `${META_KEY}.specVersion must be 1`,
        });
      }
      if (
        typeof m.redactedByRole !== "string" ||
        m.redactedByRole.trim() === ""
      ) {
        violations.push({
          code: "meta_role",
          detail: `${META_KEY}.redactedByRole must name operator role (spec accountability)`,
        });
      }
    }
  } else {
    violations.push({
      code: "meta_missing",
      detail: `${META_KEY} attestation required (redactedByRole, specVersion: 1)`,
    });
  }

  return violations;
}

function materializeProductionOracleFixture(
  parsed: unknown,
): ProductionOracleFixture {
  const obj = parsed as Record<string, unknown>;
  const meta = obj[META_KEY] as ProductionOracleFixtureAttestation;
  return {
    GENERAL: obj.GENERAL as ListAgentsByAgentGeneralWireRow[],
    PLAYERS: obj.PLAYERS as ListAgentsByAgentPlayerWireRow[],
    EXTRA:
      typeof obj.EXTRA === "boolean"
        ? obj.EXTRA
        : obj.EXTRA === undefined
          ? undefined
          : Boolean(obj.EXTRA),
    _f402Redaction: meta,
  };
}

function failProductionFixtureRedaction(
  violations: readonly ProductionFixtureRedactionViolation[],
): never {
  emitProductionFixtureRedactionFailure(violations);
  throw new ProductionFixtureRedactionError(violations);
}

/** File boundary: JSON text → validated production oracle fixture. */
export function parseProductionOracleFixtureText(
  rawText: string,
): ProductionOracleFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    failProductionFixtureRedaction([
      {
        code: "invalid_json",
        detail: `fixture must be JSON: ${String(e)}`,
      },
    ]);
  }
  const violations = validateProductionOracleFixtureText(rawText, parsed);
  if (violations.length > 0) failProductionFixtureRedaction(violations);
  return materializeProductionOracleFixture(parsed);
}

export function buildProductionOracleFixtureDocument(options: {
  readonly envelope: {
    readonly GENERAL: readonly ListAgentsByAgentGeneralWireRow[];
    readonly PLAYERS: readonly ListAgentsByAgentPlayerWireRow[];
    readonly EXTRA?: boolean;
  };
  readonly redactedByRole: string;
  readonly general: readonly ListAgentsByAgentGeneralWireRow[];
}): ProductionOracleFixture {
  return {
    GENERAL: options.general,
    PLAYERS: [],
    EXTRA: options.envelope.EXTRA,
    _f402Redaction: { specVersion: 1, redactedByRole: options.redactedByRole },
  };
}

export function assertProductionOracleFixtureRedaction(
  rawText: string,
  parsed: unknown,
): void {
  const violations = validateProductionOracleFixtureText(rawText, parsed);
  if (violations.length === 0) return;
  failProductionFixtureRedaction(violations);
}
