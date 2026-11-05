/**
 * @file fraud_patterns.ts
 * @description Named sportsbook fraud/surveillance detectors for the SportsDesk security console.
 *
 * The detector ids are API (frozen in `Scratch/security/SECURITY-PLUGIN-CONTRACT.md` rev 2): the
 * client half renders `counts.bySeverity`/`counts.byCategory` and the Findings tab, so ids and
 * severities must not drift. Each finding carries its own provenance, evidence pointers and an
 * explicit `insufficientData` flag instead of a fabricated zero.
 *
 * PII: account ids/logins may appear (desk tools already show them); IP addresses appear only in
 * masked form (`ipMasked`/`<ip:hash8>`), never raw.
 *
 * Detector thresholds come from `config/fraud-model.json` (`detectors.*`); where the existing repo
 * already defines a predicate (delay-elapsed classification, WebLog rollup flags, GSLive activity
 * codes) this module calls that definition instead of re-deriving it.
 */

import { classifyDelayElapsedSec } from "./gslive_bet_event_log.ts";
import {
  agentHierarchy,
  ipGraphSummary,
  listIpClusters,
  type FraudBetRecord,
  type FraudFinding,
  type FraudFindingCategory,
  type FraudFindingEvidence,
  type FraudFindingSeverity,
  type FraudIpIndex,
  type FraudPerception,
  type FraudSourceState,
  type Provenance,
} from "./fraud_logs.ts";
import type { GsliveWeblogActivity } from "./gslive_weblog_activity.ts";

/* `FraudFinding*` types are frozen in fraud_logs.ts so every module shares one definition. */
export type {
  FraudFinding,
  FraudFindingCategory,
  FraudFindingEvidence,
  FraudFindingSeverity,
};

export interface FraudPatternCounts {
  readonly bySeverity: Readonly<Record<FraudFindingSeverity, number>>;
  readonly byCategory: Readonly<Record<FraudFindingCategory, number>>;
}

export interface FraudPatternResult {
  readonly findings: readonly FraudFinding[];
  readonly counts: FraudPatternCounts;
  readonly insufficient: readonly string[];
}

export const FRAUD_SEVERITIES: readonly FraudFindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

export const FRAUD_CATEGORIES: readonly FraudFindingCategory[] = [
  "courtsiding",
  "multi_accounting",
  "line_shopping",
  "match_integrity",
  "agent_scheme",
  "ticket_anomaly",
  "ip_network",
  "data_quality",
];

const SEVERITY_RANK: Readonly<Record<FraudFindingSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/* -------------------------------------------------------------------------- */
/* Finding construction helpers                                                */
/* -------------------------------------------------------------------------- */

interface FindingInput {
  readonly id: string;
  readonly title: string;
  readonly severity: FraudFindingSeverity;
  readonly category: FraudFindingCategory;
  readonly subject: FraudFinding["subject"];
  readonly observed: FraudFinding["observed"];
  readonly threshold?: FraudFinding["threshold"];
  readonly evidence: readonly FraudFindingEvidence[];
  readonly provenance: readonly Provenance[];
  readonly explanation: string;
  readonly insufficientData: boolean;
}

function finding(input: FindingInput): FraudFinding {
  return {
    id: input.id,
    title: input.title,
    severity: input.severity,
    category: input.category,
    subject: input.subject,
    observed: input.observed,
    threshold: input.threshold ?? null,
    evidence: [...input.evidence],
    provenance: [...input.provenance],
    explanation: input.explanation,
    insufficientData: input.insufficientData,
  };
}

function evidenceFor(
  perception: FraudPerception,
  sourceId: FraudSourceState["id"],
  pointer: string,
): FraudFindingEvidence {
  const source = perception.sources.find((state) => state.id === sourceId);
  return {
    source: sourceId,
    path: source?.path ?? "missing",
    pointer,
  };
}

function numeratorShare(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function insufficientCorpusFinding(
  id: string,
  title: string,
  category: FraudFindingCategory,
  perception: FraudPerception,
  pointer: string,
  reason: string,
): FraudFinding {
  return finding({
    id,
    title,
    severity: "info",
    category,
    subject: { kind: "source", id: "gslive_bet_report" },
    observed: { rows: null, detectorRan: false },
    evidence: [evidenceFor(perception, "gslive_bet_report", pointer)],
    provenance: ["missing"],
    explanation: `${reason} The detector did not run; this is insufficientData, not zero.`,
    insufficientData: true,
  });
}

/* -------------------------------------------------------------------------- */
/* gslive_bet_report detectors                                                 */
/* -------------------------------------------------------------------------- */

interface CorpusDetectorContext {
  readonly perception: FraudPerception;
  readonly records: readonly FraudBetRecord[];
  readonly isMissing: boolean;
}

function corpusContext(perception: FraudPerception): CorpusDetectorContext {
  const records = perception.corpus?.records ?? [];
  return { perception, records, isMissing: perception.corpus === null };
}

function suspectedBotFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "SUSPECTED_BOT_BET",
      "Rows flagged isSuspectedBot",
      "match_integrity",
      perception,
      "r.bets[*].isSuspectedBot",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const flagged = records.filter((record) => record.suspectedBot);
  return finding({
    id: "SUSPECTED_BOT_BET",
    title: "Rows flagged isSuspectedBot",
    severity: flagged.length > 0 ? "high" : "info",
    category: "match_integrity",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: flagged.length,
      corpusRows: records.length,
      share: round(numeratorShare(flagged.length, records.length)),
      accounts: new Set(flagged.map((record) => record.userId)).size,
      agents: new Set(
        flagged.flatMap((record) =>
          record.agentId === null ? [] : [record.agentId],
        ),
      ).size,
    },
    threshold: { minRows: 1 },
    evidence: [
      evidenceFor(perception, "gslive_bet_report", "r.bets[*].isSuspectedBot"),
    ],
    provenance: ["live-api"],
    explanation:
      "Desk-provided suspect-bot flag on the bet row. It is a weak label (one of the three desk_flag proxies), not an adjudicated fraud finding; the flagged account ids are shown in dossier/bets, not here.",
    insufficientData: false,
  });
}

function reversedCreditFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "REVERSED_CREDIT_BET",
      "Rows with a reversed credit",
      "agent_scheme",
      perception,
      "r.bets[*].reversedCredit",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const flagged = records.filter((record) => record.reversedCredit);
  return finding({
    id: "REVERSED_CREDIT_BET",
    title: "Rows with a reversed credit",
    severity: flagged.length > 0 ? "high" : "info",
    category: "agent_scheme",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: flagged.length,
      corpusRows: records.length,
      share: round(numeratorShare(flagged.length, records.length)),
      accounts: new Set(flagged.map((record) => record.userId)).size,
      agents: new Set(
        flagged.flatMap((record) =>
          record.agentId === null ? [] : [record.agentId],
        ),
      ).size,
    },
    threshold: { minRows: 1 },
    evidence: [
      evidenceFor(perception, "gslive_bet_report", "r.bets[*].reversedCredit"),
    ],
    provenance: ["live-api"],
    explanation:
      "A reversed credit means the desk unwound a wager/credit after the fact. It is a weak label, not proof of intent; one account can own many rows because a row is a leg.",
    insufficientData: false,
  });
}

function manualLogFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "MANUAL_LOG_BET",
      "Rows with a manual log entry",
      "agent_scheme",
      perception,
      "r.bets[*].manualLogExists",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const flagged = records.filter((record) => record.manualLog);
  return finding({
    id: "MANUAL_LOG_BET",
    title: "Rows with a manual log entry",
    severity: flagged.length > 0 ? "medium" : "info",
    category: "agent_scheme",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: flagged.length,
      corpusRows: records.length,
      share: round(numeratorShare(flagged.length, records.length)),
      accounts: new Set(flagged.map((record) => record.userId)).size,
      agents: new Set(
        flagged.flatMap((record) =>
          record.agentId === null ? [] : [record.agentId],
        ),
      ).size,
      withAdminUser: records.filter(
        (record) => record.manualLog && record.adminUser !== null,
      ).length,
    },
    threshold: { minRows: 1 },
    evidence: [
      evidenceFor(perception, "gslive_bet_report", "r.bets[*].manualLogExists"),
    ],
    provenance: ["live-api"],
    explanation:
      "Manual log entries mark desk-side intervention on a wager. Legitimate support actions also set this flag, so it is a weak label and a detector input, not a verdict.",
    insufficientData: false,
  });
}

function oddsDriftFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "ODDS_DRIFT_BET",
      "Rows whose accepted odds differ from placed odds",
      "line_shopping",
      perception,
      "r.bets[*].fVal vs fVal_new",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const drifted = records.filter(
    (record) => record.oddsDrift !== null && record.oddsDrift !== 0,
  );
  const improved = drifted.filter(
    (record) => (record.oddsDrift ?? 0) > 0,
  ).length;
  return finding({
    id: "ODDS_DRIFT_BET",
    title: "Rows whose accepted odds differ from placed odds",
    severity: drifted.length > 0 ? "info" : "info",
    category: "line_shopping",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: drifted.length,
      corpusRows: records.length,
      share: round(numeratorShare(drifted.length, records.length)),
      improved,
      worsened: drifted.length - improved,
    },
    threshold: { definition: "fVal !== fVal_new" },
    evidence: [
      evidenceFor(perception, "gslive_bet_report", "r.bets[*].fVal|fVal_new"),
    ],
    provenance: ["live-api"],
    explanation:
      "Decimal odds drift between placement and acceptance. Some drift is normal market movement during the configured delay; the detector reports the count, not a conclusion.",
    insufficientData: false,
  });
}

interface DelayMismatchStats {
  readonly rows: number;
  readonly maxElapsedSec: number | null;
  readonly maxDelaySec: number | null;
}

function computeDelayMismatch(
  records: readonly FraudBetRecord[],
  minElapsedSec: number,
  maxElapsedSec: number,
): DelayMismatchStats {
  let rows = 0;
  let worst: number | null = null;
  let worstDelay: number | null = null;
  for (const record of records) {
    if (
      record.placedAtMs === null ||
      record.acceptedAtMs === null ||
      record.delaySec === null
    ) {
      continue;
    }
    const elapsed = classifyDelayElapsedSec(
      record.acceptedAtMs,
      Math.floor(record.placedAtMs / 1000),
      record.delaySec,
    );
    if (elapsed < minElapsedSec || elapsed > maxElapsedSec) {
      rows += 1;
      const magnitude = Math.abs(elapsed);
      if (worst === null || magnitude > Math.abs(worst)) {
        worst = elapsed;
        worstDelay = record.delaySec;
      }
    }
  }
  return { rows, maxElapsedSec: worst, maxDelaySec: worstDelay };
}

function delayMismatchFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "DELAY_MISMATCH_BET",
      "Rows whose acceptance elapsed time contradicts the configured delay",
      "match_integrity",
      perception,
      "r.bets[*].acceptTime|logTime|delay",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const minElapsedSec = perception.config.detectors.delayMismatchMinElapsedSec;
  const maxElapsedSec = perception.config.detectors.delayMismatchMaxElapsedSec;
  const stats = computeDelayMismatch(records, minElapsedSec, maxElapsedSec);
  return finding({
    id: "DELAY_MISMATCH_BET",
    title:
      "Rows whose acceptance elapsed time contradicts the configured delay",
    severity: stats.rows > 0 ? "high" : "info",
    category: "match_integrity",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: stats.rows,
      corpusRows: records.length,
      maxElapsedSec: stats.maxElapsedSec,
      maxDelaySec: stats.maxDelaySec,
    },
    threshold: {
      minElapsedSec,
      maxElapsedSec,
      definition:
        "classifyDelayElapsedSec(acceptTime, logTime, delay) outside [min,max]",
    },
    evidence: [
      evidenceFor(
        perception,
        "gslive_bet_report",
        "r.bets[*].acceptTime|logTime|delay",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "Reuses lib/gslive_bet_event_log.ts `classifyDelayElapsedSec` (the repo's own delay-window predicate) instead of re-deriving the threshold. A normal handshake lands in 0–5 s; a large positive elapsed means acceptance happened well after the configured delay window.",
    insufficientData: false,
  });
}

function stateMixFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "STATE_MIX_ANOMALY",
      "Settled-state mix of the snapshot",
      "data_quality",
      perception,
      "r.bets[*].state",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const counts = { win: 0, lose: 0, push: 0, other: 0 };
  for (const record of records) {
    if (record.stateCode === 1) counts.win += 1;
    else if (record.stateCode === 2) counts.lose += 1;
    else if (record.stateCode === 3) counts.push += 1;
    else counts.other += 1;
  }
  const winShare = round(numeratorShare(counts.win, records.length));
  const threshold = perception.config.detectors.stateMixMinWinShare;
  return finding({
    id: "STATE_MIX_ANOMALY",
    title: "Settled-state mix of the snapshot",
    severity: winShare < threshold ? "info" : "info",
    category: "data_quality",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: records.length,
      win: counts.win,
      lose: counts.lose,
      push: counts.push,
      other: counts.other,
      winShare,
    },
    threshold: { minWinShare: threshold },
    evidence: [evidenceFor(perception, "gslive_bet_report", "r.bets[*].state")],
    provenance: ["live-api"],
    explanation:
      "The capture is a settled-wager report, so losses dominate by construction. This is a data-shape note (it stops a reader treating the book as live pending flow), not a fraud detector verdict.",
    insufficientData: false,
  });
}

function sharedIpClusterFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, isMissing } = context;
  const corpus = perception.corpus;
  if (isMissing || corpus === null) {
    return insufficientCorpusFinding(
      "SHARED_IP_CLUSTER",
      "IP clusters shared by multiple accounts",
      "ip_network",
      perception,
      "r.bets[*].ipAddress (masked)",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const { sharedIpMinAccounts, sharedIpTop } = perception.config.detectors;
  const summary = ipGraphSummary(corpus, sharedIpMinAccounts);
  const clusters = listIpClusters(corpus, {
    minAccounts: sharedIpMinAccounts,
    limit: sharedIpTop,
  });
  const top = clusters[0];
  return finding({
    id: "SHARED_IP_CLUSTER",
    title: "IP clusters shared by multiple accounts",
    severity:
      summary.maxAccountsPerIp >= 5
        ? "high"
        : summary.sharedIps > 0
          ? "medium"
          : "info",
    category: "ip_network",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      sharedIps: summary.sharedIps,
      distinctIps: summary.distinctIps,
      maxAccountsPerIp: summary.maxAccountsPerIp,
      topClusterMasked: top?.masked ?? null,
      topClusterAccounts: top?.accounts ?? 0,
      topClusterBets: top?.bets ?? 0,
    },
    threshold: { minAccounts: sharedIpMinAccounts },
    evidence: [
      evidenceFor(
        perception,
        "gslive_bet_report",
        "r.bets[*].ipAddress -> masked ip:<sha256:8>",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "Two or more distinct accounts placing from the same IP is a multi-accounting signal, but shared NAT/carrier CGNAT addresses produce the same shape. Cluster ids are masked and hash-tagged; no raw IP is emitted.",
    insufficientData: false,
  });
}

function accountIpFanoutFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, isMissing } = context;
  const corpus = perception.corpus;
  if (isMissing || corpus === null) {
    return insufficientCorpusFinding(
      "ACCOUNT_IP_FANOUT",
      "Accounts appearing from many distinct IPs",
      "ip_network",
      perception,
      "r.bets[*].ipAddress grouped by userID",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const { accountFanoutMinIps, accountFanoutHighIps } =
    perception.config.detectors;
  let accounts = 0;
  let high = 0;
  for (const ips of corpus.ipIndex.byAccount.values()) {
    if (ips.size >= accountFanoutMinIps) accounts += 1;
    if (ips.size >= accountFanoutHighIps) high += 1;
  }
  return finding({
    id: "ACCOUNT_IP_FANOUT",
    title: "Accounts appearing from many distinct IPs",
    severity: high > 0 ? "medium" : accounts > 0 ? "low" : "info",
    category: "ip_network",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      accounts,
      highFanoutAccounts: high,
      minIps: accountFanoutMinIps,
      highIps: accountFanoutHighIps,
      accountsSeen: corpus.accounts,
    },
    threshold: { minIps: accountFanoutMinIps, highIps: accountFanoutHighIps },
    evidence: [
      evidenceFor(
        perception,
        "gslive_bet_report",
        "r.bets[*].userID x ipAddress (masked tag)",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "Legitimate bettors roam between cell towers and home/work addresses, so fan-out alone is weak. It is reported because it is one of the frozen detector ids; combine it with SHARED_IP_CLUSTER before acting.",
    insufficientData: false,
  });
}

function botRingIpFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "BOT_RING_IP_RANGE",
      "Rows placed from the 140.248.0.0/16 bot-ring range",
      "ip_network",
      perception,
      "r.bets[*].ipAddress classifyIp()==BOT_RING_140_248",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const inRange = records.filter((record) => record.botRingRange);
  const distinctIps = new Set(
    inRange.flatMap((record) => (record.ipTag === null ? [] : [record.ipTag])),
  ).size;
  return finding({
    id: "BOT_RING_IP_RANGE",
    title: "Rows placed from the 140.248.0.0/16 bot-ring range",
    severity: inRange.length > 0 ? "high" : "info",
    category: "ip_network",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: inRange.length,
      accounts: new Set(inRange.map((record) => record.userId)).size,
      agents: new Set(
        inRange.flatMap((record) =>
          record.agentId === null ? [] : [record.agentId],
        ),
      ).size,
      distinctIps,
    },
    threshold: { cidr: perception.config.detectors.botRingCidr },
    evidence: [
      evidenceFor(
        perception,
        "gslive_bet_report",
        "r.bets[*].ipAddress classifyIp()==BOT_RING_140_248",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "The 140.248.0.0/16 range is the repo's existing BOT_RING_140_248 classification in lib/f402_weblog.ts (reused, not re-derived). Traffic from it is a network signal, not proof of a bot account.",
    insufficientData: false,
  });
}

function datacenterIpFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "DATACENTER_IP_CLASS",
      "Rows placed from datacenter/relay IP classes",
      "ip_network",
      perception,
      "r.bets[*].ipAddress classifyIp()",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const configured = perception.config.detectors.datacenterClasses;
  const ipIndex: FraudIpIndex | null = perception.corpus?.ipIndex ?? null;
  let ips = 0;
  let bets = 0;
  for (const record of records) {
    if (!configured.includes(record.ipClass)) continue;
    bets += 1;
  }
  if (ipIndex !== null) {
    for (const node of ipIndex.byIp.values()) {
      if (configured.includes(node.ipClass)) ips += 1;
    }
  }
  return finding({
    id: "DATACENTER_IP_CLASS",
    title: "Rows placed from datacenter/relay IP classes",
    severity: bets > 0 ? "medium" : "info",
    category: "ip_network",
    subject: { kind: "book", id: "gslive_bet_report" },
    observed: {
      rows: bets,
      distinctIps: ips,
      classes: configured.join("|"),
      corpusRows: records.length,
    },
    threshold: { classes: configured.join("|") },
    evidence: [
      evidenceFor(
        perception,
        "gslive_bet_report",
        "r.bets[*].ipAddress classifyIp()",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "Reuses lib/f402_weblog.ts `classifyIp`; the configured class list (default ICLOUD_RELAY) is the desk's own datacenter/relay classification. VPNs are used by legitimate bettors too, so this is context for SHARED_IP_CLUSTER, not a standalone accusation.",
    insufficientData: false,
  });
}

interface AgentFlagConcentration {
  readonly agents: number;
  readonly top: {
    readonly agentId: string;
    readonly bets: number;
    readonly flags: number;
    readonly flagRate: number;
  } | null;
  readonly flaggedBets: number;
}

function agentFlagConcentration(
  records: readonly FraudBetRecord[],
  minBets: number,
  minRate: number,
): AgentFlagConcentration {
  const byAgent = new Map<string, { bets: number; flags: number }>();
  for (const record of records) {
    if (record.agentId === null) continue;
    const entry = byAgent.get(record.agentId) ?? { bets: 0, flags: 0 };
    entry.bets += 1;
    if (record.suspectedBot || record.reversedCredit || record.manualLog) {
      entry.flags += 1;
    }
    byAgent.set(record.agentId, entry);
  }
  let agents = 0;
  let flaggedBets = 0;
  let top: AgentFlagConcentration["top"] = null;
  for (const [agentId, entry] of byAgent) {
    if (entry.bets < minBets) continue;
    const flagRate = numeratorShare(entry.flags, entry.bets);
    if (flagRate < minRate) continue;
    agents += 1;
    flaggedBets += entry.flags;
    if (
      top === null ||
      entry.flags > top.flags ||
      (entry.flags === top.flags && flagRate > top.flagRate)
    ) {
      top = { agentId, bets: entry.bets, flags: entry.flags, flagRate };
    }
  }
  return { agents, top, flaggedBets };
}

function agentFlagFinding(context: CorpusDetectorContext): FraudFinding {
  const { perception, records, isMissing } = context;
  if (isMissing) {
    return insufficientCorpusFinding(
      "AGENT_FLAG_CONCENTRATION",
      "Agents whose book concentrates desk-flagged rows",
      "agent_scheme",
      perception,
      "r.bets[*].agent x isSuspectedBot|reversedCredit|manualLogExists",
      "The GSLive bet-report corpus is MISSING.",
    );
  }
  const { agentFlagMinBets, agentFlagMinRate } = perception.config.detectors;
  const stats = agentFlagConcentration(
    records,
    agentFlagMinBets,
    agentFlagMinRate,
  );
  const topAgent = stats.top?.agentId ?? null;
  return finding({
    id: "AGENT_FLAG_CONCENTRATION",
    title: "Agents whose book concentrates desk-flagged rows",
    severity: stats.agents > 0 ? "high" : "info",
    category: "agent_scheme",
    subject: {
      kind: "agent",
      id: topAgent ?? "(none)",
    },
    observed: {
      agents: stats.agents,
      flaggedBets: stats.flaggedBets,
      topAgent,
      topAgentBets: stats.top?.bets ?? null,
      topAgentFlags: stats.top?.flags ?? null,
      topAgentFlagRate: stats.top === null ? null : round(stats.top.flagRate),
    },
    threshold: { minBets: agentFlagMinBets, minFlagRate: agentFlagMinRate },
    evidence: [
      evidenceFor(perception, "gslive_bet_report", "r.bets[*].agent x flags"),
    ],
    provenance: ["live-api"],
    explanation:
      "Concentration of flagged rows under one agent can be an agent scheme or a large agent simply carrying more volume; the rate threshold and minimum book size are reported so the reader can judge. The subject agent id is a desk login, not a person.",
    insufficientData: false,
  });
}

/* -------------------------------------------------------------------------- */
/* F402 WebLog rollup detectors (counts only; no account attribution)          */
/* -------------------------------------------------------------------------- */

interface RollupDetectorContext {
  readonly posture: FraudPerception["weblogPosture"];
  readonly perception: FraudPerception;
}

function rollupFinding(
  context: RollupDetectorContext,
  id: string,
  title: string,
  category: FraudFindingCategory,
  severity: FraudFindingSeverity,
  observed: FraudFinding["observed"],
  explanation: string,
  pointer: string,
): FraudFinding {
  const { posture, perception } = context;
  const evidence = evidenceFor(
    perception,
    "f402_weblog_rollup",
    `${posture?.sourcePath ?? "rollup"} ${pointer}`,
  );
  if (posture === null) {
    return finding({
      id,
      title,
      severity: "info",
      category,
      subject: { kind: "source", id: "f402_weblog_rollup" },
      observed: { ...observed, detectorRan: false },
      evidence: [evidence],
      provenance: ["missing"],
      explanation: `The F402 WebLog rollup is MISSING, so ${id} could not be evaluated and no count is invented. ${explanation}`,
      insufficientData: true,
    });
  }
  return finding({
    id,
    title,
    severity,
    category,
    subject: { kind: "book", id: "f402_weblog" },
    observed,
    threshold: null,
    evidence: [evidence],
    provenance: ["api-log-rollup"],
    explanation,
    insufficientData: false,
  });
}

function rollupDetectors(context: RollupDetectorContext): FraudFinding[] {
  const { posture } = context;
  const flags = posture?.flags;
  return [
    rollupFinding(
      context,
      "EXECUTION_SNIPERS",
      "Accounts whose first action after login was a fast wager",
      "ticket_anomaly",
      flags?.executionSnipers !== null && (flags?.executionSnipers ?? 0) > 0
        ? "medium"
        : "info",
      {
        accounts: flags?.executionSnipers ?? null,
        rowsObserved: posture?.rows.parsed ?? null,
      },
      "Rollup definition: first wager within 15 s of session start, or wager-to-wager gap <= 15 s. The rollup carries counts only, so account attribution is unavailable here (insufficientData for per-account work).",
      "flags.executionSnipers",
    ),
    rollupFinding(
      context,
      "SNIPER_TWINS",
      "Same-/24 login pairs placing within 60 s",
      "multi_accounting",
      (flags?.sniperTwins ?? 0) > 0 ? "high" : "info",
      {
        accounts: flags?.sniperTwins ?? null,
        negativeControls:
          posture?.gates.find((gate) => gate.gate === "GATE-WL-03")?.detail ??
          null,
      },
      "Rollup definition: two accounts on the same IPv4 /24 or IPv6 /64, at least one fast, placing within 60 s, with the desk's negative controls excluded (GATE-WL-03 checks 7 controls, 0 false positives).",
      "flags.sniperTwins",
    ),
    rollupFinding(
      context,
      "LINE_SHOPPERS",
      "Long zero-wager sessions (line shopping)",
      "line_shopping",
      "info",
      {
        sessions: flags?.lineShoppers ?? null,
        zeroWagerSessions: posture?.sessions.zeroWagerSessions ?? null,
      },
      "Rollup definition: a session with no wagers lasting >= 120 s. The count is large and mostly reflects normal browsing; it is included because the detector id is frozen, not because it is evidence of fraud.",
      "flags.lineShoppers",
    ),
    rollupFinding(
      context,
      "BOT_RING_ACCOUNTS",
      "Accounts seen from the bot-ring IP range",
      "ip_network",
      (flags?.botRingAccounts ?? 0) > 0 ? "high" : "info",
      {
        accounts: flags?.botRingAccounts ?? null,
        ipClass: posture?.ipClasses["BOT_RING_140_248"] ?? null,
      },
      "Count of distinct logins seen from the 140.248.0.0/16 range in the WebLog rollup. Counts only: the rollup deliberately carries no login↔IP rows.",
      "flags.botRingAccounts",
    ),
    rollupFinding(
      context,
      "CROSS_OFFICE_BEARDS",
      "Login pairs sharing a /24 and a skin domain",
      "multi_accounting",
      (flags?.crossOfficeBeards ?? 0) > 0 ? "medium" : "info",
      {
        pairs: flags?.crossOfficeBeards ?? null,
        ipClasses: posture?.ipClasses["ICLOUD_RELAY"] ?? null,
      },
      "Rollup definition: more than one login on the same IPv4 /24 with the same skin domain. Shared offices/households produce this shape too.",
      "flags.crossOfficeBeards",
    ),
    (() => {
      const ipClasses = posture?.ipClasses ?? null;
      if (posture === null || ipClasses === null) {
        return rollupFinding(
          context,
          "IP_CLASS_ANOMALY",
          "WebLog traffic concentrated in relay/bot-ring IP classes",
          "ip_network",
          "info",
          { botRingRows: null, relayRows: null },
          "Rollup IP-class counts could not be evaluated because the rollup is missing.",
          "ipClasses",
        );
      }
      const total = Object.values(ipClasses).reduce(
        (sum, value) => sum + value,
        0,
      );
      const botRingRows = ipClasses["BOT_RING_140_248"] ?? 0;
      const relayRows = ipClasses["ICLOUD_RELAY"] ?? 0;
      const botRingShare = round(numeratorShare(botRingRows, total));
      return rollupFinding(
        context,
        "IP_CLASS_ANOMALY",
        "WebLog traffic concentrated in relay/bot-ring IP classes",
        "ip_network",
        botRingShare >= 0.01 ? "medium" : "info",
        {
          rows: total,
          botRingRows,
          relayRows,
          botRingShare,
          relayShare: round(numeratorShare(relayRows, total)),
        },
        "Reads the rollup's existing classifyIp buckets (lib/f402_weblog.ts); a high bot-ring share is a network signal that should be read with BOT_RING_ACCOUNTS.",
        "ipClasses",
      );
    })(),
    (() => {
      const gates = posture?.gates ?? [];
      const failed = gates.filter((gate) => gate.status === "fail");
      return rollupFinding(
        context,
        "WEBLOG_GATE_FAIL",
        "WebLog rollup integrity gate failure",
        "data_quality",
        failed.length > 0 ? "critical" : "info",
        {
          gates: gates.length,
          failed: failed.length,
          passed: gates.length - failed.length,
          gateNames: failed.map((gate) => gate.gate).join("|"),
        },
        "The rollup's own GATE-WL-01..04 checks. A failing gate means the rollup numbers should not be quoted; a passing gate still does not make them observations of account behaviour.",
        "gates",
      );
    })(),
  ];
}

/* -------------------------------------------------------------------------- */
/* GSLive WebLog activity detectors (mapped repo predicates; artifact MISSING) */
/* -------------------------------------------------------------------------- */

const GSLIVE_ACTIVITY_DETECTORS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly category: FraudFindingCategory;
  readonly severity: FraudFindingSeverity;
  readonly codes: readonly string[];
  readonly predicate: string;
}> = [
  {
    id: "STEAM_15S_5S",
    title: "Sub-15s score snipe / 5s stall at placement",
    category: "courtsiding",
    severity: "high",
    codes: ["SUB_15S_SCORE_SNIPE", "FEED_STALL_AT_PLACEMENT", "DELAY_MISMATCH"],
    predicate:
      "SUB_15S_SCORE_SNIPE (<15 s to next score), FEED_STALL_AT_PLACEMENT (>5 s feed gap), DELAY_MISMATCH (lib/gslive_bet_event_log.ts constants)",
  },
  {
    id: "CLINCH_AT_PLACEMENT",
    title: "Score/possession change during the delay window",
    category: "courtsiding",
    severity: "high",
    codes: [
      "SCORE_DURING_DELAY_WINDOW",
      "POSSESSION_FLIP_DURING_DELAY",
      "ODDS_IMPROVEMENT_DURING_DELAY",
    ],
    predicate:
      "validateAndAuditBetTimeline anomalies for score/possession change inside the placement→acceptance window",
  },
  {
    id: "CONFIRM_BYPASS",
    title: "Accepted while the event feed was blocked",
    category: "match_integrity",
    severity: "critical",
    codes: ["ACCEPTED_WHILE_BLOCKED", "WAGER_STATE_MISMATCH"],
    predicate:
      "ACCEPTED_WHILE_BLOCKED / WAGER_STATE_MISMATCH from the existing bet timeline audit",
  },
  {
    id: "DONOR_SHIELD",
    title: "Manual admin intervention shielding a wager",
    category: "agent_scheme",
    severity: "high",
    codes: ["MANUAL_ADMIN_INTERVENTION"],
    predicate:
      "isManuallyEntered/adminUserName from parseBetLog (lib/gslive_bet_event_log.ts)",
  },
  {
    id: "TROJAN_HORSE",
    title: "Frozen clock / extended feed outage around placement",
    category: "match_integrity",
    severity: "medium",
    codes: [
      "FROZEN_CLOCK_SCORING_OR_PLAY",
      "EXTENDED_FEED_OUTAGE",
      "PLACEMENT_SNAPSHOT_MISMATCH",
    ],
    predicate:
      "auditEventTimeline / prescreen constants for frozen-clock scores and long feed gaps",
  },
  {
    id: "MANUAL_ADMIN_INTERVENTION",
    title: "Manual admin/desk intervention rows",
    category: "agent_scheme",
    severity: "medium",
    codes: ["MANUAL_ADMIN_INTERVENTION", "MANUAL_LOG", "ADMIN_USER"],
    predicate:
      "prescreen reasons MANUAL_LOG/ADMIN_USER plus the timeline audit's MANUAL_ADMIN_INTERVENTION",
  },
];

function weblogsActivityDetectors(perception: FraudPerception): FraudFinding[] {
  const activity: GsliveWeblogActivity = perception.weblogs;
  const measured = activity.status === "measured";
  const sourceState = perception.sources.find(
    (source) => source.id === "gslive_weblogs",
  );
  return GSLIVE_ACTIVITY_DETECTORS.map((detector) => {
    const counts: Record<string, number> = {};
    let flaggedAccounts = 0;
    let matchedBets = 0;
    if (measured) {
      for (const account of activity.accounts) {
        let matched = 0;
        for (const flag of account.flags) {
          if (!detector.codes.includes(flag.code)) continue;
          matched += flag.count;
          counts[flag.code] = (counts[flag.code] ?? 0) + flag.count;
        }
        if (matched > 0) {
          flaggedAccounts += 1;
          matchedBets += matched;
        }
      }
    }
    const observed: Record<string, number | string | boolean | null> = {
      flaggedAccounts: measured ? flaggedAccounts : null,
      flags: measured ? matchedBets : null,
      activityAccounts: measured ? activity.summary.accounts : null,
      activityStatus: activity.status,
    };
    for (const code of detector.codes) {
      observed[code] = measured ? (counts[code] ?? 0) : null;
    }
    const missingReason = measured
      ? null
      : `the GSLive WebLog activity artifact is MISSING and its session expired (HTTP 401): operator re-auth then ${activity.command}`;
    return finding({
      id: detector.id,
      title: detector.title,
      severity: measured && flaggedAccounts > 0 ? detector.severity : "info",
      category: detector.category,
      subject: { kind: "book", id: "gslive_weblogs" },
      observed,
      threshold: { mappedCodes: detector.codes.join("|") },
      evidence: [
        {
          source: "gslive_weblogs",
          path: sourceState?.path ?? "missing",
          pointer: `accounts[].flags.code in {${detector.codes.join(",")}}`,
        },
      ],
      provenance: measured ? ["api-log-rollup"] : ["missing"],
      explanation: measured
        ? `Maps the frozen detector id to the existing audit codes (${detector.predicate}) over the measured activity artifact; no threshold is re-derived here.`
        : `${detector.title}: ${missingReason}. Detector not run — insufficientData, not zero.`,
      insufficientData: !measured,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* F402 live ticket detectors                                                  */
/* -------------------------------------------------------------------------- */

interface TicketDetectorContext {
  readonly perception: FraudPerception;
  readonly tickets: readonly FraudPerception["tickets"]["bets"][number][];
  readonly isMissing: boolean;
}

function ticketContext(perception: FraudPerception): TicketDetectorContext {
  const tickets = [...perception.tickets.bets, ...perception.tickets.wagers];
  return { perception, tickets, isMissing: tickets.length === 0 };
}

function insufficientTicketFinding(
  id: string,
  title: string,
  category: FraudFindingCategory,
  perception: FraudPerception,
  reason: string,
): FraudFinding {
  return finding({
    id,
    title,
    severity: "info",
    category,
    subject: { kind: "source", id: "f402_live_wagers" },
    observed: { tickets: null, detectorRan: false },
    evidence: [
      evidenceFor(perception, "f402_live_wagers", "LIST[*]"),
      evidenceFor(perception, "f402_live_bets", "games[*]"),
    ],
    provenance: ["missing"],
    explanation: `${reason} Detector not run — insufficientData, not zero.`,
    insufficientData: true,
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function roundStakeFinding(context: TicketDetectorContext): FraudFinding {
  const { perception, tickets, isMissing } = context;
  if (isMissing) {
    return insufficientTicketFinding(
      "ROUND_STAKE_LADDER",
      "Round-stake ladder on live tickets",
      "ticket_anomaly",
      perception,
      "F402 live ticket captures are missing or empty.",
    );
  }
  const step = perception.config.detectors.roundStakeStepCents;
  const roundStakeTickets = tickets.filter(
    (ticket) =>
      ticket.stakeCents !== null &&
      ticket.stakeCents > 0 &&
      ticket.stakeCents % step === 0,
  );
  return finding({
    id: "ROUND_STAKE_LADDER",
    title: "Round-stake ladder on live tickets",
    severity: roundStakeTickets.length > 0 ? "info" : "info",
    category: "ticket_anomaly",
    subject: { kind: "book", id: "f402_live_tickets" },
    observed: {
      tickets: roundStakeTickets.length,
      capturedTickets: tickets.length,
      share: round(numeratorShare(roundStakeTickets.length, tickets.length)),
    },
    threshold: { stepCents: step },
    evidence: [
      evidenceFor(perception, "f402_live_wagers", "LIST[*].AmountWagered"),
      evidenceFor(perception, "f402_live_bets", "games[*].wagered"),
    ],
    provenance: ["live-api"],
    explanation:
      "Counts live tickets whose stake is an exact multiple of the configured step ($100 default). Round stakes are common; a ladder matters only when one account walks it within a session.",
    insufficientData: false,
  });
}

function longshotConcentrationFinding(
  context: TicketDetectorContext,
): FraudFinding {
  const { perception, tickets, isMissing } = context;
  if (isMissing) {
    return insufficientTicketFinding(
      "LONGSHOT_CONCENTRATION",
      "Longshot concentration per account",
      "ticket_anomaly",
      perception,
      "F402 live ticket captures are missing or empty.",
    );
  }
  const minRatio = perception.config.detectors.longshotMinPayoutRatio;
  const minTickets = perception.config.detectors.longshotMinTickets;
  const byAccount = new Map<string, { tickets: number; longshots: number }>();
  for (const ticket of tickets) {
    if (
      ticket.stakeCents === null ||
      ticket.stakeCents <= 0 ||
      ticket.toWinCents === null
    ) {
      continue;
    }
    const entry = byAccount.get(ticket.accountId) ?? {
      tickets: 0,
      longshots: 0,
    };
    entry.tickets += 1;
    if (ticket.toWinCents / ticket.stakeCents >= minRatio) entry.longshots += 1;
    byAccount.set(ticket.accountId, entry);
  }
  let accounts = 0;
  let ticketsInScope = 0;
  for (const entry of byAccount.values()) {
    if (entry.tickets < minTickets) continue;
    if (entry.longshots / entry.tickets >= 0.5) {
      accounts += 1;
      ticketsInScope += entry.tickets;
    }
  }
  return finding({
    id: "LONGSHOT_CONCENTRATION",
    title: "Longshot concentration per account",
    severity: accounts > 0 ? "medium" : "info",
    category: "ticket_anomaly",
    subject: { kind: "book", id: "f402_live_tickets" },
    observed: {
      accounts,
      ticketsInScope,
      capturedTickets: tickets.length,
      minTickets,
      minPayoutRatio: minRatio,
    },
    threshold: { minPayoutRatio: minRatio, minTickets, share: 0.5 },
    evidence: [
      evidenceFor(
        perception,
        "f402_live_wagers",
        "LIST[*].ToWinAmount/AmountWagered",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "An account with at least the minimum ticket count whose longshot share (to-win/stake >= the configured ratio) is at least half. Longshot betting is legal; the detector flags concentration for review.",
    insufficientData: false,
  });
}

const CHANNEL_WRITERS: ReadonlySet<string> = new Set([
  "INTERNET",
  "ALERT",
  "GSLIVE",
  "GSBUILDER",
  "CASINO",
  "KIOSK",
]);

function writerAgentMismatchFinding(
  context: TicketDetectorContext,
): FraudFinding {
  const { perception, tickets, isMissing } = context;
  if (isMissing) {
    return insufficientTicketFinding(
      "WRITER_AGENT_MISMATCH",
      "Ticket writer does not match the booking agent",
      "agent_scheme",
      perception,
      "F402 live ticket captures are missing or empty.",
    );
  }
  let mismatches = 0;
  let captured = 0;
  for (const ticket of tickets) {
    if (ticket.writer === null) continue;
    captured += 1;
    const writer = ticket.writer.trim().toUpperCase();
    if (writer === "" || CHANNEL_WRITERS.has(writer)) continue;
    if (
      ticket.agentId === null ||
      writer !== ticket.agentId.trim().toUpperCase()
    ) {
      mismatches += 1;
    }
  }
  return finding({
    id: "WRITER_AGENT_MISMATCH",
    title: "Ticket writer does not match the booking agent",
    severity: mismatches > 0 ? "medium" : "info",
    category: "agent_scheme",
    subject: { kind: "book", id: "f402_live_tickets" },
    observed: {
      mismatches,
      rowsWithWriter: captured,
      capturedTickets: tickets.length,
      channelWriters: [...CHANNEL_WRITERS].join("|"),
    },
    threshold: {
      definition:
        "TicketWriter is a login (not Internet/ALERT/GSLIVE/GSBUILDER/CASINO/KIOSK) and differs from AgentID",
    },
    evidence: [
      evidenceFor(
        perception,
        "f402_live_wagers",
        "LIST[*].TicketWriter vs LIST[*].AgentID",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "Desk channel writers (Internet, ALERT, GSLIVE, GSBUILDER, ...) are expected to differ from the booking agent; a named human login writing under a different agent's book is the anomaly.",
    insufficientData: false,
  });
}

function ticketBurstFinding(context: TicketDetectorContext): FraudFinding {
  const { perception, tickets, isMissing } = context;
  if (isMissing) {
    return insufficientTicketFinding(
      "TICKET_BURST",
      "Ticket bursts per account",
      "ticket_anomaly",
      perception,
      "F402 live ticket captures are missing or empty.",
    );
  }
  const windowMs = perception.config.detectors.burstWindowSeconds * 1000;
  const minTickets = perception.config.detectors.burstMinTickets;
  const byAccount = new Map<string, number[]>();
  for (const ticket of tickets) {
    if (ticket.placedAtMs === null) continue;
    const times = byAccount.get(ticket.accountId) ?? [];
    times.push(ticket.placedAtMs);
    byAccount.set(ticket.accountId, times);
  }
  let burstAccounts = 0;
  let burstEvents = 0;
  for (const times of byAccount.values()) {
    times.sort((a, b) => a - b);
    let start = 0;
    let accountHasBurst = false;
    for (let end = 0; end < times.length; end += 1) {
      while (
        start < end &&
        (times[end] ?? 0) - (times[start] ?? 0) > windowMs
      ) {
        start += 1;
      }
      if (end - start + 1 >= minTickets) {
        burstEvents += 1;
        accountHasBurst = true;
        // Jump past this burst so one long run is not counted per ticket.
        start = end + 1;
      }
    }
    if (accountHasBurst) burstAccounts += 1;
  }
  return finding({
    id: "TICKET_BURST",
    title: "Ticket bursts per account",
    severity: burstAccounts > 0 ? "medium" : "info",
    category: "ticket_anomaly",
    subject: { kind: "book", id: "f402_live_tickets" },
    observed: {
      burstAccounts,
      bursts: burstEvents,
      capturedTickets: tickets.length,
      windowSeconds: perception.config.detectors.burstWindowSeconds,
      minTickets,
    },
    threshold: {
      windowSeconds: perception.config.detectors.burstWindowSeconds,
      minTickets,
    },
    evidence: [
      evidenceFor(perception, "f402_live_wagers", "LIST[*].InsertDateTime"),
      evidenceFor(perception, "f402_live_bets", "games[*].gameDateTime"),
    ],
    provenance: ["live-api"],
    explanation:
      "Three or more tickets from one account inside the configured window. The captured ticker is a single partial snapshot, so a burst here is a lower bound, not a session-level count.",
    insufficientData: false,
  });
}

function agentConcentrationFinding(
  context: TicketDetectorContext,
): FraudFinding {
  const { perception, tickets, isMissing } = context;
  if (isMissing) {
    return insufficientTicketFinding(
      "AGENT_CONCENTRATION",
      "One agent concentrates the captured ticket volume",
      "agent_scheme",
      perception,
      "F402 live ticket captures are missing or empty.",
    );
  }
  const stakeByAgent = new Map<string, number>();
  let totalStake = 0;
  for (const ticket of tickets) {
    if (ticket.agentId === null || ticket.stakeCents === null) continue;
    stakeByAgent.set(
      ticket.agentId,
      (stakeByAgent.get(ticket.agentId) ?? 0) + Math.abs(ticket.stakeCents),
    );
    totalStake += Math.abs(ticket.stakeCents);
  }
  let topAgent: string | null = null;
  let topStake = 0;
  for (const [agentId, stake] of stakeByAgent) {
    if (stake > topStake) {
      topStake = stake;
      topAgent = agentId;
    }
  }
  const share = round(numeratorShare(topStake, totalStake));
  const threshold = perception.config.detectors.agentConcentrationMinShare;
  return finding({
    id: "AGENT_CONCENTRATION",
    title: "One agent concentrates the captured ticket volume",
    severity: share >= threshold ? "medium" : "info",
    category: "agent_scheme",
    subject: { kind: "agent", id: topAgent ?? "(none)" },
    observed: {
      topAgent,
      topStakeShare: share,
      agents: stakeByAgent.size,
      totalStakeCents: totalStake,
      capturedTickets: tickets.length,
    },
    threshold: { minShare: threshold },
    evidence: [
      evidenceFor(perception, "f402_live_wagers", "LIST[*].AgentID"),
      evidenceFor(perception, "f402_live_bets", "games[*].agent.id"),
    ],
    provenance: ["live-api"],
    explanation:
      "Share of captured stake booked by the largest agent. Agent concentration is expected in a small snapshot; the threshold is reported so the reader can judge scale.",
    insufficientData: false,
  });
}

function vipStakeOutlierFinding(context: TicketDetectorContext): FraudFinding {
  const { perception, tickets, isMissing } = context;
  if (isMissing) {
    return insufficientTicketFinding(
      "VIP_STAKE_OUTLIER",
      "VIP ticket stake outlier",
      "ticket_anomaly",
      perception,
      "F402 live ticket captures are missing or empty.",
    );
  }
  const multiple = perception.config.detectors.vipStakeMultiple;
  const stakes = tickets.flatMap((ticket) =>
    ticket.stakeCents === null ? [] : [Math.abs(ticket.stakeCents)],
  );
  const nonVip = tickets
    .filter((ticket) => !ticket.vip && ticket.stakeCents !== null)
    .map((ticket) => Math.abs(ticket.stakeCents ?? 0));
  const reference = median(nonVip.length > 0 ? nonVip : stakes);
  const vip = tickets.filter((ticket) => ticket.vip);
  const outliers =
    reference === null || reference === 0
      ? []
      : vip.filter(
          (ticket) =>
            ticket.stakeCents !== null &&
            Math.abs(ticket.stakeCents) >= multiple * reference,
        );
  return finding({
    id: "VIP_STAKE_OUTLIER",
    title: "VIP ticket stake outlier",
    severity: outliers.length > 0 ? "low" : "info",
    category: "ticket_anomaly",
    subject: { kind: "book", id: "f402_live_tickets" },
    observed: {
      vipTickets: vip.length,
      outliers: outliers.length,
      referenceMedianCents: reference,
      multiple,
      capturedTickets: tickets.length,
    },
    threshold: { minMultiple: multiple },
    evidence: [
      evidenceFor(
        perception,
        "f402_live_wagers",
        "LIST[*].VIP x AmountWagered",
      ),
    ],
    provenance: ["live-api"],
    explanation:
      "Compares VIP-flagged ticket stakes with the median non-VIP stake in the same snapshot. A high-stakes VIP is expected to bet more; the detector flags only a stake multiple of the desk's own median.",
    insufficientData: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Data-quality findings                                                       */
/* -------------------------------------------------------------------------- */

function dataQualityFindings(perception: FraudPerception): FraudFinding[] {
  const findings: FraudFinding[] = [];
  for (const source of perception.sources) {
    if (!source.stale) continue;
    findings.push(
      finding({
        id: "SOURCE_STALE",
        title: `Stale source: ${source.id}`,
        severity: source.state === "stale" ? "medium" : "info",
        category: "data_quality",
        subject: { kind: "source", id: source.id },
        observed: {
          path: source.path,
          ageSeconds: source.ageSeconds,
          stale: true,
          provenance: source.provenance,
          state: source.state,
        },
        threshold: null,
        evidence: [{ source: source.id, path: source.path, pointer: "mtime" }],
        provenance: [source.provenance],
        explanation: `The ${source.id} artifact is older than its staleness budget; its numbers are shown with their age, not silently trusted. ${source.note}`,
        insufficientData: false,
      }),
    );
  }
  const corpus = perception.sources.find(
    (source) => source.id === "gslive_bet_report",
  );
  if (corpus?.exists === true) {
    findings.push(
      finding({
        id: "SOURCE_EPHEMERAL",
        title: "Bet-report corpus is an untracked, unmanifested Scratch export",
        severity: "medium",
        category: "data_quality",
        subject: { kind: "source", id: "gslive_bet_report" },
        observed: {
          path: corpus.path,
          bytes: corpus.bytes,
          sha256Known: corpus.sha256 !== null,
          ephemeral: true,
        },
        evidence: [
          {
            source: "gslive_bet_report",
            path: corpus.path,
            pointer: "provenance",
          },
        ],
        provenance: ["live-api"],
        explanation:
          "The 55 MB getBetReport export lives under gitignored Scratch/ and is not in the evidence manifest; it can be lost or replaced without a trace. The backup plus sidecar sha256 is the only provenance anchor, so numbers derived from it are labelled ephemeral.",
        insufficientData: false,
      }),
    );
  }
  if (perception.suspectAudit === null) {
    findings.push(
      finding({
        id: "SUSPECT_AUDIT_DEFECT",
        title: "Derived suspect audit missing or untrustworthy",
        severity: "info",
        category: "data_quality",
        subject: { kind: "source", id: "gslive_suspect_audit" },
        observed: { present: false, targetAccount: null },
        evidence: [
          evidenceFor(perception, "gslive_suspect_audit", "targetAccount"),
        ],
        provenance: ["missing"],
        explanation:
          "The derived suspect-account audit is missing, so the known --help target defect cannot even be demonstrated; its numbers are unavailable.",
        insufficientData: true,
      }),
    );
  } else {
    findings.push(
      finding({
        id: "SUSPECT_AUDIT_DEFECT",
        title: "Derived suspect audit ran against a flag, not an account",
        severity: "medium",
        category: "data_quality",
        subject: { kind: "source", id: "gslive_suspect_audit" },
        observed: {
          present: true,
          targetAccount: perception.suspectAudit.targetAccount,
          targetAgent: perception.suspectAudit.targetAgent,
          generatedAt: perception.suspectAudit.generatedAt,
          windowStart: perception.suspectAudit.windowStart,
          windowEnd: perception.suspectAudit.windowEnd,
        },
        threshold: { expectedAccount: "a real account id" },
        evidence: [
          evidenceFor(perception, "gslive_suspect_audit", "targetAccount"),
        ],
        provenance: ["derived"],
        explanation: `${perception.suspectAudit.note}. The file is surfaced as a defect, and its per-account numbers are not treated as observations anywhere in this plugin.`,
        insufficientData: false,
      }),
    );
  }
  if (perception.capture === null) {
    findings.push(
      finding({
        id: "EVIDENCE_ROWS_MISSING",
        title: "getWebLog evidence capture is absent",
        severity: "info",
        category: "data_quality",
        subject: { kind: "source", id: "f402_weblog_capture" },
        observed: { present: false, rowsMissing: true },
        evidence: [
          evidenceFor(
            perception,
            "f402_weblog_capture",
            "response.bodySkeleton.fields.LIST",
          ),
        ],
        provenance: ["missing"],
        explanation:
          "No getWebLog capture exists, so raw weblog rows are MISSING (not zero).",
        insufficientData: true,
      }),
    );
  } else {
    findings.push(
      finding({
        id: "EVIDENCE_ROWS_MISSING",
        title: "getWebLog capture proves only the response shape",
        severity: "medium",
        category: "data_quality",
        subject: { kind: "source", id: "f402_weblog_capture" },
        observed: {
          present: true,
          rowsMissing: perception.capture.rowsMissing,
          status: perception.capture.status,
          responseBytes: perception.capture.responseBytes,
          capturedAt: perception.capture.capturedAt,
          redactionClean: perception.capture.redactionClean,
        },
        evidence: [
          evidenceFor(
            perception,
            "f402_weblog_capture",
            "response.bodySkeleton.fields.LIST",
          ),
        ],
        provenance: ["fixture"],
        explanation: perception.capture.note,
        insufficientData: perception.capture.rowsMissing,
      }),
    );
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run every frozen detector over one perception snapshot. Pure: no I/O, no clock (perception
 * carries the pinned now). Findings are returned in stable (severity, id, subject) order and each
 * one states its provenance and whether it actually ran.
 */
export function runFraudPatterns(
  perception: FraudPerception,
): FraudPatternResult {
  const corpus = corpusContext(perception);
  const rollup = rollupDetectors({
    posture: perception.weblogPosture,
    perception,
  });
  const tickets = ticketContext(perception);
  const findings: FraudFinding[] = [
    suspectedBotFinding(corpus),
    reversedCreditFinding(corpus),
    manualLogFinding(corpus),
    oddsDriftFinding(corpus),
    delayMismatchFinding(corpus),
    stateMixFinding(corpus),
    sharedIpClusterFinding(corpus),
    accountIpFanoutFinding(corpus),
    botRingIpFinding(corpus),
    datacenterIpFinding(corpus),
    agentFlagFinding(corpus),
    ...rollup,
    ...weblogsActivityDetectors(perception),
    roundStakeFinding(tickets),
    longshotConcentrationFinding(tickets),
    writerAgentMismatchFinding(tickets),
    ticketBurstFinding(tickets),
    agentConcentrationFinding(tickets),
    vipStakeOutlierFinding(tickets),
    ...dataQualityFindings(perception),
  ];
  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.subject.id !== b.subject.id) {
      return a.subject.id < b.subject.id ? -1 : 1;
    }
    return 0;
  });
  const bySeverity = Object.fromEntries(
    FRAUD_SEVERITIES.map((severity) => [severity, 0]),
  ) as Record<FraudFindingSeverity, number>;
  const byCategory = Object.fromEntries(
    FRAUD_CATEGORIES.map((category) => [category, 0]),
  ) as Record<FraudFindingCategory, number>;
  for (const item of findings) {
    bySeverity[item.severity] += 1;
    byCategory[item.category] += 1;
  }
  const insufficient = findings
    .filter((item) => item.insufficientData)
    .map((item) => `${item.id}: ${item.explanation}`);
  return { findings, counts: { bySeverity, byCategory }, insufficient };
}

/* -------------------------------------------------------------------------- */
/* Filtering / ranking                                                         */
/* -------------------------------------------------------------------------- */

export interface FraudPatternFilters {
  /** Inclusive minimum severity (default `info`). */
  readonly minSeverity: FraudFindingSeverity;
  readonly category: FraudFindingCategory | null;
  readonly agent: string | null;
  readonly limit: number;
}

export function filterFraudPatterns(
  result: FraudPatternResult,
  filters: FraudPatternFilters,
): FraudPatternResult {
  const minRank = SEVERITY_RANK[filters.minSeverity];
  const agent = filters.agent?.trim().toUpperCase() ?? null;
  const findings = result.findings.filter((item) => {
    if (SEVERITY_RANK[item.severity] > minRank) return false;
    if (filters.category !== null && item.category !== filters.category)
      return false;
    if (agent !== null) {
      const subjectMatch =
        item.subject.kind === "agent" &&
        item.subject.id.trim().toUpperCase() === agent;
      const observedMatch = Object.values(item.observed).some(
        (value) => typeof value === "string" && value.toUpperCase() === agent,
      );
      if (!subjectMatch && !observedMatch) return false;
    }
    return true;
  });
  const bySeverity = Object.fromEntries(
    FRAUD_SEVERITIES.map((severity) => [severity, 0]),
  ) as Record<FraudFindingSeverity, number>;
  const byCategory = Object.fromEntries(
    FRAUD_CATEGORIES.map((category) => [category, 0]),
  ) as Record<FraudFindingCategory, number>;
  for (const item of findings) {
    bySeverity[item.severity] += 1;
    byCategory[item.category] += 1;
  }
  const insufficient = findings
    .filter((item) => item.insufficientData)
    .map((item) => `${item.id}: ${item.explanation}`);
  return {
    findings: findings.slice(0, filters.limit),
    counts: { bySeverity, byCategory },
    insufficient,
  };
}

/** Findings that point at one dossier subject (account/agent), avoiding a full detector rerun. */
export function findingsForSubject(
  findings: readonly FraudFinding[],
  subject: { readonly kind: "account" | "agent"; readonly id: string },
): readonly FraudFinding[] {
  const wanted = subject.id.trim().toUpperCase();
  return findings.filter(
    (item) =>
      item.subject.id.trim().toUpperCase() === wanted &&
      (item.subject.kind === subject.kind ||
        item.subject.kind === "agent" ||
        item.subject.kind === "book"),
  );
}

/** Hierarchy helper re-exported for the CLI dossier payload. */
export function dossierHierarchy(
  perception: FraudPerception,
  agentId: string | null,
): ReturnType<typeof agentHierarchy> {
  return agentHierarchy(perception.agentIndex, agentId);
}
