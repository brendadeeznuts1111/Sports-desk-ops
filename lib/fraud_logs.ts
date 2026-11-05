/**
 * @file fraud_logs.ts
 * @description Source discovery, provenance and normalization for the SportsDesk security/fraud
 * console (`dsh-plugin-sportsdesk-security`, tool namespace `fraud_*`).
 *
 * Read-only by construction: this module stats/reads captured artifacts, masks identifiers and
 * never writes. It is the honesty floor of every CLI answer — each command prints the
 * `FraudSourceState[]` this file derives, so MISSING is never reported as zero, an ephemeral
 * Scratch corpus is labelled ephemeral, and a generated fixture is labelled fixture.
 *
 * PII posture: a raw IP address is converted at the parse boundary into `ipMasked`
 * (`47.223.***.***`), `ipTag` (first 8 hex of sha256) and `ipPrefix24`; the raw address is never
 * stored on a record and never emitted. Account ids/logins do appear (existing desk tools show
 * them), but never joined to a raw IP.
 *
 * Corpus volume: the live GSLive `getBetReport` capture is 55,600,957 bytes / 24,778 rows.
 * Measured on Bun 1.4.4 (macOS arm64): `Bun.file(path).json()` ≈ 60–110 ms including the parse,
 * so one invocation parses the document once and every command reuses that in-memory corpus.
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256Hex } from "./f402_bet_ticker_delta.ts";
import { classifyIp, parseAccessMs } from "./f402_weblog.ts";
import { parseGsliveTimestampMs } from "./gslive_bet_event_log.ts";
import {
  GSLIVE_WEBLOG_ARTIFACT_KIND,
  GSLIVE_WEBLOG_REFRESH_COMMAND,
  loadGsliveWeblogActivity,
  type GsliveWeblogActivity,
} from "./gslive_weblog_activity.ts";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const FRAUD_SCHEMA_VERSION = 1 as const;
export const FRAUD_CONFIG_REL_PATH = "config/fraud-model.json";
/** The command that produces the only artifact this plugin can write. */
export const FRAUD_MODEL_FIT_COMMAND =
  "bun run cli/sportsdesk_fraud_cli.ts model fit --write --json";
/** The command an operator runs to refresh the missing GSLive WebLog activity artifact. */
export const GSLIVE_WEBLOG_ACTIVITY_COMMAND = GSLIVE_WEBLOG_REFRESH_COMMAND;
/** Largest file this module will re-hash on discovery; bigger sources need a sha256 sidecar. */
const MAX_INLINE_SHA256_BYTES = 2 * 1024 * 1024;

export type Provenance =
  "live-api" | "api-log-rollup" | "derived" | "fixture" | "missing";

export type FraudSourceId =
  | "gslive_bet_report"
  | "gslive_wagers_by_state"
  | "f402_live_bets"
  | "f402_live_wagers"
  | "f402_weblog_rollup"
  | "gslive_weblogs"
  | "gslive_suspect_audit"
  | "f402_weblog_capture"
  | "customer_book"
  | "agent_index"
  | "ip_tracker_clusters";

/** Canonical source order; every payload prints this order so a UI matrix is stable. */
export const FRAUD_SOURCE_IDS: readonly FraudSourceId[] = [
  "gslive_bet_report",
  "gslive_wagers_by_state",
  "f402_live_bets",
  "f402_live_wagers",
  "f402_weblog_rollup",
  "gslive_weblogs",
  "gslive_suspect_audit",
  "f402_weblog_capture",
  "customer_book",
  "agent_index",
  "ip_tracker_clusters",
];

/* -------------------------------------------------------------------------- */
/* Canonical records (frozen names; the client half reads these)               */
/* -------------------------------------------------------------------------- */

export interface FraudSourceState {
  readonly id: FraudSourceId;
  readonly label: string;
  readonly path: string;
  readonly exists: boolean;
  readonly bytes: number | null;
  readonly mtimeIso: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly provenance: Provenance;
  readonly records: number | null;
  readonly sha256: string | null;
  readonly state: "ok" | "stale" | "missing" | "session_expired" | "unreadable";
  readonly note: string;
  readonly reason: string | null;
}

/** One getBetReport row, normalized. `ipMasked`/`ipTag`/`ipPrefix24` replace the raw address. */
export interface BetRecord {
  readonly betId: string;
  readonly userId: string;
  readonly agentId: string | null;
  readonly placedAtMs: number | null;
  readonly acceptedAtMs: number | null;
  readonly delaySec: number | null;
  readonly acceptSec: number | null;
  readonly stateCode: number | null;
  readonly oddsPlaced: number | null;
  readonly oddsAccepted: number | null;
  readonly oddsDrift: number | null;
  readonly stakeCents: number | null;
  readonly toWinCents: number | null;
  readonly lineHundredths: number | null;
  /**
   * API `sport`. getBetReport sends a sport id (`sID`/`displaySportId`), while F402 live tickets
   * send a sport name; this field carries whichever the source sent, verbatim.
   */
  readonly sport: string | null;
  /** API `subSport`. The 69-field getBetReport capture has no sub-sport column; F402 tickets do. */
  readonly subSport: string | null;
  /** API `period` code exactly as sent (`m`, `h1`, `s2`, …). The ordinal is `periodCode`. */
  readonly period: string | null;
  /** API `wagerType` code exactly as sent (getBetReport `type`, F402 `WagerType`: S/E/G/M/T/…). */
  readonly wagerType: string | null;
  readonly eventId: string | null;
  readonly resultCode: string | null;
  readonly ipMasked: string | null;
  readonly ipTag: string | null;
  readonly ipPrefix24: string | null;
  readonly suspectedBot: boolean;
  readonly reversedCredit: boolean;
  readonly manualLog: boolean;
  readonly adminUser: string | null;
}

/** Internal normalized row: the frozen {@link BetRecord} plus fields only detectors/model use. */
export interface FraudBetRecord extends BetRecord {
  /** IP classification from `lib/f402_weblog.ts` (`BOT_RING_140_248`, `ICLOUD_RELAY`, ...). */
  readonly ipClass: string;
  readonly botRingRange: boolean;
  readonly stakeUsd: number | null;
  readonly toWinUsd: number | null;
  readonly hourOfDayUtc: number;
  readonly dayOfWeekUtc: number;
  /** Ordinal period encoding: `sN` → N, `hN` → 20+N, `m` → 0, unknown → null. */
  readonly periodCode: number | null;
  /** Numeric settled outcome: win=1, lose=0, push=0.5, open/unknown=0. */
  readonly resultCodeNum: number;
}

export interface IpCluster {
  /** `ip:<hash8>` | `prefix24:<a.b.c>` */
  readonly key: string;
  /** Masked display form; a raw address is never emitted. */
  readonly masked: string;
  readonly prefix24: string;
  readonly accounts: number;
  readonly bets: number;
  readonly sampleAccounts: readonly string[];
  readonly sharedIp: boolean;
  readonly botRingRange: boolean;
  readonly datacenterClass: string | null;
}

export type FraudFindingSeverity =
  "critical" | "high" | "medium" | "low" | "info";

/** Frozen category vocabulary exactly as spelled in the contract (line 104). */
export type FraudFindingCategory =
  | "courtsiding"
  | "multi_accounting"
  | "line_shopping"
  | "match_integrity"
  | "agent_scheme"
  | "ticket_anomaly"
  | "ip_network"
  | "data_quality";

export interface FraudFindingEvidence {
  readonly source: string;
  readonly path: string;
  readonly pointer: string;
}

/** One named detector result, frozen in the contract. `insufficientData` must be truthful. */
export interface FraudFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: FraudFindingSeverity;
  readonly category: FraudFindingCategory;
  readonly subject: {
    readonly kind: "account" | "agent" | "book" | "source";
    readonly id: string;
  };
  readonly observed: Readonly<Record<string, number | string | boolean | null>>;
  readonly threshold: Readonly<Record<string, number | string>> | null;
  readonly evidence: readonly FraudFindingEvidence[];
  readonly provenance: readonly Provenance[];
  readonly explanation: string;
  readonly insufficientData: boolean;
}

export interface WeblogPostureFile {
  readonly path: string;
  readonly ageSeconds: number | null;
  readonly sha256: string | null;
  readonly rows: number | null;
  readonly valid: boolean;
  readonly error: string | null;
}

