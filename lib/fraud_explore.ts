/**
 * @file fraud_explore.ts
 * @description Read-only pattern exploration over the GSLive corpus. This deliberately does NOT add
 * frozen detectors: it (a) maps the research backlog's proposed detectors to the raw fields this
 * corpus actually carries, and (b) surfaces descriptive account-level candidates that a human can
 * triage. Every candidate is labelled exploratory — no threshold verdict, no fraud probability.
 *
 * Pure over its inputs (corpus + optional research catalog), so the output is deterministic and
 * testable without the 55 MB corpus.
 */

import type {
  FraudBetRecord,
  FraudCorpus,
  FraudPerception,
} from "./fraud_logs.ts";

/** Local exploration constants (reported in the payload, not hidden thresholds). */
export const EXPLORATION_CONSTANTS = {
  /** Minimum bets before an account is eligible for the entropy / concentration candidates. */
  minBets: 20,
  /** Candidate rows returned per candidate (bounded again by the CLI --limit). */
  maxRows: 10,
  /** Market-entropy bucket, named after the upstream API fields. */
  entropyBucket: "sport|subSport|period|wagerType|line",
} as const;

export interface BacklogFieldAvailability {
  readonly field: string;
  readonly available: boolean;
  /** How the raw field maps onto the normalized record, or why it is absent. */
  readonly via: string;
}

export interface BacklogEntry {
  readonly id: string;
  readonly status: string;
  readonly implemented: boolean;
  readonly fields: readonly BacklogFieldAvailability[];
  readonly allListedFieldsAvailable: boolean;
  readonly rationale: string | null;
}

export interface EntropyCandidateRow {
  readonly account: string;
  readonly agent: string | null;
  readonly bets: number;
  readonly entropyBits: number;
  readonly bucketCount: number;
  readonly topBucketShare: number;
}

export interface UnattributedOverrideRow {
  readonly account: string;
  readonly agent: string | null;
  readonly manualLogRows: number;
  readonly rowsWithoutAdminUser: number;
  readonly share: number;
}

export interface StakeConcentrationRow {
  readonly account: string;
  readonly agent: string | null;
  readonly bets: number;
  readonly topStakeShare: number;
  readonly topStakeUsd: number | null;
}

export interface ExplorationCandidate<Row> {
  readonly id: string;
  readonly status: "exploratory";
  readonly question: string;
  readonly method: string;
  readonly caveat: string;
  readonly rows: readonly Row[];
  readonly omittedRows: number;
}

export interface VocabularyEntry {
  /** Normalized record field carrying the value. */
  readonly normalized: string;
  /** Upstream raw field(s) it comes from. */
  readonly raw: string;
  readonly note: string | null;
}

export interface ExploredVocabulary {
  readonly sport: VocabularyEntry;
  readonly subSport: VocabularyEntry;
  readonly period: VocabularyEntry;
  readonly wagerType: VocabularyEntry;
  readonly line: VocabularyEntry;
}

export interface FraudExplorationResult {
  readonly constants: typeof EXPLORATION_CONSTANTS;
  readonly vocabulary: ExploredVocabulary;
  readonly corpus: {
    readonly rows: number;
    readonly accounts: number;
    readonly agents: number;
  };
  readonly frozenDetectors: readonly string[];
  readonly backlog: readonly BacklogEntry[];
  readonly candidates: {
    readonly marketEntropy: ExplorationCandidate<EntropyCandidateRow>;
    readonly unattributedOverride: ExplorationCandidate<UnattributedOverrideRow>;
    readonly stakeConcentration: ExplorationCandidate<StakeConcentrationRow>;
  };
  readonly limits: readonly string[];
}

export interface FraudExplorationInput {
  readonly corpus: FraudCorpus;
  readonly catalog: unknown;
  readonly frozenDetectorIds: readonly string[];
  readonly limit: number;
}

/** Raw getBetReport field → normalized accessor. Unknown fields are reported unavailable. */
const RAW_FIELD_PROBES: Readonly<
  Record<
    string,
    {
      readonly via: string;
      readonly present: (record: FraudBetRecord) => boolean;
    }
  >
