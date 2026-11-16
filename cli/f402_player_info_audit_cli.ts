#!/usr/bin/env bun
/**
 * Player Profile & Risk Posture Audit CLI (`bun run audit:player-info`).
 * Audits raw `getInfoPlayer` envelopes, verifies balance & carryover identities,
 * checks credential security, cross-venue Polymarket proxy wallets, and risk postures.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  auditPlayerRiskPosture,
  formatPlayerRiskPostureReport,
  parseGetInfoPlayerEnvelope,
  parseGetInfoPlayerProbe,
  redactGetInfoPlayer,
  summarizeGetInfoPlayer,
  type DecisionInstrumentReportOverlay,
  type GetInfoPlayerEnvelope,
} from "../lib/f402_get_info_player.ts";
import { fetchPlayerInfo } from "../lib/fantasy402_manager_wire.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    customer: { type: "string", short: "c" },
    file: { type: "string", short: "f" },
    json: { type: "boolean" },
    redact: { type: "boolean" },
    rankings: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`sportsdesk player-info-audit — Audit F402/DGS getInfoPlayer profile payloads

Usage:
  bun run audit:player-info -c <customer-login> [options]
  bun run audit:player-info <path-to-json> [options]
  cat payload.json | bun run audit:player-info [options]

Options:
  -c, --customer <id> Fetch live player profile by Customer ID/Login
  -f, --file <path>   Path to raw getInfoPlayer JSON file
  --json              Output audit report and summary as JSON
  --redact            Output redacted envelope JSON (PII/passwords masked)
  --rankings <path>   v3.0.0 rankings artifact used for the Section 4 overlay
                      (default: scratch/f402-customer-decision-rankings.json)
  -h, --help          Show this help message
`);
  process.exit(0);
}

let envelope: GetInfoPlayerEnvelope;

if (values.customer) {
  const custId = values.customer.trim();
  const rawResponse = await fetchPlayerInfo({ customerIdentifier: custId });
  if (!rawResponse) {
    console.error(
      `Error: Failed to fetch getInfoPlayer for customer "${custId}". Check portal connectivity or credentials (F402_BEARER_TOKEN / F402_COOKIE).`,
    );
    process.exit(1);
  }
  const probe = parseGetInfoPlayerProbe(rawResponse);
  if (!probe.found) {
    console.error(`Error: Customer "${custId}" not found on portal.`);
    process.exit(1);
  }
  envelope = probe.envelope;
} else {
  let inputJson = "";
  const targetPath = values.file || positionals[0];

  if (targetPath && targetPath !== "-") {
    const file = Bun.file(resolve(targetPath));
    if (!(await file.exists())) {
      console.error(`Error: File not found: ${targetPath}`);
      process.exit(1);
    }
    inputJson = await file.text();
  } else {
    // Read from stdin
    inputJson = await Bun.stdin.text();
  }

  if (!inputJson.trim()) {
    console.error(
      "Error: No input provided. Provide -c <customer>, a file path, or pipe JSON to stdin.",
    );
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch (e) {
    console.error(
      `Error parsing JSON input: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  envelope = parseGetInfoPlayerEnvelope(raw);
}

if (values.redact) {
  const redacted = redactGetInfoPlayer(envelope);
  console.log(JSON.stringify(redacted, null, 2));
  process.exit(0);
}

const summary = summarizeGetInfoPlayer(envelope);
const audit = auditPlayerRiskPosture(envelope);

const DEFAULT_RANKINGS_PATH = "scratch/f402-customer-decision-rankings.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Normalizes a login so `BBB_0` and `BBB` compare equal on both sides of the match. */
function normalizeLogin(value: string): string {
  return value.trim().replace(/_\d+$/, "");
}

/**
 * Validates one `allCustomerRows` entry against exactly the fields the report dereferences.
 * Returns null for a malformed row so a stale or foreign artifact cannot crash the formatter.
 */
