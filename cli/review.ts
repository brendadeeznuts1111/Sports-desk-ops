/**
 * Flag-review workflow: a stratified sample of fired flags, a SQLite review ledger, and the
 * `flags-metric-metadata` contract that reports sampled rule precision without pretending it is
 * per-flag confidence.
 *
 * Budget is analyst-minutes per day, not flags per day: minutes are the invariant, the sampling
 * rate is what the budget buys. Sampling is stratified by rule, deterministic for a capture and
 * seed, and censuses low-volume rules instead of hoping a systematic slice hits them.
 */
import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite, sqlInt } from "../lib/sportsdesk_sqlite.ts";
import {
  METRIC_DERIVED_FROM,
  METRIC_METADATA_KINDS,
  isMetricDerivedFrom,
  isMetricMetadataKind,
  type MetricDerivedFrom,
} from "../lib/metric_metadata.ts";
import { DEFAULT_QUEUE_READINESS_POLICY } from "../lib/queue_readiness.ts";
import type { Anomaly, RuleName } from "./rules.ts";

export const REVIEW_VERDICTS = [
  "confirmed",
  "false_positive",
  "needs_more_info",
] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const FLAGS_REVIEW_DB_REL_PATH = "reports/security/flags-review.sqlite";
/** A flag is confirmed when at least one reviewer says so; reviewers stay separate for kappa. */
export const DEFAULT_REVIEW_POLICY = "at_least_one_confirmed" as const;
export const DEFAULT_REVIEW_SEED = "dx-2026-q4";
export const DEFAULT_ANALYST_MINUTES_PER_DAY = 60;
export const DEFAULT_VOLUME_FLOOR = 10;
/** n below this is not a precision estimate; report it as not_measured instead. */
export const MIN_PRECISION_SAMPLE = 10;
/** Bounded queue weight: reasons can reorder, never override the model score. */
export const RULE_HIT_WEIGHT_PER_CONFIRMED = 0.02;
export const RULE_HIT_WEIGHT_CAP = 0.1;

/** Minutes to review one flag, by rule. Defaults are seeds to recalibrate after two weeks. */
export const DEFAULT_COST_PER_FLAG: Readonly<Record<string, number>> = {
  period_correlation: 3,
  opposite_sides_same_customer: 2,
  opposite_sides_across_customers: 3,
  batch_replay: 0.5,
  clone_bet: 1,
  velocity_customer: 2,
  velocity_market: 2,
  period_order_anomaly: 2,
  past_post: 1,
  default: 2,
};

export interface SamplingBudget {
  readonly analystMinutesPerDay: number;
  readonly costPerFlagByRule: Readonly<Record<string, number>>;
  readonly volumeFloor: number;
  readonly seed: string;
}

export const DEFAULT_SAMPLING_BUDGET: SamplingBudget = {
  analystMinutesPerDay: DEFAULT_ANALYST_MINUTES_PER_DAY,
  costPerFlagByRule: DEFAULT_COST_PER_FLAG,
  volumeFloor: DEFAULT_VOLUME_FLOOR,
  seed: DEFAULT_REVIEW_SEED,
};

export type ReviewMode = "census" | "sample" | "not_sampled";

export interface ReviewRulePlan {
  readonly rule: string;
  readonly fired: number;
  readonly selected: number;
  readonly mode: ReviewMode;
  readonly minutes: number;
}

export interface ReviewFlag {
  readonly seq: number;
  readonly rule: string;
  readonly severity: string;
  readonly wagerNumbers: readonly string[];
  readonly customerRef: string | null;
  readonly agentRef: string | null;
}

export interface ReviewSample {
  readonly seq: number;
  readonly rule: string;
  readonly severity: string;
  readonly wagerNumbers: readonly string[];
  readonly customerRef: string | null;
  readonly agentRef: string | null;
  readonly minutes: number;
  /** Every 20th sample gets a second reviewer for inter-rater agreement. */
  readonly doubleReview: boolean;
}

export interface ReviewPlan {
  readonly runId: string;
  readonly generatedAt: string;
  readonly budget: SamplingBudget;
  readonly budgetMinutes: number;
  readonly estimatedMinutes: number;
  readonly wagerCount: number;
  readonly flagCount: number;
  readonly samples: readonly ReviewSample[];
  /** Every anomaly in the run, including those not sampled for review. */
  readonly flags?: readonly ReviewFlag[];
  readonly rules: readonly ReviewRulePlan[];
}

export interface WilsonInterval {
  readonly low: number;
  readonly high: number;
}

/** Wilson score interval for a binomial proportion; null when n is zero. */
export function wilsonInterval(
  successes: number,
  samples: number,
  z = 1.96,
): WilsonInterval | null {
  if (samples <= 0) return null;
  const p = Math.min(1, Math.max(0, successes / samples));
  const denominator = 1 + (z * z) / samples;
  const center = (p + (z * z) / (2 * samples)) / denominator;
  const half =
    (z *
      Math.sqrt((p * (1 - p)) / samples + (z * z) / (4 * samples * samples))) /
    denominator;
  return {
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  };
}

function costFor(budget: SamplingBudget, rule: string): number {
  const value =
    budget.costPerFlagByRule[rule] ?? budget.costPerFlagByRule["default"];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 2;
}

function samplingKey(seed: string, captureKey: string, seq: number): string {
  return `${seed}|${captureKey}|${seq}`;
}

/**
 * Build a deterministic, stratified review plan. Census rules below the volume floor; allocate a
 * minimum sample to the rest; distribute the remaining minutes to the largest unmet demand. The
 * sample itself is ordered by a seeded hash of the capture and flag sequence, so rule order does
 * not bias it and the same capture + seed yields the same shortlist.
 */
