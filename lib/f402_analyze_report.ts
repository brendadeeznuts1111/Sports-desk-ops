/**
 * Ranked Markdown review: top clusters, top predicted changes, evidence tables.
 * IPs must already be hashed in the reports passed in.
 */

import type { CalibrationReport } from "./f402_analyze_calibrate.ts";
import type { JoinCoverage } from "./f402_analyze_join.ts";
import type { AccountCluster, LinkReport } from "./f402_analyze_link.ts";
import type { PredictReport } from "./f402_analyze_predict.ts";

export function renderReviewMarkdown(input: {
  readonly generatedAtIso: string;
  readonly inDir: string;
  readonly link: LinkReport;
  readonly predict: PredictReport;
  readonly join: JoinCoverage;
  readonly calibration?: CalibrationReport;
  readonly topN?: number;
}): string {
  const topN = input.topN ?? 10;
  const lines: string[] = [];
  lines.push("# Fantasy402 review");
  lines.push("");
  lines.push(`Generated at ${input.generatedAtIso} from \`${input.inDir}\`.`);
  lines.push("");
  lines.push(input.link.disclaimer);
  lines.push("");
  lines.push("## Join coverage");
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("| --- | ---: |");
  lines.push(
    `| Weblog tickets joined | ${input.join.weblogJoined}/${input.join.weblogTicketsDistinct} (${pct(input.join.weblogCoverage)}) |`,
  );
  lines.push(
    `| Wagers joined to weblog | ${input.join.wagersJoinedToWeblog}/${input.join.wagerTicketsDistinct} (${pct(input.join.wagerToWeblogCoverage)}) |`,
  );
  lines.push(
    `| Ledger wager rows joined | ${input.join.ledgerJoined}/${input.join.ledgerWagerRows} (${pct(input.join.ledgerCoverage)}) |`,
  );
  lines.push(
    `| Wagers joined to ledger | ${input.join.wagersJoinedToLedger}/${input.join.wagerTicketsDistinct} (${pct(input.join.wagerToLedgerCoverage)}) |`,
  );
  lines.push("");
  lines.push(
    "Confidence counts: " +
      Object.entries(input.join.byConfidence)
        .map(([key, n]) => `${key}=${n}`)
        .join(", ") +
      ".",
  );
  lines.push("");
  lines.push("Assumptions:");
  for (const assumption of input.join.assumptions) {
    lines.push(`- ${assumption}`);
  }
  lines.push("");
  lines.push("## Top clusters");
  lines.push("");
  const clusters = input.link.clusters.slice(0, topN);
  if (clusters.length === 0) {
    lines.push("No clusters exceeded the evidence threshold.");
    lines.push("");
  }
  for (const cluster of clusters) {
    lines.push(renderCluster(cluster));
  }
  lines.push("## Top predicted changes");
  lines.push("");
  const accounts = input.predict.accounts.slice(0, topN);
  if (accounts.length === 0) {
    lines.push("No accounts to score.");
    lines.push("");
  }
  for (const row of accounts) {
    lines.push(
      `### ${row.accountId} (score ${row.score.toFixed(3)}, ${row.label})`,
    );
    lines.push("");
    const window = row.expectedChange;
    lines.push(
      `- Window: ${window.windowStartIso ?? "n/a"} → ${window.windowEndIso ?? "n/a"} (τ=${window.tauDays}d, hazard=${window.hazard}, overdue=${window.overdue})`,
    );
    lines.push(`- ${window.explanation}`);
    lines.push("");
    lines.push("| Signal | Available | Value | Contribution | Reason |");
    lines.push("| --- | --- | ---: | ---: | --- |");
    for (const signal of row.signals) {
      lines.push(
        `| ${signal.name} | ${signal.available ? "yes" : "no"} | ${fmt(signal.value)} | ${signal.contribution.toFixed(3)} | ${escapeCell(signal.reason)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Snapshot cadence");
  lines.push("");
  const cadence = input.predict.snapshotCadence;
  lines.push(`- Census: ${cadence.census}`);
  lines.push(`- Transactions: ${cadence.transactions}`);
  lines.push(`- Weblog: ${cadence.weblog}`);
  for (const note of cadence.notes) lines.push(`- ${note}`);
  lines.push("");
  if (input.calibration !== undefined) {
    const cal = input.calibration;
    lines.push("## Calibration backtest");
    lines.push("");
    lines.push(
      `Horizon ${cal.horizonDays}d, ${cal.windowCount} account-windows, Brier ${cal.brier}. ` +
        (cal.lowSample
          ? `Low-sample flag is on (n < ${cal.lowSampleThreshold}).`
          : "Sample is above the low-sample threshold."),
    );
    lines.push("");
    lines.push("| Bin | Predicted mean | Observed rate | Count | Low sample |");
    lines.push("| --- | ---: | ---: | ---: | --- |");
    for (const bin of cal.bins) {
      lines.push(
        `| ${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)} | ${bin.predictedMean.toFixed(3)} | ${bin.observedRate.toFixed(3)} | ${bin.count} | ${bin.lowSample ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderCluster(cluster: AccountCluster): string {
  const lines: string[] = [];
  lines.push(
    `### ${cluster.id} (score ${cluster.score.toFixed(3)}, ${cluster.accounts.join(", ")}, ${cluster.label})`,
  );
  lines.push("");
  lines.push("| Account A | Account B | Score | Evidence |");
  lines.push("| --- | --- | ---: | --- |");
  for (const edge of cluster.edges) {
    const evidence = edge.evidence
      .map(
        (item) =>
          `${item.type} ${item.score.toFixed(2)}: ${escapeCell(item.detail)}`,
      )
      .join("<br>");
    lines.push(
      `| ${edge.a} | ${edge.b} | ${edge.score.toFixed(3)} | ${evidence} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmt(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