> = {
  userID: { via: "record.userId", present: (r) => r.userId.trim() !== "" },
  eID: { via: "record.eventId", present: (r) => r.eventId !== null },
  period: {
    via: "record.period (API period code: m, h1, s2, …)",
    present: (r) => r.period !== null,
  },
  subSport: {
    via: "record.subSport (F402 tickets carry it; getBetReport has no sub-sport column)",
    present: (r) => r.subSport !== null,
  },
  wagerType: {
    via: "record.wagerType (getBetReport type / F402 WagerType: S/E/G/M/T/…)",
    present: (r) => r.wagerType !== null,
  },
  logTime: { via: "record.placedAtMs", present: (r) => r.placedAtMs !== null },
  accept: { via: "record.acceptSec", present: (r) => r.acceptSec !== null },
  delay: { via: "record.delaySec", present: (r) => r.delaySec !== null },
  state: { via: "record.stateCode", present: (r) => r.stateCode !== null },
  agent: { via: "record.agentId", present: (r) => r.agentId !== null },
  ipAddress: {
    via: "record.ipTag (masked at parse)",
    present: (r) => r.ipTag !== null,
  },
  fVal: { via: "record.oddsPlaced", present: (r) => r.oddsPlaced !== null },
  fVal_new: {
    via: "record.oddsAccepted",
    present: (r) => r.oddsAccepted !== null,
  },
  bet: { via: "record.stakeCents", present: (r) => r.stakeCents !== null },
  toWin: { via: "record.toWinCents", present: (r) => r.toWinCents !== null },
  result: { via: "record.resultCode", present: (r) => r.resultCode !== null },
  sport: {
    via: "record.sport (getBetReport sID/displaySportId is an id; F402 tickets carry a name)",
    present: (r) => r.sport !== null,
  },
  line: {
    via: "record.lineHundredths (constant 0: the getBetReport capture has no line column)",
    present: () => false,
  },
  manualLogExists: { via: "record.manualLog", present: (r) => r.manualLog },
  adminUser: { via: "record.adminUser", present: (r) => r.adminUser !== null },
  // Fields the corpus does not carry (KYC, payment instruments, settlement timestamps, device
  // ids, closing odds, registration/first-bet timestamps, lifetime values) are intentionally not
  // in this map: they report as unavailable rather than being guessed.
};

function availabilityFor(
  field: string,
  records: readonly FraudBetRecord[],
): BacklogFieldAvailability {
  const probe = RAW_FIELD_PROBES[field];
  if (probe === undefined) {
    return {
      field,
      available: false,
      via: "not present in this corpus (or not mapped); would need a new source",
    };
  }
  const any = records.some((record) => probe.present(record));
  return { field, available: any, via: probe.via };
}

function parseCatalog(catalog: unknown): Record<string, unknown> | null {
  return catalog !== null &&
    typeof catalog === "object" &&
    !Array.isArray(catalog)
    ? (catalog as Record<string, unknown>)
    : null;
}

