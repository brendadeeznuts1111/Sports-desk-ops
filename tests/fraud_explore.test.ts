import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { FraudBetRecord, FraudCorpus } from "../lib/fraud_logs.ts";
import { loadFraudPerception } from "../lib/fraud_logs.ts";
import { runFraudPatterns } from "../lib/fraud_patterns.ts";
import { buildFraudExploration } from "../lib/fraud_explore.ts";
import { buildFixtureRoot, fixedNow } from "./fixtures/fraud/support.ts";

const ROOT = join(import.meta.dir, "..");
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

function record(overrides: Partial<FraudBetRecord>): FraudBetRecord {
  return {
    betId: "b1",
    userId: "A1",
    agentId: "AG1",
    placedAtMs: 1_793_163_600_000,
    acceptedAtMs: null,
    delaySec: 5,
    acceptSec: 1,
    stateCode: 1,
    oddsPlaced: 2,
    oddsAccepted: 2,
    oddsDrift: 0,
    stakeCents: 100,
    toWinCents: 200,
    lineHundredths: null,
    sportId: "1",
    eventId: "e1",
    period: 0,
    resultCode: null,
    ipMasked: "10.0.***.***",
    ipTag: "ip:abcd1234",
    ipPrefix24: "10.0.0",
    suspectedBot: false,
    reversedCredit: false,
    manualLog: false,
    adminUser: null,
    ipClass: "PUBLIC",
    botRingRange: false,
    stakeUsd: 1,
    toWinUsd: 2,
    hourOfDayUtc: 1,
    dayOfWeekUtc: 1,
    periodCode: 0,
    resultCodeNum: 0,
    ...overrides,
  };
}

function syntheticCorpus(records: readonly FraudBetRecord[]): FraudCorpus {
  const accounts = new Set(records.map((item) => item.userId)).size;
  const agents = new Set(records.map((item) => item.agentId)).size;
  return {
    source: {
      id: "gslive_bet_report",
      label: "synthetic",
      path: "/synthetic",
      exists: true,
      bytes: null,
      mtimeIso: null,
      ageSeconds: 0,
      stale: false,
      provenance: "fixture",
      records: records.length,
      sha256: null,
      state: "ok",
      note: "synthetic",
      reason: null,
    },
    path: "/synthetic",
    sha256: null,
    rows: records.length,
    malformed: 0,
    records,
    window: { fromMs: 0, toMs: 0 },
    ipIndex: {
      distinctIps: 0,
      clusters: [],
      prefixClusters: [],
      botRingAccounts: [],
      fanout: new Map(),
      highFanout: [],
    },
    accounts,
    agents,
    parseMs: 1,
    timerSource: "mock",
  } as unknown as FraudCorpus;
}

async function realCatalog(): Promise<unknown> {
  return Bun.file(join(ROOT, "config", "fraud-research.json")).json();
}