export function planReviews(
  anomalies: readonly Anomaly[],
  options: {
    readonly runId: string;
    readonly wagerCount: number;
    readonly budget?: SamplingBudget;
    readonly captureKey?: string;
    readonly now?: Date;
  },
): ReviewPlan {
  const budget = options.budget ?? DEFAULT_SAMPLING_BUDGET;
  const budgetMinutes = budget.analystMinutesPerDay;
  const groups = new Map<
    string,
    Array<{ readonly anomaly: Anomaly; readonly seq: number }>
  >();
  anomalies.forEach((anomaly, seq) => {
    const list = groups.get(anomaly.rule) ?? [];
    list.push({ anomaly, seq });
    groups.set(anomaly.rule, list);
  });

  const candidates = [...groups.entries()]
    .map(([rule, entries]) => {
      const cost = costFor(budget, rule);
      const warning = entries.some(
        (entry) => entry.anomaly.severity === "warning",
      );
      return {
        rule,
        entries,
        cost,
        fired: entries.length,
        minimum:
          entries.length < budget.volumeFloor
            ? entries.length
            : Math.min(entries.length, 5),
        priority: warning ? 0 : 1,
        selected: 0,
      };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.cost - b.cost ||
        b.fired - a.fired ||
        a.rule.localeCompare(b.rule),
    );

  let remaining = budgetMinutes;
  for (const candidate of candidates) {
    if (
      candidate.minimum > 0 &&
      remaining >= candidate.minimum * candidate.cost
    ) {
      candidate.selected = candidate.minimum;
      remaining -= candidate.minimum * candidate.cost;
    }
  }

  while (remaining > 0) {
    const next = candidates
      .filter((candidate) => candidate.selected < candidate.fired)
      .sort(
        (a, b) =>
          b.fired - b.selected - (a.fired - a.selected) ||
          a.cost - b.cost ||
          a.rule.localeCompare(b.rule),
      )[0];
    if (next === undefined || remaining < next.cost) break;
    next.selected += 1;
    remaining -= next.cost;
  }

  const captureKey = options.captureKey ?? options.runId;
  const flags: ReviewFlag[] = anomalies.map((anomaly, seq) => ({
    seq,
    rule: anomaly.rule,
    severity: anomaly.severity,
    wagerNumbers: anomaly.tickets.map((ticket) => ticket.wagerNumber),
    customerRef:
      typeof anomaly.evidence["customerRef"] === "string"
        ? anomaly.evidence["customerRef"]
        : null,
    agentRef:
      typeof anomaly.evidence["agentRef"] === "string"
        ? anomaly.evidence["agentRef"]
        : null,
  }));
  const samples: ReviewSample[] = [];
  for (const candidate of candidates) {
    if (candidate.selected === 0) continue;
    const chosen = [...candidate.entries]
      .sort((a, b) => {
        const aKey = samplingKey(budget.seed, captureKey, a.seq);
        const bKey = samplingKey(budget.seed, captureKey, b.seq);
        return aKey.localeCompare(bKey) || a.seq - b.seq;
      })
      .slice(0, candidate.selected)
      .sort((a, b) => a.seq - b.seq);
    for (const entry of chosen) {
      const flag = flags[entry.seq];
      if (flag === undefined) continue;
      samples.push({
        ...flag,
        minutes: candidate.cost,
        doubleReview: false,
      });
    }
  }

  const rules: ReviewRulePlan[] = candidates
    .map((candidate) => ({
      rule: candidate.rule,
      fired: candidate.fired,
      selected: candidate.selected,
      mode:
        candidate.selected === 0
          ? ("not_sampled" as const)
          : candidate.selected === candidate.fired
            ? ("census" as const)
            : ("sample" as const),
      minutes: candidate.selected * candidate.cost,
    }))
    .sort((a, b) => a.rule.localeCompare(b.rule));

  const ordered = samples
    .sort((a, b) => a.seq - b.seq)
    .map((sample, index) => ({
      ...sample,
      doubleReview: index % 20 === 0,
    }));
  return {
    runId: options.runId,
    generatedAt: (options.now ?? new Date()).toISOString(),
    budget,
    budgetMinutes,
    estimatedMinutes: rules.reduce((sum, rule) => sum + rule.minutes, 0),
    wagerCount: options.wagerCount,
    flagCount: anomalies.length,
    samples: ordered,
    flags,
    rules,
  };
}

/* -------------------------------------------------------------------------- */
/* Review ledger                                                              */
/* -------------------------------------------------------------------------- */

export interface ReviewRunMeta {
  readonly capturePath?: string | null;
  readonly captureSha256?: string | null;
}

export interface FlagReviewInput {
  readonly runId: string;
  readonly seq: number;
  readonly rule: string;
  readonly wagerNumbers: readonly string[];
  readonly verdict: ReviewVerdict;
  readonly reviewer: string;
  readonly reviewedAt?: string;
  /** Free text: kappa says whether reviewers disagree; notes say why. */
  readonly notes?: string | undefined;
  /** Hashed F402 actor refs carried from the anomaly evidence; no raw login. */
  readonly customerRef?: string | null;
  readonly agentRef?: string | null;
}

export type StoredFlagReview = Omit<
  FlagReviewInput,
  "notes" | "customerRef" | "agentRef"
> & {
  readonly reviewedAt: string;
  readonly notes: string | null;
  readonly customerRef: string | null;
  readonly agentRef: string | null;
};

export function openReviewDb(path: string): Database {
  const db = openSportsdeskSqlite(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS flag_run (
      run_id          TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      capture_path    TEXT,
      capture_sha256  TEXT,
      wager_count     INTEGER NOT NULL,
      flag_count      INTEGER NOT NULL,
      budget_json     TEXT NOT NULL,
      plan_json       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS flag_review (
      run_id         TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      rule           TEXT NOT NULL,
      wager_numbers  TEXT NOT NULL,
      verdict        TEXT NOT NULL CHECK (verdict IN ('confirmed', 'false_positive', 'needs_more_info')),
      reviewed_at    TEXT NOT NULL,
      reviewer       TEXT NOT NULL,
      notes          TEXT,
      customer_ref   TEXT,
      agent_ref      TEXT,
      PRIMARY KEY (run_id, seq, reviewer)
    );

    CREATE INDEX IF NOT EXISTS idx_flag_review_run  ON flag_review(run_id);
    CREATE INDEX IF NOT EXISTS idx_flag_review_rule ON flag_review(rule);
  `);
  // Add notes to a ledger created before the column existed.
  const columns = db.query("PRAGMA table_info(flag_review)").all() as Array<{
    name: string;
  }>;
  for (const [name, type] of [
    ["notes", "TEXT"],
    ["customer_ref", "TEXT"],
    ["agent_ref", "TEXT"],
  ] as const) {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE flag_review ADD COLUMN ${name} ${type}`);
    }
  }
  return db;
}

