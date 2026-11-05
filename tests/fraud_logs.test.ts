import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  FRAUD_SOURCE_IDS,
  aggregateBets,
  assertNoRawIpInText,
  dollarsToCents,
  encodePeriodCode,
  filterBets,
  impliedProbability,
  ipClassOf,
  ipGraphSummary,
  ipPrefixKeyOf,
  ipTagOf,
  listIpClusters,
  loadFraudPerception,
  maskIp,
  parseFraudCorpus,
  toBetRecord,
  type FraudBetRecord,
} from "../lib/fraud_logs.ts";
import {
  buildFixtureRoot,
  CORPUS_PRIMARY_REL,
  FIXED_NOW_ISO,
  fixtureText,
  makeRoot,
  readFixtureJson,
  sha256Of,
  writeAt,
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

async function fixtureCorpus(): Promise<{
  root: string;
  records: readonly FraudBetRecord[];
}> {
  const root = track(buildFixtureRoot());
  const parsed = await parseFraudCorpus(join(root, CORPUS_PRIMARY_REL));
  return { root, records: parsed.records };
}

/* -------------------------------------------------------------------------- */
/* Masking and small parsers                                                   */
/* -------------------------------------------------------------------------- */

describe("IP masking (PII boundary)", () => {
  test("maskIp masks the last two IPv4 octets and most IPv6 groups", () => {
    expect(maskIp("47.223.36.100")).toBe("47.223.***.***");
    expect(maskIp("  140.248.10.20 ")).toBe("140.248.***.***");
    expect(maskIp("2607:fb90:1234:5678:9abc:def0:1111:2222")).toBe(
      "2607:fb90:***:***",
    );
    expect(maskIp("not-an-ip")).toBeNull();
    expect(maskIp("")).toBeNull();
    expect(maskIp("999.1.1.1")).toBeNull();
  });

  test("ipTagOf is a stable short sha256 and ipPrefixKeyOf is the /24", () => {
    const tag = ipTagOf("47.223.36.100");
    expect(tag).toBe(sha256Of("47.223.36.100").slice(0, 8));
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(ipTagOf("47.223.36.100")).toBe(tag);
    expect(ipPrefixKeyOf("47.223.36.100")).toBe("47.223.36");
    expect(ipPrefixKeyOf("2607:fb90:1234:5678::1")).toBe(
      "v6:2607:fb90:1234:5678",
    );
  });

  test("classifyIp is reused for bot-ring and relay classification", () => {
    expect(ipClassOf("140.248.10.20")).toBe("BOT_RING_140_248");
    expect(ipClassOf("146.75.1.2")).toBe("ICLOUD_RELAY");
    expect(ipClassOf("8.8.8.8")).toBe("OTHER");
  });

  test("period / money / implied probability parsers", () => {
    expect(encodePeriodCode("s1")).toBe(1);
    expect(encodePeriodCode("s12")).toBe(12);
    expect(encodePeriodCode("h2")).toBe(22);
    expect(encodePeriodCode("m")).toBe(0);
    expect(encodePeriodCode("weird")).toBeNull();
    expect(dollarsToCents("100")).toBe(10_000);
    expect(dollarsToCents("2.865")).toBe(287);
    expect(dollarsToCents(null)).toBeNull();
    expect(impliedProbability(2)).toBe(0.5);
    expect(impliedProbability(1)).toBeNull();
    expect(impliedProbability(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Corpus parsing from the crafted fixture                                     */
/* -------------------------------------------------------------------------- */

describe("parseFraudCorpus (fixture)", () => {
  test("normalizes rows, masks IPs and never stores a raw address", async () => {
    const { records } = await fixtureCorpus();
    expect(records).toHaveLength(16);
    expect(new Set(records.map((record) => record.userId)).size).toBe(12);
    expect(
      new Set(
        records.flatMap((record) =>
          record.agentId === null ? [] : [record.agentId],
        ),
      ).size,
    ).toBe(5);
    expect(new Set(records.map((record) => record.ipTag)).size).toBe(13);
    for (const record of records) {
      expect(record.ipMasked).toMatch(/^\d{1,3}\.\d{1,3}\.\*\*\*\.\*\*\*$/);
      expect(record.ipTag).toMatch(/^[0-9a-f]{8}$/);
      expect(record.ipPrefix24).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
    const serialized = JSON.stringify(records.map(toBetRecord));
    assertNoRawIpInText(serialized, rawFixtureIps());
    expect(() =>
      assertNoRawIpInText(`leak ${"47.223.36.100"} here`, ["47.223.36.100"]),
    ).toThrow();
    expect(() =>
      assertNoRawIpInText(serialized, ["47.223.36.100"]),
    ).not.toThrow();
  });

  test("normalized fields follow the contract vocabulary", async () => {
    const { records } = await fixtureCorpus();
    const first = records[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("fixture corpus is empty");
    expect(first.betId).toBe("900001");
    expect(first.userId).toBe("U001");
    expect(first.agentId).toBe("AG1");
    expect(first.delaySec).toBe(5);
    expect(first.acceptSec).toBe(1);
    expect(first.stateCode).toBe(2);
    expect(first.oddsPlaced).toBe(2);
    expect(first.oddsAccepted).toBe(2);
    expect(first.oddsDrift).toBe(0);
    expect(first.stakeCents).toBe(10_000);
    expect(first.toWinCents).toBe(20_000);
    expect(first.sport).toBe("8");
    expect(first.subSport).toBeNull();
    expect(first.eventId).toBe("1001");
    expect(first.period).toBe("m");
    expect(first.periodCode).toBe(0);
    expect(first.wagerType).toBe("0");
    expect(first.resultCode).toBe("-100");
    expect(first.suspectedBot).toBe(false);
    expect(first.reversedCredit).toBe(false);
    expect(first.manualLog).toBe(false);
    const drifted = records.find((record) => record.betId === "900005");
    expect(drifted?.oddsDrift).toBeCloseTo(0.25, 10);
    const reversed = records.find((record) => record.betId === "900004");
    expect(reversed?.reversedCredit).toBe(true);
    expect(reversed?.ipClass).toBe("BOT_RING_140_248");
    expect(reversed?.botRingRange).toBe(true);
  });

  test("corpus window reports both the document and measured logTime range", async () => {
    const root = track(buildFixtureRoot());
    const parsed = await parseFraudCorpus(join(root, CORPUS_PRIMARY_REL));
    expect(parsed.rows).toBe(16);
    expect(parsed.malformed).toBe(0);
    expect(parsed.window.fromEpochSec).toBe(1_793_163_600);
    expect(parsed.window.toEpochSec).toBe(1_793_163_600 + 7 * 24 * 3600);
    expect(parsed.window.measuredFromIso).toBe("2026-10-28T05:01:00.000Z");
    expect(parsed.accounts).toBe(12);
    expect(parsed.agents).toBe(5);
    expect(parsed.parseMs).toBeGreaterThanOrEqual(0);
  });

  test("IP index summary and clusters are derived from masked keys only", async () => {
    const root = track(buildFixtureRoot());
    const parsed = await parseFraudCorpus(join(root, CORPUS_PRIMARY_REL));
    const corpus = {
      source: {
        id: "gslive_bet_report" as const,
        label: "",
        path: "",
        exists: true,
        bytes: 0,
        mtimeIso: null,
        ageSeconds: 0,
        stale: false,
        provenance: "live-api" as const,
        records: 16,
        sha256: null,
        state: "ok" as const,
        note: "",
        reason: null,
      },
      path: "",
      sha256: null,
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
      timerSource: "mock" as const,
    };
    const summary = ipGraphSummary(corpus, 2);
    expect(summary.distinctIps).toBe(13);
    expect(summary.sharedIps).toBe(1);
    expect(summary.accountsMultiIp).toBe(2);
    expect(summary.maxAccountsPerIp).toBe(3);
    const clusters = listIpClusters(corpus, { minAccounts: 2, limit: 10 });
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster?.masked).toBe("47.223.***.***");
    expect(cluster?.sharedIp).toBe(true);
    expect(cluster?.accounts).toBe(3);
    const serialized = JSON.stringify(clusters);
    assertNoRawIpInText(serialized, rawFixtureIps());
  });
});

/* -------------------------------------------------------------------------- */
/* Aggregates / filters                                                        */
/* -------------------------------------------------------------------------- */

describe("bets aggregation", () => {
  test("filters and aggregate counts are measured on the filtered set", async () => {
    const { records } = await fixtureCorpus();
    const all = aggregateBets(records);
    expect(all.rows).toBe(16);
    expect(all.accounts).toBe(12);
    expect(all.agents).toBe(5);
    expect(all.states.win).toBe(1);
    expect(all.states.lose).toBe(13);
    expect(all.states.push).toBe(2);
    expect(all.suspectedBot).toBe(2);
    expect(all.reversedCredit).toBe(1);
    expect(all.manualLog).toBe(1);
    expect(all.oddsDrift).toBe(1);
    expect(all.delayHistogram).toEqual([{ delaySec: 5, count: 16 }]);

    const withoutBots = filterBets(records, {
      agent: null,
      account: null,
      state: null,
      since: null,
      includeBots: false,
    });
    expect(withoutBots).toHaveLength(14);

    const agentFiltered = filterBets(records, {
      agent: "AG1",
      account: null,
      state: null,
      since: null,
      includeBots: true,
    });
    expect(agentFiltered.length).toBeGreaterThan(0);
    expect(agentFiltered.every((record) => record.agentId === "AG1")).toBe(
      true,
    );

    const sinceFiltered = filterBets(records, {
      agent: null,
      account: null,
      state: null,
      since: new Date(1_793_163_600 * 1000 + 600 * 1000),
      includeBots: true,
    });
    expect(sinceFiltered.length).toBe(6);
  });
});

/* -------------------------------------------------------------------------- */
/* Source discovery / provenance                                               */
/* -------------------------------------------------------------------------- */

describe("source discovery and provenance", () => {
  test("a complete fixture root reports measured source states", async () => {
    const root = track(buildFixtureRoot());
    const perception = await loadFraudPerception({
      root,
      now: new Date(FIXED_NOW_ISO),
    });
    expect(perception.sources.map((source) => source.id)).toEqual([
      ...FRAUD_SOURCE_IDS,
    ]);
    expect(perception.sources).toHaveLength(11);
    const corpus = perception.sources.find(
      (source) => source.id === "gslive_bet_report",
    );
    expect(corpus?.exists).toBe(true);
    expect(corpus?.state).toBe("ok");
    expect(corpus?.records).toBe(16);
    expect(corpus?.sha256).toBe(sha256Of(fixtureText("betreport-small.json")));
    expect(corpus?.note).toContain("sha256 read from sidecar");
    expect(corpus?.note).toContain("ephemeral");
    expect(corpus?.stale).toBe(false);
    const weblogs = perception.sources.find(
      (source) => source.id === "gslive_weblogs",
    );
    expect(weblogs?.state).toBe("session_expired");
    expect(weblogs?.exists).toBe(false);
    expect(weblogs?.reason).toContain("session expiry");
    const customerBook = perception.sources.find(
      (source) => source.id === "customer_book",
    );
    expect(customerBook?.provenance).toBe("fixture");
    expect(customerBook?.note).toContain("NEVER used to fit the model");
    const suspect = perception.sources.find(
      (source) => source.id === "gslive_suspect_audit",
    );
    expect(suspect?.reason).toContain("--help");
    const capture = perception.sources.find(
      (source) => source.id === "f402_weblog_capture",
    );
    expect(capture?.provenance).toBe("fixture");
    expect(capture?.reason).toContain("evidence rows missing");
    expect(perception.suspectAudit?.targetDefect).toBe(true);
    expect(perception.capture?.rowsMissing).toBe(true);
    expect(perception.tickets.bets).toHaveLength(4);
    expect(perception.tickets.wagers).toHaveLength(5);
    expect(perception.agentIndex?.agentCount).toBe(4);
    expect(perception.weblogPosture?.files).toHaveLength(1);
    expect(perception.weblogPosture?.rows.parsed).toBe(998);
    expect(perception.weblogs.status).toBe("not_measured");
    expect(perception.customerBook.customers).toBe(2);
    expect(perception.corpus?.records).toHaveLength(16);
    expect(perception.timing.corpusParseMs).not.toBeNull();
  });

  test("the fallback corpus path is discovered when the backup is absent", async () => {
    const root = track(makeRoot());
    writeAt(
      root,
      "Scratch/betReport-all.json",
      fixtureText("betreport-small.json"),
    );
    const perception = await loadFraudPerception({
      root,
      now: new Date(FIXED_NOW_ISO),
    });
    const corpus = perception.sources.find(
      (source) => source.id === "gslive_bet_report",
    );
    expect(corpus?.exists).toBe(true);
    expect(corpus?.path).toBe("Scratch/betReport-all.json");
    expect(corpus?.sha256).toBe(sha256Of(fixtureText("betreport-small.json")));
    expect(perception.corpus?.rows).toBe(16);
  });

  test("a missing corpus is MISSING (records:null), never zero rows", async () => {
    const root = track(makeRoot());
    const perception = await loadFraudPerception({
      root,
      now: new Date(FIXED_NOW_ISO),
    });
    expect(perception.corpus).toBeNull();
    for (const source of perception.sources) {
      expect(source.exists).toBe(false);
      expect(source.records).toBeNull();
      expect(source.reason).not.toBeNull();
      // The GSLive WebLog artifact is the one source with a state-specific absence reason.
      if (source.id === "gslive_weblogs") {
        expect(source.state).toBe("session_expired");
      } else {
        expect(source.state).toBe("missing");
      }
    }
    // The GSLive WebLog artifact is state-specific even when every artifact is absent.
    expect(
      perception.sources.find((source) => source.id === "gslive_weblogs")
        ?.state,
    ).toBe("session_expired");
    expect(perception.sources).toHaveLength(11);
  });

  test("staleness is measured against the pinned clock", async () => {
    const root = track(buildFixtureRoot());
    const later = new Date("2026-12-01T00:00:00.000Z");
    const perception = await loadFraudPerception({ root, now: later });
    const staleIds = perception.sources
      .filter((source) => source.stale)
      .map((source) => source.id);
    expect(staleIds).toContain("f402_live_bets");
    expect(staleIds).toContain("f402_live_wagers");
    expect(staleIds).toContain("gslive_bet_report");
    for (const source of perception.sources) {
      if (!source.exists) continue;
      expect(source.ageSeconds).not.toBeNull();
      // Sources with a null staleness budget (fixtures) are never "stale"; they are labelled.
      expect(source.state).toBe(source.stale ? "stale" : "ok");
    }
  });

  test("an unparseable corpus is reported unreadable, not zero", async () => {
    const root = track(makeRoot());
    writeAt(root, CORPUS_PRIMARY_REL, "{not json");
    const perception = await loadFraudPerception({
      root,
      now: new Date(FIXED_NOW_ISO),
    });
    const corpus = perception.sources.find(
      (source) => source.id === "gslive_bet_report",
    );
    expect(corpus?.state).toBe("unreadable");
    expect(corpus?.records).toBeNull();
    expect(perception.corpus).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Real corpus smoke test (skipped when the untracked backup is absent)        */
/* -------------------------------------------------------------------------- */

const REAL_CORPUS = join(
  process.cwd(),
  "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json",
);
const realCorpusPresent = existsSync(REAL_CORPUS);

describe("real corpus (measured, skipped when absent)", () => {
  test.skipIf(!realCorpusPresent)(
    "reports the contracted counts and weak-label supports",
    async () => {
      const parsed = await parseFraudCorpus(REAL_CORPUS);
      const suspectedBot = parsed.records.filter(
        (record) => record.suspectedBot,
      ).length;
      const reversedCredit = parsed.records.filter(
        (record) => record.reversedCredit,
      ).length;
      const manualLog = parsed.records.filter(
        (record) => record.manualLog,
      ).length;
      const deskFlag = parsed.records.filter(
        (record) =>
          record.suspectedBot || record.reversedCredit || record.manualLog,
      ).length;
      const oddsDrift = parsed.records.filter(
        (record) => record.oddsDrift !== null && record.oddsDrift !== 0,
      ).length;
      expect(parsed.rows).toBe(24_778);
      expect(parsed.malformed).toBe(0);
      expect(parsed.accounts).toBe(2_586);
      expect(parsed.agents).toBe(448);
      expect(parsed.byIp.size).toBe(5_614);
      expect(suspectedBot).toBe(70);
      expect(reversedCredit).toBe(733);
      expect(manualLog).toBe(153);
      expect(deskFlag).toBe(852);
      expect(oddsDrift).toBe(4_339);
      expect(parsed.window.fromEpochSec).toBe(1_793_163_600);
      expect(parsed.window.toEpochSec).toBe(1_793_771_999);
      // One parse per invocation must stay cheap (the whole 55.6 MB document + normalization).
      expect(parsed.parseMs).toBeLessThan(5_000);
      const sample = JSON.stringify(
        parsed.records.slice(0, 200).map(toBetRecord),
      );
      expect(/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sample)).toBe(false);
      expect(
        /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(
          JSON.stringify(
            listIpClusters({
              source: {
                id: "gslive_bet_report",
                label: "",
                path: "",
                exists: true,
                bytes: 0,
                mtimeIso: null,
                ageSeconds: 0,
                stale: false,
                provenance: "live-api",
                records: parsed.rows,
                sha256: null,
                state: "ok",
                note: "",
                reason: null,
              },
              path: "",
              sha256: null,
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
              timerSource: "mock",
            }),
          ),
        ),
      ).toBe(false);
    },
    120_000,
  );
});
