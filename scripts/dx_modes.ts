#!/usr/bin/env bun
/**
 * @file dx_modes.ts
 * `./bin/dx modes [1..10]` — the 10-mode forensic / risk / cross-market matrix.
 *
 * Extracted verbatim from the inline `bun -e` block in bin/dx so the argument handling is
 * testable. The one behaviour change: a mode that is not an integer 1..10 is a usage error
 * (exit 2) instead of an empty table (`modes 99`) or every mode (`modes abc`).
 */
import { parseArgs } from "node:util";
import { buildTenModeLiveSnapshot } from "../lib/forensic_diagnostic_modes.ts";

export const MODE_COUNT = 10;

/** Parse the optional mode argument: `null` = all modes, otherwise an integer 1 to MODE_COUNT. */
export function parseModeFilter(arg: string | undefined): number | null {
  if (arg === undefined || arg === "") return null;
  if (!/^\d+$/.test(arg)) {
    throw new Error(`mode must be an integer 1..${MODE_COUNT}, got "${arg}"`);
  }
  const mode = Number(arg);
  if (mode < 1 || mode > MODE_COUNT) {
    throw new Error(`mode must be an integer 1..${MODE_COUNT}, got ${mode}`);
  }
  return mode;
}

export function printModes(filterMode: number | null): void {
  const snap = buildTenModeLiveSnapshot();
  console.log(
    "========================================================================================================================",
  );
  console.log(
    "  🔬 10-MODE FORENSIC, RISK, CROSS-MARKET & DATA INTEGRITY MATRIX (Identity, Risk, Cross-Market, Reconciliation)",
  );
  console.log(
    "========================================================================================================================",
  );
  for (const spec of snap.catalog) {
    if (filterMode && spec.modeNumber !== filterMode) continue;
    console.log(
      `  [${spec.domain.padEnd(18)}] ${spec.modeLabel.padEnd(25)} | Checks: ${spec.checksSummary.padEnd(55)} | Output: ${spec.outputSummary}`,
    );
  }
  console.log(
    "------------------------------------------------------------------------------------------------------------------------",
  );
  if (!filterMode || filterMode === 1) {
    console.log(
      "  [Mode 1 · Customer Overview]:",
      snap.mode1CustomerOverview
        .map(
          (c) =>
            `${c.customerId} (${c.officeAgentId}): Net $${(c.validatedNetCents / 100).toLocaleString()} | Liab $${(c.pendingDefinedLiabilityCents / 100).toLocaleString()} | Warnings=${c.missingDataWarnings.length ? c.missingDataWarnings.join(",") : "NONE"}`,
        )
        .join(" || "),
    );
  }
  if (!filterMode || filterMode === 2) {
    console.log(
      `  [Mode 2 · Access Logs (${snap.mode2AccessLogs.customerId})]: ${snap.mode2AccessLogs.totalEvents} events across ${snap.mode2AccessLogs.distinctActorsCount} distinct actors (SELF_PLAYER + OFFICE_AGENT)`,
    );
  }
  if (!filterMode || filterMode === 3) {
    console.log(
      `  [Mode 3 · Shared-IP Overview]: ${snap.mode3SharedIpOverview.totalAccountGroups} account groups (${snap.mode3SharedIpOverview.dateWindowStartMdy}..${snap.mode3SharedIpOverview.dateWindowEndMdy})`,
    );
  }
  if (!filterMode || filterMode === 4) {
    console.log(
      `  [Mode 4 · Customer IP History (${snap.mode4CustomerIpHistory.customerId})]: ${snap.mode4CustomerIpHistory.ipTimeline.length} spans | Changes=${snap.mode4CustomerIpHistory.ipChangeCount} | Gaps=${snap.mode4CustomerIpHistory.collectionGapsCount}`,
    );
  }
  if (!filterMode || filterMode === 5) {
    console.log(
      `  [Mode 5 · Accounts by IP (${snap.mode5AccountsByIp.selectedIp})]: ${snap.mode5AccountsByIp.observedAccountCount} accounts (${snap.mode5AccountsByIp.accounts.map((a) => a.accountId).join(", ")})`,
    );
  }
  if (!filterMode || filterMode === 6) {
    console.log(
      "  [Mode 6 · Activity Overlap]:",
      snap.mode6ActivityOverlap
        .map(
          (o) =>
            `${o.primaryWindow.accountId}<->${o.secondaryWindow.accountId}: ${o.distinctionVerdict} (overlap=${o.overlapDurationSeconds}s, gap=${o.gapBetweenWindowsSeconds}s)`,
        )
        .join(" || "),
    );
  }
  if (!filterMode || filterMode === 7) {
    console.log(
      "  [Mode 7 · Wager Comparison]:",
      snap.mode7WagerComparisons
        .map(
          (w) =>
            `${w.canonicalEventId} ${w.side}: F402=${w.f402EffectiveLineHundredths} vs PM=${w.polymarketEffectiveLineHundredths} (Δ=${w.lineDeltaHundredths}, Δt=${w.timestampDeltaSeconds}s)`,
        )
        .join(" || "),
    );
  }
  if (!filterMode || filterMode === 8) {
    console.log(
      "  [Mode 8 · Settled Net]:",
      snap.mode8SettledNet
        .map(
          (s) =>
            `${s.customerId}: P/L=$${(s.customerNetProfitLossCents / 100).toLocaleString()} (FreePlay Saved=$${(s.freePlayLostPrincipalSavedCents / 100).toLocaleString()}, Adj=$${(s.adjustmentsNetCents / 100).toLocaleString()})`,
        )
        .join(" || "),
    );
  }
  if (!filterMode || filterMode === 9) {
    console.log(
      "  [Mode 9 · Pending Exposure]:",
      snap.mode9PendingExposure
        .map(
          (p) =>
            `${p.customerId}: ${p.uniquePendingTicketsCount} unique tix (${p.droppedNoiseOrAlertRowsCount} ALERT dropped) | Stake=$${(p.totalStakeCents / 100).toLocaleString()} | Payout=$${(p.potentialPayoutCents / 100).toLocaleString()} | Liability=$${(p.definedLiabilityCents / 100).toLocaleString()}`,
        )
        .join(" || "),
    );
  }
  if (!filterMode || filterMode === 10) {
    console.log(
      "  [Mode 10 · Reconciliation]:",
      snap.mode10Reconciliation
        .map(
          (r) =>
            `${r.customerId}: ${r.reconciliationStatus} (Matched=$${(r.matchedTotalsCents / 100).toLocaleString()}, Explained=$${(r.explainedDifferencesTotalCents / 100).toLocaleString()}, UnresolvedGap=$${(r.unresolvedGapCents / 100).toLocaleString()})`,
        )
        .join(" || "),
    );
  }
  console.log(
    "========================================================================================================================",
  );
}

if (import.meta.main) {
  let filter: number | null;
  try {
    // strict: an option-looking argument such as `-1` is a usage error, not a silent "all modes".
    const { positionals } = parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new Error(`expected at most one mode, got ${positionals.length}`);
    }
    filter = parseModeFilter(positionals[0]);
  } catch (error) {
    console.error(
      `dx modes: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("usage: ./bin/dx modes [1..10]");
    process.exit(2);
  }
  printModes(filter);
}
