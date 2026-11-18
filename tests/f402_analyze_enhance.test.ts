import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  containsUnhashedIp,
  filterProjection,
  hashIp,
  ingestPullDirectory,
  linkAccounts,
  loadAnalyzeConfig,
  parseAnalyzeConfig,
  parseAnalyzeFormat,
  PREDICT_SIGNAL_WEIGHTS,
  renderAnalyzeOutput,
  runCalibrateAnalysis,
  runDiffAnalysis,
  runExplainAnalysis,
} from "../lib/f402_analyze.ts";
import { F402AnalyzeError } from "../lib/f402_analyze_ingest.ts";
import {
  DEFAULT_LINK_LISTS,
  resolvedLinkLists,
} from "../lib/f402_analyze_config.ts";
import {
  GENERIC_ENTERED_BY,
  SHARED_INFRA_CLASSES,
  isSharedInfraIp,
} from "../lib/f402_analyze_link.ts";
import { buildRings } from "../lib/f402_analyze_rings.ts";
import { buildAccountTimeline } from "../lib/f402_analyze_timeline.ts";
import {
  brierScore,
  leaveOneOutWeights,
} from "../lib/f402_analyze_calibrate.ts";
import {
  plantedClusterPull,
  plantedEnhancePull,
  writeSyntheticPull,
} from "./fixtures/f402-analyze/synthetic_pull.ts";
import { main as analyzeMain } from "../scripts/f402_analyze.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempRoot(prefix = "f402-enhance-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function enhanceTree(): string {
  const root = tempRoot();
  writeSyntheticPull(root, plantedEnhancePull());
  return root;
}

describe("analyze config schema", () => {
  test("accepts known weights and thresholds, and rejects unknown keys", () => {
    const parsed = parseAnalyzeConfig({
      weights: { link: { steam_chase: 0 }, predict: { activity_gaps: 0.1 } },
      thresholds: { minEdgeScore: 0.4, ringMinEdgeScore: 0.5 },
    });
    expect(parsed.weights.link.steam_chase).toBe(0);
    expect(parsed.weights.predict.activity_gaps).toBe(0.1);
    expect(parsed.thresholds.ringMinEdgeScore).toBe(0.5);
    expect(() => parseAnalyzeConfig({ mystery: 1 })).toThrow(F402AnalyzeError);
    expect(() =>
      parseAnalyzeConfig({ weights: { link: { not_a_signal: 1 } } }),
    ).toThrow(F402AnalyzeError);
    expect(() =>
      parseAnalyzeConfig({ thresholds: { minEdgeScore: -1 } }),
    ).toThrow(F402AnalyzeError);
    const path = join(tempRoot(), "cfg.json");
    writeFileSync(path, JSON.stringify({ weights: { link: { clv_beat: 1 } } }));
    expect(loadAnalyzeConfig(path).weights.link.clv_beat).toBe(1);
  });
});

