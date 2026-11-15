/**
 * Per-account explanation: evidence edges, ring membership, prediction
 * signal contributions, and join coverage. Everything is an evidence-scored guess.
 */

import {
  F402AnalyzeError,
  type PullProjection,
} from "./f402_analyze_ingest.ts";
import { reportJoinCoverage, type JoinCoverage } from "./f402_analyze_join.ts";
import type { AccountEdge, LinkReport } from "./f402_analyze_link.ts";
import type { AccountPrediction } from "./f402_analyze_predict.ts";
import type { AccountRing } from "./f402_analyze_rings.ts";
import {
  timelineForAccount,
  type AccountTimeline,
} from "./f402_analyze_timeline.ts";

export const EXPLAIN_DISCLAIMER =
  "This explanation lists evidence-scored guesses, not confirmed identity or cause.";

export interface AccountExplain {
  readonly disclaimer: typeof EXPLAIN_DISCLAIMER;
  readonly accountId: string;
  readonly login: string;
  readonly label: "evidence-scored guess";
  readonly edges: readonly AccountEdge[];
  readonly rings: readonly AccountRing[];
  readonly prediction: AccountPrediction | null;
  readonly timeline: AccountTimeline;
  readonly join: {
    readonly weblogToWager: number;
    readonly wagerToLedger: number;
    readonly coverage: JoinCoverage;
  };
}

export function explainAccount(
  projection: PullProjection,
  accountId: string,
  options: {
    readonly link: LinkReport;
    readonly rings: readonly AccountRing[];
    readonly prediction: AccountPrediction | null;
  },
): AccountExplain {
  const account = projection.accounts.find(
    (row) =>
      row.accountId === accountId ||
      row.login.toLowerCase() === accountId.toLowerCase(),
  );
  if (account === undefined) {
    throw new F402AnalyzeError(
      "config",
      "explain",
      `unknown account ${accountId}`,
    );
  }
  const id = account.accountId;
  const edges = options.link.edges.filter(
    (edge) => edge.a === id || edge.b === id,
  );
  const rings = options.rings.filter((ring) => ring.accounts.includes(id));
  const coverage = reportJoinCoverage(projection).coverage;
  const weblogToWager = projection.weblog.filter(
    (row) =>
      (row.loginId.toLowerCase() === id.toLowerCase() ||
        row.loginId.toLowerCase() === account.login.toLowerCase()) &&
      row.ticket !== null &&
      row.ticket !== "",
  ).length;
  const wagerToLedger = projection.wagers.filter(
    (row) =>
      row.accountId === id &&
      (row.documentNumber !== null || row.ticketNumber !== ""),
  ).length;
  return {
    disclaimer: EXPLAIN_DISCLAIMER,
    accountId: id,
    login: account.login,
    label: "evidence-scored guess",
    edges,
    rings,
    prediction: options.prediction,
    timeline: timelineForAccount(projection, id),
    join: { weblogToWager, wagerToLedger, coverage },
  };
}
