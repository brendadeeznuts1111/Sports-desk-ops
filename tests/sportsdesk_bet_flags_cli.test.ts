/**
 * @file tests/sportsdesk_bet_flags_cli.test.ts
 * @description CLI + alert-sender tests for the incoming-bet flags surface.
 *
 * Deterministic and offline: no live F402 call (the incoming-bet fetcher is injected), no
 * Telegram call and no keychain read (every alert run is `--dry-run`, or the deliverer is
 * injected). State + rule files live under a per-test mkdtemp root that is removed afterwards.
 *
 * The real subprocess path is exercised for `rules`, refusals and usage errors; the injected
 * in-process path exercises scan/alert/watch, because that is where the network seam lives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  deskDateYmd,
  runSportsdeskBetFlagsCli,
  type BetFlagsCliDeps,
} from "../cli/sportsdesk_bet_flags_cli.ts";
import {
  ALERT_STATE_REL_PATH,
  deliverFlagAlerts,
  renderAlertMessage,
  resolveTelegramCredentials,
} from "../lib/telegram_alert_sender.ts";
import type { BetFlagFinding, IncomingBetRecord } from "../lib/bet_flags.ts";
import { readAlertAudit } from "../lib/telegram_alert_audit.ts";
import type {
  IncomingBetsOptions,
  IncomingBetsResult,
} from "../lib/f402_incoming_bets.ts";

const CLI_PATH = resolve(import.meta.dir, "../cli/sportsdesk_bet_flags_cli.ts");
const FIXED_NOW_ISO = "2026-11-04T20:40:00.000Z";
const FIXED_NOW = new Date(FIXED_NOW_ISO);

const TWO_RULES_YAML = `schemaVersion: 1
rules:
  - id: stake_over_100
    title: Stake over $100
    severity: high
    enabled: true
    tags: [stake]
    when:
      all:
        - { field: stakeUsd, op: gte, value: 100 }
  - id: live_bet
    title: Live bet placed
    severity: medium
    enabled: true
    when: { field: isLive, op: eq, value: true }
`;

const HIGH_ONLY_YAML = `schemaVersion: 1
rules:
  - id: stake_over_100
    title: Stake over $100
    severity: high
    enabled: true
    when: { field: stakeUsd, op: gte, value: 100 }
`;

const LOW_ONLY_YAML = `schemaVersion: 1
rules:
  - id: stake_over_100
    title: Stake over $100
    severity: low
    enabled: true
    when: { field: stakeUsd, op: gte, value: 100 }
`;

const INVALID_SEVERITY_YAML = `schemaVersion: 1
rules:
  - id: bad_severity
    title: Bad severity
    severity: catastrophic
    enabled: true
    when: { field: stakeUsd, op: gte, value: 1 }
`;

/* -------------------------------------------------------------------------- */
/* Small JSON narrowing helpers (no casts)                                     */
/* -------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} is not a JSON object: ${JSON.stringify(value)}`);
  }
  return value;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array: ${JSON.stringify(value)}`);
  }
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not a string: ${JSON.stringify(value)}`);
  }
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is not a number: ${JSON.stringify(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is not a boolean: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Parses the WHOLE stdout: extra text after the object makes JSON.parse throw. */
function parseSingleJson(stdout: string): JsonObject {
  const parsed: unknown = JSON.parse(stdout);
  return asObject(parsed, "stdout");
}

function errorCode(body: JsonObject): string {
  return asString(asObject(body["error"], "error")["code"], "error.code");
}

function countField(body: JsonObject, key: string): number {
  return asNumber(asObject(body["counts"], "counts")[key], `counts.${key}`);
}

function severityCount(body: JsonObject, severity: string): number {
  const bySeverity = asObject(
    asObject(body["counts"], "counts")["bySeverity"],
    "counts.bySeverity",
  );
  return asNumber(bySeverity[severity], `counts.bySeverity.${severity}`);
}

function findingRows(body: JsonObject): readonly JsonObject[] {
  return asArray(body["findings"], "findings").map((finding, index) =>
    asObject(finding, `findings[${index}]`),
  );
}

/** Map `bet.betKey` -> `bet.context` for the serialized findings. */
function contextByBetKey(
  findings: readonly JsonObject[],
): ReadonlyMap<string, JsonObject> {
  const contexts = new Map<string, JsonObject>();
  for (const finding of findings) {
    const bet = asObject(finding["bet"], "bet");
    contexts.set(
      asString(bet["betKey"], "bet.betKey"),
      asObject(bet["context"], "bet.context"),
    );
  }
  return contexts;
}

function deliveryRows(body: JsonObject): readonly JsonObject[] {
  return asArray(body["deliveries"], "deliveries").map((delivery, index) =>
    asObject(delivery, `deliveries[${index}]`),
  );
}