function toDecisionOverlay(
  candidate: unknown,
): DecisionInstrumentReportOverlay | null {
  if (!isRecord(candidate)) return null;
  const {
    rankOverallSharp,
    rankSystematicSignature,
    totalBetsN,
    correctedUnionRateShrunkKappa20,
    unionClvBhQValueAllCustomers,
    estimatedNetEvAfterVigPct,
    realizedPlayerNetUsd,
    limitHeuristicScore,
    costRatioThresholdTau,
    minDistinctTicketGapSeconds,
    decisionTier,
    recommendedAction,
    powerStatus,
    systematicSignatureClass,
  } = candidate;
  const labelsValid =
    typeof decisionTier === "string" &&
    decisionTier.trim().length > 0 &&
    typeof recommendedAction === "string" &&
    recommendedAction.trim().length > 0 &&
    typeof powerStatus === "string" &&
    powerStatus.trim().length > 0 &&
    typeof systematicSignatureClass === "string" &&
    systematicSignatureClass.trim().length > 0;
  const numbersValid =
    isFiniteNumber(rankOverallSharp) &&
    isFiniteNumber(rankSystematicSignature) &&
    isFiniteNumber(totalBetsN) &&
    isFiniteNumber(correctedUnionRateShrunkKappa20) &&
    isFiniteNumber(unionClvBhQValueAllCustomers) &&
    isFiniteNumber(estimatedNetEvAfterVigPct) &&
    isFiniteNumber(realizedPlayerNetUsd) &&
    isFiniteNumber(limitHeuristicScore) &&
    isFiniteNumber(costRatioThresholdTau) &&
    (minDistinctTicketGapSeconds === null ||
      isFiniteNumber(minDistinctTicketGapSeconds));
  if (!labelsValid || !numbersValid) return null;
  return {
    rankOverallSharp,
    rankSystematicSignature,
    totalBetsN,
    correctedUnionRateShrunkKappa20,
    unionClvBhQValueAllCustomers,
    estimatedNetEvAfterVigPct,
    realizedPlayerNetUsd,
    limitHeuristicScore,
    costRatioThresholdTau,
    minDistinctTicketGapSeconds,
    decisionTier,
    recommendedAction,
    powerStatus,
    systematicSignatureClass,
  };
}

let decisionOverlay: DecisionInstrumentReportOverlay | null = null;
const rankingsPath = values.rankings ?? DEFAULT_RANKINGS_PATH;
const rankingsFile = Bun.file(resolve(rankingsPath));

if (await rankingsFile.exists()) {
  let parsed: unknown = undefined;
  try {
    parsed = await rankingsFile.json();
  } catch (error) {
    console.error(
      `note: could not parse rankings artifact ${rankingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rows =
    isRecord(parsed) && Array.isArray(parsed.allCustomerRows)
      ? parsed.allCustomerRows
      : [];
  // `customerId` keeps its `_N` suffix: that suffix is what makes it unique (the login
  // normalizer strips it, which would collapse `DUPLE_1` and `DUPLE_9` into `DUPLE`).
  const targetCustomerId = summary.customerId.trim();
  const targetLogin = normalizeLogin(summary.login || summary.customerId);
  // `customerId` is unique in the artifact; `playerLogin` is not (the current book has ten
  // duplicated logins), so a login-only match is accepted only when it is unambiguous.
  const loginMatches: DecisionInstrumentReportOverlay[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (!isRecord(row)) {
      skipped++;
      continue;
    }
    const overlay = toDecisionOverlay(row);
    if (overlay === null) {
      skipped++;
      continue;
    }
    const rowCustomerId =
      typeof row.customerId === "string" ? row.customerId.trim() : "";
    if (rowCustomerId !== "" && rowCustomerId === targetCustomerId) {
      decisionOverlay = overlay;
      break;
    }
    const rowLogin =
      typeof row.playerLogin === "string"
        ? normalizeLogin(row.playerLogin)
        : "";
    if (rowLogin !== "" && rowLogin === targetLogin) {
      loginMatches.push(overlay);
    }
  }
  if (decisionOverlay === null && loginMatches.length === 1) {
    decisionOverlay = loginMatches[0] ?? null;
  } else if (decisionOverlay === null && loginMatches.length > 1) {
    console.error(
      `note: login "${targetLogin}" matches ${loginMatches.length} customers in ${rankingsPath}; overlay omitted (customerId is the only unique key)`,
    );
  }
  if (skipped > 0) {
    console.error(
      `note: skipped ${skipped} malformed row(s) in ${rankingsPath}`,
    );
  }
  if (decisionOverlay === null && rows.length > 0 && loginMatches.length <= 1) {
    console.error(
      `note: no ranking row matched customer "${targetCustomerId}" (login "${targetLogin}"); Section 4 overlay omitted`,
    );
  }
} else {
  console.error(
    `note: no rankings artifact at ${rankingsPath}; Section 4 overlay omitted (generate it with bun scripts/generate_customer_decision_rankings.ts)`,
  );
}

if (values.json) {
  console.log(
    JSON.stringify(
      {
        summary,
        audit,
        ...(decisionOverlay
          ? { decisionInstrumentOverlay: decisionOverlay }
          : {}),
      },
      null,
      2,
    ),
  );
} else {
  console.log(formatPlayerRiskPostureReport(audit, summary, decisionOverlay));
}