export interface WeblogGate {
  readonly gate: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

/** F402 WebLog rollup posture: counts only. Account attribution is unavailable from a rollup. */
export interface WeblogPosture {
  readonly kind: "f402-weblog";
  readonly sourcePath: string;
  readonly generatedAtIso: string | null;
  readonly ageSeconds: number | null;
  readonly files: readonly WeblogPostureFile[];
  readonly window: {
    readonly fromIso: string | null;
    readonly toIso: string | null;
  };
  readonly rows: {
    readonly total: number;
    readonly parsed: number;
    readonly malformed: number;
    readonly distinctTemplates: number;
  };
  readonly sessions: {
    readonly logins: number;
    readonly sessions: number;
    readonly sessionsWithWagers: number;
    readonly zeroWagerSessions: number;
  };
  readonly join: {
    readonly totalWindowWagers: number;
    readonly matched: number;
    readonly persistentUnmatched: number;
    readonly nonWebChannel: number;
    readonly futureJoins: number;
  };
  readonly flags: {
    readonly executionSnipers: number | null;
    readonly sniperTwins: number;
    readonly lineShoppers: number;
    readonly botRingAccounts: number;
    readonly crossOfficeBeards: number;
  };
  readonly ipClasses: Readonly<Record<string, number>>;
  readonly gates: readonly WeblogGate[];
  readonly notes: readonly string[];
}

/** F402 live ticket, normalized to the watchlist vocabulary. */
export interface TicketEvent {
  readonly source: "f402_live_bets" | "f402_live_wagers";
  readonly ticketId: string | null;
  readonly wagerNumber: string | null;
  readonly accountId: string;
  readonly agentId: string | null;
  readonly wagerType: string | null;
  readonly stakeCents: number | null;
  readonly toWinCents: number | null;
  readonly placedAtMs: number | null;
  readonly writer: string | null;
  readonly vip: boolean;
  readonly sport: string | null;
  readonly subSport: string | null;
  readonly period: string | null;
  readonly status: string | null;
}

export interface FraudTickets {
  readonly bets: readonly TicketEvent[];
  readonly wagers: readonly TicketEvent[];
  readonly betsCapturedAt: string | null;
  readonly wagersObservedAt: string | null;
  readonly wagersPartial: boolean | null;
  readonly betsPendingCount: number | null;
}

export interface AgentIndexEntry {
  readonly id: string;
  readonly level: number | null;
  readonly type: string | null;
  readonly parent: string | null;
  readonly sequence: number | null;
}

export interface FraudAgentIndex {
  readonly sourcePath: string;
  readonly treePath: string | null;
  readonly agentCount: number;
  readonly agents: ReadonlyMap<string, AgentIndexEntry>;
  readonly roots: readonly string[];
  readonly collisions: readonly {
    readonly key: string;
    readonly ids: readonly string[];
  }[];
}

export interface SuspectAuditSummary {
  readonly path: string;
  readonly generatedAt: string | null;
  readonly targetAccount: string | null;
  readonly targetAgent: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  /** True when `targetAccount` is the known `--help` argument-parsing defect. */
  readonly targetDefect: boolean;
  /** Never trust the audit's account numbers: the capture ran against a flag, not an account. */
  readonly trustworthyNumbers: false;
  readonly note: string;
}

export interface WeblogCaptureSummary {
  readonly path: string;
  readonly capturedAt: string | null;
  readonly status: number | null;
  readonly responseBytes: number | null;
  readonly responseRows: number | null;
  /** True when the capture proves the response body was an empty LIST (rows MISSING, not zero). */
  readonly rowsMissing: boolean;
  readonly redactionClean: boolean | null;
  readonly note: string;
}

export interface CorpusWindow {
  readonly fromEpochSec: number | null;
  readonly toEpochSec: number | null;
  readonly fromIso: string | null;
  readonly toIso: string | null;
  /** Actual min/max `logTime` observed among normalized rows. */
  readonly measuredFromIso: string | null;
  readonly measuredToIso: string | null;
}

export interface IpClusterNode {
  readonly tag: string;
  readonly masked: string;
  readonly prefix24: string;
  readonly ipClass: string;
  readonly botRingRange: boolean;
  bets: number;
  readonly accounts: Set<string>;
  readonly sampleAccounts: string[];
}

export interface FraudIpIndex {
  readonly byIp: Map<string, IpClusterNode>;
  readonly byPrefix24: Map<string, { accounts: Set<string>; bets: number }>;
  readonly byAccount: Map<string, Set<string>>;
  readonly distinctIps: number;
}

export interface FraudCorpus {
  readonly source: FraudSourceState;
  readonly path: string;
  readonly sha256: string | null;
  readonly rows: number;
  readonly malformed: number;
  readonly records: readonly FraudBetRecord[];
  readonly window: CorpusWindow;
  readonly ipIndex: FraudIpIndex;
  readonly accounts: number;
  readonly agents: number;
  readonly parseMs: number;
  readonly timerSource: "Bun.file().json" | "mock";
}

/** Everything one CLI invocation measures, loaded once (the 55 MB corpus parsed once). */
export interface FraudPerception {
  readonly root: string;
  readonly nowIso: string;
  readonly config: FraudPluginConfig;
  readonly configPath: string;
  readonly configExists: boolean;
  readonly configNote: string | null;
  readonly sources: readonly FraudSourceState[];
  readonly corpus: FraudCorpus | null;
  readonly weblogPosture: WeblogPosture | null;
  readonly weblogs: GsliveWeblogActivity;
  readonly tickets: FraudTickets;
  readonly agentIndex: FraudAgentIndex | null;
  readonly suspectAudit: SuspectAuditSummary | null;
  readonly capture: WeblogCaptureSummary | null;
  readonly customerBook: {
    readonly path: string;
    readonly exists: boolean;
    readonly customers: number | null;
  };
  readonly ipTrackerFixture: {
    readonly path: string;
    readonly exists: boolean;
  };
  readonly timing: {
    readonly loadMs: number;
    readonly corpusParseMs: number | null;
  };
}

/* -------------------------------------------------------------------------- */
/* Config (config/fraud-model.json; built-in defaults when absent)             */
/* -------------------------------------------------------------------------- */

export interface FraudCorpusConfig {
  readonly primaryRelPath: string;
  readonly fallbackRelPaths: readonly string[];
  readonly sha256SidecarRelPath: string;
  readonly expectedSha256: string | null;
  readonly staleAfterSeconds: number | null;
}

export interface FraudSourceConfig {
  readonly relPath: string | null;
  readonly relDir: string | null;
  readonly altRelPath: string | null;
  readonly fileGlob: string | null;
  readonly agentTreeRelPath: string | null;
  readonly staleAfterSeconds: number | null;
}

export interface FraudDetectorConfig {
  readonly sharedIpMinAccounts: number;
  readonly sharedIpTop: number;
  readonly accountFanoutMinIps: number;
  readonly accountFanoutHighIps: number;
  readonly botRingCidr: string;
  readonly datacenterClasses: readonly string[];
  readonly agentFlagMinBets: number;
  readonly agentFlagMinRate: number;
  readonly agentFlagTop: number;
  readonly stateMixMinWinShare: number;
  readonly delayMismatchMinElapsedSec: number;
  readonly delayMismatchMaxElapsedSec: number;
  readonly roundStakeStepCents: number;
  readonly longshotMinPayoutRatio: number;
  readonly longshotMinTickets: number;
  readonly burstWindowSeconds: number;
  readonly burstMinTickets: number;
  readonly agentConcentrationMinShare: number;
  readonly vipStakeMultiple: number;
}

export type FraudProxyLabel = "desk_flag" | "suspected_bot" | "reversed_credit";

export interface FraudModelHyperparameters {
  readonly proxy: FraudProxyLabel;
  readonly split: number;
  readonly l2: number;
  readonly epochs: number;
  readonly learningRate: number;
  readonly seed: number;
  readonly minRows: number;
  readonly minLabeledAccounts: number;
  readonly calibrationBins: number;
  readonly scoreQuantiles: number;
  readonly scoreBands: {
    readonly lowMax: number;
    readonly mediumMax: number;
    readonly highMax: number;
  };
}

export interface FraudFeatureConfig {
  readonly id: string;
  readonly label: string;
  readonly kind: "snapshot" | "history";
}

export interface FraudPluginConfig {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly corpus: FraudCorpusConfig;
  readonly sources: Readonly<Record<FraudSourceId, FraudSourceConfig>>;
  readonly detectors: FraudDetectorConfig;
  readonly model: FraudModelHyperparameters;
  readonly features: readonly FraudFeatureConfig[];
}

const EMPTY_SOURCE_CONFIG: FraudSourceConfig = {
  relPath: null,
  relDir: null,
  altRelPath: null,
  fileGlob: null,
  agentTreeRelPath: null,
  staleAfterSeconds: null,
};

export const DEFAULT_FRAUD_CONFIG: FraudPluginConfig = {
  schemaVersion: 1,
  kind: "fraud-model-config",
  corpus: {
    primaryRelPath:
      "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json",
    fallbackRelPaths: ["Scratch/betReport-all.json"],
    sha256SidecarRelPath: "Scratch/security/corpus/sha256.txt",
    expectedSha256:
      "8afe7684cec35d3fc179f226712db615fd350a350da266c642eb219af4052acb",
    staleAfterSeconds: 172_800,
  },
  sources: {
    gslive_bet_report: { ...EMPTY_SOURCE_CONFIG },
    gslive_wagers_by_state: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "Scratch/gslive-wagers-by-state.summary.json",
      staleAfterSeconds: 259_200,
    },
    f402_live_bets: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "data/live-bets.json",
      staleAfterSeconds: 900,
    },
    f402_live_wagers: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "data/live-wagers.json",
      staleAfterSeconds: 900,
    },
    f402_weblog_rollup: {
      ...EMPTY_SOURCE_CONFIG,
      relDir: "Scratch/weblog",
      fileGlob: "^rollup-\\d{4}-\\d{2}-\\d{2}\\.json$",
      staleAfterSeconds: 172_800,
    },
    gslive_weblogs: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "Scratch/gslive-weblogs/latest.json",
      altRelPath: "gslive-weblogs/latest.json",
      staleAfterSeconds: 21_600,
    },
    gslive_suspect_audit: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "reports/gslive-suspect-all-states-audit.json",
      staleAfterSeconds: 604_800,
    },
    f402_weblog_capture: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "docs/evidence/captures/2026-10-31/getWebLog.post.json",
    },
    customer_book: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "enriched_customers_full.json",
    },
    agent_index: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "data/agent-index.json",
      agentTreeRelPath: "data/agent-tree.json",
      staleAfterSeconds: 604_800,
    },
    ip_tracker_clusters: {
      ...EMPTY_SOURCE_CONFIG,
      relPath: "lib/bet_ticker_ip_tracker_bridge.ts",
    },
  },
  detectors: {
    sharedIpMinAccounts: 2,
    sharedIpTop: 10,
    accountFanoutMinIps: 3,
    accountFanoutHighIps: 10,
    botRingCidr: "140.248.0.0/16",
    datacenterClasses: ["ICLOUD_RELAY"],
    agentFlagMinBets: 20,
    agentFlagMinRate: 0.2,
    agentFlagTop: 10,
    stateMixMinWinShare: 0.01,
    delayMismatchMinElapsedSec: -1,
    delayMismatchMaxElapsedSec: 5,
    roundStakeStepCents: 10_000,
    longshotMinPayoutRatio: 3,
    longshotMinTickets: 5,
    burstWindowSeconds: 60,
    burstMinTickets: 3,
    agentConcentrationMinShare: 0.25,
    vipStakeMultiple: 5,
  },
  model: {
    proxy: "desk_flag",
    split: 0.7,
    l2: 0.01,
    epochs: 4000,
    learningRate: 0.5,
    seed: 0,
    minRows: 500,
    minLabeledAccounts: 20,
    calibrationBins: 10,
    scoreQuantiles: 1001,
    scoreBands: { lowMax: 49, mediumMax: 74, highMax: 89 },
  },
  features: [
    { id: "delay_sec", label: "Configured delay (seconds)", kind: "snapshot" },
    { id: "accept_sec", label: "Accept flag (seconds)", kind: "snapshot" },
    {
      id: "odds_drift",
      label: "Decimal odds drift (accepted - placed)",
      kind: "snapshot",
    },
    {
      id: "implied_prob",
      label: "Implied probability at placement",
      kind: "snapshot",
    },
    { id: "stake_usd", label: "Stake (USD)", kind: "snapshot" },
    { id: "to_win_usd", label: "To-win (USD)", kind: "snapshot" },
    {
      id: "line_hundredths",
      label: "Line (hundredths; capture has no line column)",
      kind: "snapshot",
    },
    {
      id: "period",
      label: "Period ordinal (sN=N, hN=20+N, m=0)",
      kind: "snapshot",
    },
    { id: "state_code", label: "Raw wager state code", kind: "snapshot" },
    { id: "hour_of_day", label: "UTC hour of day (0-23)", kind: "snapshot" },
    { id: "day_of_week", label: "UTC day of week (0=Sun)", kind: "snapshot" },
    {
      id: "result_code",
      label: "Settled outcome code (win=1, lose=0, push=0.5)",
      kind: "snapshot",
    },
    { id: "acct_prior_bets", label: "Account prior bets", kind: "history" },
    {
      id: "acct_prior_stake_mean",
      label: "Account prior mean stake (USD)",
      kind: "history",
    },
    {
      id: "acct_prior_drift_rate",
      label: "Account prior odds-drift rate",
      kind: "history",
    },
    {
      id: "acct_prior_reversal_rate",
      label: "Account prior reversed-credit rate",
      kind: "history",
    },
    {
      id: "acct_prior_bot_rate",
      label: "Account prior suspected-bot rate",
      kind: "history",
    },
    {
      id: "ip_prior_accounts",
      label: "Distinct accounts on the IP before this row",
      kind: "history",
    },
    {
      id: "ip_prior_bets",
      label: "Bets on the IP before this row",
      kind: "history",
    },
    {
      id: "ip_prefix24_accounts",
      label: "Distinct accounts on the /24 before this row",
      kind: "history",
    },
    {
      id: "acct_prior_ip_count",
      label: "Distinct IPs for the account before this row",
      kind: "history",
    },
    {
      id: "ip_bot_ring_range",
      label: "IP inside the 140.248.0.0/16 bot-ring range",
      kind: "history",
    },
    {
      id: "ip_datacenter",
      label: "IP class is a configured datacenter/relay class",
      kind: "history",
    },
    { id: "agent_prior_bets", label: "Agent prior bets", kind: "history" },
    {
      id: "agent_prior_drift_rate",
      label: "Agent prior odds-drift rate",
      kind: "history",
    },
    {
      id: "agent_prior_bot_rate",
      label: "Agent prior suspected-bot rate",
      kind: "history",
    },
  ],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function numberInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= min && parsed <= max ? parsed : fallback;
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((item): item is string => typeof item === "string");
  return list.length === value.length ? list : null;
}

function proxyLabel(value: unknown): FraudProxyLabel | null {
  return value === "desk_flag" ||
    value === "suspected_bot" ||
    value === "reversed_credit"
    ? value
    : null;
}

function mergeSourceConfig(
  defaults: FraudSourceConfig,
  raw: unknown,
): FraudSourceConfig {
  const record = asRecord(raw);
  if (record === null) return defaults;
  const stale = finiteNumber(record["staleAfterSeconds"]);
  return {
    relPath: nonEmptyText(record["relPath"]) ?? defaults.relPath,
    relDir: nonEmptyText(record["relDir"]) ?? defaults.relDir,
    altRelPath: nonEmptyText(record["altRelPath"]) ?? defaults.altRelPath,
    fileGlob: nonEmptyText(record["fileGlob"]) ?? defaults.fileGlob,
    agentTreeRelPath:
      nonEmptyText(record["agentTreeRelPath"]) ?? defaults.agentTreeRelPath,
    staleAfterSeconds:
      stale !== null && stale >= 0 ? stale : defaults.staleAfterSeconds,
  };
}

/**
 * Parse `config/fraud-model.json` over the built-in defaults. A missing or invalid config never
 * crashes a read command: it reports the defaults plus an explicit `configNote` (honest, not
 * silent). Only field types are validated; the frozen registry shape is not invented.
 */
