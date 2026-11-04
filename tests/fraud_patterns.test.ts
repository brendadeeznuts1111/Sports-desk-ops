import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  loadFraudPerception,
  type FraudPerception,
} from "../lib/fraud_logs.ts";
import {
  FRAUD_CATEGORIES,
  FRAUD_SEVERITIES,
  filterFraudPatterns,
  findingsForSubject,
  runFraudPatterns,
  type FraudFinding,
  type FraudPatternResult,
} from "../lib/fraud_patterns.ts";
import {
  buildFixtureRoot,
  fixedNow,
  FIXED_NOW_ISO,
  makeRoot,
  readFixtureJson,
} from "./fixtures/fraud/support.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function track(root: string): string {
  roots.push(root);
  return root;
}

async function fixturePerception(
  options: Parameters<typeof buildFixtureRoot>[0] = {},
  now: Date = fixedNow(),
): Promise<{ perception: FraudPerception; result: FraudPatternResult }> {
  const root = track(buildFixtureRoot(options));
  const perception = await loadFraudPerception({ root, now });
  return { perception, result: runFraudPatterns(perception) };
}

function rawFixtureIps(): readonly string[] {
  const document = readFixtureJson("betreport-small.json") as {
    r: { bets: Record<string, unknown>[] };
  };
  return [
    ...new Set(
      document.r.bets
        .map((bet) => String(bet["ipAddress"] ?? "").trim())
        .filter((value) => value !== ""),
    ),
  ];
}

function finding(
  result: FraudPatternResult,
  id: string,
): FraudFinding | undefined {
  return result.findings.find((item) => item.id === id);
}

const CATALOG_IDS = [
  // gslive_bet_report
  "SUSPECTED_BOT_BET",
  "REVERSED_CREDIT_BET",
  "MANUAL_LOG_BET",
  "ODDS_DRIFT_BET",
  "DELAY_MISMATCH_BET",
  "STATE_MIX_ANOMALY",
  "SHARED_IP_CLUSTER",
  "ACCOUNT_IP_FANOUT",
  "BOT_RING_IP_RANGE",
  "DATACENTER_IP_CLASS",
  "AGENT_FLAG_CONCENTRATION",
  // f402_weblog_rollup
  "EXECUTION_SNIPERS",
  "SNIPER_TWINS",
  "LINE_SHOPPERS",
  "BOT_RING_ACCOUNTS",
  "CROSS_OFFICE_BEARDS",
  "IP_CLASS_ANOMALY",
  "WEBLOG_GATE_FAIL",
  // gslive weblog activity
  "STEAM_15S_5S",
  "CLINCH_AT_PLACEMENT",
  "CONFIRM_BYPASS",
  "DONOR_SHIELD",
  "TROJAN_HORSE",
  "MANUAL_ADMIN_INTERVENTION",
  // f402 live tickets
  "ROUND_STAKE_LADDER",
  "LONGSHOT_CONCENTRATION",
  "WRITER_AGENT_MISMATCH",
  "TICKET_BURST",
  "AGENT_CONCENTRATION",
  "VIP_STAKE_OUTLIER",
  // data quality
  "SOURCE_STALE",
  "SOURCE_EPHEMERAL",
  "SUSPECT_AUDIT_DEFECT",
  "EVIDENCE_ROWS_MISSING",
] as const;

/* -------------------------------------------------------------------------- */
/* Catalog coverage and counts                                                 */
/* -------------------------------------------------------------------------- */