function proposedEntries(catalog: unknown): readonly Record<string, unknown>[] {
  const record = parseCatalog(catalog);
  const proposed = record?.["proposedDetectors"];
  if (!Array.isArray(proposed)) return [];
  return proposed.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

function backlogOf(
  catalog: unknown,
  records: readonly FraudBetRecord[],
): readonly BacklogEntry[] {
  return proposedEntries(catalog)
    .map((entry): BacklogEntry | null => {
      const id = typeof entry["id"] === "string" ? entry["id"] : null;
      if (id === null) return null;
      const status =
        typeof entry["status"] === "string" ? entry["status"] : "unknown";
      const implemented = status === "implemented";
      const fieldsRaw = entry["fields"];
      const fields = Array.isArray(fieldsRaw)
        ? fieldsRaw
            .filter((field): field is string => typeof field === "string")
            .map((field) => availabilityFor(field, records))
        : [];
      return {
        id,
        status,
        implemented,
        fields,
        allListedFieldsAvailable:
          fields.length > 0 && fields.every((field) => field.available),
        rationale:
          typeof entry["rationale"] === "string" ? entry["rationale"] : null,
      };
    })
    .filter((entry): entry is BacklogEntry => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

interface AccountScan {
  readonly account: string;
  agent: string | null;
  bets: number;
  readonly buckets: Map<string, number>;
  manualLogRows: number;
  rowsWithoutAdminUser: number;
  readonly stakeCents: number[];
}

function entropyBits(buckets: Map<string, number>, total: number): number {
  if (total <= 0 || buckets.size <= 1) return 0;
  let bits = 0;
  for (const count of buckets.values()) {
    const p = count / total;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function topShare(values: readonly number[], total: number): number {
  if (total <= 0) return 0;
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max / total;
}

function scanAccounts(corpus: FraudCorpus): readonly AccountScan[] {
  const byAccount = new Map<string, AccountScan>();
  for (const record of corpus.records) {
    const key = record.userId.trim().toUpperCase();
    if (key === "") continue;
    const agent = record.agentId === null ? null : record.agentId.trim();
    const existing = byAccount.get(key);
    const scan =
      existing ??
      ((): AccountScan => {
        const created: AccountScan = {
          account: record.userId.trim(),
          agent,
          bets: 0,
          buckets: new Map<string, number>(),
          manualLogRows: 0,
          rowsWithoutAdminUser: 0,
          stakeCents: [],
        };
        byAccount.set(key, created);
        return created;
      })();
    scan.bets += 1;
    if (scan.agent === null && agent !== null) scan.agent = agent;
    const bucket =
      `${record.sport ?? "?"}|${record.subSport ?? "?"}|${record.period ?? "?"}|` +
      `${record.wagerType ?? "?"}|${record.lineHundredths ?? "?"}`;
    scan.buckets.set(bucket, (scan.buckets.get(bucket) ?? 0) + 1);
    if (record.manualLog) {
      scan.manualLogRows += 1;
      if (record.adminUser === null) scan.rowsWithoutAdminUser += 1;
    }
    if (record.stakeCents !== null) scan.stakeCents.push(record.stakeCents);
  }
  return [...byAccount.values()];
}

const ENTROPY_CAVEAT =
  "Descriptive specialisation signal only (the MARKET_ENTROPY proposal). Low entropy can be a " +
  "legitimate niche bettor; this is not a finding and carries no threshold verdict.";
const OVERRIDE_CAVEAT =
  "Descriptive attribution gap only (the OVERRIDE_AUDIT proposal). A manual-log row without an " +
  "adminUser is an audit gap to inspect, not evidence of fraud by the account.";
const STAKE_CAVEAT =
  "Descriptive stake concentration only. A single large stake is not fraud; this ranks accounts " +
  "for a human look and is not a finding.";

function candidatesOf(
  scans: readonly AccountScan[],
  limit: number,
): FraudExplorationResult["candidates"] {
  const minBets = EXPLORATION_CONSTANTS.minBets;
  const eligible = scans.filter((scan) => scan.bets >= minBets);
  const maxRows = Math.max(1, Math.min(limit, EXPLORATION_CONSTANTS.maxRows));

  const entropyRows: EntropyCandidateRow[] = eligible
    .map((scan) => {
      let top = 0;
      for (const count of scan.buckets.values()) if (count > top) top = count;
      return {
        account: scan.account,
        agent: scan.agent,
        bets: scan.bets,
        entropyBits: Number(entropyBits(scan.buckets, scan.bets).toFixed(3)),
        bucketCount: scan.buckets.size,
        topBucketShare: Number((top / scan.bets).toFixed(4)),
      };
    })
    .sort(
      (left, right) =>
        left.entropyBits - right.entropyBits ||
        right.bets - left.bets ||
        left.account.localeCompare(right.account),
    );

  const overrideRows: UnattributedOverrideRow[] = scans
    .filter((scan) => scan.manualLogRows > 0)
    .map((scan) => ({
      account: scan.account,
      agent: scan.agent,
      manualLogRows: scan.manualLogRows,
      rowsWithoutAdminUser: scan.rowsWithoutAdminUser,
      share: Number(
        (scan.rowsWithoutAdminUser / scan.manualLogRows).toFixed(4),
      ),
    }))
    .sort(
      (left, right) =>
        right.rowsWithoutAdminUser - left.rowsWithoutAdminUser ||
        right.manualLogRows - left.manualLogRows ||
        left.account.localeCompare(right.account),
    );

  const stakeEligible = scans.filter((scan) => scan.bets >= 5);
  const stakeRows: StakeConcentrationRow[] = stakeEligible
    .map((scan) => {
      const total = scan.stakeCents.reduce((sum, value) => sum + value, 0);
      const max = scan.stakeCents.reduce(
        (top, value) => (value > top ? value : top),
        0,
      );
      return {
        account: scan.account,
        agent: scan.agent,
        bets: scan.bets,
        topStakeShare: Number(topShare(scan.stakeCents, total).toFixed(4)),
        topStakeUsd: total === 0 ? null : Number((max / 100).toFixed(2)),
      };
    })
    .sort(
      (left, right) =>
        right.topStakeShare - left.topStakeShare ||
        right.bets - left.bets ||
        left.account.localeCompare(right.account),
    );

  return {
    marketEntropy: {
      id: "MARKET_ENTROPY",
      status: "exploratory",
      question:
        "Which high-volume accounts concentrate on the fewest market buckets?",
      method:
        `Shannon entropy (bits) over the API vocabulary bucket ` +
        `${EXPLORATION_CONSTANTS.entropyBucket} per account, accounts with >= ${minBets} bets, ` +
        `ascending entropy.`,
      caveat: ENTROPY_CAVEAT,
      rows: entropyRows.slice(0, maxRows),
      omittedRows: Math.max(0, entropyRows.length - maxRows),
    },
    unattributedOverride: {
      id: "OVERRIDE_AUDIT",
      status: "exploratory",
      question: "Which manual-log rows lack an adminUser attribution?",
      method:
        "Per account: manualLog rows and the subset with a null adminUser, sorted by the gap.",
      caveat: OVERRIDE_CAVEAT,
      rows: overrideRows.slice(0, maxRows),
      omittedRows: Math.max(0, overrideRows.length - maxRows),
    },
    stakeConcentration: {
      id: "STAKE_CONCENTRATION",
      status: "exploratory",
      question:
        "Which accounts put the largest share of their stake into one bet?",
      method: "Per account with >= 5 bets: max single stake / total stake.",
      caveat: STAKE_CAVEAT,
      rows: stakeRows.slice(0, maxRows),
      omittedRows: Math.max(0, stakeRows.length - maxRows),
    },
  };
}

/** Build the exploration payload. Deterministic for a fixed corpus/catalog/limit. */
export function buildFraudExploration(
  input: FraudExplorationInput,
): FraudExplorationResult {
  const scans = scanAccounts(input.corpus);
  return {
    constants: EXPLORATION_CONSTANTS,
    vocabulary: {
      sport: {
        normalized: "record.sport",
        raw: "getBetReport sID/displaySportId; F402 tickets sport",
        note: "The getBetReport capture carries a sport id, not a sport name; tickets carry a name.",
      },
      subSport: {
        normalized: "record.subSport",
        raw: "F402 game subSport; getBetReport has no column",
        note: "Unavailable in the getBetReport corpus; present only on F402 ticket captures.",
      },
      period: {
        normalized: "record.period",
        raw: "getBetReport period / F402 period",
        note: "Kept verbatim as the API code (m, h1, s2, …); the numeric encoding stays at record.periodCode.",
      },
      wagerType: {
        normalized: "record.wagerType",
        raw: "getBetReport type; F402 WagerType",
        note: null,
      },
      line: {
        normalized: "record.lineHundredths",
        raw: "no line column in the 69-field capture",
        note: "Constant 0 today; the availability map reports it as unavailable.",
      },
    },
    corpus: {
      rows: input.corpus.rows,
      accounts: input.corpus.accounts,
      agents: input.corpus.agents,
    },
    frozenDetectors: [...new Set(input.frozenDetectorIds)].sort(),
    backlog: backlogOf(input.catalog, input.corpus.records),
    candidates: candidatesOf(scans, input.limit),
    limits: [
      "Exploration only: these candidates are descriptive, not frozen detectors or findings.",
      "No threshold verdict: rows are sorted for a human look; a low-entropy niche bettor or a " +
        "single large stake is not fraud on its own.",
      "Backlog unavailable fields mean the source does not carry them; a proposed detector that " +
        "needs one cannot be implemented from this corpus alone.",
      "All listed fields being available does not imply the detector is implementable: the " +
        "rationale may need fields the research entry did not list (CLV needs a closing line, KYC " +
        "needs verification state, SETTLE_BYPASS needs settlement timestamps).",
      "No account-facing decision should cite an exploratory row as evidence.",
      "Field names follow the upstream API vocabulary (sport, subSport, period, wagerType, " +
        "line); the vocabulary block maps each to its normalized record field and raw source.",
    ],
  };
}

/** Convenience for the CLI: perception already carries the corpus. */
export function explorePerception(
  perception: FraudPerception,
  catalog: unknown,
  frozenDetectorIds: readonly string[],
  limit: number,
): FraudExplorationResult {
  if (perception.corpus === null) {
    throw new Error("explorePerception: corpus is missing");
  }
  return buildFraudExploration({
    corpus: perception.corpus,
    catalog,
    frozenDetectorIds,
    limit,
  });
}