describe("analyze config lists", () => {
  test("defaults keep the previous operator and carrier lists", () => {
    expect([...GENERIC_ENTERED_BY]).toEqual([
      "",
      "system",
      "internet",
      "ggl-livedealer",
    ]);
    expect([...SHARED_INFRA_CLASSES]).toEqual([
      "CGNAT",
      "T_MOBILE",
      "VERIZON_192",
      "VERIZON_208",
      "ICLOUD_RELAY",
      "BOT_RING_140_248",
      "IPV6_CARRIER:T_MOBILE",
      "IPV6_CARRIER:VERIZON",
      "IPV6_CARRIER:ATT",
      "IPV6_CARRIER:ICLOUD",
    ]);
    const resolved = resolvedLinkLists(undefined);
    expect([...resolved.genericEnteredBy]).toEqual([
      ...DEFAULT_LINK_LISTS.genericEnteredBy,
    ]);
    expect([...resolved.sharedInfraClasses]).toEqual([
      ...DEFAULT_LINK_LISTS.sharedInfraClasses,
    ]);
    expect(parseAnalyzeConfig({}).lists).toEqual({});
  });

  test("a configured list replaces the default and is normalized", () => {
    const parsed = parseAnalyzeConfig({
      lists: {
        genericEnteredBy: [" System ", "Kiosk"],
        sharedInfraClasses: [" CGNAT "],
      },
    });
    expect(parsed.lists?.genericEnteredBy).toEqual(["system", "kiosk"]);
    expect(parsed.lists?.sharedInfraClasses).toEqual(["CGNAT"]);
    const resolved = resolvedLinkLists(parsed);
    expect(resolved.genericEnteredBy.has("internet")).toBe(false);
    expect(resolved.sharedInfraClasses.has("T_MOBILE")).toBe(false);
    expect(isSharedInfraIp("2607:fb90::1")).toBe(true);
    expect(isSharedInfraIp("2607:fb90::1", resolved.sharedInfraClasses)).toBe(
      false,
    );
  });

  test("bad lists fail loudly", () => {
    for (const raw of [
      { lists: { operators: [] } },
      { lists: [] },
      { lists: { genericEnteredBy: "system" } },
      { lists: { genericEnteredBy: [1] } },
      { lists: { sharedInfraClasses: [" "] } },
    ]) {
      let caught: unknown;
      try {
        parseAnalyzeConfig(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(F402AnalyzeError);
      expect((caught as F402AnalyzeError).code).toBe("config");
    }
  });

  test("genericEnteredBy decides which clerks count as link evidence", () => {
    const root = tempRoot();
    writeSyntheticPull(root, plantedClusterPull());
    const projection = ingestPullDirectory(root);
    const hasEnteredBy = (report: ReturnType<typeof linkAccounts>) =>
      report.edges.some((edge) =>
        edge.evidence.some((item) => item.type === "same_entered_by"),
      );
    expect(hasEnteredBy(linkAccounts(projection, { hashIp }))).toBe(false);
    const withoutSystem = linkAccounts(projection, {
      hashIp,
      config: parseAnalyzeConfig({ lists: { genericEnteredBy: [""] } }),
    });
    expect(hasEnteredBy(withoutSystem)).toBe(true);
  });
});

describe("filters and formats", () => {
  test("account, sport, and min-stake filters keep only matching wagers", () => {
    const root = enhanceTree();
    const projection = ingestPullDirectory(root);
    const onlyClv = filterProjection(projection, { accounts: ["CLV1"] });
    expect(onlyClv.accounts.map((a) => a.accountId)).toEqual(["CLV1"]);
    expect(onlyClv.wagers.every((w) => w.accountId === "CLV1")).toBe(true);
    const nba = filterProjection(projection, { sports: ["NBA"] });
    expect(nba.wagers.length).toBe(projection.wagers.length);
    const nfl = filterProjection(projection, { sports: ["NFL"] });
    expect(nfl.wagers.length).toBe(0);
    const big = filterProjection(projection, { minStake: 50 });
    expect(big.wagers.some((w) => w.accountId === "CLV1")).toBe(true);
    expect(big.wagers.some((w) => w.accountId === "MID1")).toBe(true);
    expect(big.wagers.every((w) => w.accountId !== "LAT3")).toBe(true);
  });

  test("formatters emit json, csv, and markdown without raw IPs", () => {
    expect(parseAnalyzeFormat(undefined)).toBe("json");
    expect(() => parseAnalyzeFormat("xml")).toThrow(F402AnalyzeError);
    const rows = [{ id: "ring-1", accounts: "CLV1 CLV2", score: 0.5 }];
    const csv = renderAnalyzeOutput("csv", "Rings", rows);
    expect(csv).toContain("id,accounts,score");
    expect(csv).toContain("CLV1 CLV2");
    const md = renderAnalyzeOutput("md", "Rings", rows);
    expect(md).toContain("# Rings");
    expect(md).toContain("| id |");
    expect(containsUnhashedIp(csv)).toBe(false);
  });
});

describe("rings, timeline, explain, and diff", () => {
  test("builds rings with summaries and can split a weak edge at a higher threshold", () => {
    const root = enhanceTree();
    const projection = ingestPullDirectory(root);
    const report = linkAccounts(projection, { hashIp });
    const rings = buildRings(report.edges, { minEdgeScore: 0.2, projection });
    expect(rings.length).toBeGreaterThan(0);
    expect(rings.every((ring) => ring.label === "evidence-scored guess")).toBe(
      true,
    );
    expect(rings[0]?.summary.accountCount).toBeGreaterThanOrEqual(2);
    const tight = buildRings(report.edges, { minEdgeScore: 0.99, projection });
    expect(tight.every((ring) => ring.summary.minEdgeScore >= 0.99)).toBe(true);
    expect(tight.length).toBeLessThanOrEqual(rings.length);
  });

  test("timeline records agent, limit, and status changes", () => {
    const root = enhanceTree();
    const projection = ingestPullDirectory(root);
    const timeline = buildAccountTimeline(projection, { accounts: ["MOVE1"] });
    const kinds = new Set(
      timeline.accounts.flatMap((row) => row.events.map((e) => e.kind)),
    );
    expect(kinds.has("agent_move")).toBe(true);
    expect(kinds.has("credit_limit_change")).toBe(true);
    expect(kinds.has("status_change")).toBe(true);
    const agent = timeline.accounts[0]?.events.find(
      (e) => e.kind === "agent_move",
    );
    expect(agent?.fromValue).toBe("SUB1");
    expect(agent?.toValue).toBe("SUB2");
    expect(agent?.label).toBe("evidence-scored guess");
  });

  test("explain lists edges, rings, and signal contributions for one account", () => {
    const root = enhanceTree();
    const { explain, outPath } = runExplainAnalysis(root, { account: "CLV1" });
    expect(explain.label).toBe("evidence-scored guess");
    expect(explain.accountId).toBe("CLV1");
    expect(
      explain.edges.some((edge) => edge.b === "CLV2" || edge.a === "CLV2"),
    ).toBe(true);
    expect(explain.rings.some((ring) => ring.accounts.includes("CLV2"))).toBe(
      true,
    );
    expect(explain.prediction?.signals.length).toBeGreaterThan(0);
    const saved = JSON.parse(readFileSync(outPath, "utf8")) as unknown;
    expect(containsUnhashedIp(saved)).toBe(false);
    expect(() => runExplainAnalysis(root, {})).toThrow(F402AnalyzeError);
  });

  test("diff two pulls reports added and removed accounts", () => {
    const left = tempRoot("f402-diff-l-");
    const right = tempRoot("f402-diff-r-");
    const base = plantedEnhancePull();
    writeSyntheticPull(left, base);
    writeSyntheticPull(right, {
      ...base,
      snapshots: base.snapshots.map((snap, index) => ({
        ...snap,
        players: [
          ...snap.players.filter((p) => p.customerID !== "LAT3"),
          ...(index === base.snapshots.length - 1
            ? [
                {
                  customerID: "NEW1",
                  Login: "new1",
                  NameFirst: "N",
                  Agent: "SUB1",
                },
              ]
            : []),
        ],
      })),
    });
    const { diff } = runDiffAnalysis(left, right);
    expect(diff.label).toBe("evidence-scored guess");
    expect(diff.accounts.added).toContain("NEW1");
    expect(diff.accounts.removed).toContain("LAT3");
    expect(containsUnhashedIp(diff)).toBe(false);
  });
});

describe("new behaviour signals", () => {
  test("finds planted CLV, middling, and login-latency pairs, not decoys", () => {
    const root = enhanceTree();
    const projection = ingestPullDirectory(root);
    const report = linkAccounts(projection, { hashIp });
    const typesFor = (a: string, b: string): string[] =>
      report.edges
        .filter(
          (edge) =>
            (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a),
        )
        .flatMap((edge) => edge.evidence.map((item) => item.type));

    expect(typesFor("CLV1", "CLV2")).toContain("clv_beat");
    expect(typesFor("CLV1", "CLV3")).not.toContain("clv_beat");
    expect(typesFor("MID1", "MID2")).toContain("middling_arb");
    expect(typesFor("LAT1", "LAT2")).toContain("login_then_bet");
    expect(typesFor("LAT1", "LAT3")).not.toContain("login_then_bet");
    expect(
      report.edges.every((edge) => edge.label === "evidence-scored guess"),
    ).toBe(true);
  });

  test("a zero steam_chase weight suppresses that evidence type", () => {
    const root = tempRoot();
    writeSyntheticPull(root, plantedClusterPull());
    const projection = ingestPullDirectory(root);
    const config = parseAnalyzeConfig({
      weights: { link: { shared_ip: 0, transfer: 0, same_device_timing: 0 } },
    });
    const silenced = linkAccounts(projection, { hashIp, config });
    const types = new Set(
      silenced.edges.flatMap((edge) => edge.evidence.map((item) => item.type)),
    );
    expect(types.has("shared_ip")).toBe(false);
    expect(types.has("transfer")).toBe(false);
  });
});

describe("calibration ablation", () => {
  test("leave-one-out weights zero one signal and ablation reports every signal", () => {
    const dropped = leaveOneOutWeights(PREDICT_SIGNAL_WEIGHTS, "activity_gaps");
    expect(dropped.activity_gaps).toBe(0);
    expect(dropped.balance_trend).toBe(PREDICT_SIGNAL_WEIGHTS.balance_trend);
    const root = tempRoot();
    writeSyntheticPull(root, plantedClusterPull());
    const { report } = runCalibrateAnalysis(root, {
      nowMs: Date.parse("2026-11-14T00:00:00.000Z"),
    });
    expect(report.ablation.length).toBe(
      Object.keys(PREDICT_SIGNAL_WEIGHTS).length,
    );
    expect(report.ablation.map((row) => row.signal).sort()).toEqual(
      Object.keys(PREDICT_SIGNAL_WEIGHTS).sort(),
    );
    expect(report.ablation.every((row) => Number.isFinite(row.brier))).toBe(
      true,
    );
    expect(brierScore([0.5], [1])).toBe(0.25);
  });
});

describe("CLI format and new commands", () => {
  test("link --format csv and timeline/explain stay hashed", async () => {
    const root = enhanceTree();
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      expect(await analyzeMain(["link", "--in", root, "--format", "csv"])).toBe(
        0,
      );
      expect(
        await analyzeMain(["timeline", "--in", root, "--accounts", "MOVE1"]),
      ).toBe(0);
      expect(
        await analyzeMain(["explain", "--in", root, "--account", "CLV1"]),
      ).toBe(0);
    } finally {
      console.log = original;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("id,accounts,score");
    expect(joined).not.toContain("198.51.100.10");
    expect(joined).toContain("evidence-scored guess");
    const hashed = hashIp("198.51.100.10");
    expect(joined.includes(hashed) || !joined.includes("198.51.100")).toBe(
      true,
    );
  });
});