function summaryField(body: JsonObject, key: string): number {
  return asNumber(asObject(body["summary"], "summary")[key], `summary.${key}`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function trackRoot(root: string): string {
  roots.push(root);
  return root;
}

async function makeRoot(rulesYaml?: string): Promise<string> {
  const root = trackRoot(await mkdtemp(join(tmpdir(), "bet-flags-cli-")));
  if (rulesYaml !== undefined) {
    await writeRules(root, "config/bet-flags.yml", rulesYaml);
  }
  return root;
}

async function writeRules(
  root: string,
  relPath: string,
  yaml: string,
): Promise<void> {
  const path = join(root, relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, yaml, "utf8");
}

function makeBet(
  overrides: Partial<IncomingBetRecord> = {},
): IncomingBetRecord {
  return {
    schemaVersion: 1,
    betKey: "BET-0001",
    ticketNumber: "T-0001",
    wagerNumber: "W-0001",
    customerId: "CCC107",
    agentId: "BIGDAD",
    agentLogin: "BIGDAD",
    agentLevel: 2,
    channel: "GSLIVE",
    wagerType: "straight",
    wagerKind: "straight",
    sport: "Baseball",
    league: "MLB",
    subSport: "MLB",
    period: "game",
    rotationNumber: 901,
    selection: "Yankees -1.5",
    description: "Yankees -1.5",
    shortDescription: "NYY -1.5",
    americanOdds: -110,
    impliedProb: 0.524,
    line: -1.5,
    stakeUsd: 500,
    toWinUsd: 454.55,
    volumeUsd: 500,
    riskUsd: 500,
    // v3 derived numeric fields (one leg, -110), required by IncomingBetRecord.
    stakeToWinRatio: 500 / 454.55,
    stakePerLeg: 500,
    oddsFromEven: 210,
    isLive: false,
    isVip: false,
    acceptedAt: "2026-11-04T19:00:00.000Z",
    observedAt: "2026-11-04T19:00:05.000Z",
    ageSeconds: 30,
    source: "live-ticker",
    raw: { id: "BET-0001" },
    // v2 depth: structured market fields + context (null until enrichIncomingBets).
    eventLabel: "Yankees vs Red Sox",
    eventKey: "Baseball|Yankees vs Red Sox",
    marketKey: "Baseball|Yankees vs Red Sox|moneyline|Game|",
    marketType: "moneyline",
    periodLabel: "Game",
    side: "Yankees",
    playerName: null,
    isPlayerProp: false,
    isAltLine: false,
    context: null,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<BetFlagFinding> = {}): BetFlagFinding {
  return {
    ruleId: "stake_over_100",
    ruleTitle: "Stake over $100",
    severity: "high",
    bet: makeBet(),
    matchedAt: FIXED_NOW_ISO,
    dedupeKey: "stake_over_100:BET-0001",
    evidence: {},
    ...overrides,
  };
}

interface FakeSource {
  readonly fetchBets: (
    options: IncomingBetsOptions,
  ) => Promise<IncomingBetsResult>;
  readonly calls: IncomingBetsOptions[];
}

/** Deterministic incoming-bet source. `result` replaces every non-row field when given. */
function fakeSource(
  rows: readonly IncomingBetRecord[],
  result?: Omit<IncomingBetsResult, "rows">,
): FakeSource {
  const calls: IncomingBetsOptions[] = [];
  const fetchBets = async (
    options: IncomingBetsOptions,
  ): Promise<IncomingBetsResult> => {
    calls.push(options);
    if (result !== undefined) return { ...result, rows: [...rows] };
    return {
      ok: true,
      source: "live-ticker",
      fetchedAt: FIXED_NOW_ISO,
      agentId: options.agentId ?? "AGENT1",
      rows: [...rows],
      diagnostic: { code: "ok", transport: "test-fake" },
    };
  };
  return { fetchBets, calls };
}

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunCliOptions {
  /** `false` omits `--now`, so the CLI anchors at the batch's newest acceptedAt. */
  readonly fixedNow?: boolean;
}

/** In-process invocation with a fixed clock/root and injected collaborators. */
async function runCli(
  root: string,
  args: readonly string[],
  deps: BetFlagsCliDeps = {},
  options: RunCliOptions = {},
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const globals =
    options.fixedNow === false
      ? ["--json", "--root", root]
      : ["--json", "--root", root, "--now", FIXED_NOW_ISO];
  const code = await runSportsdeskBetFlagsCli([...args, ...globals], {
    ...deps,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnCli(args: readonly string[]): SpawnResult {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, CLI_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/* -------------------------------------------------------------------------- */
/* rules / explain                                                             */
/* -------------------------------------------------------------------------- */

describe("rules", () => {
  test("lists the loaded rule pack as one JSON object", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const run = await runCli(root, ["rules"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const body = parseSingleJson(run.stdout);
    expect(body["success"]).toBe(true);
    expect(body["schemaVersion"]).toBe(1);
    expect(body["command"]).toBe("rules");
    expect(asString(body["generatedAt"], "generatedAt")).toBe(FIXED_NOW_ISO);
    expect(asString(body["path"], "path")).toBe(
      join(root, "config/bet-flags.yml"),
    );
    expect(asNumber(body["count"], "count")).toBe(2);
    const ids = asArray(body["rules"], "rules").map((rule, index) =>
      asString(asObject(rule, `rules[${index}]`)["id"], "rule.id"),
    );
    expect(ids).toEqual(["stake_over_100", "live_bet"]);
    expect(body["errors"]).toEqual([]);
  });

  test("real subprocess emits exactly one JSON object on stdout", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const proc = spawnCli(["--json", "--root", root, "rules"]);
    expect(proc.code).toBe(0);
    // JSON.parse over the whole stdout rejects any second object or trailing prose.
    const body = parseSingleJson(proc.stdout);
    expect(body["command"]).toBe("rules");
    expect(proc.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("a missing pack is a rules_missing refusal (exit 3)", async () => {
    const root = await makeRoot();
    const proc = spawnCli(["--json", "--root", root, "rules"]);
    expect(proc.code).toBe(3);
    const body = parseSingleJson(proc.stdout);
    expect(body["success"]).toBe(false);
    expect(errorCode(body)).toBe("rules_missing");
    expect(proc.stderr).toContain("rules_missing");
  });

  test("an invalid pack is a rules_invalid refusal (exit 3)", async () => {
    const root = await makeRoot(INVALID_SEVERITY_YAML);
    const run = await runCli(root, ["rules"]);
    expect(run.code).toBe(3);
    const body = parseSingleJson(run.stdout);
    expect(errorCode(body)).toBe("rules_invalid");
    const details = asObject(
      asObject(body["error"], "error")["details"],
      "details",
    );
    expect(asArray(details["errors"], "details.errors").length).toBeGreaterThan(
      0,
    );
  });
});

describe("explain", () => {
  test("shows one rule", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const run = await runCli(root, ["explain", "live_bet"]);
    expect(run.code).toBe(0);
    const body = parseSingleJson(run.stdout);
    expect(body["command"]).toBe("explain");
    const rule = asObject(body["rule"], "rule");
    expect(asString(rule["id"], "rule.id")).toBe("live_bet");
    expect(asString(rule["severity"], "rule.severity")).toBe("medium");
  });

  test("an unknown rule id is a not_found refusal (exit 3)", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const run = await runCli(root, ["explain", "no_such_rule"]);
    expect(run.code).toBe(3);
    expect(errorCode(parseSingleJson(run.stdout))).toBe("not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* scan                                                                        */
/* -------------------------------------------------------------------------- */

describe("scan", () => {
  test("returns findings with the wide bet and a customer view", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const source = fakeSource([
      makeBet({ betKey: "BET-1", stakeUsd: 500, isLive: true }),
      makeBet({
        betKey: "BET-2",
        ticketNumber: "T-2",
        customerId: "AAA111",
        stakeUsd: 1500,
        isLive: false,
      }),
    ]);
    const run = await runCli(
      root,
      ["scan", "--agent", "AGENT9", "--limit", "7", "--source", "auto"],
      { fetchBets: source.fetchBets },
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const body = parseSingleJson(run.stdout);
    expect(body["success"]).toBe(true);
    expect(body["command"]).toBe("scan");
    expect(asString(body["generatedAt"], "generatedAt")).toBe(FIXED_NOW_ISO);

    const rules = asObject(body["rules"], "rules");
    expect(asNumber(rules["count"], "rules.count")).toBe(2);
    expect(countField(body, "rows")).toBe(2);
    expect(countField(body, "rulesEvaluated")).toBe(2);
    expect(severityCount(body, "high")).toBe(2);
    expect(severityCount(body, "medium")).toBe(1);
    const findings = findingRows(body);
    expect(findings).toHaveLength(3);

    const sourceBlock = asObject(body["source"], "source");
    expect(asString(sourceBlock["kind"], "source.kind")).toBe("live-ticker");
    expect(asString(sourceBlock["transport"], "source.transport")).toBe(
      "test-fake",
    );
    expect(asString(sourceBlock["agentId"], "source.agentId")).toBe("AGENT9");

    const customerIds = findings.map((finding) =>
      asString(
        asObject(finding["customerView"], "customerView")["customerId"],
        "customerView.customerId",
      ),
    );
    expect(customerIds).toContain("CCC107");
    expect(customerIds).toContain("AAA111");
    for (const finding of findings) {
      const view = asObject(finding["customerView"], "customerView");
      const bet = asObject(finding["bet"], "bet");
      expect(asString(view["customerId"], "customerView.customerId")).toBe(
        asString(bet["customerId"], "bet.customerId"),
      );
      expect(
        asString(view["gsLivePlayerId"], "customerView.gsLivePlayerId").length,
      ).toBeGreaterThan(0);
      expect(
        asString(view["betHistoryUrl"], "customerView.betHistoryUrl").length,
      ).toBeGreaterThan(0);
      expect(
        asString(finding["dedupeKey"], "dedupeKey").length,
      ).toBeGreaterThan(0);
    }

    const diagnostic = asObject(body["diagnostic"], "diagnostic");
    expect(asString(diagnostic["code"], "diagnostic.code")).toBe("ok");

    // Composition: the flags reached the injected fetcher, which got the --root and --now.
    const call = source.calls[0];
    expect(call).toBeDefined();
    expect(call?.agentId).toBe("AGENT9");
    expect(call?.limit).toBe(7);
    expect(call?.source).toBe("auto");
    expect(call?.rootDir).toBe(root);
    expect(call?.now?.toISOString()).toBe(FIXED_NOW_ISO);
  });

  test("--min-severity and --max-findings filter the returned findings", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const source = fakeSource([
      makeBet({ betKey: "BET-1", stakeUsd: 500, isLive: true }),
      makeBet({ betKey: "BET-2", stakeUsd: 1500, isLive: false }),
    ]);
    const high = await runCli(root, ["scan", "--min-severity", "high"], {
      fetchBets: source.fetchBets,
    });
    expect(high.code).toBe(0);
    const highBody = parseSingleJson(high.stdout);
    expect(countField(highBody, "findings")).toBe(2);
    expect(severityCount(highBody, "medium")).toBe(0);

    const capped = await runCli(root, ["scan", "--max-findings", "1"], {
      fetchBets: source.fetchBets,
    });
    expect(capped.code).toBe(0);
    expect(countField(parseSingleJson(capped.stdout), "findings")).toBe(1);
  });

  test("an unavailable source is a source_unavailable refusal (exit 3)", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const source = fakeSource([], {
      ok: false,
      source: "live-ticker",
      fetchedAt: FIXED_NOW_ISO,
      agentId: null,
      diagnostic: {
        code: "transport_unavailable",
        message: "no replay transport",
        hint: "run session:login",
      },
    });
    const run = await runCli(root, ["scan"], { fetchBets: source.fetchBets });
    expect(run.code).toBe(3);
    const body = parseSingleJson(run.stdout);
    expect(errorCode(body)).toBe("source_unavailable");
    const details = asObject(
      asObject(body["error"], "error")["details"],
      "details",
    );
    expect(
      asString(
        asObject(details["diagnostic"], "diagnostic")["code"],
        "diagnostic.code",
      ),
    ).toBe("transport_unavailable");
  });

  test("deskDateYmd resolves the desk day from the frozen clock", () => {
    expect(deskDateYmd(FIXED_NOW)).toBe("2026-11-04");
  });
});

/* -------------------------------------------------------------------------- */
/* v2 depth: enriched context baselines                                        */
/* -------------------------------------------------------------------------- */

describe("scan v2 context", () => {
  const contextRows = [
    makeBet({
      betKey: "BET-A",
      ticketNumber: "T-A",
      wagerNumber: "W-A",
      acceptedAt: "2026-11-04T20:30:00.000Z",
      stakeUsd: 100,
    }),
    makeBet({
      betKey: "BET-B",
      ticketNumber: "T-B",
      wagerNumber: "W-B",
      acceptedAt: "2026-11-04T20:38:00.000Z",
      stakeUsd: 200,
    }),
    makeBet({
      betKey: "BET-C",
      ticketNumber: "T-C",
      wagerNumber: "W-C",
      acceptedAt: "2026-11-04T20:39:00.000Z",
      stakeUsd: 300,
    }),
  ];

  function requireContext(
    contexts: ReadonlyMap<string, JsonObject>,
    betKey: string,
  ): JsonObject {
    const context = contexts.get(betKey);
    if (context === undefined) throw new Error(`no context for ${betKey}`);
    return context;
  }

  test("findings carry the deep bet fields and a default 300s bet.context", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const run = await runCli(root, ["scan"], {
      fetchBets: fakeSource(contextRows).fetchBets,
    });
    expect(run.code).toBe(0);
    const findings = findingRows(parseSingleJson(run.stdout));
    expect(findings).toHaveLength(3);
    for (const finding of findings) {
      const bet = asObject(finding["bet"], "bet");
      expect(asString(bet["eventLabel"], "bet.eventLabel")).toBe(
        "Yankees vs Red Sox",
      );
      expect(asString(bet["marketType"], "bet.marketType")).toBe("moneyline");
      expect(asString(bet["periodLabel"], "bet.periodLabel")).toBe("Game");
      expect(asBoolean(bet["isPlayerProp"], "bet.isPlayerProp")).toBe(false);
      const context = asObject(bet["context"], "bet.context");
      expect(asNumber(context["windowSeconds"], "windowSeconds")).toBe(300);
      expect(asString(context["marketKey"], "context.marketKey")).toBe(
        "Baseball|Yankees vs Red Sox|moneyline|Game|",
      );
    }

    const contexts = contextByBetKey(findings);
    const a = requireContext(contexts, "BET-A");
    expect(asNumber(a["customerPriorBets"], "A.priorBets")).toBe(0);
    expect(a["stakeVsPriorMedian"]).toBeNull();

    const b = requireContext(contexts, "BET-B");
    expect(asNumber(b["customerPriorBets"], "B.priorBets")).toBe(1);
    expect(asNumber(b["customerPriorStakeMedianUsd"], "B.priorMedian")).toBe(
      100,
    );
    expect(asNumber(b["stakeVsPriorMedian"], "B.stakeVsPriorMedian")).toBe(2);
    expect(asNumber(b["customerBetsWindow"], "B.customerBetsWindow")).toBe(2);
    expect(
      asNumber(b["customerStakeWindowUsd"], "B.customerStakeWindowUsd"),
    ).toBe(500);
    expect(asNumber(b["customerPeriodBetsWindow"], "B.periodWindow")).toBe(2);
    expect(asNumber(b["agentBetsWindow"], "B.agentBetsWindow")).toBe(2);
    expect(asNumber(b["marketCrowdBets"], "B.marketCrowdBets")).toBe(2);
    expect(asNumber(b["marketCrowdCustomers"], "B.marketCrowdCustomers")).toBe(
      1,
    );
    expect(asNumber(b["ticketLegs"], "B.ticketLegs")).toBe(1);

    const c = requireContext(contexts, "BET-C");
    expect(asNumber(c["customerPriorBets"], "C.priorBets")).toBe(2);
    expect(asNumber(c["customerPriorStakeUsd"], "C.priorStake")).toBe(300);
    expect(asNumber(c["customerPriorStakeMedianUsd"], "C.priorMedian")).toBe(
      150,
    );
    expect(asNumber(c["stakeVsPriorMedian"], "C.stakeVsPriorMedian")).toBe(2);
    expect(asNumber(c["customerBetsWindow"], "C.customerBetsWindow")).toBe(2);
  });

  test("--context-window changes the window counts, not the prior baselines", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const run = await runCli(root, ["scan", "--context-window", "60"], {
      fetchBets: fakeSource(contextRows).fetchBets,
    });
    expect(run.code).toBe(0);
    const findings = findingRows(parseSingleJson(run.stdout));
    expect(findings).toHaveLength(3);
    for (const finding of findings) {
      expect(
        asNumber(
          asObject(asObject(finding["bet"], "bet")["context"], "context")[
            "windowSeconds"
          ],
          "windowSeconds",
        ),
      ).toBe(60);
    }
    const contexts = contextByBetKey(findings);
    // now = 20:40:00; a 60s window starts at 20:39:00 (inclusive): B (20:38) is out, C is in.
    const b = requireContext(contexts, "BET-B");
    // Window counts are batch-wide (current bet included, later rows included); only C is in.
    expect(asNumber(b["customerBetsWindow"], "B.customerBetsWindow")).toBe(1);
    expect(
      asNumber(b["customerStakeWindowUsd"], "B.customerStakeWindowUsd"),
    ).toBe(300);
    expect(asNumber(b["customerPriorBets"], "B.priorBets")).toBe(1);
    const c = requireContext(contexts, "BET-C");
    expect(asNumber(c["customerBetsWindow"], "C.customerBetsWindow")).toBe(1);
    expect(
      asNumber(c["customerStakeWindowUsd"], "C.customerStakeWindowUsd"),
    ).toBe(300);
    expect(asNumber(c["agentBetsWindow"], "C.agentBetsWindow")).toBe(1);
    expect(asNumber(c["marketCrowdBets"], "C.marketCrowdBets")).toBe(1);
    expect(asNumber(c["customerPriorBets"], "C.priorBets")).toBe(2);
  });

  test("--context-window is bounded to 1..3600 (usage error exit 2)", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const rejected: readonly (readonly string[])[] = [
      ["scan", "--context-window", "0"],
      ["scan", "--context-window", "3601"],
      ["scan", "--context-window", "not-a-number"],
      ["alert", "--dry-run", "--context-window", "0"],
      ["watch", "--once", "--context-window", "3601"],
    ];
    for (const args of rejected) {
      const run = await runCli(root, args, { fetchBets: source.fetchBets });
      expect(run.code, args.join(" ")).toBe(2);
      expect(errorCode(parseSingleJson(run.stdout))).toBe("usage_error");
      expect(run.stderr).toContain("usage_error");
    }
    const low = await runCli(root, ["scan", "--context-window", "1"], {
      fetchBets: source.fetchBets,
    });
    expect(low.code).toBe(0);
    const lowContext = asObject(
      asObject(
        asObject(findingRows(parseSingleJson(low.stdout))[0], "finding")["bet"],
        "bet",
      )["context"],
      "context",
    );
    expect(asNumber(lowContext["windowSeconds"], "windowSeconds")).toBe(1);
  });
});

describe("alert v2 context", () => {
  test("alert evaluates the enriched batch and passes bet.context to the deliverer", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const seen: BetFlagFinding[] = [];
    const run = await runCli(
      root,
      ["alert", "--dry-run", "--context-window", "120"],
      {
        fetchBets: source.fetchBets,
        deliverFlagAlerts: async (findings) => {
          seen.push(...findings);
          return {
            ok: true,
            deliveries: findings.map((finding) => ({
              dedupeKey: finding.dedupeKey,
              ruleId: finding.ruleId,
              severity: finding.severity,
              outcome: "simulated",
              chatId: null,
            })),
            summary: {
              scannedFindings: findings.length,
              sent: 0,
              simulated: findings.length,
              deduped: 0,
              rateLimited: 0,
              failed: 0,
            },
          };
        },
      },
    );
    expect(run.code).toBe(0);
    expect(seen).toHaveLength(1);
    const deliveredBet = seen[0]?.bet;
    expect(deliveredBet?.marketKey).toBe(
      "Baseball|Yankees vs Red Sox|moneyline|Game|",
    );
    expect(deliveredBet?.eventLabel).toBe("Yankees vs Red Sox");
    expect(deliveredBet?.context?.windowSeconds).toBe(120);
    expect(deliveredBet?.context?.marketKey).toBe(deliveredBet?.marketKey);
    const body = parseSingleJson(run.stdout);
    expect(
      asNumber(asObject(body["scan"], "scan")["findings"], "findings"),
    ).toBe(1);
    expect(summaryField(body, "simulated")).toBe(1);
  });
});

describe("scan clock anchoring", () => {
  test("without --now the context window anchors at the newest captured bet", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    // Capture-style batch: every row is ~20 minutes old relative to wall clock.
    const wallNowMs = Date.now();
    const oldest = new Date(wallNowMs - 20 * 60 * 1000);
    const rows = [
      makeBet({
        betKey: "CAP-A",
        ticketNumber: "TC-A",
        wagerNumber: "WC-A",
        customerId: "CCC107",
        acceptedAt: oldest.toISOString(),
        stakeUsd: 100,
      }),
      makeBet({
        betKey: "CAP-B",
        ticketNumber: "TC-B",
        wagerNumber: "WC-B",
        customerId: "CCC107",
        acceptedAt: new Date(oldest.getTime() + 60_000).toISOString(),
        stakeUsd: 200,
      }),
      makeBet({
        betKey: "CAP-C",
        ticketNumber: "TC-C",
        wagerNumber: "WC-C",
        customerId: "AAA111",
        acceptedAt: new Date(oldest.getTime() + 120_000).toISOString(),
        stakeUsd: 300,
      }),
    ];
    const run = await runCli(
      root,
      ["scan"],
      { fetchBets: fakeSource(rows).fetchBets },
      { fixedNow: false },
    );
    expect(run.code).toBe(0);
    const findings = findingRows(parseSingleJson(run.stdout));
    expect(findings).toHaveLength(3);
    const contexts = contextByBetKey(findings);
    for (const betKey of ["CAP-A", "CAP-B", "CAP-C"]) {
      const context = contexts.get(betKey);
      if (context === undefined) throw new Error(`no context for ${betKey}`);
      expect(asNumber(context["windowSeconds"], "windowSeconds")).toBe(300);
      // The depth signal is alive: the window is anchored at the newest row (~18 min old).
      expect(
        asNumber(context["marketCrowdCustomers"], "marketCrowdCustomers"),
      ).toBe(2);
      expect(asNumber(context["marketCrowdBets"], "marketCrowdBets")).toBe(3);
    }
    const a = contexts.get("CAP-A");
    const c = contexts.get("CAP-C");
    if (a === undefined || c === undefined) throw new Error("missing context");
    expect(asNumber(a["customerBetsWindow"], "A.customerBetsWindow")).toBe(2);
    expect(asNumber(c["customerBetsWindow"], "C.customerBetsWindow")).toBe(1);
  });

  test("an explicit --now stays authoritative over the batch anchor", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const rows = [
      makeBet({
        betKey: "OLD-A",
        ticketNumber: "TO-A",
        wagerNumber: "WO-A",
        acceptedAt: "2026-11-04T20:20:00.000Z",
        stakeUsd: 100,
      }),
      makeBet({
        betKey: "OLD-B",
        ticketNumber: "TO-B",
        wagerNumber: "WO-B",
        acceptedAt: "2026-11-04T20:21:00.000Z",
        stakeUsd: 200,
      }),
    ];
    // --now 20:40, window 300s from 20:35: both rows are outside -> zeros.
    const pinned = await runCli(root, ["scan"], {
      fetchBets: fakeSource(rows).fetchBets,
    });
    expect(pinned.code).toBe(0);
    const pinnedContexts = contextByBetKey(
      findingRows(parseSingleJson(pinned.stdout)),
    );
    for (const context of pinnedContexts.values()) {
      expect(
        asNumber(context["customerBetsWindow"], "pinned.customerBetsWindow"),
      ).toBe(0);
      expect(
        asNumber(context["marketCrowdBets"], "pinned.marketCrowdBets"),
      ).toBe(0);
    }

    // No --now: the newest acceptedAt (20:21) anchors the window and both rows are inside.
    const anchored = await runCli(
      root,
      ["scan"],
      { fetchBets: fakeSource(rows).fetchBets },
      { fixedNow: false },
    );
    expect(anchored.code).toBe(0);
    const anchoredContexts = contextByBetKey(
      findingRows(parseSingleJson(anchored.stdout)),
    );
    for (const context of anchoredContexts.values()) {
      expect(
        asNumber(context["customerBetsWindow"], "anchored.customerBetsWindow"),
      ).toBe(2);
      expect(
        asNumber(context["marketCrowdBets"], "anchored.marketCrowdBets"),
      ).toBe(2);
    }
  });

  test("watch --once without --now uses the same batch anchor", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const oldest = new Date(Date.now() - 25 * 60 * 1000);
    const rows = [
      makeBet({
        betKey: "W-A",
        ticketNumber: "TW-A",
        wagerNumber: "WW-A",
        acceptedAt: oldest.toISOString(),
        stakeUsd: 100,
      }),
      makeBet({
        betKey: "W-B",
        ticketNumber: "TW-B",
        wagerNumber: "WW-B",
        acceptedAt: new Date(oldest.getTime() + 45_000).toISOString(),
        stakeUsd: 200,
      }),
    ];
    const run = await runCli(
      root,
      ["watch", "--once"],
      { fetchBets: fakeSource(rows).fetchBets },
      { fixedNow: false },
    );
    expect(run.code).toBe(0);
    const body = parseSingleJson(run.stdout);
    const watchContext = asObject(
      asObject(findingRows(body)[0]?.["bet"], "bet")["context"],
      "bet.context",
    );
    expect(asNumber(watchContext["windowSeconds"], "windowSeconds")).toBe(300);
    expect(
      asNumber(watchContext["customerBetsWindow"], "customerBetsWindow"),
    ).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* locate                                                                      */
/* -------------------------------------------------------------------------- */

describe("locate", () => {
  test("resolves a customer to GSLive Manager links with an honest read block", async () => {
    const root = await makeRoot();
    const run = await runCli(root, [
      "locate",
      "--customer",
      "CCC107",
      "--window",
      "3",
      "--state",
      "pending",
    ]);
    expect(run.code).toBe(0);
    const body = parseSingleJson(run.stdout);
    expect(body["command"]).toBe("locate");
    expect(asString(body["customerId"], "customerId")).toBe("CCC107");
    const links = asObject(body["links"], "links");
    expect(
      asString(links["gsLivePlayerId"], "links.gsLivePlayerId").length,
    ).toBeGreaterThan(0);
    expect(asString(links["betHistoryUrl"], "links.betHistoryUrl")).toContain(
      "bet-history",
    );
    expect(
      asString(links["playerReportUrl"], "links.playerReportUrl").length,
    ).toBeGreaterThan(0);
    expect(
      asString(links["openBetReportUrl"], "links.openBetReportUrl").length,
    ).toBeGreaterThan(0);
    const read = asObject(body["read"], "read");
    expect(asBoolean(read["available"], "read.available")).toBe(false);
    expect(asString(read["reason"], "read.reason")).toBe(
      "customer_read_not_configured",
    );
  });

  test("resolves --bet from the incoming source and reports a miss as not_found", async () => {
    const root = await makeRoot();
    const source = fakeSource([
      makeBet({ betKey: "BET-2", customerId: "AAA111" }),
    ]);
    const hit = await runCli(root, ["locate", "--bet", "BET-2"], {
      fetchBets: source.fetchBets,
    });
    expect(hit.code).toBe(0);
    const hitBody = parseSingleJson(hit.stdout);
    expect(asString(hitBody["betKey"], "betKey")).toBe("BET-2");
    expect(asString(hitBody["customerId"], "customerId")).toBe("AAA111");

    const miss = await runCli(root, ["locate", "--bet", "BET-NOPE"], {
      fetchBets: source.fetchBets,
    });
    expect(miss.code).toBe(3);
    expect(errorCode(parseSingleJson(miss.stdout))).toBe("not_found");
  });

  test("locate selector/date/state misuse is a usage error (exit 2)", async () => {
    const root = await makeRoot();
    const missing = await runCli(root, ["locate"]);
    expect(missing.code).toBe(2);
    expect(errorCode(parseSingleJson(missing.stdout))).toBe("usage_error");

    const both = await runCli(root, [
      "locate",
      "--customer",
      "CCC107",
      "--bet",
      "BET-1",
    ]);
    expect(both.code).toBe(2);

    const badState = await runCli(root, [
      "locate",
      "--customer",
      "CCC107",
      "--state",
      "not-a-state",
    ]);
    expect(badState.code).toBe(2);

    const badDate = await runCli(root, [
      "locate",
      "--customer",
      "CCC107",
      "--date",
      "2026-02-30",
    ]);
    expect(badDate.code).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* alert                                                                       */
/* -------------------------------------------------------------------------- */

describe("alert", () => {
  test("dry run is repeatable and never advances the dedupe ledger", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const statePath = join(root, ALERT_STATE_REL_PATH);
    // Two dry runs in a row: both must preview the SAME finding, and neither may write state.
    for (const runNumber of [1, 2]) {
      const run = await runCli(root, ["alert", "--dry-run"], {
        fetchBets: source.fetchBets,
      });
      expect(run.code).toBe(0);
      const body = parseSingleJson(run.stdout);
      expect(body["command"]).toBe("alert");
      expect(summaryField(body, "scannedFindings")).toBe(1);
      expect(summaryField(body, "simulated"), `dry run ${runNumber}`).toBe(1);
      expect(summaryField(body, "sent")).toBe(0);
      expect(summaryField(body, "deduped")).toBe(0);
      expect(summaryField(body, "failed")).toBe(0);
      const deliveries = deliveryRows(body);
      expect(deliveries).toHaveLength(1);
      expect(asString(deliveries[0]?.["outcome"], "outcome")).toBe("simulated");
      expect(deliveries[0]?.["chatId"]).toBeNull();
      // v2 context enrichment must not change the dedupe identity.
      expect(asString(deliveries[0]?.["dedupeKey"], "dedupeKey")).toBe(
        "stake_over_100:BET-0001",
      );
      expect(existsSync(statePath)).toBe(false);
    }
  });

  test("a live delivery advances the ledger, then the second identical run dedupes", async () => {
    const root = await makeRoot();
    const statePath = join(root, ALERT_STATE_REL_PATH);
    const finding = makeFinding({ dedupeKey: "stake_over_100:BET-0001" });
    const sends: string[] = [];
    const options = {
      credentials: { botToken: "123:abc", chatId: "42" },
      statePath,
      now: FIXED_NOW,
      sendMessage: async (chatId: string, html: string) => {
        sends.push(`${chatId}:${html.length}`);
        return { ok: true, message_id: 77 };
      },
    };
    const first = await deliverFlagAlerts([finding], options);
    expect(first.ok).toBe(true);
    expect(first.summary.sent).toBe(1);
    expect(first.deliveries[0]?.messageId).toBe(77);
    expect(sends).toHaveLength(1);
    expect(existsSync(statePath)).toBe(true);

    const second = await deliverFlagAlerts([finding], options);
    expect(second.ok).toBe(true);
    expect(second.summary.deduped).toBe(1);
    expect(second.summary.sent).toBe(0);
    expect(sends).toHaveLength(1);
  });

  test("dry run honours --chat-id in the delivery record but never sends", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const run = await runCli(root, ["alert", "--dry-run", "--chat-id", "42"], {
      fetchBets: source.fetchBets,
    });
    expect(run.code).toBe(0);
    const delivery = deliveryRows(parseSingleJson(run.stdout))[0];
    expect(asString(delivery?.["chatId"], "chatId")).toBe("42");
    expect(asString(delivery?.["outcome"], "outcome")).toBe("simulated");
  });

  test("max-messages caps the batch and reports the overflow as rate_limited", async () => {
    const rows = Array.from({ length: 30 }, (_unused, index) =>
      makeBet({
        betKey: `BET-${index}`,
        ticketNumber: `T-${index}`,
        wagerNumber: `W-${index}`,
        stakeUsd: 500,
      }),
    );
    const generousRoot = await makeRoot(HIGH_ONLY_YAML);
    const generous = await runCli(
      generousRoot,
      ["alert", "--dry-run", "--max-messages", "20"],
      { fetchBets: fakeSource(rows).fetchBets },
    );
    expect(generous.code).toBe(0);
    const generousBody = parseSingleJson(generous.stdout);
    expect(summaryField(generousBody, "simulated")).toBe(30);
    expect(summaryField(generousBody, "rateLimited")).toBe(0);

    const tightRoot = await makeRoot(HIGH_ONLY_YAML);
    const tight = await runCli(
      tightRoot,
      ["alert", "--dry-run", "--max-messages", "1"],
      { fetchBets: fakeSource(rows).fetchBets },
    );
    expect(tight.code).toBe(0);
    const tightBody = parseSingleJson(tight.stdout);
    const simulated = summaryField(tightBody, "simulated");
    const rateLimited = summaryField(tightBody, "rateLimited");
    expect(simulated).toBeGreaterThan(0);
    expect(rateLimited).toBeGreaterThan(0);
    expect(simulated + rateLimited).toBe(30);
    expect(deliveryRows(tightBody)).toHaveLength(30);
  });

  test("--min-severity (default medium) excludes lower-severity findings", async () => {
    const root = await makeRoot(LOW_ONLY_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const run = await runCli(root, ["alert", "--dry-run"], {
      fetchBets: source.fetchBets,
    });
    expect(run.code).toBe(0);
    const body = parseSingleJson(run.stdout);
    expect(
      asNumber(asObject(body["scan"], "scan")["findings"], "scan.findings"),
    ).toBe(1);
    expect(summaryField(body, "scannedFindings")).toBe(1);
    expect(deliveryRows(body)).toHaveLength(0);
    expect(summaryField(body, "simulated")).toBe(0);
  });

  test("a dedupe entry inside the 7-day window previews as deduped, an expired one as deliverable", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const statePath = join(root, ALERT_STATE_REL_PATH);
    // The engine's key is `<ruleId>:<betKey>`; the fixture bet is BET-0001.
    const key = "stake_over_100:BET-0001";
    await mkdir(dirname(statePath), { recursive: true });
    const state = {
      schemaVersion: 1,
      deliveries: {
        [key]: {
          ruleId: "stake_over_100",
          severity: "high",
          deliveredAt: FIXED_NOW_ISO,
        },
      },
    };
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");

    const fresh = await runCli(root, ["alert", "--dry-run"], {
      fetchBets: source.fetchBets,
    });
    expect(fresh.code).toBe(0);
    const freshBody = parseSingleJson(fresh.stdout);
    expect(summaryField(freshBody, "deduped")).toBe(1);
    expect(summaryField(freshBody, "simulated")).toBe(0);

    state.deliveries[key].deliveredAt = "2026-10-01T00:00:00.000Z";
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
    const expired = await runCli(root, ["alert", "--dry-run"], {
      fetchBets: source.fetchBets,
    });
    expect(expired.code).toBe(0);
    const expiredBody = parseSingleJson(expired.stdout);
    expect(summaryField(expiredBody, "simulated")).toBe(1);
    expect(summaryField(expiredBody, "deduped")).toBe(0);
  });

  test("a corrupt dedupe state fails open instead of dropping the alert", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const statePath = join(root, ALERT_STATE_REL_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "not json at all\n", "utf8");
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const run = await runCli(root, ["alert", "--dry-run"], {
      fetchBets: source.fetchBets,
    });
    expect(run.code).toBe(0);
    expect(summaryField(parseSingleJson(run.stdout), "simulated")).toBe(1);
    // The corrupt file is left untouched: a dry run never writes the ledger.
    expect(await readFile(statePath, "utf8")).toBe("not json at all\n");
  });

  test("alert uses the injected deliverer and never touches Telegram or the keychain", async () => {
    const root = await makeRoot(HIGH_ONLY_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const seenFindings: number[] = [];
    const run = await runCli(root, ["alert"], {
      fetchBets: source.fetchBets,
      deliverFlagAlerts: async (findings) => {
        seenFindings.push(findings.length);
        return {
          ok: true,
          deliveries: findings.map((finding) => ({
            dedupeKey: finding.dedupeKey,
            ruleId: finding.ruleId,
            severity: finding.severity,
            outcome: "sent",
            chatId: "42",
            messageId: 1,
          })),
          summary: {
            scannedFindings: findings.length,
            sent: findings.length,
            simulated: 0,
            deduped: 0,
            rateLimited: 0,
            failed: 0,
          },
        };
      },
    });
    expect(run.code).toBe(0);
    expect(seenFindings).toEqual([1]);
    const body = parseSingleJson(run.stdout);
    expect(summaryField(body, "sent")).toBe(1);
    expect(asString(deliveryRows(body)[0]?.["outcome"], "outcome")).toBe(
      "sent",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* watch                                                                       */
/* -------------------------------------------------------------------------- */

describe("watch", () => {
  test("--once emits one NDJSON tick and appends it to the tick log", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500, isLive: false })]);
    const run = await runCli(root, ["watch", "--once"], {
      fetchBets: source.fetchBets,
    });
    expect(run.code).toBe(0);
    const body = parseSingleJson(run.stdout);
    expect(body["command"]).toBe("watch");
    expect(body["success"]).toBe(true);
    expect(asNumber(body["tick"], "tick")).toBe(1);
    expect(asNumber(body["intervalSeconds"], "intervalSeconds")).toBe(60);
    expect(countField(body, "rows")).toBe(1);
    expect(countField(body, "findings")).toBe(1);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    const watchBet = asObject(findingRows(body)[0]?.["bet"], "bet");
    const watchContext = asObject(watchBet["context"], "bet.context");
    expect(asNumber(watchContext["windowSeconds"], "windowSeconds")).toBe(300);
    expect(asString(watchBet["marketType"], "marketType")).toBe("moneyline");

    const logPath = join(
      root,
      "Scratch/watchlist-autobet/bet-flags-watch.jsonl",
    );
    expect(existsSync(logPath)).toBe(true);
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const firstLine = lines[0];
    if (firstLine === undefined) throw new Error("expected one watch-log line");
    const logged = asObject(JSON.parse(firstLine), "watch-log");
    expect(logged["command"]).toBe("watch");
    expect(asNumber(logged["tick"], "logged.tick")).toBe(1);
  });

  test("--interval below 15 is a usage error (exit 2)", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const run = await runCli(root, ["watch", "--once", "--interval", "5"]);
    expect(run.code).toBe(2);
    const body = parseSingleJson(run.stdout);
    expect(errorCode(body)).toBe("usage_error");
    expect(run.stderr).toContain("usage_error");
  });
});

/* -------------------------------------------------------------------------- */
/* Usage errors + rendering + credentials                                      */
/* -------------------------------------------------------------------------- */

describe("usage errors", () => {
  test("unknown flag, unknown command and missing command exit 2 with one JSON object", async () => {
    const root = await makeRoot(TWO_RULES_YAML);

    const unknownFlag = await runCli(root, ["scan", "--bogus"]);
    expect(unknownFlag.code).toBe(2);
    expect(errorCode(parseSingleJson(unknownFlag.stdout))).toBe("usage_error");
    expect(unknownFlag.stderr).toContain("usage_error");

    const unknownCommand = await runCli(root, ["frobnicate"]);
    expect(unknownCommand.code).toBe(2);
    expect(errorCode(parseSingleJson(unknownCommand.stdout))).toBe(
      "usage_error",
    );

    let stdout = "";
    let stderr = "";
    const missingCommand = await runSportsdeskBetFlagsCli(["--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(missingCommand).toBe(2);
    expect(errorCode(parseSingleJson(stdout))).toBe("usage_error");
    expect(stderr).toContain("usage_error");
  });
});

describe("renderAlertMessage", () => {
  test("escapes user text while keeping Telegram tags", () => {
    const html = renderAlertMessage([
      makeFinding({
        ruleTitle: "Pwn <b>",
        bet: makeBet({
          customerId: "<script>",
          agentId: "a&b",
          selection: "<img src=x>",
        }),
      }),
    ]);
    expect(html).toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).toContain("1 finding");
  });
});

describe("resolveTelegramCredentials", () => {
  test("a fully configured environment wins without a keychain read", async () => {
    const credentials = await resolveTelegramCredentials({
      TELEGRAM_BOT_TOKEN: " 123:abc ",
      TELEGRAM_CHAT_ID: " 42 ",
    });
    expect(credentials).toEqual({
      botToken: "123:abc",
      chatId: "42",
      source: "env",
    });
  });
});

describe("telegram alert audit integration", () => {
  test("a live delivery is audited with rule identity, chat and hash — no message text", async () => {
    const root = await makeRoot();
    const statePath = join(root, ALERT_STATE_REL_PATH);
    const finding = makeFinding({ dedupeKey: "stake_over_100:BET-0001" });
    const result = await deliverFlagAlerts([finding], {
      credentials: { botToken: "123:abc", chatId: "42" },
      statePath,
      now: FIXED_NOW,
      audit: { root, chatLabel: "deskbotops" },
      sendMessage: async () => ({ ok: true, message_id: 77 }),
    });
    expect(result.summary.sent).toBe(1);

    const rows = await readAlertAudit(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.source).toBe("flag-alert");
    expect(rows[0]?.chatId).toBe("42");
    expect(rows[0]?.chatLabel).toBe("deskbotops");
    expect(rows[0]?.ruleId).toBe("stake_over_100");
    expect(rows[0]?.severity).toBe("high");
    expect(rows[0]?.messageId).toBe(77);
    expect(rows[0]?.messageSha256).toHaveLength(64);
    expect(rows[0]?.messageChars).toBeGreaterThan(0);
    // The alerted bettor and dimensions are tracked (never the message text).
    expect(rows[0]?.customerId).toBe(finding.bet.customerId);
    expect(rows[0]?.sport).toBe(finding.bet.sport);
    expect(rows[0]?.wagerType).toBe(finding.bet.wagerType);
    // The rendered HTML/text is not stored.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("<b>");
    expect(serialized).not.toContain("Stake over $100");
  });

  test("a deduped run is recorded as deduped, without a chat", async () => {
    const root = await makeRoot();
    const statePath = join(root, ALERT_STATE_REL_PATH);
    const finding = makeFinding();
    const options = {
      credentials: { botToken: "123:abc", chatId: "42" },
      statePath,
      now: FIXED_NOW,
      audit: { root },
      sendMessage: async () => ({ ok: true, message_id: 77 }),
    };
    await deliverFlagAlerts([finding], options);
    await deliverFlagAlerts([finding], options);
    const rows = await readAlertAudit(root);
    expect(rows.map((row) => row.status).sort()).toEqual(["deduped", "sent"]);
    const deduped = rows.find((row) => row.status === "deduped");
    expect(deduped?.chatId).toBeNull();
  });

  test("CLI alert --dry-run writes simulated rows and alert-log reads them", async () => {
    const root = await makeRoot(TWO_RULES_YAML);
    const source = fakeSource([makeBet({ stakeUsd: 500 })]);
    const run = await runCli(root, ["alert", "--dry-run"], {
      fetchBets: source.fetchBets,
    });
    expect(run.code).toBe(0);

    const rows = await readAlertAudit(root);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "simulated")).toBe(true);
    expect(rows[0]?.dedupeKey).toContain("stake_over_100");

    const log = await runCli(root, ["alert-log"]);
    expect(log.code).toBe(0);
    const body = parseSingleJson(log.stdout);
    expect(body["command"]).toBe("alert-log");
    const summary = body["summary"] as Record<string, unknown>;
    expect(Number(summary["total"])).toBeGreaterThan(0);
    const byStatus = summary["byStatus"] as Record<string, unknown>;
    expect(Number(byStatus["simulated"])).toBe(rows.length);
  });

  test("alert-log filters and can merge the bot activity log", async () => {
    const root = await makeRoot();
    const auditDir = join(root, "Scratch/watchlist-autobet");
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, "telegram-alerts.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        atIso: "2026-11-05T07:00:00.000Z",
        source: "flag-alert",
        chatId: "42",
        chatLabel: "deskbotops",
        status: "sent",
        ruleId: "stake_over_100",
        severity: "high",
      })}\n`,
    );
    const activityDir = join(root, "reports");
    await mkdir(activityDir, { recursive: true });
    await writeFile(
      join(activityDir, "telegram-activity.jsonl"),
      `${JSON.stringify({
        at: "2026-11-05T07:10:00.000Z",
        direction: "out",
        chatId: "",
        summary: "pulse",
        outcome: "simulated",
        detail: "TELEGRAM_BOT_TOKEN is not set",
      })}\n`,
    );

    const onlyAudit = await runCli(root, ["alert-log", "--status", "sent"]);
    expect(onlyAudit.code).toBe(0);
    const auditBody = parseSingleJson(onlyAudit.stdout);
    expect((auditBody["rows"] as unknown[]).length).toBe(1);

    const merged = await runCli(root, ["alert-log", "--include-activity"]);
    expect(merged.code).toBe(0);
    const mergedBody = parseSingleJson(merged.stdout);
    const rows = mergedBody["rows"] as Record<string, unknown>[];
    expect(rows.length).toBe(2);
    expect(rows.some((row) => row["source"] === "telegram-activity")).toBe(
      true,
    );

    const invalid = await runCli(root, ["alert-log", "--status", "nonsense"]);
    expect(invalid.code).toBe(2);

    // Backfill imports the historical outbound activity row, then is idempotent.
    const backfilled = await runCli(root, [
      "alert-log",
      "--backfill",
      "--summary",
    ]);
    expect(backfilled.code).toBe(0);
    const backfillBody = parseSingleJson(backfilled.stdout);
    const backfillInfo = backfillBody["backfill"] as Record<string, unknown>;
    expect(Number(backfillInfo["imported"])).toBe(1);
    const rollups = backfillBody["rollups"] as Record<string, unknown>;
    expect(Array.isArray(rollups["daily"])).toBe(true);
    expect(Array.isArray(rollups["chat"])).toBe(true);
    expect(Array.isArray(rollups["rule"])).toBe(true);

    const again = await runCli(root, ["alert-log", "--backfill"]);
    const againInfo = parseSingleJson(again.stdout)["backfill"] as Record<
      string,
      unknown
    >;
    expect(Number(againInfo["imported"])).toBe(0);
    expect(Number(againInfo["skipped"])).toBeGreaterThan(0);

    // Chat filter matches the recorded label, not the activity row's empty chat.
    const chatOnly = await runCli(root, ["alert-log", "--chat", "deskbotops"]);
    expect(chatOnly.code).toBe(0);
    const chatRows = parseSingleJson(chatOnly.stdout)["rows"] as Record<
      string,
      unknown
    >[];
    expect(chatRows.length).toBe(1);
    expect(chatRows[0]?.["chatLabel"]).toBe("deskbotops");

    // CSV export bypasses the JSON envelope (and refuses --json).
    let csvOut = "";
    const csvCode = await runSportsdeskBetFlagsCli(
      ["alert-log", "--csv", "--root", root],
      {
        stdout: (text) => {
          csvOut += text;
        },
      },
    );
    expect(csvCode).toBe(0);
    expect(csvOut.split("\n")[0]).toContain("atIso,source,status,chatId");
    expect(csvOut).toContain("deskbotops");
    const csvJson = await runCli(root, ["alert-log", "--csv"]);
    expect(csvJson.code).toBe(2);
  });

  test("alert-log --performance joins alerted customers to outcomes by dimension", async () => {
    const root = await makeRoot();
    const auditDir = join(root, "Scratch/watchlist-autobet");
    await mkdir(auditDir, { recursive: true });
    const auditRow = (
      customerId: string,
      wagerNumber: string,
      atIso: string,
    ) => ({
      schemaVersion: 1,
      atIso,
      source: "flag-alert",
      chatId: "8013171035",
      chatLabel: "deskbotops",
      status: "sent",
      ruleId: "stake_over_10k",
      severity: "high",
      customerId,
      wagerNumber,
      sport: "Football",
      subSport: "Total",
      period: "Game",
      wagerType: "M",
    });
    await writeFile(
      join(auditDir, "telegram-alerts.jsonl"),
      `${JSON.stringify(auditRow("ALPHA", "1", "2026-11-05T07:00:00.000Z"))}\n${JSON.stringify(auditRow("BETA", "2", "2026-11-05T07:01:00.000Z"))}\n`,
    );
    await writeFile(
      join(root, "enriched_customers_full.json"),
      `${JSON.stringify([
        {
          customer_id: "ALPHA",
          recent_tickets: [{ wager_number: 1, result: "WIN", net_usd: 250 }],
        },
        {
          customer_id: "BETA",
          recent_tickets: [{ wager_number: 2, result: "LOSS", net_usd: -75 }],
        },
      ])}\n`,
    );

    // Default: no outcome source unless explicitly opted in.
    const noSource = await runCli(root, ["alert-log", "--performance"]);
    const noSourceBody = parseSingleJson(noSource.stdout)[
      "performance"
    ] as Record<string, unknown>;
    expect(noSourceBody["available"]).toBe(false);
    expect(String(noSourceBody["reason"])).toContain("no outcomes source");

    const run = await runCli(root, [
      "alert-log",
      "--performance",
      "--use-customer-book-sample",
    ]);
    expect(run.code).toBe(0);
    const body = parseSingleJson(run.stdout);
    const performance = body["performance"] as Record<string, unknown>;
    expect(performance["available"]).toBe(true);
    expect((performance["warnings"] as unknown[]).length).toBeGreaterThan(0);
    expect(performance["matched"]).toBe(2);
    const dimensions = performance["dimensions"] as Record<string, unknown>[];
    const sport = dimensions.find(
      (group) => group["dimension"] === "sport" && group["key"] === "Football",
    );
    expect(sport).toBeDefined();
    expect(
      (sport?.["topWinner"] as Record<string, unknown>)?.["customerId"],
    ).toBe("ALPHA");
    expect(
      (sport?.["topLoser"] as Record<string, unknown>)?.["customerId"],
    ).toBe("BETA");

    let humanOut = "";
    const humanCode = await runSportsdeskBetFlagsCli(
      ["alert-log", "--performance", "--root", root],
      {
        stdout: (text) => {
          humanOut += text;
        },
      },
    );
    expect(humanCode).toBe(0);
    expect(humanOut).toContain("alert performance");

    // An explicit outcomes file overrides the book.
    const outcomesPath = join(root, "outcomes.jsonl");
    await writeFile(
      outcomesPath,
      `${JSON.stringify({ customerId: "ALPHA", wagerNumber: 1, outcome: "LOSS", netUsd: -40 })}\n`,
    );
    const explicit = await runCli(root, [
      "alert-log",
      "--performance",
      "--outcomes",
      outcomesPath,
    ]);
    const explicitBody = parseSingleJson(explicit.stdout)[
      "performance"
    ] as Record<string, unknown>;
    expect(explicitBody["outcomeSource"]).toBe("outcomes_file");
    expect(explicitBody["matched"]).toBe(1);

    // A missing explicit outcomes path is unavailable, not zero.
    const missing = await runCli(root, [
      "alert-log",
      "--performance",
      "--outcomes",
      join(root, "absent.json"),
    ]);
    const missingBody = parseSingleJson(missing.stdout)[
      "performance"
    ] as Record<string, unknown>;
    expect(missingBody["available"]).toBe(false);
    expect(String(missingBody["reason"])).toContain("outcome source missing");
  });
});