export async function loadFraudConfig(
  root: string,
  configRelPath: string = FRAUD_CONFIG_REL_PATH,
): Promise<{
  readonly config: FraudPluginConfig;
  readonly path: string;
  readonly exists: boolean;
  readonly note: string | null;
}> {
  const path = join(root, configRelPath);
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (error) {
    const missing = !(await Bun.file(path).exists());
    return {
      config: DEFAULT_FRAUD_CONFIG,
      path,
      exists: false,
      note: missing
        ? `config not found at ${configRelPath}; built-in defaults used`
        : `config at ${configRelPath} is not valid JSON (${
            error instanceof Error ? error.message : String(error)
          }); built-in defaults used`,
    };
  }
  const record = asRecord(raw);
  if (record === null) {
    return {
      config: DEFAULT_FRAUD_CONFIG,
      path,
      exists: true,
      note: `config at ${configRelPath} is not a JSON object; built-in defaults used`,
    };
  }
  const corpus = asRecord(record["corpus"]);
  const detectors = asRecord(record["detectors"]);
  const model = asRecord(record["model"]);
  const sources = asRecord(record["sources"]);
  const featuresRaw = record["features"];
  const sourceEntries = Object.entries(DEFAULT_FRAUD_CONFIG.sources) as Array<
    [FraudSourceId, FraudSourceConfig]
  >;
  const sourcesMerged = Object.fromEntries(
    sourceEntries.map(([id, defaults]) => [
      id,
      mergeSourceConfig(defaults, sources?.[id]),
    ]),
  ) as Record<FraudSourceId, FraudSourceConfig>;
  const fallbacks = stringList(corpus?.["fallbackRelPaths"]);
  const bands = asRecord(model?.["scoreBands"]);
  const features: FraudFeatureConfig[] = [];
  if (Array.isArray(featuresRaw)) {
    for (const featureRaw of featuresRaw) {
      const feature = asRecord(featureRaw);
      if (feature === null) continue;
      const id = nonEmptyText(feature["id"]);
      const label = nonEmptyText(feature["label"]);
      const kind = feature["kind"];
      if (id === null || label === null) continue;
      if (kind !== "snapshot" && kind !== "history") continue;
      features.push({ id, label, kind });
    }
  }
  const defaultFeaturesById = new Map(
    DEFAULT_FRAUD_CONFIG.features.map((feature) => [feature.id, feature]),
  );
  const registry =
    features.length > 0
      ? features
      : DEFAULT_FRAUD_CONFIG.features.map((feature) => ({ ...feature }));
  // Keep the frozen ordering from the built-in registry when the config reorders/extends it.
  registry.sort((a, b) => {
    const indexA = DEFAULT_FRAUD_CONFIG.features.findIndex(
      (f) => f.id === a.id,
    );
    const indexB = DEFAULT_FRAUD_CONFIG.features.findIndex(
      (f) => f.id === b.id,
    );
    return (
      (indexA === -1 ? Number.MAX_SAFE_INTEGER : indexA) -
      (indexB === -1 ? Number.MAX_SAFE_INTEGER : indexB)
    );
  });
  for (const feature of registry) {
    if (!defaultFeaturesById.has(feature.id)) {
      return {
        config: DEFAULT_FRAUD_CONFIG,
        path,
        exists: true,
        note: `config at ${configRelPath} declares unknown feature "${feature.id}"; built-in defaults used`,
      };
    }
  }
  const config: FraudPluginConfig = {
    schemaVersion: 1,
    kind: nonEmptyText(record["kind"]) ?? DEFAULT_FRAUD_CONFIG.kind,
    corpus: {
      primaryRelPath:
        nonEmptyText(corpus?.["primaryRelPath"]) ??
        DEFAULT_FRAUD_CONFIG.corpus.primaryRelPath,
      fallbackRelPaths:
        fallbacks ?? DEFAULT_FRAUD_CONFIG.corpus.fallbackRelPaths,
      sha256SidecarRelPath:
        nonEmptyText(corpus?.["sha256SidecarRelPath"]) ??
        DEFAULT_FRAUD_CONFIG.corpus.sha256SidecarRelPath,
      expectedSha256:
        nonEmptyText(corpus?.["expectedSha256"]) ??
        DEFAULT_FRAUD_CONFIG.corpus.expectedSha256,
      staleAfterSeconds:
        finiteNumber(corpus?.["staleAfterSeconds"]) !== null
          ? (finiteNumber(corpus?.["staleAfterSeconds"]) as number)
          : DEFAULT_FRAUD_CONFIG.corpus.staleAfterSeconds,
    },
    sources: sourcesMerged,
    detectors: {
      sharedIpMinAccounts: positiveInt(
        detectors?.["sharedIpMinAccounts"],
        DEFAULT_FRAUD_CONFIG.detectors.sharedIpMinAccounts,
      ),
      sharedIpTop: positiveInt(
        detectors?.["sharedIpTop"],
        DEFAULT_FRAUD_CONFIG.detectors.sharedIpTop,
      ),
      accountFanoutMinIps: positiveInt(
        detectors?.["accountFanoutMinIps"],
        DEFAULT_FRAUD_CONFIG.detectors.accountFanoutMinIps,
      ),
      accountFanoutHighIps: positiveInt(
        detectors?.["accountFanoutHighIps"],
        DEFAULT_FRAUD_CONFIG.detectors.accountFanoutHighIps,
      ),
      botRingCidr:
        nonEmptyText(detectors?.["botRingCidr"]) ??
        DEFAULT_FRAUD_CONFIG.detectors.botRingCidr,
      datacenterClasses:
        stringList(detectors?.["datacenterClasses"]) ??
        DEFAULT_FRAUD_CONFIG.detectors.datacenterClasses,
      agentFlagMinBets: positiveInt(
        detectors?.["agentFlagMinBets"],
        DEFAULT_FRAUD_CONFIG.detectors.agentFlagMinBets,
      ),
      agentFlagMinRate: numberInRange(
        detectors?.["agentFlagMinRate"],
        DEFAULT_FRAUD_CONFIG.detectors.agentFlagMinRate,
        0,
        1,
      ),
      agentFlagTop: positiveInt(
        detectors?.["agentFlagTop"],
        DEFAULT_FRAUD_CONFIG.detectors.agentFlagTop,
      ),
      stateMixMinWinShare: numberInRange(
        detectors?.["stateMixMinWinShare"],
        DEFAULT_FRAUD_CONFIG.detectors.stateMixMinWinShare,
        0,
        1,
      ),
      delayMismatchMinElapsedSec:
        finiteNumber(detectors?.["delayMismatchMinElapsedSec"]) ??
        DEFAULT_FRAUD_CONFIG.detectors.delayMismatchMinElapsedSec,
      delayMismatchMaxElapsedSec:
        finiteNumber(detectors?.["delayMismatchMaxElapsedSec"]) ??
        DEFAULT_FRAUD_CONFIG.detectors.delayMismatchMaxElapsedSec,
      roundStakeStepCents: positiveInt(
        detectors?.["roundStakeStepCents"],
        DEFAULT_FRAUD_CONFIG.detectors.roundStakeStepCents,
      ),
      longshotMinPayoutRatio: numberInRange(
        detectors?.["longshotMinPayoutRatio"],
        DEFAULT_FRAUD_CONFIG.detectors.longshotMinPayoutRatio,
        1,
        1000,
      ),
      longshotMinTickets: positiveInt(
        detectors?.["longshotMinTickets"],
        DEFAULT_FRAUD_CONFIG.detectors.longshotMinTickets,
      ),
      burstWindowSeconds: positiveInt(
        detectors?.["burstWindowSeconds"],
        DEFAULT_FRAUD_CONFIG.detectors.burstWindowSeconds,
      ),
      burstMinTickets: positiveInt(
        detectors?.["burstMinTickets"],
        DEFAULT_FRAUD_CONFIG.detectors.burstMinTickets,
      ),
      agentConcentrationMinShare: numberInRange(
        detectors?.["agentConcentrationMinShare"],
        DEFAULT_FRAUD_CONFIG.detectors.agentConcentrationMinShare,
        0,
        1,
      ),
      vipStakeMultiple: numberInRange(
        detectors?.["vipStakeMultiple"],
        DEFAULT_FRAUD_CONFIG.detectors.vipStakeMultiple,
        1,
        1000,
      ),
    },
    model: {
      proxy: proxyLabel(model?.["proxy"]) ?? DEFAULT_FRAUD_CONFIG.model.proxy,
      split: numberInRange(
        model?.["split"],
        DEFAULT_FRAUD_CONFIG.model.split,
        0.5,
        0.9,
      ),
      l2: numberInRange(model?.["l2"], DEFAULT_FRAUD_CONFIG.model.l2, 0, 1),
      epochs: positiveInt(model?.["epochs"], DEFAULT_FRAUD_CONFIG.model.epochs),
      learningRate: numberInRange(
        model?.["learningRate"],
        DEFAULT_FRAUD_CONFIG.model.learningRate,
        1e-6,
        10,
      ),
      seed: Math.trunc(
        finiteNumber(model?.["seed"]) ?? DEFAULT_FRAUD_CONFIG.model.seed,
      ),
      minRows: positiveInt(
        model?.["minRows"],
        DEFAULT_FRAUD_CONFIG.model.minRows,
      ),
      minLabeledAccounts: positiveInt(
        model?.["minLabeledAccounts"],
        DEFAULT_FRAUD_CONFIG.model.minLabeledAccounts,
      ),
      calibrationBins: positiveInt(
        model?.["calibrationBins"],
        DEFAULT_FRAUD_CONFIG.model.calibrationBins,
      ),
      scoreQuantiles: positiveInt(
        model?.["scoreQuantiles"],
        DEFAULT_FRAUD_CONFIG.model.scoreQuantiles,
      ),
      scoreBands: {
        lowMax: numberInRange(
          bands?.["lowMax"],
          DEFAULT_FRAUD_CONFIG.model.scoreBands.lowMax,
          0,
          100,
        ),
        mediumMax: numberInRange(
          bands?.["mediumMax"],
          DEFAULT_FRAUD_CONFIG.model.scoreBands.mediumMax,
          0,
          100,
        ),
        highMax: numberInRange(
          bands?.["highMax"],
          DEFAULT_FRAUD_CONFIG.model.scoreBands.highMax,
          0,
          100,
        ),
      },
    },
    features: registry,
  };
  return { config, path, exists: true, note: null };
}

/* -------------------------------------------------------------------------- */
/* IP masking / classification                                                 */
/* -------------------------------------------------------------------------- */

function validIpv4Parts(ip: string): readonly number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    numbers.push(value);
  }
  return numbers;
}

/** `47.223.36.100` → `47.223.***.***`; IPv6 keeps its first two groups and masks the rest. */
export function maskIp(rawIp: string): string | null {
  const ip = rawIp.trim();
  if (ip === "") return null;
  const v4 = validIpv4Parts(ip);
  if (v4 !== null) {
    return `${v4[0]}.${v4[1]}.***.***`;
  }
  if (!ip.includes(":")) return null;
  const groups = ip
    .replace(/^\[|\]$/g, "")
    .split(":")
    .filter((g) => g !== "");
  if (groups.length < 2) return "***";
  return `${groups[0]}:${groups[1]}:***:***`;
}

/** Stable 8-hex sha256 tag for an address (the only persisted IP key). */
export function ipTagOf(rawIp: string): string | null {
  const ip = rawIp.trim();
  if (ip === "") return null;
  return sha256Hex(ip).slice(0, 8);
}

/** `/24` key for IPv4 (`47.223.36`) or a `v6:<first 4 groups>` prefix key for IPv6. */
export function ipPrefixKeyOf(rawIp: string): string | null {
  const ip = rawIp.trim();
  if (ip === "") return null;
  const v4 = validIpv4Parts(ip);
  if (v4 !== null) return `${v4[0]}.${v4[1]}.${v4[2]}`;
  const groups = ip
    .replace(/^\[|\]$/g, "")
    .split(":")
    .filter((group) => group !== "");
  return groups.length >= 2 ? `v6:${groups.slice(0, 4).join(":")}` : null;
}

export function isBotRingIp(rawIp: string): boolean {
  return classifyIp(rawIp.trim()) === "BOT_RING_140_248";
}

/** Datacenter/relay class for one address (classification rules live in lib/f402_weblog.ts). */
export function ipClassOf(rawIp: string): string {
  const ip = rawIp.trim();
  if (ip === "") return "UNKNOWN";
  return classifyIp(ip);
}

/** Period ordinal encoding used by the model feature `period`. */
export function encodePeriodCode(period: string | null): number | null {
  if (period === null) return null;
  const text = period.trim().toLowerCase();
  if (text === "m" || text === "") return 0;
  const match = /^([sh])(\d{1,2})$/.exec(text);
  if (match === null) return null;
  const index = Number(match[2]);
  if (!Number.isInteger(index)) return null;
  return match[1] === "s" ? index : 20 + index;
}

/* -------------------------------------------------------------------------- */
/* Money / odds helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Dollar amount (number or numeric string) → integer cents; null when absent/unparseable. */
export function dollarsToCents(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed * 100);
}

/** Decimal odds (e.g. "2.86") → implied probability; null when absent/non-positive. */
export function impliedProbability(decimalOdds: number | null): number | null {
  if (decimalOdds === null || !Number.isFinite(decimalOdds)) return null;
  if (decimalOdds <= 1) return null;
  return 1 / decimalOdds;
}

/* -------------------------------------------------------------------------- */
/* Source-state helpers                                                        */
/* -------------------------------------------------------------------------- */

