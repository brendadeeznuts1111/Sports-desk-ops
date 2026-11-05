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
  METRIC_METADATA_KINDS,
  isMetricDerivedFrom,
  isMetricMetadataKind,
  type MetricDerivedFrom,
} from "../lib/metric_metadata.ts";
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

export interface ReviewSample {
  readonly seq: number;
  readonly rule: string;
  readonly severity: string;
  readonly wagerNumbers: readonly string[];
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
    chosen.forEach((entry) => {
      samples.push({
        seq: entry.seq,
        rule: entry.anomaly.rule,
        severity: entry.anomaly.severity,
        wagerNumbers: entry.anomaly.tickets.map((ticket) => ticket.wagerNumber),
        minutes: candidate.cost,
        doubleReview: false,
      });
    });
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
}

export type StoredFlagReview = Omit<FlagReviewInput, "notes"> & {
  readonly reviewedAt: string;
  readonly notes: string | null;
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
      PRIMARY KEY (run_id, seq, reviewer)
    );

    CREATE INDEX IF NOT EXISTS idx_flag_review_run  ON flag_review(run_id);
    CREATE INDEX IF NOT EXISTS idx_flag_review_rule ON flag_review(rule);
  `);
  // Add notes to a ledger created before the column existed.
  const columns = db.query("PRAGMA table_info(flag_review)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "notes")) {
    db.exec("ALTER TABLE flag_review ADD COLUMN notes TEXT");
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
    `INSERT INTO flag_review (run_id, seq, rule, wager_numbers, verdict, reviewed_at, reviewer, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, seq, reviewer) DO UPDATE SET
       rule = excluded.rule,
       wager_numbers = excluded.wager_numbers,
       verdict = excluded.verdict,
       reviewed_at = excluded.reviewed_at,
       notes = excluded.notes`,
  ).run(
    review.runId,
    review.seq,
    review.rule,
    JSON.stringify(review.wagerNumbers),
    review.verdict,
    review.reviewedAt ?? new Date().toISOString(),
    review.reviewer.trim(),
    review.notes?.trim() ? review.notes.trim() : null,
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

export function readFlagReviews(
  db: Database,
  runId?: string,
): readonly StoredFlagReview[] {
  const rows =
    runId === undefined
      ? db
          .query(
            `SELECT run_id, seq, rule, wager_numbers, verdict, reviewed_at, reviewer, notes
             FROM flag_review ORDER BY run_id, seq, reviewer`,
          )
          .all()
      : db
          .query(
            `SELECT run_id, seq, rule, wager_numbers, verdict, reviewed_at, reviewer, notes
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
  readonly blockedBy?: string | undefined;
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
export function buildFlagsMetricMetadata(
  plan: ReviewPlan,
  reviews: readonly StoredFlagReview[],
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
        value: plan.wagerCount === 0 ? null : plan.flagCount / plan.wagerCount,
        state: plan.wagerCount === 0 ? "not_measured" : undefined,
        blockedBy: plan.wagerCount === 0 ? "noWagers" : undefined,
        description:
          "Flags fired divided by wagers scored; diagnostic only, not precision.",
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
        `flagsMetricMetadata: ${row.name}.derivedFrom "${row.derivedFrom}" is not sampled|measured|computed|extrapolated`,
      );
    }
    if (row.state === "not_measured" && (row.blockedBy ?? "").trim() === "") {
      throw new Error(
        `flagsMetricMetadata: ${row.name} is not_measured but has no blockedBy`,
      );
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