export function recordReviewPlan(
  db: Database,
  plan: ReviewPlan,
  meta: ReviewRunMeta = {},
): void {
  const serialized = JSON.stringify(plan);
  const existing = db
    .query("SELECT plan_json FROM flag_run WHERE run_id = ?1")
    .get(plan.runId) as { plan_json: string } | null;
  if (existing !== null) {
    if (existing.plan_json !== serialized) {
      throw new Error(
        `flag_run: "${plan.runId}" already exists with a different plan; use a new run id`,
      );
    }
    return;
  }
  db.prepare(
    `INSERT INTO flag_run (run_id, created_at, capture_path, capture_sha256, wager_count, flag_count, budget_json, plan_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.runId,
    plan.generatedAt,
    meta.capturePath ?? null,
    meta.captureSha256 ?? null,
    plan.wagerCount,
    plan.flagCount,
    JSON.stringify(plan.budget),
    serialized,
  );
}

export function recordFlagReview(db: Database, review: FlagReviewInput): void {
  if (!REVIEW_VERDICTS.includes(review.verdict)) {
    throw new Error(`flag_review: unknown verdict "${review.verdict}"`);
  }
  if (review.reviewer.trim() === "") {
    throw new Error("flag_review: reviewer must not be empty");
  }
  if (!Number.isInteger(review.seq) || review.seq < 0) {
    throw new Error("flag_review: seq must be a non-negative integer");
  }
  db.prepare(
    `INSERT INTO flag_review (run_id, seq, rule, wager_numbers, verdict, reviewed_at, reviewer, notes, customer_ref, agent_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, seq, reviewer) DO UPDATE SET
       rule = excluded.rule,
       wager_numbers = excluded.wager_numbers,
       verdict = excluded.verdict,
       reviewed_at = excluded.reviewed_at,
       notes = excluded.notes,
       customer_ref = excluded.customer_ref,
       agent_ref = excluded.agent_ref`,
  ).run(
    review.runId,
    review.seq,
    review.rule,
    JSON.stringify(review.wagerNumbers),
    review.verdict,
    review.reviewedAt ?? new Date().toISOString(),
    review.reviewer.trim(),
    review.notes?.trim() ? review.notes.trim() : null,
    review.customerRef ?? null,
    review.agentRef ?? null,
  );
}

export interface ReviewRunSummary {
  readonly runId: string;
  readonly createdAt: string;
  readonly capturePath: string | null;
  readonly captureSha256: string | null;
  readonly wagerCount: number;
  readonly flagCount: number;
  readonly plan: ReviewPlan;
}

export function readReviewRun(
  db: Database,
  runId?: string,
): ReviewRunSummary | null {
  const row =
    runId === undefined
      ? db
          .query(
            `SELECT run_id, created_at, capture_path, capture_sha256, wager_count, flag_count, plan_json
             FROM flag_run ORDER BY created_at DESC LIMIT 1`,
          )
          .get()
      : db
          .query(
            `SELECT run_id, created_at, capture_path, capture_sha256, wager_count, flag_count, plan_json
             FROM flag_run WHERE run_id = ?1`,
          )
          .get(runId);
  if (row === null || row === undefined) return null;
  const record = row as Record<string, unknown>;
  return {
    runId: String(record["run_id"]),
    createdAt: String(record["created_at"]),
    capturePath:
      record["capture_path"] === null ? null : String(record["capture_path"]),
    captureSha256:
      record["capture_sha256"] === null
        ? null
        : String(record["capture_sha256"]),
    wagerCount: sqlInt(record["wager_count"] as number | bigint | null),
    flagCount: sqlInt(record["flag_count"] as number | bigint | null),
    plan: JSON.parse(String(record["plan_json"])) as ReviewPlan,
  };
}

export function readReviewRuns(db: Database): readonly ReviewRunSummary[] {
  const rows = db
    .query(
      `SELECT run_id, created_at, capture_path, capture_sha256, wager_count, flag_count, plan_json
       FROM flag_run ORDER BY created_at ASC`,
    )
    .all();
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      runId: String(record["run_id"]),
      createdAt: String(record["created_at"]),
      capturePath:
        record["capture_path"] === null ? null : String(record["capture_path"]),
      captureSha256:
        record["capture_sha256"] === null
          ? null
          : String(record["capture_sha256"]),
      wagerCount: sqlInt(record["wager_count"] as number | bigint | null),
      flagCount: sqlInt(record["flag_count"] as number | bigint | null),
      plan: JSON.parse(String(record["plan_json"])) as ReviewPlan,
    };
  });
}

export interface FlagRateHistory {
  readonly runs: number;
  readonly runsWithFullFlags: number;
  readonly p50: Readonly<Record<string, number>>;
}

/**
 * Per-rule median flag rate over runs that persisted every flag. Sample-only runs are counted in
 * `runs` but excluded from the median: their denominator is the sample, not the wager count.
 */

export function buildFlagRateHistory(
  runs: readonly ReviewRunSummary[],
  minRuns = 3,
): FlagRateHistory | null {
  const timed = runs.filter(
    (run) => run.wagerCount > 0 && run.plan.rules.length > 0,
  );
  const full = timed.filter((run) => (run.plan.flags?.length ?? 0) > 0);
  if (full.length < minRuns) return null;
  const rates = new Map<string, number[]>();
  for (const run of full) {
    for (const rule of run.plan.rules) {
      const list = rates.get(rule.rule) ?? [];
      list.push(rule.fired / run.wagerCount);
      rates.set(rule.rule, list);
    }
  }
  const p50: Record<string, number> = {};
  for (const [rule, values] of rates) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    p50[rule] =
      sorted.length % 2 === 1
        ? sorted[middle]!
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return {
    runs: timed.length,
    runsWithFullFlags: full.length,
    p50,
  };
}

export function readFlagReviews(
  db: Database,
  runId?: string,
): readonly StoredFlagReview[] {
  const rows =
    runId === undefined
      ? db
          .query(
            `SELECT run_id, seq, rule, wager_numbers, verdict, reviewed_at, reviewer, notes, customer_ref, agent_ref
             FROM flag_review ORDER BY run_id, seq, reviewer`,
          )
          .all()
      : db
          .query(
            `SELECT run_id, seq, rule, wager_numbers, verdict, reviewed_at, reviewer, notes, customer_ref, agent_ref
             FROM flag_review WHERE run_id = ?1 ORDER BY seq, reviewer`,
          )
          .all(runId);
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      runId: String(record["run_id"]),
      seq: sqlInt(record["seq"] as number | bigint | null),
      rule: String(record["rule"]),
      wagerNumbers: JSON.parse(String(record["wager_numbers"])) as string[],
      verdict: String(record["verdict"]) as ReviewVerdict,
      reviewedAt: String(record["reviewed_at"]),
      reviewer: String(record["reviewer"]),
      notes: record["notes"] === null ? null : String(record["notes"]),
      customerRef:
        record["customer_ref"] === null ? null : String(record["customer_ref"]),
      agentRef:
        record["agent_ref"] === null ? null : String(record["agent_ref"]),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Review progress and export                                                 */
/* -------------------------------------------------------------------------- */

function emptyVerdicts(): Record<ReviewVerdict, number> {
  return { confirmed: 0, false_positive: 0, needs_more_info: 0 };
}

export interface ReviewRuleProgress {
  readonly rule: string;
  readonly selected: number;
  readonly reviewed: number;
  readonly remaining: number;
  /** Review rows, not flags: a double-reviewed flag contributes two. */
  readonly verdicts: Record<ReviewVerdict, number>;
}

export interface ReviewProgress {
  readonly runId: string;
  readonly flagCount: number;
  readonly sampled: number;
  readonly reviewed: number;
  readonly remaining: number;
  readonly doubleReviewPlanned: number;
  readonly doubleReviewCovered: number;
  readonly verdicts: Record<ReviewVerdict, number>;
  readonly rules: readonly ReviewRuleProgress[];
}

/** What a reviewer still has to do, from the persisted plan and the review rows. */
export function reviewProgress(
  plan: ReviewPlan,
  reviews: readonly StoredFlagReview[],
): ReviewProgress {
  const sampleSeqs = new Set(plan.samples.map((sample) => sample.seq));
  const bySeq = new Map<number, StoredFlagReview[]>();
  for (const review of reviews) {
    if (!sampleSeqs.has(review.seq)) continue;
    const list = bySeq.get(review.seq) ?? [];
    list.push(review);
    bySeq.set(review.seq, list);
  }
  const verdicts = emptyVerdicts();
  for (const list of bySeq.values()) {
    for (const review of list) verdicts[review.verdict] += 1;
  }
  const rules = plan.rules.map((rule) => {
    const sampled = plan.samples.filter((sample) => sample.rule === rule.rule);
    const reviewed = sampled.filter((sample) => bySeq.has(sample.seq));
    const ruleVerdicts = emptyVerdicts();
    for (const sample of reviewed) {
      for (const review of bySeq.get(sample.seq) ?? []) {
        ruleVerdicts[review.verdict] += 1;
      }
    }
    return {
      rule: rule.rule,
      selected: sampled.length,
      reviewed: reviewed.length,
      remaining: sampled.length - reviewed.length,
      verdicts: ruleVerdicts,
    };
  });
  const doubleReviewPlanned = plan.samples.filter(
    (sample) => sample.doubleReview,
  ).length;
  const doubleReviewCovered = plan.samples.filter(
    (sample) =>
      sample.doubleReview && (bySeq.get(sample.seq)?.length ?? 0) >= 2,
  ).length;
  const reviewed = bySeq.size;
  return {
    runId: plan.runId,
    flagCount: plan.flagCount,
    sampled: plan.samples.length,
    reviewed,
    remaining: plan.samples.length - reviewed,
    doubleReviewPlanned,
    doubleReviewCovered,
    verdicts,
    rules,
  };
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The reviewer's tracker, separate from the measurement report. */
export function reviewsCsv(reviews: readonly StoredFlagReview[]): string {
  const header = [
    "run_id",
    "seq",
    "rule",
    "verdict",
    "reviewer",
    "reviewed_at",
    "notes",
    "customer_ref",
    "agent_ref",
    "wager_numbers",
  ].join(",");
  const rows = [...reviews]
    .sort((a, b) => a.seq - b.seq || a.reviewer.localeCompare(b.reviewer))
    .map((review) =>
      [
        review.runId,
        String(review.seq),
        review.rule,
        review.verdict,
        review.reviewer,
        review.reviewedAt,
        review.notes ?? "",
        review.customerRef ?? "",
        review.agentRef ?? "",
        review.wagerNumbers.join("|"),
      ]
        .map(csvCell)
        .join(","),
    );
  return [header, ...rows].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Flags metric metadata                                                      */
/* -------------------------------------------------------------------------- */

export type BlockedByLayer =
  "persistence" | "application" | "execution" | "escalation";

export interface BlockedByRef {
  readonly name: string;
  readonly layer: BlockedByLayer;
  /** Why this blocker exists and what clearing it would unlock; shown next to the layer. */
  readonly description?: string;
}

export type BlockedBy =
  string | BlockedByRef | readonly (string | BlockedByRef)[];

export interface FlagsMetricDefinition {
  readonly name: string;
  readonly kind: string;
  readonly unit?: string;
  readonly label?: string;
  readonly population?: string;
  readonly baselineRef?: string;
  readonly detailRef?: string;
  readonly evaluates?: string;
  readonly notApplicableTo?: string;
  readonly state?: string | undefined;
  readonly blockedBy?: BlockedBy | undefined;
  readonly method?: string;
  readonly value?: unknown;
  readonly sampledFrom?: number;
  readonly n?: number;
  readonly derivedFrom?: MetricDerivedFrom;
  readonly reviewPolicy?: string;
  readonly description: string;
}

export interface FlagsMetricMetadata {
  readonly kind: "flags-metric-metadata";
  readonly schemaVersion: 1;
  readonly reviewPolicy: string;
  readonly definitions: readonly FlagsMetricDefinition[];
}

interface RulePrecisionRow {
  readonly state?: "not_measured";
  readonly blockedBy?: string;
  readonly precision?: number;
  readonly wilson?: WilsonInterval | null;
  readonly n: number;
  readonly sampledFrom: number;
  readonly confirmed: number;
}

function definitiveFlags(
  reviews: readonly StoredFlagReview[],
): Map<number, { rule: string; verdict: ReviewVerdict }> {
  const bySeq = new Map<number, StoredFlagReview[]>();
  for (const review of reviews) {
    const list = bySeq.get(review.seq) ?? [];
    list.push(review);
    bySeq.set(review.seq, list);
  }
  const result = new Map<number, { rule: string; verdict: ReviewVerdict }>();
  for (const [seq, list] of bySeq) {
    const verdicts = list.map((review) => review.verdict);
    const verdict: ReviewVerdict = verdicts.includes("confirmed")
      ? "confirmed"
      : verdicts.includes("false_positive")
        ? "false_positive"
        : "needs_more_info";
    result.set(seq, { rule: list[0]?.rule ?? "?", verdict });
  }
  return result;
}

function cohenKappa(
  pairs: ReadonlyArray<readonly [string, string]>,
): number | null {
  if (pairs.length === 0) return null;
  const categories = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  const total = pairs.length;
  let agreements = 0;
  const row = new Map<string, number>();
  const column = new Map<string, number>();
  for (const [a, b] of pairs) {
    if (a === b) agreements += 1;
    row.set(a, (row.get(a) ?? 0) + 1);
    column.set(b, (column.get(b) ?? 0) + 1);
  }
  const observed = agreements / total;
  let expected = 0;
  for (const category of categories) {
    expected +=
      ((row.get(category) ?? 0) / total) *
      ((column.get(category) ?? 0) / total);
  }
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

function reviewerPairs(
  reviews: readonly StoredFlagReview[],
): ReadonlyArray<readonly [string, string]> {
  const bySeq = new Map<number, StoredFlagReview[]>();
  for (const review of reviews) {
    const list = bySeq.get(review.seq) ?? [];
    list.push(review);
    bySeq.set(review.seq, list);
  }
  const pairs: Array<readonly [string, string]> = [];
  for (const list of bySeq.values()) {
    if (list.length < 2) continue;
    const ordered = [...list].sort((a, b) =>
      a.reviewer.localeCompare(b.reviewer),
    );
    pairs.push([ordered[0]!.verdict, ordered[1]!.verdict]);
  }
  return pairs;
}

/**
 * The `flags-metric-metadata` contract. `rulePrecision` is sampled precision over reviewed flags,
 * never per-flag probability; `evaluates`/`notApplicableTo` make that boundary machine-readable.
 */
export interface FlagsMetadataOptions {
  readonly flagRateHistory?: FlagRateHistory | null;
}

export function buildFlagsMetricMetadata(
  plan: ReviewPlan,
  reviews: readonly StoredFlagReview[],
  options: FlagsMetadataOptions = {},
): FlagsMetricMetadata {
  const flags = definitiveFlags(reviews);
  const byRule = new Map<
    string,
    Array<{ seq: number; verdict: ReviewVerdict }>
  >();
  for (const [seq, entry] of flags) {
    const list = byRule.get(entry.rule) ?? [];
    list.push({ seq, verdict: entry.verdict });
    byRule.set(entry.rule, list);
  }

  const rulePrecision: Record<string, RulePrecisionRow> = {};
  for (const rule of plan.rules) {
    const reviewed = byRule.get(rule.rule) ?? [];
    const definitive = reviewed.filter(
      (entry) => entry.verdict !== "needs_more_info",
    );
    const confirmed = definitive.filter(
      (entry) => entry.verdict === "confirmed",
    ).length;
    if (definitive.length === 0) {
      rulePrecision[rule.rule] = {
        state: "not_measured",
        blockedBy: "noReviews",
        n: 0,
        sampledFrom: rule.fired,
        confirmed: 0,
      };
      continue;
    }
    if (definitive.length < MIN_PRECISION_SAMPLE) {
      rulePrecision[rule.rule] = {
        state: "not_measured",
        blockedBy: "reviewedSampleSize",
        n: definitive.length,
        sampledFrom: rule.fired,
        confirmed,
      };
      continue;
    }
    rulePrecision[rule.rule] = {
      precision: confirmed / definitive.length,
      wilson: wilsonInterval(confirmed, definitive.length),
      n: definitive.length,
      sampledFrom: rule.fired,
      confirmed,
    };
  }

  const definitive = [...flags.values()].filter(
    (entry) => entry.verdict !== "needs_more_info",
  );
  const confirmed = definitive.filter(
    (entry) => entry.verdict === "confirmed",
  ).length;
  const reviewedSampleRate =
    definitive.length < MIN_PRECISION_SAMPLE
      ? {
          state: "not_measured" as const,
          blockedBy:
            definitive.length === 0 ? "noReviews" : "reviewedSampleSize",
        }
      : {
          value: confirmed / definitive.length,
          wilson: wilsonInterval(confirmed, definitive.length),
        };

  const pairs = reviewerPairs(reviews);
  const kappa = cohenKappa(pairs);
  const reviewerAgreement =
    pairs.length === 0
      ? {
          state: "not_measured" as const,
          blockedBy: "noDoubleReview",
          n: 0,
        }
      : kappa === null
        ? {
            state: "not_measured" as const,
            blockedBy: "kappaUndefined",
            n: pairs.length,
          }
        : {
            value: kappa,
            method: "cohen-kappa",
            n: pairs.length,
          };

  const reviewedFlags = new Set(reviews.map((review) => review.seq)).size;
  const flagsPersisted = (plan.flags?.length ?? 0) > 0;
  const confirmedByRule = Object.fromEntries(
    Object.entries(rulePrecision)
      .filter(([, row]) => row.confirmed !== undefined)
      .map(([rule, row]) => [rule, row.confirmed]),
  );
  const minPerRule = DEFAULT_QUEUE_READINESS_POLICY.minConfirmedReviewsPerRule;
  const appliedRules = Object.entries(confirmedByRule)
    .filter(([, count]) => count >= minPerRule)
    .map(([rule]) => rule);
  const notAppliedRules = Object.entries(confirmedByRule)
    .filter(([, count]) => count < minPerRule)
    .map(([rule, n]) => ({ rule, n }));
  const ruleApplicationState =
    appliedRules.length === 0
      ? "not_measured"
      : notAppliedRules.length === 0
        ? "measured"
        : "partial";
  return {
    kind: "flags-metric-metadata",
    schemaVersion: 1,
    reviewPolicy: DEFAULT_REVIEW_POLICY,
    definitions: [
      {
        name: "flagRate",
        kind: "metric",
        unit: "flag",
        population: "all-wagers",
        baselineRef: "flagRateReference",
        value: plan.wagerCount === 0 ? null : plan.flagCount / plan.wagerCount,
        state: plan.wagerCount === 0 ? "not_measured" : undefined,
        blockedBy: plan.wagerCount === 0 ? "noWagers" : undefined,
        description:
          "Flags fired divided by wagers scored; diagnostic only, not precision. Read it against flagRateReference, not in isolation.",
      },
      {
        name: "flagRateReference",
        kind: "baseline",
        ...(options.flagRateHistory === undefined ||
        options.flagRateHistory === null
          ? {
              state: "not_measured",
              blockedBy: {
                name: "captureHistory",
                layer: "persistence" as const,
              },
              value: null,
              description:
                "Historical per-rule flag-rate reference (P50 over recent captures); needs at least three runs that persisted every flag. Sample-only runs use a different denominator and are excluded from the median.",
            }
          : {
              state: "measured",
              value: {
                runs: options.flagRateHistory.runs,
                runsWithFullFlags: options.flagRateHistory.runsWithFullFlags,
                p50: options.flagRateHistory.p50,
              },
              description:
                "Per-rule median flag rate over persisted runs; the reference flagRate should be read against.",
            }),
      },
      {
        name: "ruleHitWeight",
        kind: "parameter",
        state: "not_measured",
        blockedBy: "scoreSubIntegerPrecision",
        value: {
          perConfirmedHit: RULE_HIT_WEIGHT_PER_CONFIRMED,
          cap: RULE_HIT_WEIGHT_CAP,
          appliedTo: "normalized-priority",
          confirmedByRule,
        },
        description:
          "Not used with the current integer model scores. A +0.10 bonus would be a score override against the observed zero median top-K gap. Kept for a future sub-integer score model; the boolean ruleHitTieBreak is the shippable contract.",
      },
      {
        name: "samplingRate",
        kind: "parameter",
        value: plan.flagCount === 0 ? null : reviewedFlags / plan.flagCount,
        state: plan.flagCount === 0 ? "not_measured" : undefined,
        blockedBy: plan.flagCount === 0 ? "noFlags" : undefined,
        description:
          "Fraction of fired flags actually reviewed. Set by the analyst-minute budget, not by the data.",
      },
      {
        name: "rulePrecision",
        kind: "metric",
        unit: "flag",
        label: "reviewer.verdict == confirmed",
        population: "reviewed-sample",
        baselineRef: "reviewedSamplePositiveRate",
        detailRef: "reviews.rulePrecision",
        evaluates: "rule",
        notApplicableTo: "individual-flag",
        value: rulePrecision,
        n: definitive.length,
        sampledFrom: plan.flagCount,
        derivedFrom: "sampled",
        reviewPolicy: DEFAULT_REVIEW_POLICY,
        description:
          "Sampled precision per rule over reviewed flags. A sampled 0.85 does not mean flag N is 85% likely to be real; it means the rule was right 85% of the time in the reviewed sample. Per-flag evaluation requires case-level review.",
      },
      {
        name: "allFlagRows",
        kind: "caveat",
        ...(flagsPersisted
          ? {
              state: "measured",
              value: "persisted-in-plan",
              description:
                "Every anomaly is persisted in flag_run.plan_json with customerRef/agentRef; hasRuleHit can cover the full run, not just the review sample.",
            }
          : {
              state: "not_measured",
              blockedBy: {
                name: "flagRunPersistence",
                layer: "persistence" as const,
              },
              value: "not_persisted",
              description:
                "flag_run.plan_json stores only the review sample, not every anomaly. hasRuleHit needs all flag rows with customerRef; persist them at review-plan time or rerun dx flags at batch time.",
            }),
      },
      {
        name: "ruleApplication",
        kind: "parameter",
        state: ruleApplicationState,
        blockedBy:
          ruleApplicationState === "measured"
            ? undefined
            : {
                name: "reviewRowsPerRule",
                layer: "application",
              },
        value: {
          applied: appliedRules,
          notApplied: notAppliedRules,
        },
        description:
          "Per-run applied/not_applied rules. A rule below 5 confirmed reviews contributes no tie-break and appears in notApplied with its n, so a promoted account never hides which rule was excluded. partial means some rules applied and some did not.",
      },
      {
        name: "bridgeRepresentativeness",
        kind: "quality",
        state: "not_measured",
        blockedBy: "studyArtifact",
        value: {
          representative: null,
          study: "missing",
        },
        description:
          "The other three execution gates (corpus, model, reviews) clear as data lands. This one requires a written study artifact at reports/security/bridge-representativeness.json; the gate reads `representative` and refuses if it is false or missing. The reader verifies `representative` against the covered and uncovered Wilson intervals, so the field cannot contradict the arms. Coverage is measured separately and is not a substitute for this study.",
      },
      {
        name: "queueEscalation",
        kind: "caveat",
        state: "not_measured",
        blockedBy: [
          {
            name: "durableCustomerMaster",
            layer: "escalation",
            description:
              "Execution proceeds at current coverage if bridgeRepresentativeness clears; full coverage is required only for escalation. The two blockers are the same data problem at different severity, so they do not resolve together.",
          },
          { name: "corpusFreshness", layer: "execution" },
          { name: "modelFreshness", layer: "execution" },
          { name: "bridgeRepresentativeness", layer: "execution" },
          { name: "reviewRows", layer: "execution" },
          { name: "reviewRowsPerRule", layer: "application" },
          ...(flagsPersisted
            ? []
            : [{ name: "allFlagRows", layer: "application" as const }]),
        ],
        value: "not_implemented",
        description:
          "Bridge coverage is 99.65% (2,577/2586) against the 2026-11-01 getListAgenstByAgent PLAYERS capture; 9 accounts are unmatched (BA109_0, CRB102, GAGCOF1052, ML117, PEP119, TD103, TD104, TD106, TD108); the GSLive corpus ends 2026-11-04T05:59:59Z; the model was fitted 2026-11-05T05:36Z from that stale corpus; 0 confirmed reviews; top-100 median adjacent score gap is 0 (54 ties). hasRuleHit is a tie-break after the model score, not a promotion; all readiness gates must clear before the batch can run.",
      },
      {
        name: "response",
        kind: "caveat",
        value: "measurement-only",
        description:
          "A confirmed flag writes to flag_review only: no notification, queue escalation, or account change. rulePrecision measures the rule, not an action.",
      },
      {
        name: "queuePriorityOrder",
        kind: "parameter",
        state: "not_measured",
        blockedBy: [
          {
            name: "durableCustomerMaster",
            layer: "escalation",
            description:
              "Execution proceeds at current coverage if bridgeRepresentativeness clears; full coverage is required only for escalation. The two blockers are the same data problem at different severity, so they do not resolve together.",
          },
          { name: "reviewRowsPerRule", layer: "application" },
        ],
        value: [
          "desk-flag",
          "findings",
          "odds-drift",
          "model-score",
          "has-rule-hit",
          "has-confirmed-rule-hit",
          "bets",
        ],
        description:
          "Lexicographic key order. Rule evidence is a tie-break after the model score, not a bucket promotion: a 95 still beats an 82.5 with a rule hit. has-rule-hit uses all anomalies; has-confirmed-rule-hit is reviewer evidence.",
      },
      {
        name: "ruleHitTieBreak",
        kind: "parameter",
        state: "not_measured",
        blockedBy: [
          {
            name: "durableCustomerMaster",
            layer: "escalation",
            description:
              "Execution proceeds at current coverage if bridgeRepresentativeness clears; full coverage is required only for escalation. The two blockers are the same data problem at different severity, so they do not resolve together.",
          },
          ...(flagsPersisted
            ? []
            : [{ name: "allFlagRows", layer: "application" as const }]),
          { name: "reviewRowsPerRule", layer: "application" },
          { name: "bridgeRepresentativeness", layer: "execution" },
        ],
        value: {
          field: "hasRuleHit",
          evidenceField: "hasConfirmedRuleHit",
          order: "desc",
          position: "after-model-score",
          scoreBonus: false,
          minConfirmedReviewsPerRule: 5,
        },
        description:
          "Tie-break, not a score bonus or bucket promotion. Unreviewed hasRuleHit is the dense signal; hasConfirmedRuleHit stays reviewer evidence because at 10% sampling it reflects which flags were sampled. Applied per rule only after >= 5 confirmed reviews.",
      },
      {
        name: "modelFreshnessThreshold",
        kind: "parameter",
        value: 7,
        unit: "day",
        derivedFrom: "assumed_default",
        description:
          "Not empirically derived; precision@20 versus model age has not been measured. Revisit when the decay study exists.",
      },
      {
        name: "bridgeRepresentativenessThreshold",
        kind: "parameter",
        value: "within one Wilson interval",
        derivedFrom: "assumed_default",
        description:
          "Default bar for covered-vs-uncovered precision. Revisit if small but persistent divergence turns out to be meaningful.",
      },
      {
        name: "scoreNormalization",
        kind: "parameter",
        state: "not_measured",
        blockedBy: { name: "corpusFreshness", layer: "execution" },
        value: {
          divisor: 100,
          observed: {
            n: 1276,
            min: 0,
            max: 100,
            mean: 52.18,
            sd: 22.67,
          },
          measuredAt: "2026-11-05T05:50:00.006Z",
          source: "GSLive corpus 2026-11-04 (stale)",
        },
        description:
          "The model score is 0-100; recorded for display and future sub-integer scoring. The tie-break contract does not add a score bonus. Observed over 1,276 eligible accounts; refresh after live ingestion.",
      },
      {
        name: "bridgeCoverage",
        kind: "metric",
        unit: "account",
        population: "gslive-accounts",
        value: 0.9965,
        derivedFrom: "measured",
        description:
          "2,577/2,586 GSLive accounts resolve to the 2026-11-01 getListAgenstByAgent PLAYERS capture on customerID or Login (99.65%), measured 2026-11-05T07:03Z. The 9 unmatched ids look like accounts added after that capture. Coverage is reported, not gated: representativeness decides whether the covered accounts stand in for the uncovered ones. A measurement older than 30 days emits bridgeCoverageStaleness as a warning, not a blocker.",
      },
      {
        name: "reviewedSamplePositiveRate",
        kind: "baseline",
        unit: "flag",
        value: "value" in reviewedSampleRate ? reviewedSampleRate.value : null,
        state:
          "state" in reviewedSampleRate ? reviewedSampleRate.state : undefined,
        blockedBy:
          "blockedBy" in reviewedSampleRate
            ? reviewedSampleRate.blockedBy
            : undefined,
        description:
          "Confirmed rate across the reviewed sample; rulePrecision is lift over this rate.",
      },
      {
        name: "reviewerAgreement",
        kind: "quality",
        ...reviewerAgreement,
        description:
          "Cohen's kappa on double-reviewed flags. Without it, rule precision cannot separate rule quality from reviewer disagreement.",
      },
    ],
  };
}

/**
 * Enforce the flags metadata contract: references resolve; classification metrics evaluate rules,
 * never individual flags; and a not-measured row names its blocker.
 */
export function validateFlagsMetricMetadata(
  metadata: FlagsMetricMetadata,
  root?: unknown,
): void {
  if (metadata.schemaVersion !== 1) {
    throw new Error(
      `flagsMetricMetadata: schemaVersion ${metadata.schemaVersion} but validator expects 1`,
    );
  }
  const byName = new Map(metadata.definitions.map((row) => [row.name, row]));
  if (byName.size !== metadata.definitions.length) {
    throw new Error("flagsMetricMetadata: duplicate definition name");
  }
  for (const row of metadata.definitions) {
    if (!isMetricMetadataKind(row.kind)) {
      throw new Error(
        `flagsMetricMetadata: ${row.name} has unknown kind "${row.kind}"; allowed: ${METRIC_METADATA_KINDS.join(", ")}`,
      );
    }
  }
  const resolve = (path: string): unknown => {
    let current = root;
    for (const key of path.split(".")) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };
  for (const row of metadata.definitions) {
    if (
      row.baselineRef !== undefined &&
      byName.get(row.baselineRef)?.kind !== "baseline"
    ) {
      throw new Error(
        `flagsMetricMetadata: ${row.name}.baselineRef -> "${row.baselineRef}" is not a baseline`,
      );
    }
    if (
      row.derivedFrom !== undefined &&
      !isMetricDerivedFrom(row.derivedFrom)
    ) {
      throw new Error(
        `flagsMetricMetadata: ${row.name}.derivedFrom "${row.derivedFrom}" is not ${METRIC_DERIVED_FROM.join("|")}`,
      );
    }
    if (row.state === "not_measured" || row.state === "partial") {
      const blocked = row.blockedBy;
      const empty =
        blocked === undefined ||
        (typeof blocked === "string"
          ? blocked.trim() === ""
          : "name" in blocked
            ? blocked.name.trim() === ""
            : blocked.length === 0);
      if (empty) {
        throw new Error(
          `flagsMetricMetadata: ${row.name} is ${row.state} but has no blockedBy`,
        );
      }
      if (blocked !== undefined) {
        const entries =
          typeof blocked === "string"
            ? []
            : Array.isArray(blocked)
              ? blocked
              : [blocked];
        for (const entry of entries) {
          if (typeof entry === "string") continue;
          const layer = entry.layer;
          if (
            layer !== "persistence" &&
            layer !== "application" &&
            layer !== "execution" &&
            layer !== "escalation"
          ) {
            throw new Error(
              `flagsMetricMetadata: ${row.name}.blockedBy "${entry.name}" has unknown layer "${String(layer)}"`,
            );
          }
          if (entry.name.trim() === "") {
            throw new Error(
              `flagsMetricMetadata: ${row.name}.blockedBy has an empty name`,
            );
          }
          if (
            entry.description !== undefined &&
            entry.description.trim() === ""
          ) {
            throw new Error(
              `flagsMetricMetadata: ${row.name}.blockedBy "${entry.name}" has an empty description`,
            );
          }
        }
      }
    }
    if (row.evaluates !== undefined) {
      if (row.evaluates !== "rule") {
        throw new Error(
          `flagsMetricMetadata: ${row.name} metric must evaluate rules, not ${row.evaluates ?? "nothing"}`,
        );
      }
      if (row.notApplicableTo !== "individual-flag") {
        throw new Error(
          `flagsMetricMetadata: ${row.name} must disclaim individual-flag evaluation`,
        );
      }
      if (typeof row.n !== "number" || typeof row.sampledFrom !== "number") {
        throw new Error(
          `flagsMetricMetadata: ${row.name} metric needs n and sampledFrom`,
        );
      }
      if (row.detailRef === undefined) {
        throw new Error(`flagsMetricMetadata: ${row.name} has no detailRef`);
      }
      if (root !== undefined && resolve(row.detailRef) === undefined) {
        throw new Error(
          `flagsMetricMetadata: ${row.name}.detailRef -> "${row.detailRef}" does not resolve`,
        );
      }
    }
  }
}

export type { RuleName };