const SOURCE_LABELS: Readonly<Record<FraudSourceId, string>> = {
  gslive_bet_report: "GSLive bet-report corpus (with IPs)",
  gslive_wagers_by_state: "Wagers-by-state summary (no IP)",
  f402_live_bets: "F402 live Pending tickets",
  f402_live_wagers: "F402 live ticker rows",
  f402_weblog_rollup: "F402 WebLog rollup",
  gslive_weblogs: "GSLive WebLog activity",
  gslive_suspect_audit: "Suspect audit (defective target)",
  f402_weblog_capture: "getWebLog capture (shape sample)",
  customer_book: "Customer book (generated fixture)",
  agent_index: "Agent index (derived)",
  ip_tracker_clusters: "IP tracker clusters (fixture)",
};

const SOURCE_PROVENANCE: Readonly<Record<FraudSourceId, Provenance>> = {
  gslive_bet_report: "live-api",
  gslive_wagers_by_state: "derived",
  f402_live_bets: "live-api",
  f402_live_wagers: "live-api",
  f402_weblog_rollup: "api-log-rollup",
  gslive_weblogs: "api-log-rollup",
  gslive_suspect_audit: "derived",
  f402_weblog_capture: "fixture",
  customer_book: "fixture",
  agent_index: "derived",
  ip_tracker_clusters: "fixture",
};

interface StateInput {
  readonly id: FraudSourceId;
  readonly root: string;
  readonly absolutePath: string;
  readonly now: Date;
  readonly mtime: Date | null;
  readonly bytes: number | null;
  readonly provenance: Provenance;
  readonly ageSeconds: number | null;
  readonly staleAfterSeconds: number | null;
  readonly records: number | null;
  readonly sha256: string | null;
  readonly note: string;
  readonly reason: string | null;
  readonly state: FraudSourceState["state"];
}

function buildSourceState(input: StateInput): FraudSourceState {
  const exists = input.mtime !== null;
  const ageSeconds = input.ageSeconds;
  const stale =
    exists && ageSeconds !== null && input.staleAfterSeconds !== null
      ? ageSeconds > input.staleAfterSeconds
      : false;
  const derivedState: FraudSourceState["state"] =
    input.state === "ok" && stale ? "stale" : input.state;
  return {
    id: input.id,
    label: SOURCE_LABELS[input.id],
    path: input.absolutePath.startsWith(`${input.root}/`)
      ? input.absolutePath.slice(input.root.length + 1)
      : input.absolutePath,
    exists,
    bytes: input.bytes,
    mtimeIso: input.mtime === null ? null : input.mtime.toISOString(),
    ageSeconds,
    stale,
    provenance: exists ? input.provenance : "missing",
    records: exists ? input.records : null,
    sha256: input.sha256,
    state: derivedState,
    note: input.note,
    reason: input.reason,
  };
}

function missingSource(
  id: FraudSourceId,
  root: string,
  absolutePath: string,
  reason: string,
  note: string,
  provenance: Provenance = SOURCE_PROVENANCE[id],
): FraudSourceState {
  return buildSourceState({
    id,
    root,
    absolutePath,
    now: new Date(0),
    mtime: null,
    bytes: null,
    provenance,
    ageSeconds: null,
    staleAfterSeconds: null,
    records: null,
    sha256: null,
    note,
    reason,
    state: "missing",
  });
}

async function statFile(
  path: string,
): Promise<{ mtime: Date; bytes: number } | null> {
  try {
    const info = await stat(path);
    return { mtime: info.mtime, bytes: info.size };
  } catch {
    return null;
  }
}

async function hashFile(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.size > maxBytes) return null;
    return sha256Hex(await Bun.file(path).text());
  } catch {
    return null;
  }
}

/** Read the sha256 sidecar (`<hash>  <path>` lines) and pick the entry for this file. */
async function readSha256Sidecar(
  root: string,
  sidecarRelPath: string,
  targetRelPath: string,
): Promise<{ hash: string; namesTarget: boolean } | null> {
  try {
    const text = await Bun.file(join(root, sidecarRelPath)).text();
    const entries = text
      .split(/\r?\n/)
      .map((line) => /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        hash: (match[1] as string).toLowerCase(),
        path: (match[2] as string).trim(),
      }));
    if (entries.length === 0) return null;
    const exact = entries.find(
      (entry) =>
        entry.path === targetRelPath ||
        entry.path.endsWith(`/${targetRelPath.split("/").at(-1) ?? ""}`),
    );
    const chosen = exact ?? entries[0];
    return chosen === undefined
      ? null
      : {
          hash: chosen.hash,
          namesTarget: chosen.path === targetRelPath,
        };
  } catch {
    return null;
  }
}

function ageSecondsOf(now: Date, then: Date | null): number | null {
  if (then === null) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
}

/* -------------------------------------------------------------------------- */
/* Corpus discovery + parse                                                    */
/* -------------------------------------------------------------------------- */

