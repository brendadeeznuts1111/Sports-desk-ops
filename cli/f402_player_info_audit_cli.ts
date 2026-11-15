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
  type GetInfoPlayerEnvelope,
} from "../lib/f402_get_info_player.ts";
import type { DecisionInstrumentReportOverlay } from "../lib/f402_get_info_player.ts";
import { fetchPlayerInfo } from "../lib/fantasy402_manager_wire.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    customer: { type: "string", short: "c" },
    file: { type: "string", short: "f" },
    json: { type: "boolean" },
    redact: { type: "boolean" },
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

let decisionOverlay: DecisionInstrumentReportOverlay | null = null;
const rankingsFile = Bun.file(
  resolve("scratch/f402-customer-decision-rankings.json"),
);
if (await rankingsFile.exists()) {
  try {
    const rankings = (await rankingsFile.json()) as {
      allCustomerRows?: DecisionInstrumentReportOverlay &
        Array<
          DecisionInstrumentReportOverlay & {
            customerId?: string;
            playerLogin?: string;
          }
        >;
    };
    const rows = Array.isArray(rankings.allCustomerRows)
      ? rankings.allCustomerRows
      : [];
    const targetLogin = (summary.login || summary.customerId)
      .trim()
      .replace(/_\d+$/, "");
    const match = rows.find(
      (r) =>
        r.playerLogin === targetLogin ||
        (r.customerId ?? "").trim() === summary.customerId,
    );
    if (match) {
      decisionOverlay = match;
    }
  } catch {
    // Non-fatal if scratch rankings file is absent or malformed
  }
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