describe("detector catalog", () => {
  test("runs every frozen detector id exactly once per subject", async () => {
    const { result } = await fixturePerception();
    const ids = new Set(result.findings.map((item) => item.id));
    for (const id of CATALOG_IDS) {
      if (id === "SOURCE_STALE") continue; // no stale source at the pinned fixture clock
      expect(ids.has(id)).toBe(true);
    }
    expect(result.findings.length).toBeGreaterThanOrEqual(33);
    // Counts are sums over the returned findings, not independently invented numbers.
    const severitySum = Object.values(result.counts.bySeverity).reduce(
      (sum, value) => sum + value,
      0,
    );
    const categorySum = Object.values(result.counts.byCategory).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(severitySum).toBe(result.findings.length);
    expect(categorySum).toBe(result.findings.length);
    expect(Object.keys(result.counts.bySeverity)).toEqual([
      ...FRAUD_SEVERITIES,
    ]);
    expect(Object.keys(result.counts.byCategory)).toEqual([
      ...FRAUD_CATEGORIES,
    ]);
    for (const item of result.findings) {
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.provenance.length).toBeGreaterThan(0);
      expect(item.explanation.length).toBeGreaterThan(10);
      expect(FRAUD_SEVERITIES).toContain(item.severity);
      expect(FRAUD_CATEGORIES).toContain(item.category);
    }
  });

  test("findings are deterministic (same snapshot -> identical JSON)", async () => {
    const { perception } = await fixturePerception();
    const first = JSON.stringify(runFraudPatterns(perception));
    const second = JSON.stringify(runFraudPatterns(perception));
    expect(second).toBe(first);
  });

  test("no finding carries a raw IP address", async () => {
    const { result } = await fixturePerception();
    const serialized = JSON.stringify(result.findings);
    for (const ip of rawFixtureIps()) {
      expect(serialized.includes(ip)).toBe(false);
    }
    for (const item of result.findings) {
      for (const value of Object.values(item.observed)) {
        expect(typeof value === "string" ? value : "").not.toMatch(
          /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* gslive_bet_report detectors                                                 */
/* -------------------------------------------------------------------------- */

describe("bet-report detectors on the fixture corpus", () => {
  test("weak labels are counted from rows", async () => {
    const { result } = await fixturePerception();
    const bot = finding(result, "SUSPECTED_BOT_BET");
    expect(bot?.severity).toBe("high");
    expect(bot?.observed["rows"]).toBe(2);
    expect(bot?.observed["accounts"]).toBe(2);
    const reversed = finding(result, "REVERSED_CREDIT_BET");
    expect(reversed?.observed["rows"]).toBe(1);
    const manual = finding(result, "MANUAL_LOG_BET");
    expect(manual?.observed["rows"]).toBe(1);
    expect(manual?.observed["withAdminUser"]).toBe(1);
    const drift = finding(result, "ODDS_DRIFT_BET");
    expect(drift?.observed["rows"]).toBe(1);
    expect(drift?.observed["improved"]).toBe(1);
    expect(drift?.category).toBe("line_shopping");
  });

  test("delay mismatch reuses classifyDelayElapsedSec", async () => {
    const { result } = await fixturePerception();
    const mismatch = finding(result, "DELAY_MISMATCH_BET");
    expect(mismatch?.observed["rows"]).toBe(1);
    expect(mismatch?.observed["maxElapsedSec"]).toBe(35);
    expect(mismatch?.threshold?.["maxElapsedSec"]).toBe(5);
  });

  test("IP-network detectors use masked keys and the repo classifier", async () => {
    const { result } = await fixturePerception();
    const shared = finding(result, "SHARED_IP_CLUSTER");
    expect(shared?.observed["sharedIps"]).toBe(1);
    expect(shared?.observed["maxAccountsPerIp"]).toBe(3);
    expect(shared?.observed["topClusterMasked"]).toBe("47.223.***.***");
    const fanout = finding(result, "ACCOUNT_IP_FANOUT");
    expect(fanout?.observed["accounts"]).toBe(2);
    expect(fanout?.observed["highFanoutAccounts"]).toBe(1);
    const botRing = finding(result, "BOT_RING_IP_RANGE");
    expect(botRing?.observed["rows"]).toBe(2);
    expect(botRing?.threshold?.["cidr"]).toBe("140.248.0.0/16");
    const datacenter = finding(result, "DATACENTER_IP_CLASS");
    expect(datacenter?.observed["rows"]).toBe(1);
    expect(datacenter?.observed["classes"]).toBe("ICLOUD_RELAY");
  });

  test("agent flag concentration names a desk agent subject", async () => {
    const { result } = await fixturePerception();
    const concentration = finding(result, "AGENT_FLAG_CONCENTRATION");
    expect(concentration?.observed["agents"]).toBe(2);
    expect(concentration?.subject.kind).toBe("agent");
    expect(concentration?.subject.id).toBe("AG2");
    expect(concentration?.observed["topAgentFlagRate"]).toBeCloseTo(0.6667, 3);
  });

  test("state mix reports the settled snapshot shape", async () => {
    const { result } = await fixturePerception();
    const stateMix = finding(result, "STATE_MIX_ANOMALY");
    expect(stateMix?.observed["rows"]).toBe(16);
    expect(stateMix?.observed["lose"]).toBe(13);
    expect(stateMix?.observed["winShare"]).toBeCloseTo(1 / 16, 4);
  });
});

/* -------------------------------------------------------------------------- */
/* WebLog rollup + GSLive activity detectors                                   */
/* -------------------------------------------------------------------------- */

describe("weblog detectors", () => {
  test("rollup findings use the rollup's own counts and gates", async () => {
    const { result } = await fixturePerception();
    const snipers = finding(result, "EXECUTION_SNIPERS");
    expect(snipers?.observed["accounts"]).toBe(12);
    const twins = finding(result, "SNIPER_TWINS");
    expect(twins?.observed["accounts"]).toBe(3);
    const botRing = finding(result, "BOT_RING_ACCOUNTS");
    expect(botRing?.observed["accounts"]).toBe(7);
    const gate = finding(result, "WEBLOG_GATE_FAIL");
    expect(gate?.severity).toBe("critical");
    expect(gate?.observed["failed"]).toBe(1);
    const ipClass = finding(result, "IP_CLASS_ANOMALY");
    expect(ipClass?.observed["botRingRows"]).toBe(98);
    // The crafted rollup is the newest of exactly one file; no earlier files are claimed.
    const { perception } = await fixturePerception();
    expect(perception.weblogPosture?.files).toHaveLength(1);
  });

  test("a missing rollup makes every rollup detector insufficient, not zero", async () => {
    const { result } = await fixturePerception({ weblogRollup: false });
    const rollupIds = [
      "EXECUTION_SNIPERS",
      "SNIPER_TWINS",
      "LINE_SHOPPERS",
      "BOT_RING_ACCOUNTS",
      "CROSS_OFFICE_BEARDS",
      "IP_CLASS_ANOMALY",
      "WEBLOG_GATE_FAIL",
    ];
    for (const id of rollupIds) {
      const item = finding(result, id);
      expect(item?.insufficientData).toBe(true);
      expect(item?.provenance).toEqual(["missing"]);
    }
    expect(result.insufficient.length).toBeGreaterThanOrEqual(rollupIds.length);
  });

  test("the GSLive activity artifact maps existing audit codes when present", async () => {
    const { result } = await fixturePerception({ gsliveWeblogs: true });
    const steam = finding(result, "STEAM_15S_5S");
    expect(steam?.insufficientData).toBe(false);
    expect(steam?.observed["flaggedAccounts"]).toBe(1);
    expect(steam?.observed["SUB_15S_SCORE_SNIPE"]).toBe(2);
    const bypass = finding(result, "CONFIRM_BYPASS");
    expect(bypass?.observed["ACCEPTED_WHILE_BLOCKED"]).toBe(1);
    expect(bypass?.provenance).toEqual(["api-log-rollup"]);
    const shield = finding(result, "DONOR_SHIELD");
    expect(shield?.observed["MANUAL_ADMIN_INTERVENTION"]).toBe(2);
    const trojan = finding(result, "TROJAN_HORSE");
    expect(trojan?.observed["FROZEN_CLOCK_SCORING_OR_PLAY"]).toBe(1);
  });

  test("the missing activity artifact reports insufficientData today", async () => {
    const { result } = await fixturePerception();
    for (const id of [
      "STEAM_15S_5S",
      "CLINCH_AT_PLACEMENT",
      "CONFIRM_BYPASS",
      "DONOR_SHIELD",
      "TROJAN_HORSE",
      "MANUAL_ADMIN_INTERVENTION",
    ]) {
      const item = finding(result, id);
      expect(item?.insufficientData).toBe(true);
      expect(item?.observed["activityStatus"]).toBe("not_measured");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* F402 live ticket detectors                                                  */
/* -------------------------------------------------------------------------- */

describe("F402 live ticket detectors", () => {
  test("ticket-capture detectors fire on the crafted tickets", async () => {
    const { result } = await fixturePerception();
    const mismatch = finding(result, "WRITER_AGENT_MISMATCH");
    expect(mismatch?.observed["mismatches"]).toBe(1);
    const burst = finding(result, "TICKET_BURST");
    expect(burst?.observed["burstAccounts"]).toBe(2);
    expect(burst?.observed["bursts"]).toBe(4);
    const vip = finding(result, "VIP_STAKE_OUTLIER");
    expect(vip?.observed["vipTickets"]).toBe(1);
    expect(vip?.observed["outliers"]).toBe(1);
    const longshot = finding(result, "LONGSHOT_CONCENTRATION");
    expect(longshot?.observed["accounts"]).toBe(1);
    const round = finding(result, "ROUND_STAKE_LADDER");
    expect(Number(round?.observed["tickets"])).toBeGreaterThan(0);
  });

  test("missing ticket captures make ticket detectors insufficient", async () => {
    const { result } = await fixturePerception({ liveTickets: false });
    for (const id of [
      "ROUND_STAKE_LADDER",
      "LONGSHOT_CONCENTRATION",
      "WRITER_AGENT_MISMATCH",
      "TICKET_BURST",
      "AGENT_CONCENTRATION",
      "VIP_STAKE_OUTLIER",
    ]) {
      const item = finding(result, id);
      expect(item?.insufficientData).toBe(true);
      expect(item?.observed["tickets"]).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Data-quality detectors                                                      */
/* -------------------------------------------------------------------------- */

describe("data-quality detectors", () => {
  test("stale sources produce one SOURCE_STALE finding each", async () => {
    const { result, perception } = await fixturePerception(
      {},
      new Date("2026-12-01T00:00:00.000Z"),
    );
    const stale = result.findings.filter((item) => item.id === "SOURCE_STALE");
    const staleSourceIds = perception.sources
      .filter((source) => source.stale)
      .map((source) => source.id);
    expect(staleSourceIds.length).toBeGreaterThan(0);
    expect(stale).toHaveLength(staleSourceIds.length);
    for (const item of stale) {
      expect(item.category).toBe("data_quality");
      expect(item.threshold).toBeNull();
    }
  });

  test("the corpus is labelled ephemeral and the audit defect is surfaced", async () => {
    const { result } = await fixturePerception();
    const ephemeral = finding(result, "SOURCE_EPHEMERAL");
    expect(ephemeral?.observed["ephemeral"]).toBe(true);
    expect(ephemeral?.category).toBe("data_quality");
    const defect = finding(result, "SUSPECT_AUDIT_DEFECT");
    expect(defect?.observed["targetAccount"]).toBe("--help");
    expect(defect?.severity).toBe("medium");
    const missingRows = finding(result, "EVIDENCE_ROWS_MISSING");
    expect(missingRows?.observed["rowsMissing"]).toBe(true);
    expect(missingRows?.insufficientData).toBe(true);
  });

  test("a missing corpus makes every corpus detector insufficient", async () => {
    const root = track(makeRoot());
    const perception = await loadFraudPerception({
      root,
      now: new Date(FIXED_NOW_ISO),
    });
    const result = runFraudPatterns(perception);
    for (const id of [
      "SUSPECTED_BOT_BET",
      "REVERSED_CREDIT_BET",
      "MANUAL_LOG_BET",
      "ODDS_DRIFT_BET",
      "DELAY_MISMATCH_BET",
      "STATE_MIX_ANOMALY",
      "SHARED_IP_CLUSTER",
      "ACCOUNT_IP_FANOUT",
      "BOT_RING_IP_RANGE",
      "DATACENTER_IP_CLASS",
      "AGENT_FLAG_CONCENTRATION",
    ]) {
      const item = finding(result, id);
      expect(item?.insufficientData).toBe(true);
      expect(item?.observed["rows"]).toBeNull();
    }
    expect(result.findings.length).toBeGreaterThan(0);
    for (const item of result.findings) {
      expect(item.explanation).not.toContain("0 rows");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Filtering and subject lookup                                                */
/* -------------------------------------------------------------------------- */

describe("pattern filtering", () => {
  test("filters by severity, category, agent and limit", async () => {
    const { result } = await fixturePerception();
    const high = filterFraudPatterns(result, {
      minSeverity: "high",
      category: null,
      agent: null,
      limit: 100,
    });
    expect(high.findings.length).toBeGreaterThan(0);
    expect(
      high.findings.every(
        (item) => item.severity === "high" || item.severity === "critical",
      ),
    ).toBe(true);
    const ipNetwork = filterFraudPatterns(result, {
      minSeverity: "info",
      category: "ip_network",
      agent: null,
      limit: 100,
    });
    expect(ipNetwork.findings.length).toBeGreaterThan(0);
    expect(
      ipNetwork.findings.every((item) => item.category === "ip_network"),
    ).toBe(true);
    const agent = filterFraudPatterns(result, {
      minSeverity: "info",
      category: null,
      agent: "AG2",
      limit: 100,
    });
    expect(agent.findings.length).toBeGreaterThan(0);
    const limited = filterFraudPatterns(result, {
      minSeverity: "info",
      category: null,
      agent: null,
      limit: 2,
    });
    expect(limited.findings).toHaveLength(2);
    // Counts describe every matching finding; `limit` only caps the returned list.
    const allMatches = filterFraudPatterns(result, {
      minSeverity: "info",
      category: null,
      agent: null,
      limit: 100,
    });
    expect(limited.counts).toEqual(allMatches.counts);
    expect(
      Object.values(limited.counts.bySeverity).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBeGreaterThan(2);
  });

  test("findingsForSubject matches account/agent subjects only", async () => {
    const { result } = await fixturePerception();
    const agentFindings = findingsForSubject(result.findings, {
      kind: "agent",
      id: "AG2",
    });
    expect(agentFindings.length).toBeGreaterThan(0);
    expect(agentFindings.every((item) => item.subject.kind === "agent")).toBe(
      true,
    );
    const unknown = findingsForSubject(result.findings, {
      kind: "account",
      id: "NOBODY",
    });
    expect(unknown).toHaveLength(0);
  });
});
