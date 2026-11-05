/**
 * @file fraud_queue.ts
 * @description The desk's account priority queue: a transparent, deterministic ranking of the
 * accounts that a human should look at first, built from the corpus flags, the named detectors and
 * the fitted model — without inventing a risk probability.
 *
 * Pure over its inputs: the caller supplies the parsed corpus, the detector findings and an
 * optional per-account score function, so the ranking can be unit-tested without a 55 MB corpus.
 *
 * Ranking is lexicographic over measured counts: direct desk-flag rows first, then account-subject
 * findings by severity, then the model's 0-100 proxy score, then bet rows, then account id.
 * Nothing is weighted — a "critical finding" does not become 100 points, it simply outranks a
 * "high" one. The current corpus's detectors are mostly book/agent-level aggregates, so
 * account-level finding counts are usually 0; the direct flag rows are what actually discriminate.
 */

import type {
  FraudCorpus,
  FraudFinding,
  FraudFindingSeverity,
} from "./fraud_logs.ts";

const SEVERITY_ORDER: readonly FraudFindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

const SEVERITY_LABEL: Readonly<Record<FraudFindingSeverity, string>> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  info: "info",
};

export interface FraudQueueScore {
  readonly score: number | null;
  readonly band: string | null;
}

export type FraudQueueModelSummary =
  | {
      readonly present: true;
      readonly fittedAt: string;
      readonly proxy: string;
      readonly corpusSha256: string | null;
    }
  | { readonly present: false; readonly reason: string | null };

/** One rule hit with the rule's confirmed-review count, so the evidence carries its own strength. */
export interface FraudQueueRuleHit {
  readonly rule: string;
  /** Confirmed reviews behind the rule at gate time; 5 is the minimum, 50 is well-tested. */
  readonly n: number;
}

/** Applied-rule evidence for one account. Unreviewed hits and reviewer-confirmed hits stay separate. */
export interface FraudQueueRuleEvidence {
  readonly hasRuleHit: boolean;
  readonly hasConfirmedRuleHit: boolean;
  readonly ruleHits: readonly FraudQueueRuleHit[];
  readonly confirmedRuleHits: readonly FraudQueueRuleHit[];
}

export interface FraudQueueRow {
  readonly rank: number;
  readonly account: string;
  readonly agent: string | null;
  readonly model: FraudQueueScore | null;
  /** Tie-break after the model score, never a bucket promotion or score bonus. */
  readonly hasRuleHit: boolean;
  /** Reviewer evidence for the same tie slot; confirmed hits sort ahead of unreviewed ones. */
  readonly hasConfirmedRuleHit: boolean;
  readonly ruleHits: readonly FraudQueueRuleHit[];
  readonly confirmedRuleHits: readonly FraudQueueRuleHit[];
  readonly findings: Readonly<Record<FraudFindingSeverity, number>> & {
    readonly total: number;
  };
  readonly categories: readonly string[];
  readonly flags: {
    readonly suspectedBot: number;
    readonly reversedCredit: number;
    readonly manualLog: number;
    readonly oddsDrift: number;
  };
  /** Sum of the four direct desk-flag counts (display/transparency). */
  readonly flagRows: number;
  /** Sum of the three strong desk interventions; the first ranking key (odds drift excluded). */
  readonly deskFlagRows: number;
  readonly bets: number;
  readonly lastBetAt: string | null;
  readonly reasons: readonly string[];
}

export interface FraudQueueTotals {
  readonly accounts: number;
  readonly agents: number;
  readonly eligible: number;
  readonly returned: number;
  readonly scored: number;
}

export interface FraudQueueResult {
  readonly method: string;
  readonly eligibility: string;
  readonly rankBasis: readonly string[];
  readonly limits: readonly string[];
  readonly model: FraudQueueModelSummary;
  readonly totals: FraudQueueTotals;
  readonly rows: readonly FraudQueueRow[];
  readonly insufficient: readonly string[];
}