async function discoverCorpus(
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<{
  readonly source: FraudSourceState;
  readonly path: string;
  readonly sha256: string | null;
}> {
  const candidates = [
    config.corpus.primaryRelPath,
    ...config.corpus.fallbackRelPaths,
  ];
  let chosen: string | null = null;
  let info: { mtime: Date; bytes: number } | null = null;
  for (const candidate of candidates) {
    const candidateInfo = await statFile(join(root, candidate));
    if (candidateInfo !== null) {
      chosen = candidate;
      info = candidateInfo;
      break;
    }
  }
  if (chosen === null || info === null) {
    const source = missingSource(
      "gslive_bet_report",
      root,
      join(root, config.corpus.primaryRelPath),
      `corpus missing: looked for ${candidates.join(", ")}`,
      "No GSLive getBetReport capture found. MISSING, not zero rows. The corpus is an ephemeral Scratch export; restore it from the backup before running corpus commands.",
    );
    return {
      source,
      path: join(root, config.corpus.primaryRelPath),
      sha256: null,
    };
  }
  const absolutePath = join(root, chosen);
  let sha256: string | null = null;
  let hashNote = "sha256 computed from the file";
  if (chosen === config.corpus.primaryRelPath) {
    const sidecar = await readSha256Sidecar(
      root,
      config.corpus.sha256SidecarRelPath,
      config.corpus.primaryRelPath,
    );
    if (sidecar !== null) {
      sha256 = sidecar.hash;
      hashNote = "sha256 read from sidecar; not recomputed";
    }
  }
  if (sha256 === null)
    sha256 = await hashFile(absolutePath, MAX_INLINE_SHA256_BYTES);
  const ageSeconds = ageSecondsOf(now, info.mtime);
  const staleAfter = config.corpus.staleAfterSeconds;
  const expectedMatches =
    config.corpus.expectedSha256 === null || sha256 === null
      ? null
      : config.corpus.expectedSha256 === sha256;
  const notes = [
    `GSLive getBetReport snapshot (${info.bytes} B); ephemeral untracked Scratch export, not longitudinal`,
    hashNote,
    ...(expectedMatches === null
      ? []
      : [
          expectedMatches
            ? "matches contract sha256"
            : `sha256 MISMATCH: expected ${config.corpus.expectedSha256 ?? ""}, got ${sha256 ?? "unknown"}`,
        ]),
  ];
  const source = buildSourceState({
    id: "gslive_bet_report",
    root,
    absolutePath,
    now,
    mtime: info.mtime,
    bytes: info.bytes,
    provenance: "live-api",
    ageSeconds,
    staleAfterSeconds: staleAfter,
    records: null,
    sha256,
    note: notes.join("; "),
    reason: null,
    state: "ok",
  });
  return { source, path: absolutePath, sha256 };
}

async function parseCorpusDocument(
  path: string,
): Promise<Record<string, unknown>> {
  const parsed: unknown = await Bun.file(path).json();
  const document = asRecord(parsed);
  if (document === null) throw new Error("corpus root is not a JSON object");
  const payload = asRecord(document["r"]);
  if (payload === null || !Array.isArray(payload["bets"])) {
    throw new Error('corpus does not carry an "r.bets" array');
  }
  return document;
}

interface NormalizeAccumulator {
  readonly records: FraudBetRecord[];
  readonly byIp: Map<string, IpClusterNode>;
  readonly byPrefix24: Map<string, { accounts: Set<string>; bets: number }>;
  readonly byAccount: Map<string, Set<string>>;
  readonly accounts: Set<string>;
  readonly agents: Set<string>;
  malformed: number;
}

function recordIp(
  accumulator: NormalizeAccumulator,
  rawIp: string,
  accountId: string,
): {
  masked: string | null;
  tag: string | null;
  prefix24: string | null;
  ipClass: string;
  botRingRange: boolean;
} {
  const masked = maskIp(rawIp);
  const tag = ipTagOf(rawIp);
  const prefix24 = ipPrefixKeyOf(rawIp);
  const ipClass = ipClassOf(rawIp);
  if (masked === null || tag === null) {
    return {
      masked: null,
      tag: null,
      prefix24: null,
      ipClass,
      botRingRange: false,
    };
  }
  let node = accumulator.byIp.get(tag);
  if (node === undefined) {
    node = {
      tag,
      masked,
      prefix24: prefix24 ?? "",
      ipClass,
      botRingRange: ipClass === "BOT_RING_140_248",
      bets: 0,
      accounts: new Set<string>(),
      sampleAccounts: [],
    };
    accumulator.byIp.set(tag, node);
  }
  node.bets += 1;
  if (!node.accounts.has(accountId)) {
    node.accounts.add(accountId);
    if (node.sampleAccounts.length < 5) node.sampleAccounts.push(accountId);
  }
  if (prefix24 !== null) {
    let prefixNode = accumulator.byPrefix24.get(prefix24);
    if (prefixNode === undefined) {
      prefixNode = { accounts: new Set<string>(), bets: 0 };
      accumulator.byPrefix24.set(prefix24, prefixNode);
    }
    prefixNode.accounts.add(accountId);
    prefixNode.bets += 1;
  }
  let accountIps = accumulator.byAccount.get(accountId);
  if (accountIps === undefined) {
    accountIps = new Set<string>();
    accumulator.byAccount.set(accountId, accountIps);
  }
  accountIps.add(tag);
  return {
    masked,
    tag,
    prefix24,
    ipClass,
    botRingRange: ipClass === "BOT_RING_140_248",
  };
}

function normalizeBetRow(
  row: Record<string, unknown>,
  accumulator: NormalizeAccumulator,
): FraudBetRecord | null {
  const betId = nonEmptyText(row["id"]);
  const userId = nonEmptyText(row["userID"]);
  if (betId === null || userId === null) {
    accumulator.malformed += 1;
    return null;
  }
  const rawIp = typeof row["ipAddress"] === "string" ? row["ipAddress"] : "";
  const ip = recordIp(accumulator, rawIp, userId);
  const placedAtMs = parseGsliveTimestampMs(row["logTime"]);
  const acceptedAtMs = parseGsliveTimestampMs(
    row["acceptTime"],
    placedAtMs ?? undefined,
  );
  const delaySec = finiteNumber(row["delay"]);
  const acceptSec = finiteNumber(row["accept"]);
  const stateRaw = finiteNumber(row["state"]);
  const stateCode = stateRaw === null ? null : Math.trunc(stateRaw);
  const oddsPlaced = finiteNumber(row["fVal"]);
  const oddsAccepted = finiteNumber(row["fVal_new"]);
  const oddsDrift =
    oddsPlaced !== null && oddsAccepted !== null
      ? oddsAccepted - oddsPlaced
      : null;
  const stakeCents = dollarsToCents(row["bet"]);
  const toWinCents = dollarsToCents(row["betGroupToWin"]);
  const resultRaw = row["result"];
  const resultCode =
    typeof resultRaw === "string" && resultRaw.trim() !== ""
      ? resultRaw.trim()
      : null;
  const placedDate = placedAtMs === null ? null : new Date(placedAtMs);
  const period = nonEmptyText(row["period"]);
  const resultCodeNum =
    stateCode === 1 ? 1 : stateCode === 2 ? 0 : stateCode === 3 ? 0.5 : 0;
  accumulator.accounts.add(userId);
  const agentId = nonEmptyText(row["agent"]);
  if (agentId !== null) accumulator.agents.add(agentId);
  return {
    betId,
    userId,
    agentId,
    placedAtMs,
    acceptedAtMs,
    delaySec,
    acceptSec,
    stateCode,
    oddsPlaced,
    oddsAccepted,
    oddsDrift,
    stakeCents,
    toWinCents,
    // The 69-field capture has no `line` column; the frozen feature is constant 0.
    lineHundredths: 0,
    sport: nonEmptyText(row["displaySportId"]) ?? nonEmptyText(row["sID"]),
    subSport: null,
    period,
    wagerType: nonEmptyText(row["type"]),
    eventId: nonEmptyText(row["eID"]),
    resultCode,
    ipMasked: ip.masked,
    ipTag: ip.tag,
    ipPrefix24: ip.prefix24,
    suspectedBot: String(row["isSuspectedBot"] ?? "0") !== "0",
    reversedCredit:
      row["reversedCredit"] !== null && row["reversedCredit"] !== undefined,
    manualLog: String(row["manualLogExists"] ?? "0") !== "0",
    adminUser: nonEmptyText(row["adminUser"]),
    ipClass: ip.ipClass,
    botRingRange: ip.botRingRange,
    stakeUsd: stakeCents === null ? null : stakeCents / 100,
    toWinUsd: toWinCents === null ? null : toWinCents / 100,
    hourOfDayUtc: placedDate === null ? 0 : placedDate.getUTCHours(),
    dayOfWeekUtc: placedDate === null ? 0 : placedDate.getUTCDay(),
    periodCode: encodePeriodCode(period),
    resultCodeNum,
  };
}

function compareRecords(a: FraudBetRecord, b: FraudBetRecord): number {
  const aTime = a.placedAtMs ?? Number.POSITIVE_INFINITY;
  const bTime = b.placedAtMs ?? Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return a.betId < b.betId ? -1 : a.betId > b.betId ? 1 : 0;
}

/**
 * Parse the 55 MB `r.bets` document ONCE and normalize every row. IPs are masked here, at the
 * boundary, so no downstream consumer can print a raw address.
 */
export async function parseFraudCorpus(path: string): Promise<{
  rows: number;
  malformed: number;
  records: readonly FraudBetRecord[];
  byIp: Map<string, IpClusterNode>;
  byPrefix24: Map<string, { accounts: Set<string>; bets: number }>;
  byAccount: Map<string, Set<string>>;
  accounts: number;
  agents: number;
  window: CorpusWindow;
  parseMs: number;
}> {
  const startedAt = performance.now();
  const document = await parseCorpusDocument(path);
  const bets = (asRecord(document["r"])?.["bets"] ?? []) as unknown[];
  const accumulator: NormalizeAccumulator = {
    records: [],
    byIp: new Map(),
    byPrefix24: new Map(),
    byAccount: new Map(),
    accounts: new Set(),
    agents: new Set(),
    malformed: 0,
  };
  for (const raw of bets) {
    const row = asRecord(raw);
    if (row === null) {
      accumulator.malformed += 1;
      continue;
    }
    const record = normalizeBetRow(row, accumulator);
    if (record !== null) accumulator.records.push(record);
  }
  accumulator.records.sort(compareRecords);
  const parseMs = performance.now() - startedAt;
  const fromEpochSec = finiteNumber(document["from"]);
  const toEpochSec = finiteNumber(document["to"]);
  let measuredFrom: number | null = null;
  let measuredTo: number | null = null;
  for (const record of accumulator.records) {
    if (record.placedAtMs === null) continue;
    measuredFrom =
      measuredFrom === null
        ? record.placedAtMs
        : Math.min(measuredFrom, record.placedAtMs);
    measuredTo =
      measuredTo === null
        ? record.placedAtMs
        : Math.max(measuredTo, record.placedAtMs);
  }
  const iso = (epochSec: number | null): string | null =>
    epochSec === null ? null : new Date(epochSec * 1000).toISOString();
  return {
    rows: bets.length,
    malformed: accumulator.malformed,
    records: accumulator.records,
    byIp: accumulator.byIp,
    byPrefix24: accumulator.byPrefix24,
    byAccount: accumulator.byAccount,
    accounts: accumulator.accounts.size,
    agents: accumulator.agents.size,
    window: {
      fromEpochSec,
      toEpochSec,
      fromIso: fromEpochSec === null ? null : iso(fromEpochSec),
      toIso: toEpochSec === null ? null : iso(toEpochSec),
      measuredFromIso: measuredFrom === null ? null : iso(measuredFrom / 1000),
      measuredToIso: measuredTo === null ? null : iso(measuredTo / 1000),
    },
    parseMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Ticket normalization                                                        */
/* -------------------------------------------------------------------------- */

function ticketTimestamp(value: unknown): number | null {
  const text = nonEmptyText(value);
  if (text === null) return null;
  const parsed = parseAccessMs(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLiveBets(raw: unknown): {
  tickets: TicketEvent[];
  capturedAt: string | null;
  pendingCount: number | null;
} {
  const record = asRecord(raw);
  if (record === null) {
    return { tickets: [], capturedAt: null, pendingCount: null };
  }
  const games = Array.isArray(record["games"]) ? record["games"] : [];
  const tickets: TicketEvent[] = [];
  for (const gameRaw of games) {
    const game = asRecord(gameRaw);
    if (game === null) continue;
    const accountId =
      nonEmptyText(game["customerID"]) ?? nonEmptyText(game["login"]);
    if (accountId === null) continue;
    const agent = asRecord(game["agent"]);
    tickets.push({
      source: "f402_live_bets",
      ticketId: nonEmptyText(game["ticketNumber"]),
      wagerNumber: nonEmptyText(game["wagerNumber"]),
      accountId,
      agentId:
        nonEmptyText(agent?.["id"]) ??
        nonEmptyText(agent?.["key"]) ??
        nonEmptyText(game["agentId"]),
      wagerType: nonEmptyText(game["wagerType"]),
      stakeCents: finiteNumber(game["wagered"]),
      toWinCents: finiteNumber(game["toWin"]),
      placedAtMs:
        ticketTimestamp(game["gameDateTime"]) ??
        ticketTimestamp(game["acceptedAt"]),
      writer: null,
      vip: false,
      sport: nonEmptyText(game["sport"]),
      subSport: nonEmptyText(game["subSport"]),
      period: nonEmptyText(game["period"]),
      status: nonEmptyText(game["status"]),
    });
  }
  return {
    tickets,
    capturedAt: nonEmptyText(record["capturedAt"]),
    pendingCount: finiteNumber(record["pendingCount"]),
  };
}

function normalizeLiveWagers(raw: unknown): {
  tickets: TicketEvent[];
  observedAt: string | null;
  partial: boolean | null;
} {
  const record = asRecord(raw);
  if (record === null) {
    return { tickets: [], observedAt: null, partial: null };
  }
  const rows = Array.isArray(record["LIST"]) ? record["LIST"] : [];
  const tickets: TicketEvent[] = [];
  for (const rowRaw of rows) {
    const row = asRecord(rowRaw);
    if (row === null) continue;
    const accountId =
      nonEmptyText(row["Login"]) ??
      nonEmptyText(row["CustomerID"]) ??
      nonEmptyText(row["CustomerId"]);
    if (accountId === null) continue;
    const vipRaw = nonEmptyText(row["VIP"]);
    tickets.push({
      source: "f402_live_wagers",
      ticketId: finiteNumber(row["WagerNumber"])?.toString() ?? null,
      wagerNumber: finiteNumber(row["WagerNumber"])?.toString() ?? null,
      accountId,
      agentId: nonEmptyText(row["AgentID"]) ?? nonEmptyText(row["AgentLogin"]),
      wagerType: nonEmptyText(row["WagerType"]),
      stakeCents: finiteNumber(row["AmountWagered"]),
      toWinCents: finiteNumber(row["ToWinAmount"]),
      placedAtMs: ticketTimestamp(row["InsertDateTime"]),
      writer: nonEmptyText(row["TicketWriter"]),
      vip: vipRaw !== null && vipRaw !== "0",
      sport: null,
      subSport: nonEmptyText(row["SubSport"]) ?? nonEmptyText(row["subSport"]),
      period: nonEmptyText(row["Period"]) ?? nonEmptyText(row["period"]),
      status: null,
    });
  }
  return {
    tickets,
    observedAt: nonEmptyText(record["observedAt"]),
    partial: typeof record["partial"] === "boolean" ? record["partial"] : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Light artifact loaders                                                      */
/* -------------------------------------------------------------------------- */

function textAt(value: unknown): string | null {
  return nonEmptyText(value);
}

async function loadWeblogPosture(
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<{
  posture: WeblogPosture | null;
  state: FraudSourceState;
}> {
  const sourceConfig = config.sources.f402_weblog_rollup;
  const relDir = sourceConfig.relDir ?? "Scratch/weblog";
  const globSource = sourceConfig.fileGlob ?? ".*";
  const dirPath = join(root, relDir);
  let names: string[];
  try {
    names = await readdir(dirPath);
  } catch {
    const state = missingSource(
      "f402_weblog_rollup",
      root,
      dirPath,
      `rollup directory missing: ${relDir}`,
      "The zero-PII WebLog rollups are absent. The raw corpus behind them is MISSING too; these counts cannot be re-derived locally.",
    );
    return { posture: null, state };
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(globSource);
  } catch {
    pattern = /rollup-\d{4}-\d{2}-\d{2}\.json$/;
  }
  const candidates = names.filter((name) => pattern.test(name)).sort();
  if (candidates.length === 0) {
    const state = missingSource(
      "f402_weblog_rollup",
      root,
      join(dirPath, candidates[0] ?? "rollup-*.json"),
      `no rollup files matching ${globSource} in ${relDir}`,
      "No F402 WebLog rollup artifacts were found; account attribution and counts are unavailable.",
    );
    return { posture: null, state };
  }
  candidates.reverse();
  const files: WeblogPostureFile[] = [];
  const parsedFiles: Array<{
    readonly name: string;
    readonly raw: Record<string, unknown>;
    readonly mtime: Date | null;
    readonly bytes: number;
  }> = [];
  for (const name of candidates) {
    const absolute = join(dirPath, name);
    const info = await statFile(absolute);
    const sha256 = await hashFile(absolute, MAX_INLINE_SHA256_BYTES);
    let raw: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      raw = asRecord(await Bun.file(absolute).json());
      if (raw === null) error = "not a JSON object";
    } catch {
      error = "not valid JSON";
    }
    const valid =
      raw !== null &&
      error === null &&
      raw["schemaVersion"] === 1 &&
      raw["kind"] === "f402-weblog";
    if (raw !== null && error === null && !valid) {
      error =
        "unsupported schemaVersion/kind (expected schemaVersion 1, kind f402-weblog)";
    }
    const rowsRecord = asRecord(raw?.["rows"]);
    files.push({
      path: `${relDir}/${name}`,
      ageSeconds: info === null ? null : ageSecondsOf(now, info.mtime),
      sha256,
      rows: finiteNumber(rowsRecord?.["parsed"]),
      valid,
      error,
    });
    if (valid && raw !== null) {
      parsedFiles.push({
        name,
        raw,
        mtime: info?.mtime ?? null,
        bytes: info?.bytes ?? 0,
      });
    }
  }
  const latestEntry = parsedFiles[0] ?? null;
  const latestName = latestEntry?.name ?? candidates[0] ?? "";
  const latestBytes = latestEntry?.bytes ?? 0;
  const latestMtime = latestEntry?.mtime ?? null;
  const posture =
    latestEntry === null
      ? null
      : buildWeblogPosture(
          latestEntry.raw,
          `${relDir}/${latestEntry.name}`,
          now,
          latestEntry.mtime,
          files,
        );
  const latestFile = files.find((file) => file.valid);
  const latestInfo = await statFile(join(dirPath, latestName));
  const latestAge = ageSecondsOf(now, latestMtime);
  const staleAfter = sourceConfig.staleAfterSeconds;
  const stale =
    staleAfter !== null && latestAge !== null && latestAge > staleAfter;
  const state = buildSourceState({
    id: "f402_weblog_rollup",
    root,
    absolutePath: join(dirPath, latestName),
    now,
    mtime: latestInfo?.mtime ?? latestMtime,
    bytes: latestInfo?.bytes ?? latestBytes,
    provenance: "api-log-rollup",
    ageSeconds: latestAge,
    staleAfterSeconds: staleAfter,
    records: posture === null ? null : posture.rows.parsed,
    sha256: latestFile?.sha256 ?? null,
    note: [
      `${candidates.length} rollup file(s); latest ${latestName}`,
      "counts-only aggregate; raw corpus MISSING; no account attribution",
    ].join("; "),
    reason: null,
    state: stale ? "stale" : "ok",
  });
  return { posture, state };
}

function buildWeblogPosture(
  raw: Record<string, unknown>,
  sourcePath: string,
  now: Date,
  mtime: Date | null,
  earlierFiles: readonly WeblogPostureFile[],
): WeblogPosture {
  const rowsRecord = asRecord(raw["rows"]) ?? {};
  const sessions = asRecord(raw["sessions"]) ?? {};
  const joinRecord = asRecord(raw["join"]) ?? {};
  const flags = asRecord(raw["flags"]) ?? {};
  const windowRecord = asRecord(raw["window"]) ?? {};
  const gates: WeblogGate[] = [];
  if (Array.isArray(raw["gates"])) {
    for (const gateRaw of raw["gates"]) {
      const gate = asRecord(gateRaw);
      const name = nonEmptyText(gate?.["gate"]);
      const status = gate?.["status"];
      const detail = typeof gate?.["detail"] === "string" ? gate["detail"] : "";
      if (name === null || (status !== "pass" && status !== "fail")) continue;
      gates.push({ gate: name, status, detail });
    }
  }
  const ipClasses: Record<string, number> = {};
  const ipClassesRaw = asRecord(raw["ipClasses"]) ?? {};
  for (const [key, value] of Object.entries(ipClassesRaw)) {
    const parsed = finiteNumber(value);
    if (parsed !== null) ipClasses[key] = parsed;
  }
  const fromMs = finiteNumber(windowRecord["fromMs"]);
  const toMs = finiteNumber(windowRecord["toMs"]);
  const iso = (ms: number | null): string | null =>
    ms === null ? null : new Date(ms).toISOString();
  const executionSnipers = finiteNumber(flags["executionSnipers"]);
  const validFiles = earlierFiles.filter((file) => file.valid).length;
  const earlierFilesCount = Math.max(0, validFiles - 1);
  const notes: string[] = [];
  if (earlierFilesCount > 0) {
    notes.push(
      `${earlierFilesCount} earlier rollup file(s) are also present; this posture uses the newest valid file (${sourcePath})`,
    );
  }
  if (executionSnipers === null) {
    notes.push(
      "this rollup predates the executionSnipers field; SNIPER detectors derived from it report insufficientData",
    );
  }
  return {
    kind: "f402-weblog",
    sourcePath,
    generatedAtIso: mtime === null ? null : mtime.toISOString(),
    ageSeconds: ageSecondsOf(now, mtime),
    files: [...earlierFiles],
    window: { fromIso: iso(fromMs), toIso: iso(toMs) },
    rows: {
      total: finiteNumber(rowsRecord["total"]) ?? 0,
      parsed: finiteNumber(rowsRecord["parsed"]) ?? 0,
      malformed: finiteNumber(rowsRecord["malformed"]) ?? 0,
      distinctTemplates: finiteNumber(rowsRecord["distinctTemplates"]) ?? 0,
    },
    sessions: {
      logins: finiteNumber(sessions["logins"]) ?? 0,
      sessions: finiteNumber(sessions["sessions"]) ?? 0,
      sessionsWithWagers: finiteNumber(sessions["sessionsWithWagers"]) ?? 0,
      zeroWagerSessions: finiteNumber(sessions["zeroWagerSessions"]) ?? 0,
    },
    join: {
      totalWindowWagers: finiteNumber(joinRecord["totalWindowWagers"]) ?? 0,
      matched: finiteNumber(joinRecord["matched"]) ?? 0,
      persistentUnmatched: finiteNumber(joinRecord["persistentUnmatched"]) ?? 0,
      nonWebChannel: finiteNumber(joinRecord["nonWebChannel"]) ?? 0,
      futureJoins: finiteNumber(joinRecord["futureJoins"]) ?? 0,
    },
    flags: {
      executionSnipers,
      sniperTwins: finiteNumber(flags["sniperTwins"]) ?? 0,
      lineShoppers: finiteNumber(flags["lineShoppers"]) ?? 0,
      botRingAccounts: finiteNumber(flags["botRingAccounts"]) ?? 0,
      crossOfficeBeards: finiteNumber(flags["crossOfficeBeards"]) ?? 0,
    },
    ipClasses,
    gates,
    notes,
  };
}

async function loadWagersByState(
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<FraudSourceState> {
  const relative = config.sources.gslive_wagers_by_state.relPath;
  if (relative === null) {
    return missingSource(
      "gslive_wagers_by_state",
      root,
      join(root, "Scratch/gslive-wagers-by-state.summary.json"),
      "no configured path",
      "Source path is not configured.",
    );
  }
  const absolute = join(root, relative);
  const info = await statFile(absolute);
  if (info === null) {
    return missingSource(
      "gslive_wagers_by_state",
      root,
      absolute,
      `missing: ${relative}`,
      "GSLive wagers-by-state summary is absent; its legs/wagers totals are unavailable. The CSV it summarizes carries 18,086 rows and no IP.",
    );
  }
  let records: number | null = null;
  let note =
    "derived summary of the GSLive getBetReport capture (no IP column)";
  try {
    const raw = asRecord(await Bun.file(absolute).json());
    const totals = asRecord(raw?.["totals"]);
    records = finiteNumber(totals?.["legs"]);
    const identity = asRecord(raw?.["identity"]);
    const distinctWagers = finiteNumber(identity?.["distinctWagers"]);
    if (records !== null && distinctWagers !== null) {
      note = `derived: ${records} legs / ${distinctWagers} wagers (no IP)`;
    }
  } catch {
    note = "summary exists but is not valid JSON; records unreadable";
  }
  return buildSourceState({
    id: "gslive_wagers_by_state",
    root,
    absolutePath: absolute,
    now,
    mtime: info.mtime,
    bytes: info.bytes,
    provenance: "derived",
    ageSeconds: ageSecondsOf(now, info.mtime),
    staleAfterSeconds: config.sources.gslive_wagers_by_state.staleAfterSeconds,
    records,
    sha256: await hashFile(absolute, MAX_INLINE_SHA256_BYTES),
    note,
    reason: null,
    state: "ok",
  });
}

async function loadLiveSource(
  id: "f402_live_bets" | "f402_live_wagers",
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<{
  state: FraudSourceState;
  bets: {
    tickets: TicketEvent[];
    capturedAt: string | null;
    pendingCount: number | null;
  };
  wagers: {
    tickets: TicketEvent[];
    observedAt: string | null;
    partial: boolean | null;
  };
}> {
  const relative = config.sources[id].relPath;
  const emptyBets = { tickets: [], capturedAt: null, pendingCount: null };
  const emptyWagers = { tickets: [], observedAt: null, partial: null };
  if (relative === null) {
    return {
      state: missingSource(
        id,
        root,
        join(root, "data"),
        "no configured path",
        "Source path is not configured.",
      ),
      bets: emptyBets,
      wagers: emptyWagers,
    };
  }
  const absolute = join(root, relative);
  const info = await statFile(absolute);
  if (info === null) {
    return {
      state: missingSource(
        id,
        root,
        absolute,
        `missing: ${relative}`,
        id === "f402_live_bets"
          ? "F402 live Pending capture is absent; ticket detectors are not run (insufficientData)."
          : "F402 live bet ticker capture is absent; ticker detectors are not run (insufficientData).",
      ),
      bets: emptyBets,
      wagers: emptyWagers,
    };
  }
  let warning: string | null = null;
  let raw: unknown = null;
  try {
    raw = await Bun.file(absolute).json();
  } catch {
    warning = "file is not valid JSON";
  }
  const bets = normalizeLiveBets(raw);
  const wagers = normalizeLiveWagers(raw);
  const capturedAt =
    id === "f402_live_bets" ? bets.capturedAt : wagers.observedAt;
  const capturedDate =
    capturedAt === null ? null : new Date(Date.parse(capturedAt));
  const ageSeconds =
    capturedDate !== null && Number.isFinite(capturedDate.getTime())
      ? Math.max(0, Math.floor((now.getTime() - capturedDate.getTime()) / 1000))
      : ageSecondsOf(now, info.mtime);
  const records =
    id === "f402_live_bets"
      ? (bets.pendingCount ?? bets.tickets.length)
      : wagers.tickets.length;
  const notes: string[] = [];
  notes.push(
    id === "f402_live_bets"
      ? `F402 live Pending: ${bets.tickets.length} ticket legs`
      : `F402 live ticker: ${wagers.tickets.length} rows${
          wagers.partial === null ? "" : ` (partial: ${wagers.partial})`
        }`,
  );
  if (capturedAt !== null) notes.push(`capture stamp ${capturedAt}`);
  if (id === "f402_live_wagers") {
    notes.push("no IP in ticker rows");
  }
  if (warning !== null) notes.push(warning);
  return {
    state: buildSourceState({
      id,
      root,
      absolutePath: absolute,
      now,
      mtime: info.mtime,
      bytes: info.bytes,
      provenance: "live-api",
      ageSeconds,
      staleAfterSeconds: config.sources[id].staleAfterSeconds,
      records,
      sha256: await hashFile(absolute, MAX_INLINE_SHA256_BYTES),
      note: notes.join("; "),
      reason: warning,
      state: warning === null ? "ok" : "unreadable",
    }),
    bets,
    wagers,
  };
}

async function loadWeblogsSource(
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<{ state: FraudSourceState; activity: GsliveWeblogActivity }> {
  const activity = loadGsliveWeblogActivity({ root, now });
  const relative = config.sources.gslive_weblogs.relPath ?? "";
  const andAlt = config.sources.gslive_weblogs.altRelPath;
  const candidates = [join(root, relative)];
  if (andAlt !== null) candidates.push(join(root, andAlt));
  let absolute = candidates[0] as string;
  let info: { mtime: Date; bytes: number } | null = null;
  for (const candidate of candidates) {
    const candidateInfo = await statFile(candidate);
    if (candidateInfo !== null) {
      absolute = candidate;
      info = candidateInfo;
      break;
    }
  }
  if (info === null) {
    return {
      activity,
      state: buildSourceState({
        id: "gslive_weblogs",
        root,
        absolutePath: absolute,
        now,
        mtime: null,
        bytes: null,
        provenance: "api-log-rollup",
        ageSeconds: null,
        staleAfterSeconds: config.sources.gslive_weblogs.staleAfterSeconds,
        records: null,
        sha256: null,
        note: `GSLive WebLog activity MISSING; session expired (HTTP 401) — re-auth, then \`${GSLIVE_WEBLOG_ACTIVITY_COMMAND}\``,
        reason:
          "artifact missing; last known refresh blocked by session expiry (HTTP 401)",
        state: "session_expired",
      }),
    };
  }
  const sha256 = await hashFile(absolute, MAX_INLINE_SHA256_BYTES);
  const ageSeconds = activity.ageSeconds ?? ageSecondsOf(now, info.mtime);
  const measured = activity.status === "measured";
  return {
    activity,
    state: buildSourceState({
      id: "gslive_weblogs",
      root,
      absolutePath: absolute,
      now,
      mtime: info.mtime,
      bytes: info.bytes,
      provenance: "api-log-rollup",
      ageSeconds,
      staleAfterSeconds: config.sources.gslive_weblogs.staleAfterSeconds,
      records: measured ? activity.summary.accounts : null,
      sha256,
      note: measured
        ? `GSLive WebLog activity measured at ${activity.asOf ?? "unknown"}: ${activity.summary.accounts} accounts / ${activity.summary.bets} sampled bets`
        : `GSLive WebLog activity artifact present but not measured: ${activity.reason ?? "unknown reason"}`,
      reason: measured ? null : (activity.reason ?? "not measured"),
      state: measured ? "ok" : "unreadable",
    }),
  };
}

async function loadSuspectAudit(
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<{ summary: SuspectAuditSummary | null; state: FraudSourceState }> {
  const relative =
    config.sources.gslive_suspect_audit.relPath ??
    "reports/gslive-suspect-all-states-audit.json";
  const absolute = join(root, relative);
  const info = await statFile(absolute);
  if (info === null) {
    return {
      summary: null,
      state: missingSource(
        "gslive_suspect_audit",
        root,
        absolute,
        `missing: ${relative}`,
        "Derived suspect-account audit is absent; its numbers are unavailable (and were defective when last present).",
      ),
    };
  }
  let raw: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    raw = asRecord(await Bun.file(absolute).json());
    if (raw === null) error = "not a JSON object";
  } catch {
    error = "not valid JSON";
  }
  const targetAccount = textAt(raw?.["targetAccount"]);
  const targetAgent = textAt(raw?.["targetAgent"]);
  const generatedAt = textAt(raw?.["generatedAt"]);
  const generatedDate =
    generatedAt === null ? null : new Date(Date.parse(generatedAt));
  const ageSeconds =
    generatedDate !== null && Number.isFinite(generatedDate.getTime())
      ? Math.max(
          0,
          Math.floor((now.getTime() - generatedDate.getTime()) / 1000),
        )
      : ageSecondsOf(now, info.mtime);
  const targetDefect = targetAccount === "--help";
  const note = targetDefect
    ? `audit ran with targetAccount:"--help" (arg defect), targetAgent:"${targetAgent ?? ""}"; per-account numbers are NOT observations`
    : "derived audit; verify its target before trusting account numbers";
  return {
    summary: {
      path: relative,
      generatedAt,
      targetAccount,
      targetAgent,
      windowStart: textAt(raw?.["windowStart"]),
      windowEnd: textAt(raw?.["windowEnd"]),
      targetDefect,
      trustworthyNumbers: false,
      note,
    },
    state: buildSourceState({
      id: "gslive_suspect_audit",
      root,
      absolutePath: absolute,
      now,
      mtime: info.mtime,
      bytes: info.bytes,
      provenance: "derived",
      ageSeconds,
      staleAfterSeconds: config.sources.gslive_suspect_audit.staleAfterSeconds,
      records: null,
      sha256: await hashFile(absolute, MAX_INLINE_SHA256_BYTES),
      note,
      reason: targetDefect
        ? "targetAccount is the --help argument defect"
        : error,
      state: error === null ? "ok" : "unreadable",
    }),
  };
}

async function loadCapture(
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<{ summary: WeblogCaptureSummary | null; state: FraudSourceState }> {
  const relative =
    config.sources.f402_weblog_capture.relPath ??
    "docs/evidence/captures/2026-10-31/getWebLog.post.json";
  const absolute = join(root, relative);
  const info = await statFile(absolute);
  if (info === null) {
    return {
      summary: null,
      state: missingSource(
        "f402_weblog_capture",
        root,
        absolute,
        `missing: ${relative}`,
        "F402 getWebLog evidence capture is absent; raw weblog rows remain MISSING.",
      ),
    };
  }
  let raw: Record<string, unknown> | null = null;
  try {
    raw = asRecord(await Bun.file(absolute).json());
  } catch {
    raw = null;
  }
  const response = asRecord(raw?.["response"]);
  const skeleton = asRecord(response?.["bodySkeleton"]);
  const listField = asRecord(skeleton?.["fields"])?.["LIST"];
  const responseBytes = finiteNumber(response?.["bytes"]);
  const status = finiteNumber(response?.["status"]);
  const redaction = asRecord(raw?.["redaction"]);
  const redactionClean =
    typeof redaction?.["clean"] === "boolean"
      ? (redaction["clean"] as boolean)
      : null;
  const listDeclared = asRecord(listField)?.["type"] === "array";
  const rowsMissing =
    listDeclared && responseBytes !== null && responseBytes <= 64;
  const note = rowsMissing
    ? `shape sample only: status ${status ?? "unknown"}, ${responseBytes ?? "?"} B, empty LIST — raw rows MISSING, not zero`
    : "shape-sample capture; response rows were not physically recorded";
  return {
    summary: {
      path: relative,
      capturedAt: textAt(raw?.["capturedAt"]),
      status,
      responseBytes,
      responseRows: rowsMissing ? null : null,
      rowsMissing,
      redactionClean,
      note,
    },
    state: buildSourceState({
      id: "f402_weblog_capture",
      root,
      absolutePath: absolute,
      now,
      mtime: info.mtime,
      bytes: info.bytes,
      provenance: "fixture",
      ageSeconds: ageSecondsOf(now, info.mtime),
      staleAfterSeconds: null,
      records: null,
      sha256: await hashFile(absolute, MAX_INLINE_SHA256_BYTES),
      note,
      reason: rowsMissing
        ? "empty LIST in the captured response: evidence rows missing"
        : null,
      state: "ok",
    }),
  };
}

async function loadAgentIndex(
  root: string,
  config: FraudPluginConfig,
  now: Date,
): Promise<{ index: FraudAgentIndex | null; state: FraudSourceState }> {
  const relative =
    config.sources.agent_index.relPath ?? "data/agent-index.json";
  const absolute = join(root, relative);
  const info = await statFile(absolute);
  if (info === null) {
    return {
      index: null,
      state: missingSource(
        "agent_index",
        root,
        absolute,
        `missing: ${relative}`,
        "Derived agent index is absent; dossier hierarchy is reported as unknown.",
      ),
    };
  }
  const treeRelative = config.sources.agent_index.agentTreeRelPath;
  const treeAbsolute = treeRelative === null ? null : join(root, treeRelative);
  const treeInfo = treeAbsolute === null ? null : await statFile(treeAbsolute);
  let agents = new Map<string, AgentIndexEntry>();
  let roots: string[] = [];
  let collisions: { key: string; ids: readonly string[] }[] = [];
  let agentCount = 0;
  let error: string | null = null;
  try {
    const raw = asRecord(await Bun.file(absolute).json());
    const agentsRaw = asRecord(raw?.["agents"]);
    agentCount = finiteNumber(raw?.["agentCount"]) ?? 0;
    if (agentsRaw !== null) {
      for (const [id, entryRaw] of Object.entries(agentsRaw)) {
        const entry = asRecord(entryRaw);
        agents.set(id, {
          id,
          level: finiteNumber(entry?.["l"]),
          type: textAt(entry?.["t"]),
          parent: null,
          sequence: finiteNumber(entry?.["s"]),
        });
      }
    }
    if (treeInfo !== null && treeAbsolute !== null) {
      const treeRaw = asRecord(await Bun.file(treeAbsolute).json());
      const nodes = asRecord(treeRaw?.["nodes"]);
      if (nodes !== null) {
        for (const [id, nodeRaw] of Object.entries(nodes)) {
          const node = asRecord(nodeRaw);
          const existing = agents.get(id);
          agents.set(id, {
            id,
            level: finiteNumber(node?.["l"]) ?? existing?.level ?? null,
            type: textAt(node?.["t"]) ?? existing?.type ?? null,
            parent: textAt(node?.["p"]),
            sequence: existing?.sequence ?? null,
          });
        }
      }
      const treeRoots = treeRaw?.["roots"];
      if (Array.isArray(treeRoots)) {
        roots = treeRoots.filter(
          (value): value is string => typeof value === "string",
        );
      }
      const treeCollisions = treeRaw?.["collisions"];
      if (Array.isArray(treeCollisions)) {
        collisions = treeCollisions.flatMap((collisionRaw) => {
          const collision = asRecord(collisionRaw);
          const key = textAt(collision?.["key"]);
          const ids = collision?.["agentIds"];
          if (key === null || !Array.isArray(ids)) return [];
          return [
            {
              key,
              ids: ids.filter((id): id is string => typeof id === "string"),
            },
          ];
        });
      }
    }
  } catch {
    error = "agent index is not valid JSON";
  }
  const note = [
    `derived agent index: ${agentCount} agents`,
    treeInfo === null
      ? "agent-tree.json missing (hierarchy null)"
      : "parent chain from agent-tree.json",
    ...(collisions.length > 0
      ? [`${collisions.length} id collisions reported`]
      : []),
  ].join("; ");
  return {
    index: {
      sourcePath: relative,
      treePath: treeInfo === null ? null : (treeRelative ?? null),
      agentCount,
      agents,
      roots,
      collisions,
    },
    state: buildSourceState({
      id: "agent_index",
      root,
      absolutePath: absolute,
      now,
      mtime: info.mtime,
      bytes: info.bytes,
      provenance: "derived",
      ageSeconds: ageSecondsOf(now, info.mtime),
      staleAfterSeconds: config.sources.agent_index.staleAfterSeconds,
      records: agentCount,
      sha256: await hashFile(absolute, MAX_INLINE_SHA256_BYTES),
      note,
      reason: error,
      state: error === null ? "ok" : "unreadable",
    }),
  };
}

async function loadFixturePresence(
  root: string,
  config: FraudPluginConfig,
  id: "customer_book" | "ip_tracker_clusters",
  now: Date,
  note: string,
): Promise<{ state: FraudSourceState; customers: number | null }> {
  const relative = config.sources[id].relPath ?? "";
  const absolute = join(root, relative);
  const info = await statFile(absolute);
  if (info === null) {
    return {
      customers: null,
      state: missingSource(
        id,
        root,
        absolute,
        `missing: ${relative}`,
        `${note} It is absent; fixture context is unavailable.`,
        "fixture",
      ),
    };
  }
  let customers: number | null = null;
  if (id === "customer_book") {
    try {
      const raw: unknown = await Bun.file(absolute).json();
      if (Array.isArray(raw)) customers = raw.length;
    } catch {
      customers = null;
    }
  }
  return {
    customers,
    state: buildSourceState({
      id,
      root,
      absolutePath: absolute,
      now,
      mtime: info.mtime,
      bytes: info.bytes,
      provenance: "fixture",
      ageSeconds: ageSecondsOf(now, info.mtime),
      staleAfterSeconds: null,
      records: id === "customer_book" ? customers : null,
      sha256: await hashFile(absolute, MAX_INLINE_SHA256_BYTES),
      note: `${note} NEVER used to fit the model; context only.`,
      reason: null,
      state: "ok",
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Perception (one load per CLI invocation)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Discover every security source, parse the bet-report corpus once, and load the light artifacts.
 * A missing corpus is a measured state (`corpus: null`), never an exception.
 */
export async function loadFraudPerception(options: {
  readonly root: string;
  readonly now: Date;
}): Promise<FraudPerception> {
  const startedAt = performance.now();
  const root = resolve(options.root);
  const now = options.now;
  const configResult = await loadFraudConfig(root);
  const config = configResult.config;
  const corpusDiscovery = await discoverCorpus(root, config, now);
  let corpus: FraudCorpus | null = null;
  let corpusSource = corpusDiscovery.source;
  if (corpusSource.exists) {
    try {
      const parsed = await parseFraudCorpus(corpusDiscovery.path);
      corpus = {
        source: corpusSource,
        path: corpusDiscovery.path,
        sha256: corpusDiscovery.sha256,
        rows: parsed.rows,
        malformed: parsed.malformed,
        records: parsed.records,
        window: parsed.window,
        ipIndex: {
          byIp: parsed.byIp,
          byPrefix24: parsed.byPrefix24,
          byAccount: parsed.byAccount,
          distinctIps: parsed.byIp.size,
        },
        accounts: parsed.accounts,
        agents: parsed.agents,
        parseMs: parsed.parseMs,
        timerSource: "Bun.file().json",
      };
      corpusSource = {
        ...corpusSource,
        records: parsed.rows,
        note: `${corpusSource.note}; parsed ${parsed.rows} rows (${parsed.malformed} malformed) in ${parsed.parseMs.toFixed(0)} ms`,
      };
    } catch (error) {
      corpusSource = {
        ...corpusSource,
        state: "unreadable",
        records: null,
        reason: error instanceof Error ? error.message : String(error),
        note: `corpus exists (${corpusSource.bytes ?? "?"} bytes) but could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      corpus = null;
    }
  }

  const wagersByState = await loadWagersByState(root, config, now);
  const liveBets = await loadLiveSource("f402_live_bets", root, config, now);
  const liveWagers = await loadLiveSource(
    "f402_live_wagers",
    root,
    config,
    now,
  );
  const weblog = await loadWeblogPosture(root, config, now);
  const weblogs = await loadWeblogsSource(root, config, now);
  const suspect = await loadSuspectAudit(root, config, now);
  const capture = await loadCapture(root, config, now);
  const customerBook = await loadFixturePresence(
    root,
    config,
    "customer_book",
    now,
    "Generated fixture book; never fitted.",
  );
  const agentIndex = await loadAgentIndex(root, config, now);
  const ipTracker = await loadFixturePresence(
    root,
    config,
    "ip_tracker_clusters",
    now,
    "Hardcoded cluster fixture; not measured.",
  );
  const sources: FraudSourceState[] = [
    corpusSource,
    wagersByState,
    liveBets.state,
    liveWagers.state,
    weblog.state,
    weblogs.state,
    suspect.state,
    capture.state,
    customerBook.state,
    agentIndex.state,
    ipTracker.state,
  ];
  const tickets: FraudTickets = {
    bets: liveBets.bets.tickets,
    wagers: liveWagers.wagers.tickets,
    betsCapturedAt: liveBets.bets.capturedAt,
    wagersObservedAt: liveWagers.wagers.observedAt,
    wagersPartial: liveWagers.wagers.partial,
    betsPendingCount: liveBets.bets.pendingCount,
  };
  return {
    root,
    nowIso: now.toISOString(),
    config,
    configPath: configResult.path,
    configExists: configResult.exists,
    configNote: configResult.note,
    sources,
    corpus,
    weblogPosture: weblog.posture,
    weblogs: weblogs.activity,
    tickets,
    agentIndex: agentIndex.index,
    suspectAudit: suspect.summary,
    capture: capture.summary,
    customerBook: {
      path: config.sources.customer_book.relPath ?? "",
      exists: customerBook.state.exists,
      customers: customerBook.customers,
    },
    ipTrackerFixture: {
      path: config.sources.ip_tracker_clusters.relPath ?? "",
      exists: ipTracker.state.exists,
    },
    timing: {
      loadMs: performance.now() - startedAt,
      corpusParseMs: corpus === null ? null : corpus.parseMs,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Derived queries (pure; used by the CLI and detectors)                       */
/* -------------------------------------------------------------------------- */

export interface BetsFilters {
  readonly agent: string | null;
  readonly account: string | null;
  readonly state: number | null;
  readonly since: Date | null;
  readonly includeBots: boolean;
}

export interface BetsAggregate {
  readonly rows: number;
  readonly accounts: number;
  readonly agents: number;
  readonly states: {
    readonly win: number;
    readonly lose: number;
    readonly push: number;
    readonly other: number;
  };
  readonly suspectedBot: number;
  readonly reversedCredit: number;
  readonly manualLog: number;
  readonly oddsDrift: number;
  readonly delayHistogram: readonly {
    readonly delaySec: number;
    readonly count: number;
  }[];
}

/** Apply CLI filters to normalized rows; `includeBots:false` drops suspected-bot rows. */
export function filterBets(
  records: readonly FraudBetRecord[],
  filters: BetsFilters,
): readonly FraudBetRecord[] {
  return records.filter((record) => {
    if (!filters.includeBots && record.suspectedBot) return false;
    if (
      filters.agent !== null &&
      record.agentId?.toUpperCase() !== filters.agent.toUpperCase()
    )
      return false;
    if (
      filters.account !== null &&
      record.userId.toUpperCase() !== filters.account.toUpperCase()
    )
      return false;
    if (filters.state !== null && record.stateCode !== filters.state)
      return false;
    if (
      filters.since !== null &&
      (record.placedAtMs === null ||
        record.placedAtMs < filters.since.getTime())
    )
      return false;
    return true;
  });
}

export function aggregateBets(
  records: readonly FraudBetRecord[],
): BetsAggregate {
  const accounts = new Set<string>();
  const agents = new Set<string>();
  const states = { win: 0, lose: 0, push: 0, other: 0 };
  const delays = new Map<number, number>();
  let suspectedBot = 0;
  let reversedCredit = 0;
  let manualLog = 0;
  let oddsDrift = 0;
  for (const record of records) {
    accounts.add(record.userId);
    if (record.agentId !== null) agents.add(record.agentId);
    if (record.stateCode === 1) states.win += 1;
    else if (record.stateCode === 2) states.lose += 1;
    else if (record.stateCode === 3) states.push += 1;
    else states.other += 1;
    if (record.suspectedBot) suspectedBot += 1;
    if (record.reversedCredit) reversedCredit += 1;
    if (record.manualLog) manualLog += 1;
    if (record.oddsDrift !== null && record.oddsDrift !== 0) oddsDrift += 1;
    if (record.delaySec !== null && Number.isFinite(record.delaySec)) {
      const key = Math.trunc(record.delaySec);
      delays.set(key, (delays.get(key) ?? 0) + 1);
    }
  }
  const delayHistogram = [...delays.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([delaySec, count]) => ({ delaySec, count }));
  return {
    rows: records.length,
    accounts: accounts.size,
    agents: agents.size,
    states,
    suspectedBot,
    reversedCredit,
    manualLog,
    oddsDrift,
    delayHistogram,
  };
}

/** Strip internal-only fields so a sample row is exactly the frozen `BetRecord` shape. */
export function toBetRecord(record: FraudBetRecord): BetRecord {
  return {
    betId: record.betId,
    userId: record.userId,
    agentId: record.agentId,
    placedAtMs: record.placedAtMs,
    acceptedAtMs: record.acceptedAtMs,
    delaySec: record.delaySec,
    acceptSec: record.acceptSec,
    stateCode: record.stateCode,
    oddsPlaced: record.oddsPlaced,
    oddsAccepted: record.oddsAccepted,
    oddsDrift: record.oddsDrift,
    stakeCents: record.stakeCents,
    toWinCents: record.toWinCents,
    lineHundredths: record.lineHundredths,
    sport: record.sport,
    subSport: record.subSport,
    period: record.period,
    wagerType: record.wagerType,
    eventId: record.eventId,
    resultCode: record.resultCode,
    ipMasked: record.ipMasked,
    ipTag: record.ipTag,
    ipPrefix24: record.ipPrefix24,
    suspectedBot: record.suspectedBot,
    reversedCredit: record.reversedCredit,
    manualLog: record.manualLog,
    adminUser: record.adminUser,
  };
}

/** IP clusters with at least `minAccounts` distinct accounts, ordered by size. */
export function listIpClusters(
  corpus: FraudCorpus,
  options: {
    readonly minAccounts?: number;
    readonly limit?: number;
    readonly prefix24?: string | null;
  } = {},
): readonly IpCluster[] {
  const minAccounts = options.minAccounts ?? 2;
  const limit = options.limit ?? 100;
  const prefixFilter = options.prefix24 ?? null;
  const clusters: IpCluster[] = [];
  for (const [tag, node] of corpus.ipIndex.byIp) {
    if (node.accounts.size < minAccounts) continue;
    if (prefixFilter !== null && node.prefix24 !== prefixFilter) continue;
    clusters.push({
      key: `ip:${tag}`,
      masked: node.masked,
      prefix24: node.prefix24,
      accounts: node.accounts.size,
      bets: node.bets,
      sampleAccounts: node.sampleAccounts.slice(0, 5),
      sharedIp: node.accounts.size >= 2,
      botRingRange: node.botRingRange,
      datacenterClass:
        node.ipClass === "OTHER" || node.ipClass === "UNKNOWN"
          ? null
          : node.ipClass,
    });
  }
  clusters.sort((a, b) => {
    if (a.accounts !== b.accounts) return b.accounts - a.accounts;
    if (a.bets !== b.bets) return b.bets - a.bets;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return clusters.slice(0, limit);
}

export interface IpGraphSummary {
  readonly distinctIps: number;
  readonly sharedIps: number;
  readonly accountsMultiIp: number;
  readonly maxAccountsPerIp: number;
}

export function ipGraphSummary(
  corpus: FraudCorpus,
  minAccounts = 2,
): IpGraphSummary {
  let sharedIps = 0;
  let accountsMultiIp = 0;
  let maxAccountsPerIp = 0;
  for (const node of corpus.ipIndex.byIp.values()) {
    if (node.accounts.size >= minAccounts) sharedIps += 1;
    if (node.accounts.size > maxAccountsPerIp) {
      maxAccountsPerIp = node.accounts.size;
    }
  }
  for (const ips of corpus.ipIndex.byAccount.values()) {
    if (ips.size >= 2) accountsMultiIp += 1;
  }
  return {
    distinctIps: corpus.ipIndex.distinctIps,
    sharedIps,
    accountsMultiIp,
    maxAccountsPerIp,
  };
}

/** Cluster list keyed by `/24` prefix (`prefix24:<a.b.c>`), for `ip-graph --prefix24` views. */
export function listPrefixClusters(
  corpus: FraudCorpus,
  options: {
    readonly minAccounts?: number;
    readonly limit?: number;
    readonly prefix24: string;
  },
): readonly IpCluster[] {
  const minAccounts = options.minAccounts ?? 2;
  const limit = options.limit ?? 100;
  const clusters: IpCluster[] = [];
  for (const [prefix, node] of corpus.ipIndex.byPrefix24) {
    if (prefix !== options.prefix24) continue;
    if (node.accounts.size < minAccounts) continue;
    clusters.push({
      key: `prefix24:${prefix}`,
      masked: `${prefix}.***`,
      prefix24: prefix,
      accounts: node.accounts.size,
      bets: node.bets,
      sampleAccounts: [...node.accounts].slice(0, 5),
      sharedIp: node.accounts.size >= 2,
      botRingRange: prefix.startsWith("140.248"),
      datacenterClass: null,
    });
  }
  clusters.sort((a, b) => b.accounts - a.accounts);
  return clusters.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Dossier helpers                                                             */
/* -------------------------------------------------------------------------- */

export interface DossierHierarchy {
  readonly agentId: string | null;
  readonly parentAgent: string | null;
  readonly level: number | null;
  readonly agentType: string | null;
  readonly rootAgent: string | null;
  readonly chain: readonly {
    readonly id: string;
    readonly level: number | null;
  }[];
}

/** Walk the agent-tree parent chain to a root; cycles are cut, not followed forever. */
export function agentHierarchy(
  agentIndex: FraudAgentIndex | null,
  agentId: string | null,
): DossierHierarchy {
  if (agentId === null) {
    return {
      agentId: null,
      parentAgent: null,
      level: null,
      agentType: null,
      rootAgent: null,
      chain: [],
    };
  }
  if (agentIndex === null) {
    return {
      agentId,
      parentAgent: null,
      level: null,
      agentType: null,
      rootAgent: null,
      chain: [],
    };
  }
  const entry = agentIndex.agents.get(agentId) ?? null;
  const chain: { id: string; level: number | null }[] = [];
  const seen = new Set<string>();
  let cursor: string | null = agentId;
  let rootAgent: string | null = null;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const node = agentIndex.agents.get(cursor);
    chain.push({ id: cursor, level: node?.level ?? null });
    rootAgent = cursor;
    cursor = node?.parent ?? null;
  }
  return {
    agentId,
    parentAgent: entry?.parent ?? null,
    level: entry?.level ?? null,
    agentType: entry?.type ?? null,
    rootAgent,
    chain,
  };
}

/** Bet aggregate for one account or one agent (dossier). */
export function subjectBetAggregate(
  corpus: FraudCorpus,
  subject: { readonly kind: "account" | "agent"; readonly id: string },
): BetsAggregate & {
  readonly firstPlacedAtIso: string | null;
  readonly lastPlacedAtIso: string | null;
  readonly stakeUsd: number;
  readonly toWinUsd: number;
  readonly avgOddsPlaced: number | null;
} {
  const matched = corpus.records.filter((record) =>
    subject.kind === "account"
      ? record.userId.toUpperCase() === subject.id.toUpperCase()
      : record.agentId?.toUpperCase() === subject.id.toUpperCase(),
  );
  const aggregate = aggregateBets(matched);
  let stakeCents = 0;
  let toWinCents = 0;
  let oddsSum = 0;
  let oddsCount = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const record of matched) {
    if (record.stakeCents !== null) stakeCents += record.stakeCents;
    if (record.toWinCents !== null) toWinCents += record.toWinCents;
    if (record.oddsPlaced !== null && Number.isFinite(record.oddsPlaced)) {
      oddsSum += record.oddsPlaced;
      oddsCount += 1;
    }
    if (record.placedAtMs !== null) {
      first =
        first === null ? record.placedAtMs : Math.min(first, record.placedAtMs);
      last =
        last === null ? record.placedAtMs : Math.max(last, record.placedAtMs);
    }
  }
  return {
    ...aggregate,
    firstPlacedAtIso: first === null ? null : new Date(first).toISOString(),
    lastPlacedAtIso: last === null ? null : new Date(last).toISOString(),
    stakeUsd: Math.round(stakeCents) / 100,
    toWinUsd: Math.round(toWinCents) / 100,
    avgOddsPlaced: oddsCount === 0 ? null : oddsSum / oddsCount,
  };
}

/** True when the id is a known corpus account or agent or a known agent-index agent. */
export function resolveDossierSubject(
  perception: FraudPerception,
  id: string,
): { kind: "account" | "agent"; id: string } | null {
  const wanted = id.trim().toUpperCase();
  if (wanted === "") return null;
  if (perception.corpus !== null) {
    if (
      perception.corpus.records.some(
        (record) => record.userId.toUpperCase() === wanted,
      )
    ) {
      return { kind: "account", id };
    }
    if (
      perception.corpus.records.some(
        (record) => record.agentId?.toUpperCase() === wanted,
      )
    ) {
      return { kind: "agent", id };
    }
  }
  if (perception.agentIndex?.agents.has(id.trim()) === true) {
    return { kind: "agent", id };
  }
  return null;
}

/**
 * Compact projection of the source matrix for size-budgeted payloads (`model report`).
 * Keeps the fields a UI reads for its honesty chips — id/label/exists/state/provenance/age/
 * stale/records/note/reason — and omits the byte-level forensic fields (path/sha256/bytes/mtime)
 * which the full `status` answer always carries. The source state itself is not altered.
 */
export function compactSourceStates(
  states: readonly FraudSourceState[],
): readonly Record<string, unknown>[] {
  return states.map((source) => ({
    id: source.id,
    label: source.label,
    exists: source.exists,
    state: source.state,
    provenance: source.provenance,
    ageSeconds: source.ageSeconds,
    stale: source.stale,
    records: source.records,
    note: source.note,
    reason: source.reason,
  }));
}

/* -------------------------------------------------------------------------- */
/* Assertions used by tests and the CLI                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fail-closed guard: a serialized payload must not contain any of the corpus's raw IPv4
 * addresses. Callers pass the raw addresses they know (the corpus file is the only source);
 * this function is not a generic PII scanner.
 */
export function assertNoRawIpInText(
  text: string,
  rawIps: Iterable<string>,
): void {
  for (const rawIp of rawIps) {
    const ip = rawIp.trim();
    if (ip === "") continue;
    if (text.includes(ip)) {
      throw new Error("payload leaks a raw IP address");
    }
  }
}

export { GSLIVE_WEBLOG_ARTIFACT_KIND };