describe("pattern exploration (lib)", () => {
  test("backlog maps the research catalog's listed fields to corpus availability", async () => {
    const root = track(buildFixtureRoot());
    const perception = await loadFraudPerception({ root, now: fixedNow() });
    if (perception.corpus === null) throw new Error("fixture corpus missing");
    const frozen = runFraudPatterns(perception).findings.map((item) => item.id);
    const result = buildFraudExploration({
      corpus: perception.corpus,
      catalog: await realCatalog(),
      frozenDetectorIds: frozen,
      limit: 5,
    });

    expect(result.backlog.length).toBe(15);
    const backlogIds = result.backlog.map((entry) => entry.id);
    expect(backlogIds).toEqual([...backlogIds].sort());
    expect(result.backlog.some((entry) => entry.implemented)).toBe(true);
    expect(result.backlog.some((entry) => !entry.implemented)).toBe(true);
    for (const entry of result.backlog) {
      for (const field of entry.fields) {
        expect(typeof field.field).toBe("string");
        expect(typeof field.available).toBe("boolean");
        expect(typeof field.via).toBe("string");
      }
    }
    const donor = result.backlog.find((entry) => entry.id === "DONOR_SHIELD");
    expect(donor?.allListedFieldsAvailable).toBe(false);
    expect(result.frozenDetectors.length).toBeGreaterThanOrEqual(30);
    expect(result.constants.minBets).toBe(20);
    expect(result.limits.join(" ")).toContain("not frozen detectors");
  });

  test("candidates are deterministic, bounded and framed as exploratory", async () => {
    const records: FraudBetRecord[] = [];
    // Account A: 25 bets, one bucket, all manual-log rows without an adminUser.
    for (let index = 0; index < 25; index += 1) {
      records.push(
        record({
          betId: `a${index}`,
          userId: "A1",
          manualLog: true,
          adminUser: null,
          stakeCents: index === 0 ? 9_000 : 100,
          lineHundredths: 5,
        }),
      );
    }
    // Account B: 25 bets spread over five buckets, no manual rows.
    for (let index = 0; index < 25; index += 1) {
      records.push(
        record({
          betId: `b${index}`,
          userId: "B1",
          lineHundredths: index % 5,
        }),
      );
    }
    const corpus = syntheticCorpus(records);
    const catalog = {
      proposedDetectors: [
        { id: "MARKET_ENTROPY", status: "proposed", fields: ["sport"] },
        { id: "KYC_STAGE_GATE", status: "proposed", fields: [] },
      ],
    };
    const first = buildFraudExploration({
      corpus,
      catalog,
      frozenDetectorIds: ["SUSPECTED_BOT_BET"],
      limit: 5,
    });
    const second = buildFraudExploration({
      corpus,
      catalog,
      frozenDetectorIds: ["SUSPECTED_BOT_BET"],
      limit: 5,
    });
    expect(second).toEqual(first);
    expect(first.backlog.map((entry) => entry.id)).toEqual([
      "KYC_STAGE_GATE",
      "MARKET_ENTROPY",
    ]);
    expect(first.backlog[0]?.allListedFieldsAvailable).toBe(false); // no listed fields
    expect(first.backlog[1]?.allListedFieldsAvailable).toBe(true);

    const entropy = first.candidates.marketEntropy;
    expect(entropy.status).toBe("exploratory");
    expect(entropy.rows.length).toBeLessThanOrEqual(5);
    expect(entropy.rows[0]?.account).toBe("A1");
    expect(entropy.rows[0]?.entropyBits).toBe(0);
    expect(entropy.rows[0]?.bucketCount).toBe(1);
    expect(entropy.caveat).toContain("not a finding");

    const overrides = first.candidates.unattributedOverride;
    expect(overrides.rows[0]?.account).toBe("A1");
    expect(overrides.rows[0]?.manualLogRows).toBe(25);
    expect(overrides.rows[0]?.rowsWithoutAdminUser).toBe(25);
    expect(overrides.rows[0]?.share).toBe(1);

    const stakes = first.candidates.stakeConcentration;
    expect(stakes.rows[0]?.account).toBe("A1");
    expect(stakes.rows[0]?.topStakeShare).toBeGreaterThan(0.5);
    expect(stakes.caveat).toContain("not fraud");

    for (const candidate of Object.values(first.candidates)) {
      expect(candidate.id).toBeTruthy();
      expect(candidate.question.length).toBeGreaterThan(10);
      expect(candidate.method.length).toBeGreaterThan(10);
      expect(candidate.omittedRows).toBeGreaterThanOrEqual(0);
    }
  });

  test("a missing catalog is an empty backlog, not a crash", async () => {
    const root = track(buildFixtureRoot());
    const perception = await loadFraudPerception({ root, now: fixedNow() });
    if (perception.corpus === null) throw new Error("fixture corpus missing");
    const result = buildFraudExploration({
      corpus: perception.corpus,
      catalog: null,
      frozenDetectorIds: [],
      limit: 10,
    });
    expect(result.backlog).toEqual([]);
    expect(result.frozenDetectors).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/(?:\d{1,3}\.){3}\d{1,3}/);
  });
});