export interface FraudQueueInput {
  readonly corpus: FraudCorpus;
  readonly findings: readonly FraudFinding[];
  /** Per-account model score; omit when no artifact is fitted. Called once per eligible account. */
  readonly scoreOf?:
    ((accountId: string) => FraudQueueScore | null) | undefined;
  /**
   * Per-account evidence from rules the readiness gate applied. Omit when no rule reached the
   * review minimum; the tie-break then contributes nothing.
   */
  readonly ruleEvidenceOf?:
    ((accountId: string) => FraudQueueRuleEvidence | null) | undefined;
  readonly model?: FraudQueueModelSummary | undefined;
  readonly limit: number;
  readonly insufficient?: readonly string[] | undefined;
}

interface AccountAggregate {
  readonly account: string;
  agent: string | null;
  bets: number;
  suspectedBot: number;
  reversedCredit: number;
  manualLog: number;
  oddsDrift: number;
  lastBetAtMs: number | null;
}

const emptySeverities = (): Record<FraudFindingSeverity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function isoOrNull(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function compareRows(left: FraudQueueRow, right: FraudQueueRow): number {
  if (left.deskFlagRows !== right.deskFlagRows) {
    return right.deskFlagRows - left.deskFlagRows;
  }
  for (const severity of SEVERITY_ORDER) {
    const delta = right.findings[severity] - left.findings[severity];
    if (delta !== 0) return delta;
  }
  if (left.flags.oddsDrift !== right.flags.oddsDrift) {
    return right.flags.oddsDrift - left.flags.oddsDrift;
  }
  const leftScore = left.model?.score ?? null;
  const rightScore = right.model?.score ?? null;
  if (leftScore !== rightScore) {
    if (leftScore === null) return 1;
    if (rightScore === null) return -1;
    return rightScore - leftScore;
  }
  // Literal tie-break after the score: a 95 without a rule hit still beats an 82.5 with one.
  if (left.hasRuleHit !== right.hasRuleHit) {
    return left.hasRuleHit ? -1 : 1;
  }
  if (left.hasConfirmedRuleHit !== right.hasConfirmedRuleHit) {
    return left.hasConfirmedRuleHit ? -1 : 1;
  }
  if (left.bets !== right.bets) return right.bets - left.bets;
  return left.account < right.account
    ? -1
    : left.account > right.account
      ? 1
      : 0;
}

function ruleHitsLabel(hits: readonly FraudQueueRuleHit[]): string {
  return hits.map((hit) => `${hit.rule} (n=${hit.n})`).join(", ");
}

function reasonsFor(row: {
  findings: FraudQueueRow["findings"];
  flags: FraudQueueRow["flags"];
  model: FraudQueueScore | null;
  ruleEvidence: FraudQueueRuleEvidence | null;
}): string[] {
  const reasons: string[] = [];
  if (row.flags.suspectedBot > 0) {
    reasons.push(
      plural(row.flags.suspectedBot, "suspected-bot row", "suspected-bot rows"),
    );
  }
  if (row.flags.reversedCredit > 0) {
    reasons.push(
      plural(
        row.flags.reversedCredit,
        "reversed-credit row",
        "reversed-credit rows",
      ),
    );
  }
  if (row.flags.manualLog > 0) {
    reasons.push(
      plural(row.flags.manualLog, "manual-log row", "manual-log rows"),
    );
  }
  for (const severity of SEVERITY_ORDER) {
    const count = row.findings[severity];
    if (count > 0) {
      reasons.push(
        plural(count, `${severity} finding`, `${severity} findings`),
      );
    }
  }
  if (row.flags.oddsDrift > 0) {
    reasons.push(
      plural(row.flags.oddsDrift, "odds-drift row", "odds-drift rows"),
    );
  }
  if (row.model !== null && row.model.score !== null) {
    reasons.push(
      row.model.band === null
        ? `model score ${row.model.score}`
        : `model score ${row.model.score} (${row.model.band})`,
    );
  }
  if (row.ruleEvidence !== null && row.ruleEvidence.hasRuleHit) {
    reasons.push(
      row.ruleEvidence.ruleHits.length === 0
        ? "rule hit"
        : `rule hit: ${ruleHitsLabel(row.ruleEvidence.ruleHits)}`,
    );
  }
  if (row.ruleEvidence !== null && row.ruleEvidence.hasConfirmedRuleHit) {
    reasons.push(
      row.ruleEvidence.confirmedRuleHits.length === 0
        ? "confirmed rule hit"
        : `confirmed rule hit: ${ruleHitsLabel(row.ruleEvidence.confirmedRuleHits)}`,
    );
  }
  return reasons;
}

/**
 * Build the ranked queue. Deterministic for a given corpus/findings/scores/limit: no clock, no
 * randomness, and Map iteration order never leaks — rows are sorted and totals are counts.
 */
export function buildFraudQueue(input: FraudQueueInput): FraudQueueResult {
  const { corpus, findings, limit } = input;
  const accounts = new Map<string, AccountAggregate>();
  const agents = new Set<string>();

  for (const record of corpus.records) {
    const key = record.userId.trim().toUpperCase();
    if (key === "") continue;
    const agent = record.agentId === null ? null : record.agentId.trim();
    if (agent !== null && agent !== "") agents.add(agent.toUpperCase());
    const placedAt = record.placedAtMs;
    const existing = accounts.get(key);
    if (existing === undefined) {
      accounts.set(key, {
        account: record.userId.trim(),
        agent,
        bets: 1,
        suspectedBot: record.suspectedBot ? 1 : 0,
        reversedCredit: record.reversedCredit ? 1 : 0,
        manualLog: record.manualLog ? 1 : 0,
        oddsDrift: record.oddsDrift !== null && record.oddsDrift !== 0 ? 1 : 0,
        lastBetAtMs: placedAt,
      });
    } else {
      existing.bets += 1;
      if (existing.agent === null && agent !== null) existing.agent = agent;
      if (record.suspectedBot) existing.suspectedBot += 1;
      if (record.reversedCredit) existing.reversedCredit += 1;
      if (record.manualLog) existing.manualLog += 1;
      if (record.oddsDrift !== null && record.oddsDrift !== 0) {
        existing.oddsDrift += 1;
      }
      if (
        placedAt !== null &&
        (existing.lastBetAtMs === null || placedAt > existing.lastBetAtMs)
      ) {
        existing.lastBetAtMs = placedAt;
      }
    }
  }

  const findingCounts = new Map<
    string,
    { counts: Record<FraudFindingSeverity, number>; categories: Set<string> }
  >();
  for (const finding of findings) {
    if (finding.subject.kind !== "account") continue;
    if (finding.insufficientData) continue;
    // Data-quality findings describe the pipeline, not the account; they would rank every row.
    if (finding.category === "data_quality") continue;
    const key = finding.subject.id.trim().toUpperCase();
    if (key === "") continue;
    const entry = findingCounts.get(key) ?? {
      counts: emptySeverities(),
      categories: new Set<string>(),
    };
    entry.counts[finding.severity] += 1;
    entry.categories.add(finding.category);
    findingCounts.set(key, entry);
  }

  const candidates: FraudQueueRow[] = [];
  for (const [key, aggregate] of accounts) {
    const counted = findingCounts.get(key);
    const counts = counted?.counts ?? emptySeverities();
    const total =
      counts.critical + counts.high + counts.medium + counts.low + counts.info;
    const flags = {
      suspectedBot: aggregate.suspectedBot,
      reversedCredit: aggregate.reversedCredit,
      manualLog: aggregate.manualLog,
      oddsDrift: aggregate.oddsDrift,
    };
    const flagRows =
      flags.suspectedBot +
      flags.reversedCredit +
      flags.manualLog +
      flags.oddsDrift;
    const deskFlagRows =
      flags.suspectedBot + flags.reversedCredit + flags.manualLog;
    if (total === 0 && flagRows === 0) continue;
    const model = input.scoreOf?.(aggregate.account) ?? null;
    const ruleEvidence = input.ruleEvidenceOf?.(aggregate.account) ?? null;
    // Confirmed evidence is a subset of a hit; normalize so a direct caller cannot promote an
    // account on confirmed evidence with no hit.
    const hasRuleHit =
      ruleEvidence?.hasRuleHit === true ||
      ruleEvidence?.hasConfirmedRuleHit === true;
    const findingsBlock = { ...counts, total };
    candidates.push({
      rank: 0,
      account: aggregate.account,
      agent: aggregate.agent,
      model,
      hasRuleHit,
      hasConfirmedRuleHit: ruleEvidence?.hasConfirmedRuleHit === true,
      ruleHits: ruleEvidence?.ruleHits ?? [],
      confirmedRuleHits: ruleEvidence?.confirmedRuleHits ?? [],
      findings: findingsBlock,
      categories: [...(counted?.categories ?? [])].sort(),
      flags,
      flagRows,
      deskFlagRows,
      bets: aggregate.bets,
      lastBetAt: isoOrNull(aggregate.lastBetAtMs),
      reasons: reasonsFor({
        findings: findingsBlock,
        flags,
        model,
        ruleEvidence,
      }),
    });
  }

  candidates.sort(compareRows);
  const returned = candidates.slice(0, Math.max(0, Math.min(limit, 100)));
  const rows = returned.map((row, index) => ({ ...row, rank: index + 1 }));
  const scored = rows.filter(
    (row) => row.model !== null && row.model.score !== null,
  ).length;

  const rankBasis: string[] = ["deskFlagRows desc"];
  rankBasis.push(
    ...SEVERITY_ORDER.map(
      (severity) => `${SEVERITY_LABEL[severity]}Findings desc`,
    ),
  );
  rankBasis.push(
    "oddsDriftRows desc",
    "modelScore desc (null last)",
    "hasRuleHit desc (applied rules only)",
    "hasConfirmedRuleHit desc",
    "bets desc",
    "account asc",
  );

  return {
    method:
      "Account priority queue. Rows are accounts with at least one non-data-quality account " +
      "finding or one desk-flag row (suspected bot, reversed credit, manual log, odds drift). " +
      "Order is lexicographic: the three strong desk interventions (suspected bot, reversed " +
      "credit, manual log), then account-subject findings by severity, then odds-drift rows, " +
      "then the fitted model's 0-100 proxy score, then applied-rule evidence (unreviewed hit, " +
      "then confirmed hit), then bet rows, then account id — no finding is turned into an " +
      "invented point score. Odds drift is a corpus-wide line-movement signal " +
      "(17.5% of rows here), so it ranks after the interventions and findings. The corpus's " +
      "detectors are mostly book/agent-level aggregates, so account-level finding counts are " +
      "usually 0; the model column is not a probability.",
    eligibility:
      "one or more of: a non-insufficient account-subject finding outside data_quality, or a " +
      "suspected-bot / reversed-credit / manual-log / odds-drift bet row",
    rankBasis,
    limits: [
      "Ranking is lexicographic over measured counts; it is a triage order, not a probability.",
      "Detectors in the current corpus are mostly book/agent-level aggregates, so an account's " +
        "account-subject finding counts are usually 0; deskFlagRows (strong desk interventions) " +
        "leads the order, and odds-drift rows rank after findings because that signal is " +
        "corpus-wide.",
      "A missing model leaves the model column null and the order finding/flag-only; it does " +
        "not invent scores.",
      "Only the desk-flagged and detector-cited accounts are eligible; the queue is not a census " +
        "of all accounts.",
      "No IP data is included here — use fraud_ip_graph for masked network clusters.",
      "Findings with insufficientData or the data_quality category do not rank an account.",
      "Rule evidence is a tie-break after the model score and never adds points; only rules " +
        "the readiness gate applied after >= 5 confirmed reviews can contribute. An account with " +
        "a 95 without a rule hit still ranks ahead of an 82.5 with one.",
    ],
    model: input.model ?? { present: false, reason: null },
    totals: {
      accounts: corpus.accounts,
      agents: agents.size,
      eligible: candidates.length,
      returned: rows.length,
      scored,
    },
    rows,
    insufficient: input.insufficient ?? [],
  };
}
