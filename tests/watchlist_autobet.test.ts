import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  // ast-grep-ignore: node-fs-read-write-file -- sync CLI fixtures; the CLI under test is sync.
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  arrayValue,
  booleanValue,
  numberValue,
  recordValue,
  stringValue,
} from "../lib/zod_guards.ts";

import {
  AUTOBET_CONFIG_REL_PATH,
  AUTOBET_GATE_CHECKS,
  AUTOBET_REFERENCE_SOURCE,
  AUTOBET_SCHEMA_VERSION,
  AutobetError,
  appendLedgerEvent,
  assertIntentTransition,
  assertPaperVenue,
  buildAutobetIntent,
  buildLedgerEvent,
  clampStakeUsd,
  computeCapUsage,
  computeEffectiveImpliedProb,
  computePaperFill,
  computePayoutIfWinCents,
  computeSettlement,
  countIntentsByStatus,
  deskDayYmd,
  evaluateSignalGates,
  intentCreatedEventData,
  ledgerLockPathFor,
  ledgerPathFor,
  loadAutobetConfig,
  parseAutobetConfig,
  readLedger,
  resolveIntentStatus,
  summarizeIntents,
  withLedgerLock,
  type AutobetConfig,
  type AutobetErrorCode,
  type AutobetIntent,
  type GateContext,
  type GateResult,
  type PaperFill,
  type Settlement,
} from "../lib/watchlist_autobet.ts";
import type {
  SignalAccount,
  SignalProvenance,
  WatchlistSignal,
} from "../lib/watchlist_signal_engine.ts";

/**
 * Watchlist autobet engine + CLI contract tests.
 *
 * The CLI lifecycle test spawns the real CLI against a temp `--root` with crafted artifacts (same
 * shapes the watchlist signal engine tests build) and pins the clock with `--now`, so every
 * derived timestamp, cap window and gate verdict is deterministic.
 */

const NOW = new Date("2026-11-04T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const CLI_PATH = join(import.meta.dir, "..", "cli", "watchlist_autobet_cli.ts");

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-watchlist-autobet-"));
  temporaryRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function validConfigRaw(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "paper",
    stakeUsd: 25,
    maxStakeUsd: 100,
    dailyStakeCapUsd: 500,
    perLeagueDailyStakeCapUsd: 250,
    minConfidence: 60,
    minDistinctAccounts: 2,
    minOneSidedShare: 0.6,
    maxSignalAgeSeconds: 900,
    allowFixtureSignals: false,
    allowLiveExecution: false,
    paperSlippageBps: 50,
    expireApprovedAfterMinutes: 120,
    ledgerPath: "Scratch/watchlist-autobet/ledger.jsonl",
    eligibleLeagues: ["NBA", "NFL", "CFB", "EPL", "NHL", "MLB"],
    ...overrides,
  };
}

function baseConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): AutobetConfig {
  const parsed = parseAutobetConfig(validConfigRaw(overrides));
  if (!parsed.ok) {
    throw new Error(
      `test config fixture is invalid: ${JSON.stringify(parsed.errors)}`,
    );
  }
  return parsed.config;
}

function provenance(
  overrides: Partial<SignalProvenance> = {},
): SignalProvenance {
  return {
    dataMode: "LIVE",
    asOf: NOW_ISO,
    ageSeconds: 60,
    stale: false,
    fixture: false,
    sources: ["docs/graph-live-feed.json"],
    ...overrides,
  };
}

function account(
  login: string,
  riskUsd: number,
  sourceCategory = "POLY_ONCHAIN_CTF_WHALE",
): SignalAccount {
  return {
    login,
    agentId: "AGENT",
    archetype: "test archetype",
    sourceCategory,
    riskUsd,
    source: "docs/graph-live-feed.json",
  };
}

function makeSignal(overrides: Partial<WatchlistSignal> = {}): WatchlistSignal {
  return {
    id: "NBA-BOS_LAL-total-55.5-over",
    league: "NBA",
    marketKind: "total",
    teams: ["LAL", "BOS"],
    sideTeam: null,
    line: 55.5,
    overUnder: "over",
    accounts: [account("BGD101", 16_200), account("MJ103", 11_500)],
    distinctAccounts: 2,
    riskUsd: 27_700,
    oneSidedShare: 1,
    fairProb: 0.4651,
    confidence: 70,
    provenance: provenance(),
    ...overrides,
  };
}

function gateContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    config: baseConfig(),
    now: NOW,
    stakeUsd: 25,
    dailyStakeUsedUsd: 0,
    leagueStakeUsedUsd: 0,
    existingIntents: [],
    ...overrides,
  };
}

function gateFor(
  signal: WatchlistSignal,
  overrides: Partial<GateContext> = {},
): GateResult {
  return evaluateSignalGates(signal, gateContext(overrides));
}

function makeIntent(overrides: Partial<AutobetIntent> = {}): AutobetIntent {
  const signal = makeSignal();
  const gate = evaluateSignalGates(signal, gateContext());
  const intent = buildAutobetIntent(signal, gate, {
    config: baseConfig(),
    now: NOW,
    actor: "tester",
  });
  return { ...intent, ...overrides };
}

function fakeFill(overrides: Partial<PaperFill> = {}): PaperFill {
  return {
    venue: "paper",
    filledAt: NOW_ISO,
    stakeUsd: 25,
    effectiveImpliedProb: 0.5,
    effectiveAmericanOdds: 100,
    payoutIfWinUsd: 25,
    slippageBps: 50,
    referenceSource: AUTOBET_REFERENCE_SOURCE,
    ...overrides,
  };
}

function fakeSettlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    result: "won",
    settledAt: NOW_ISO,
    profitUsd: 25,
    payoutUsd: 50,
    ...overrides,
  };
}

function captureAutobetError(fn: () => unknown): AutobetError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AutobetError) return error;
    throw error;
  }
  throw new Error("expected an AutobetError, but nothing was thrown");
}

async function captureAsyncAutobetError(
  promise: Promise<unknown>,
): Promise<AutobetError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AutobetError) return error;
    throw error;
  }
  throw new Error("expected an AutobetError, but nothing was thrown");
}

/* -------------------------------------------------------------------------- */
/* CLI spawn helpers                                                           */
/* -------------------------------------------------------------------------- */

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly body: Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return recordValue(value);
}

/**
 * Run the real CLI. Global flags are deliberately appended AFTER the subcommand (the plugin
 * invokes it that way), so this also proves position-independent global parsing.
 */
function runCli(
  root: string,
  args: readonly string[],
  nowIso: string = NOW_ISO,
): CliResult {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      CLI_PATH,
      ...args,
      "--json",
      "--root",
      root,
      "--now",
      nowIso,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  let body: Record<string, unknown> = {};
  try {
    body = parseJsonObject(stdout);
  } catch {
    body = {};
  }
  return { code: proc.exitCode ?? -1, stdout, stderr, body };
}

/**
 * Run the real CLI concurrently (async spawn) — used by the concurrency-safety tests, where
 * `Bun.spawnSync` would serialize the processes and hide the race.
 */
async function runCliAsync(
  root: string,
  args: readonly string[],
  nowIso: string = NOW_ISO,
): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      CLI_PATH,
      ...args,
      "--json",
      "--root",
      root,
      "--now",
      nowIso,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  let body: Record<string, unknown> = {};
  try {
    body = parseJsonObject(stdout);
  } catch {
    body = {};
  }
  return { code, stdout, stderr, body };
}

/**
 * Run the real CLI with raw argv (no implicit globals). Help tests need this because `--help`
 * must work without a valid --root/config: it exits before any artifact or config is read.
 */
function runCliRaw(args: readonly string[]): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
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

function writeAutobetConfig(
  root: string,
  raw: Record<string, unknown> = validConfigRaw(),
): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, AUTOBET_CONFIG_REL_PATH),
    `${JSON.stringify(raw, null, 2)}\n`,
  );
}

function feedRow(
  login: string,
  canonicalMarket: string,
  riskUsd: number,
  oddsAmerican: string,
): Record<string, unknown> {
  return {
    ticketId: `T-${login}-${canonicalMarket}`,
    f402CustomerId: login,
    agentOwner: "AGENT",
    sourceVenue: "F402",
    sportAndPeriod: "NBA • Game",
    canonicalMarket,
    oddsAmerican,
    riskUsd,
    toWinUsd: riskUsd,
    placedAtUtc: "2026-11-04 10:00:00 UTC",
  };
}

interface ArtifactOptions {
  readonly fixtureFeed?: boolean;
  readonly observedAt?: string;
}

/** Crafted artifacts in the exact shapes `lib/watchlist_signal_engine.ts` parses. */
function writeSignalArtifacts(
  root: string,
  options: ArtifactOptions = {},
): void {
  const observedAt = options.observedAt ?? "2026-11-04T11:59:00.000Z";
  const fixtureFeed = options.fixtureFeed ?? false;
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "docs/graph-live-feed.json"),
    JSON.stringify(
      {
        schemaVersion: 3,
        dataMode: fixtureFeed ? "FIXTURE" : "LIVE",
        lastUpdatedIso: observedAt,
        provenance: { f402: { source: fixtureFeed ? "fixture" : "live" } },
        pendingBets: [
          feedRow("BGD101", "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5", 16_200, "+115"),
          feedRow("MJ103", "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5", 11_500, "+115"),
          feedRow("BGD101", "NBA_DEN_PHX_TOTAL_UNDER_223.5", 6_000, "-110"),
          feedRow("MJ103", "NBA_DEN_PHX_TOTAL_UNDER_223.5", 6_000, "-110"),
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "data/live-wagers.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        source: "paste:clipboard-ticker",
        observedAt,
        LIST: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "data/live-bets.json"),
    JSON.stringify(
      {
        capturedAt: observedAt,
        dataSource: fixtureFeed ? "fixture" : "live",
        games: [],
      },
      null,
      2,
    ),
  );
}

function ledgerFile(root: string): string {
  return join(root, "Scratch", "watchlist-autobet", "ledger.jsonl");
}

/** The default artifacts plus two accounts the registry does not watch. */
function writeCandidateArtifacts(root: string): void {
  writeSignalArtifacts(root, { observedAt: "2026-11-04T11:59:00.000Z" });
  writeFileSync(
    join(root, "data/live-wagers.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        source: "capture:/cloud/api/Manager/getBetTicker",
        observedAt: "2026-11-04T11:59:00.000Z",
        LIST: [
          {
            WagerNumber: "767173499",
            AgentID: "MARWES50",
            CustomerID: "JP1833",
            Login: "JP1833",
            WagerType: "M",
            AmountWagered: 21_600,
            InsertDateTime: "2026-11-01 17:18:20",
            TicketWriter: "Internet",
            ShortDesc:
              "M.G319748913\r\nFootball - Denver Broncos vs Kansas City Chiefs / Game / Total / Over 46.5 -108",
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "data/live-bets.json"),
    JSON.stringify(
      {
        capturedAt: "2026-11-04T11:59:00.000Z",
        dataSource: "capture:/cloud/api/Report/Pending",
        games: [
          {
            customerID: "CC364",
            agent: { id: "HRGROUP", key: "HRGROUP", level: 6 },
            wagered: 22_400_000,
            acceptedAt: "2026-11-01 14:33:47.900",
            sport: "Basketball",
            period: "1st Quarter",
            description: "Basketball #501 LAL -1.5 -110 - 1st Quarter",
            chosenTeam: "LAL",
            team1: { shortName: "LAL" },
            team2: { shortName: "BOS" },
          },
        ],
      },
      null,
      2,
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

describe("autobet config", () => {
  test("parses the frozen contract defaults", () => {
    const parsed = parseAutobetConfig(validConfigRaw());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.schemaVersion).toBe(1);
    expect(parsed.config.enabled).toBe(true);
    expect(parsed.config.mode).toBe("paper");
    expect(parsed.config.stakeUsd).toBe(25);
    expect(parsed.config.maxStakeUsd).toBe(100);
    expect(parsed.config.dailyStakeCapUsd).toBe(500);
    expect(parsed.config.perLeagueDailyStakeCapUsd).toBe(250);
    expect(parsed.config.minConfidence).toBe(60);
    expect(parsed.config.minDistinctAccounts).toBe(2);
    expect(parsed.config.minOneSidedShare).toBe(0.6);
    expect(parsed.config.maxSignalAgeSeconds).toBe(900);
    expect(parsed.config.allowFixtureSignals).toBe(false);
    expect(parsed.config.allowLiveExecution).toBe(false);
    expect(parsed.config.paperSlippageBps).toBe(50);
    expect(parsed.config.expireApprovedAfterMinutes).toBe(120);
    expect(parsed.config.ledgerPath).toBe(
      "Scratch/watchlist-autobet/ledger.jsonl",
    );
    expect(parsed.config.eligibleLeagues).toEqual([
      "NBA",
      "NFL",
      "CFB",
      "EPL",
      "NHL",
      "MLB",
    ]);
  });

  test("rejects unknown keys", () => {
    const parsed = parseAutobetConfig(validConfigRaw({ rogue: 1 }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.path)).toContain("rogue");
  });

  test("refuses live mode and live execution", () => {
    const parsed = parseAutobetConfig(
      validConfigRaw({ mode: "live", allowLiveExecution: true }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const paths = parsed.errors.map((error) => error.path);
    expect(paths).toContain("mode");
    expect(paths).toContain("allowLiveExecution");
  });

  test("rejects bad ranges and relations in one pass", () => {
    const parsed = parseAutobetConfig(
      validConfigRaw({
        schemaVersion: 2,
        stakeUsd: 0,
        maxStakeUsd: 10,
        dailyStakeCapUsd: -1,
        perLeagueDailyStakeCapUsd: -1,
        minConfidence: 101,
        minDistinctAccounts: 0,
        minOneSidedShare: 1.5,
        maxSignalAgeSeconds: 0,
        paperSlippageBps: -1,
        expireApprovedAfterMinutes: 0,
        eligibleLeagues: [],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const paths = parsed.errors.map((error) => error.path);
    for (const expected of [
      "schemaVersion",
      "stakeUsd",
      "dailyStakeCapUsd",
      "perLeagueDailyStakeCapUsd",
      "minConfidence",
      "minDistinctAccounts",
      "minOneSidedShare",
      "maxSignalAgeSeconds",
      "paperSlippageBps",
      "expireApprovedAfterMinutes",
      "eligibleLeagues",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  test("rejects stake above maxStakeUsd", () => {
    const parsed = parseAutobetConfig(
      validConfigRaw({ stakeUsd: 500, maxStakeUsd: 100 }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.path)).toContain("stakeUsd");
  });

  test("rejects unsafe ledger paths and unknown/duplicate leagues", () => {
    const parsed = parseAutobetConfig(
      validConfigRaw({
        ledgerPath: "/tmp/ledger.jsonl",
        eligibleLeagues: ["NBA", "NBA", "XFL"],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const byPath = new Map(
      parsed.errors.map((error) => [error.path, error.message]),
    );
    expect(byPath.get("ledgerPath") ?? "").toContain("repo-relative");
    expect(byPath.get("eligibleLeagues[1]") ?? "").toContain("duplicate");
    expect(byPath.get("eligibleLeagues[2]") ?? "").toContain("must be one of");
  });

  test("rejects a ledger path that escapes the root", () => {
    const parsed = parseAutobetConfig(
      validConfigRaw({ ledgerPath: "../elsewhere/ledger.jsonl" }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.path)).toContain("ledgerPath");
  });

  test("rejects a ledger file symlink that resolves outside the root", () => {
    const root = makeTemporaryRoot();
    const outside = makeTemporaryRoot();
    mkdirSync(join(root, "Scratch", "watchlist-autobet"), { recursive: true });
    const outsideLedger = join(outside, "outside-ledger.jsonl");
    writeFileSync(outsideLedger, "");
    symlinkSync(
      outsideLedger,
      join(root, "Scratch", "watchlist-autobet", "ledger.jsonl"),
    );

    let error: unknown = null;
    try {
      ledgerPathFor(root, baseConfig());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AutobetError);
    expect((error as AutobetError).code).toBe("internal_error");
    expect((error as AutobetError).message).toContain("symlink");
  });

  test("a missing config file is config_missing, not defaults", async () => {
    const root = makeTemporaryRoot();
    const error = await captureAsyncAutobetError(loadAutobetConfig(root));
    expect(error.code).toBe("config_missing");
    expect(error.exitCode).toBe(1);
  });

  test("invalid JSON config is config_invalid", async () => {
    const root = makeTemporaryRoot();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, AUTOBET_CONFIG_REL_PATH), "{not json");
    const error = await captureAsyncAutobetError(loadAutobetConfig(root));
    expect(error.code).toBe("config_invalid");
  });

  test("loads a valid config file from the root", async () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    const config = await loadAutobetConfig(root);
    expect(config.stakeUsd).toBe(25);
    expect(config.mode).toBe("paper");
  });
});

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

describe("signal gates", () => {
  const EXPECTED_CHECK_ORDER = [...AUTOBET_GATE_CHECKS];

  test("a compliant signal is eligible and all checks pass in table order", () => {
    const gate = gateFor(makeSignal());
    expect(gate.eligible).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(gate.checks.map((check) => check.check)).toEqual(
      EXPECTED_CHECK_ORDER,
    );
    expect(gate.checks.every((check) => check.ok)).toBe(true);
  });

  test("enabled: a disabled config refuses every signal", () => {
    const gate = gateFor(makeSignal(), {
      config: baseConfig({ enabled: false }),
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reasons).toEqual(["enabled"]);
  });

  test("league_allowed: exact membership only, UNKNOWN never passes", () => {
    expect(gateFor(makeSignal({ league: "UNKNOWN" })).reasons).toEqual([
      "league_allowed",
    ]);
    expect(
      gateFor(makeSignal(), {
        config: baseConfig({ eligibleLeagues: ["NFL"] }),
      }).reasons,
    ).toEqual(["league_allowed"]);
    expect(gateFor(makeSignal({ league: "NFL" })).eligible).toBe(true);
  });

  test("fixture_provenance: refused by default, opt-in via config", () => {
    const fixtureSignal = makeSignal({
      provenance: provenance({ fixture: true }),
    });
    expect(gateFor(fixtureSignal).reasons).toEqual(["fixture_provenance"]);
    expect(
      gateFor(fixtureSignal, {
        config: baseConfig({ allowFixtureSignals: true }),
      }).eligible,
    ).toBe(true);
  });

  test("freshness: missing asOf, engine-stale and too-old all fail", () => {
    const noAsOf = makeSignal({
      provenance: provenance({ asOf: null, ageSeconds: null }),
    });
    expect(gateFor(noAsOf).reasons).toEqual(["freshness"]);

    const engineStale = makeSignal({
      provenance: provenance({ stale: true }),
    });
    expect(gateFor(engineStale).reasons).toEqual(["freshness"]);

    const tooOld = makeSignal({
      provenance: provenance({ ageSeconds: 1_000 }),
    });
    expect(gateFor(tooOld).reasons).toEqual(["freshness"]);

    // Boundary: exactly maxSignalAgeSeconds is still fresh.
    const atLimit = makeSignal({
      provenance: provenance({ ageSeconds: 900 }),
    });
    expect(gateFor(atLimit).eligible).toBe(true);
  });

  test("confidence, distinct_accounts and one_sided_share floors", () => {
    expect(gateFor(makeSignal({ confidence: 59 })).reasons).toEqual([
      "confidence",
    ]);
    expect(gateFor(makeSignal({ confidence: 60 })).eligible).toBe(true);
    expect(gateFor(makeSignal({ distinctAccounts: 1 })).reasons).toEqual([
      "distinct_accounts",
    ]);
    expect(gateFor(makeSignal({ oneSidedShare: 0.5 })).reasons).toEqual([
      "one_sided_share",
    ]);
    expect(gateFor(makeSignal({ oneSidedShare: 0.6 })).eligible).toBe(true);
  });

  test("reference_price: null, 0 and 1 are all refused", () => {
    for (const fairProb of [null, 0, 1]) {
      expect(gateFor(makeSignal({ fairProb })).reasons).toEqual([
        "reference_price",
      ]);
    }
    expect(gateFor(makeSignal({ fairProb: Number.NaN })).reasons).toEqual([
      "reference_price",
    ]);
  });

  test("stake_available: a zero clamped stake is refused", () => {
    const zeroStake: AutobetConfig = {
      ...baseConfig(),
      stakeUsd: 0,
      maxStakeUsd: 0,
    };
    const gate = gateFor(makeSignal(), {
      config: zeroStake,
      stakeUsd: clampStakeUsd(zeroStake),
    });
    expect(gate.reasons).toEqual(["stake_available"]);
  });

  test("per-bet clamp is min(stakeUsd, maxStakeUsd)", () => {
    // Config parse enforces stakeUsd <= maxStakeUsd, so a loaded config never clamps down; the
    // clamp stays as a defensive boundary (the spread below can only be built in-process).
    expect(clampStakeUsd(baseConfig())).toBe(25);
    const unclamped: AutobetConfig = {
      ...baseConfig(),
      stakeUsd: 500,
      maxStakeUsd: 100,
    };
    expect(clampStakeUsd(unclamped)).toBe(100);
    expect(
      gateFor(makeSignal(), {
        config: unclamped,
        stakeUsd: clampStakeUsd(unclamped),
      }).eligible,
    ).toBe(true);
  });

  test("daily_stake_cap: used + stake may not exceed the desk-day cap", () => {
    expect(
      gateFor(makeSignal(), { dailyStakeUsedUsd: 480, stakeUsd: 25 }).reasons,
    ).toEqual(["daily_stake_cap"]);
    expect(
      gateFor(makeSignal(), { dailyStakeUsedUsd: 475, stakeUsd: 25 }).eligible,
    ).toBe(true);
  });

  test("league_daily_cap: used + stake may not exceed the per-league cap", () => {
    expect(
      gateFor(makeSignal(), { leagueStakeUsedUsd: 230, stakeUsd: 25 }).reasons,
    ).toEqual(["league_daily_cap"]);
    expect(
      gateFor(makeSignal(), { leagueStakeUsedUsd: 225, stakeUsd: 25 }).eligible,
    ).toBe(true);
  });

  test("duplicate_intent: sealed statuses block, rejected/expired release", () => {
    const signal = makeSignal();
    const blocked: AutobetIntent[] = [
      makeIntent(),
      makeIntent({ status: "approved" }),
      makeIntent({ status: "filled", fill: fakeFill() }),
      makeIntent({
        status: "settled",
        fill: fakeFill(),
        settlement: fakeSettlement(),
      }),
    ];
    for (const intent of blocked) {
      const gate = gateFor(signal, { existingIntents: [intent] });
      expect(gate.reasons).toEqual(["duplicate_intent"]);
      expect(gate.eligible).toBe(false);
    }

    expect(
      gateFor(signal, {
        existingIntents: [makeIntent({ status: "rejected" })],
      }).eligible,
    ).toBe(true);

    const expiredApproval = makeIntent({
      status: "approved",
      expiresAt: "2026-11-04T11:00:00.000Z",
    });
    expect(resolveIntentStatus(expiredApproval, NOW)).toBe("expired");
    expect(
      gateFor(signal, { existingIntents: [expiredApproval] }).eligible,
    ).toBe(true);
  });

  test("reasons are failed check ids in table order", () => {
    const signal = makeSignal({
      league: "UNKNOWN",
      confidence: 10,
      provenance: provenance({ fixture: true }),
    });
    expect(gateFor(signal).reasons).toEqual([
      "league_allowed",
      "fixture_provenance",
      "confidence",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Desk day and caps                                                           */
/* -------------------------------------------------------------------------- */

describe("desk day and caps", () => {
  test("deskDayYmd uses America/Chicago across midnight and DST", () => {
    // 2026-11-04: CST (UTC-6) after DST ended on Nov 1.
    expect(deskDayYmd(new Date("2026-11-04T05:59:59.000Z"))).toBe("2026-11-03");
    expect(deskDayYmd(new Date("2026-11-04T06:00:00.000Z"))).toBe("2026-11-04");
    // 2026-07-04: CDT (UTC-5).
    expect(deskDayYmd(new Date("2026-07-04T04:59:59.000Z"))).toBe("2026-07-03");
    expect(deskDayYmd(new Date("2026-07-04T05:00:00.000Z"))).toBe("2026-07-04");
  });

  test("computeCapUsage sums today's reserved stake, releasing rejected/expired", () => {
    const intents: AutobetIntent[] = [
      makeIntent({ status: "queued", stakeUsd: 25, league: "NBA" }),
      makeIntent({ status: "approved", stakeUsd: 50, league: "NFL" }),
      makeIntent({
        status: "filled",
        stakeUsd: 40,
        league: "NBA",
        fill: fakeFill(),
      }),
      makeIntent({
        status: "settled",
        stakeUsd: 25,
        league: "NBA",
        fill: fakeFill(),
        settlement: fakeSettlement(),
      }),
      makeIntent({ status: "rejected", stakeUsd: 100, league: "NBA" }),
      makeIntent({
        status: "approved",
        stakeUsd: 30,
        league: "NBA",
        expiresAt: "2026-11-04T11:00:00.000Z",
      }),
      makeIntent({
        status: "queued",
        stakeUsd: 25,
        league: "NBA",
        createdAt: "2026-11-04T05:00:00.000Z",
      }),
    ];
    const usage = computeCapUsage(intents, NOW);
    expect(usage.dailyStakeUsedUsd).toBe(140);
    expect(usage.byLeagueStakeUsedUsd["NBA"]).toBe(90);
    expect(usage.byLeagueStakeUsedUsd["NFL"]).toBe(50);
  });

  test("countIntentsByStatus derives expiry at read time", () => {
    const intents: AutobetIntent[] = [
      makeIntent({ status: "queued" }),
      makeIntent({
        status: "approved",
        expiresAt: "2026-11-04T11:00:00.000Z",
      }),
      makeIntent({
        status: "settled",
        fill: fakeFill(),
        settlement: fakeSettlement(),
      }),
      makeIntent({ status: "rejected" }),
    ];
    expect(countIntentsByStatus(intents, NOW)).toEqual({
      total: 4,
      queued: 1,
      approved: 0,
      filled: 0,
      settled: 1,
      rejected: 1,
      expired: 1,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Intent lifecycle                                                            */
/* -------------------------------------------------------------------------- */

describe("intent lifecycle", () => {
  test("buildAutobetIntent snapshots the signal and reference price", () => {
    const signal = makeSignal();
    const intent = makeIntent();
    expect(intent.intentId.startsWith("wa-")).toBe(true);
    expect(intent.signalId).toBe(signal.id);
    expect(intent.marketKey).toBe(signal.id);
    expect(intent.side).toBe("over");
    expect(intent.league).toBe("NBA");
    expect(intent.stakeUsd).toBe(25);
    expect(intent.referenceImpliedProb).toBe(0.4651);
    expect(intent.referenceAmericanOdds).toBe(115);
    expect(intent.status).toBe("queued");
    expect(intent.fill).toBeNull();
    expect(intent.settlement).toBeNull();
    expect(intent.createdBy).toBe("tester");
    expect(intent.createdAt).toBe(NOW_ISO);
    expect(intent.expiresAt).toBe(
      new Date(NOW.getTime() + 120 * 60_000).toISOString(),
    );
    expect(intent.accounts).toHaveLength(2);
    expect(intent.provenance.sources).toEqual(["docs/graph-live-feed.json"]);
    expect(intent.gates.every((check) => check.ok)).toBe(true);
  });

  test("approve -> execute -> settle is the only legal chain", () => {
    const queued = makeIntent();
    // `assertIntentTransition` validates and returns the resolved intent; the command layer
    // records the transition event and the ledger fold applies the new status.
    expect(
      assertIntentTransition(queued, "approve", NOW, queued.intentId).intentId,
    ).toBe(queued.intentId);
    const approved: AutobetIntent = { ...queued, status: "approved" };
    const executable = assertIntentTransition(
      approved,
      "execute",
      NOW,
      queued.intentId,
    );
    expect(executable.status).toBe("approved");
    const filled: AutobetIntent = {
      ...approved,
      status: "filled",
      fill: fakeFill(),
    };
    const settleable = assertIntentTransition(
      filled,
      "settle",
      NOW,
      queued.intentId,
    );
    expect(settleable.status).toBe("filled");
    expect(settleable.fill).not.toBeNull();
  });

  test("every illegal transition is refused", () => {
    const queued = makeIntent();
    const approved = makeIntent({ status: "approved" });
    const filled = makeIntent({ status: "filled", fill: fakeFill() });
    const settled = makeIntent({
      status: "settled",
      fill: fakeFill(),
      settlement: fakeSettlement(),
    });

    const cases: Array<{
      readonly intent: AutobetIntent | undefined;
      readonly action: "approve" | "reject" | "execute" | "settle";
      readonly code: AutobetErrorCode;
    }> = [
      { intent: approved, action: "approve", code: "invalid_transition" },
      { intent: filled, action: "approve", code: "invalid_transition" },
      { intent: settled, action: "approve", code: "invalid_transition" },
      { intent: queued, action: "execute", code: "invalid_transition" },
      { intent: filled, action: "execute", code: "invalid_transition" },
      { intent: settled, action: "execute", code: "invalid_transition" },
      { intent: approved, action: "settle", code: "invalid_transition" },
      { intent: queued, action: "settle", code: "invalid_transition" },
      { intent: settled, action: "reject", code: "invalid_transition" },
      { intent: undefined, action: "approve", code: "intent_not_found" },
    ];
    for (const testCase of cases) {
      const error = captureAutobetError(() =>
        assertIntentTransition(
          testCase.intent,
          testCase.action,
          NOW,
          "wa-missing",
        ),
      );
      expect(error.code).toBe(testCase.code);
    }
  });

  test("reject is allowed from queued and approved", () => {
    const queued = makeIntent();
    const approved = makeIntent({ status: "approved" });
    expect(
      assertIntentTransition(queued, "reject", NOW, queued.intentId).status,
    ).toBe("queued");
    expect(
      assertIntentTransition(approved, "reject", NOW, approved.intentId).status,
    ).toBe("approved");
  });

  test("an expired approval is refused with intent_expired and exit code 3", () => {
    const expiredApproval = makeIntent({
      status: "approved",
      expiresAt: "2026-11-04T12:01:00.000Z",
    });
    const later = new Date("2026-11-04T12:05:00.000Z");
    expect(resolveIntentStatus(expiredApproval, later)).toBe("expired");
    const approveError = captureAutobetError(() =>
      assertIntentTransition(
        expiredApproval,
        "approve",
        later,
        expiredApproval.intentId,
      ),
    );
    expect(approveError.code).toBe("intent_expired");
    expect(approveError.exitCode).toBe(3);
    const executeError = captureAutobetError(() =>
      assertIntentTransition(
        expiredApproval,
        "execute",
        later,
        expiredApproval.intentId,
      ),
    );
    expect(executeError.code).toBe("intent_expired");
    const settleError = captureAutobetError(() =>
      assertIntentTransition(
        expiredApproval,
        "settle",
        later,
        expiredApproval.intentId,
      ),
    );
    expect(settleError.code).toBe("invalid_transition");
  });

  test("assertPaperVenue refuses every non-paper venue", () => {
    expect(assertPaperVenue(undefined)).toBe("paper");
    expect(assertPaperVenue("paper")).toBe("paper");
    for (const venue of ["live", "draftkings", "polymarket", "PAPER"]) {
      const error = captureAutobetError(() => assertPaperVenue(venue));
      expect(error.code).toBe("live_disabled");
      expect(error.exitCode).toBe(3);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Paper math                                                                  */
/* -------------------------------------------------------------------------- */

describe("paper math", () => {
  test("slippage worsens the reference implied probability", () => {
    expect(computeEffectiveImpliedProb(0.5, 0)).toBe(0.5);
    expect(computeEffectiveImpliedProb(0.5, 50)).toBe(0.5025);
    expect(computeEffectiveImpliedProb(0.4651, 50)).toBe(0.467425);
    expect(computeEffectiveImpliedProb(0.5, 50)).toBeGreaterThan(0.5);
  });

  test("payout-if-win is integer cents of win profit", () => {
    expect(computePayoutIfWinCents(2_500, 0.5)).toBe(2_500);
    expect(computePayoutIfWinCents(2_500, 0.5025)).toBe(2_475);
  });

  test("paper fill applies slippage, rounds cents and labels the reference", () => {
    const config = baseConfig();
    const intent = makeIntent({ fairProb: 0.5, referenceImpliedProb: 0.5 });
    const fill = computePaperFill({ intent, config, now: NOW });
    expect(fill.venue).toBe("paper");
    expect(fill.filledAt).toBe(NOW_ISO);
    expect(fill.stakeUsd).toBe(25);
    expect(fill.effectiveImpliedProb).toBe(0.5025);
    expect(fill.effectiveAmericanOdds).toBe(-101);
    expect(fill.payoutIfWinUsd).toBe(24.75);
    expect(fill.slippageBps).toBe(50);
    expect(fill.referenceSource).toBe("watchlist_signal.fairProb");

    const noSlippage = computePaperFill({
      intent,
      config: baseConfig({ paperSlippageBps: 0 }),
      now: NOW,
    });
    expect(noSlippage.payoutIfWinUsd).toBe(25);
    expect(noSlippage.payoutIfWinUsd).toBeGreaterThan(fill.payoutIfWinUsd);
  });

  test("settlement pays win profit, forfeits stake, or returns a void stake", () => {
    const fill = fakeFill({ stakeUsd: 25, payoutIfWinUsd: 24.75 });
    const won = computeSettlement(fill, "won", NOW);
    expect(won).toEqual({
      result: "won",
      settledAt: NOW_ISO,
      profitUsd: 24.75,
      payoutUsd: 49.75,
    });
    expect(computeSettlement(fill, "lost", NOW).profitUsd).toBe(-25);
    expect(computeSettlement(fill, "lost", NOW).payoutUsd).toBe(0);
    expect(computeSettlement(fill, "void", NOW).profitUsd).toBe(0);
    expect(computeSettlement(fill, "void", NOW).payoutUsd).toBe(25);
  });

  test("summary reports paper P&L and ROI over settled stake only", () => {
    const intents: AutobetIntent[] = [
      makeIntent({
        status: "settled",
        stakeUsd: 25,
        fill: fakeFill(),
        settlement: fakeSettlement({ profitUsd: 24.75, payoutUsd: 49.75 }),
      }),
      makeIntent({
        status: "settled",
        stakeUsd: 25,
        fill: fakeFill(),
        settlement: fakeSettlement({
          result: "lost",
          profitUsd: -25,
          payoutUsd: 0,
        }),
      }),
      makeIntent({ status: "queued", stakeUsd: 25 }),
      makeIntent({ status: "rejected", stakeUsd: 25 }),
    ];
    const summary = summarizeIntents(intents);
    expect(summary.intents).toBe(4);
    expect(summary.byStatus).toEqual({
      queued: 1,
      approved: 0,
      filled: 0,
      settled: 2,
      rejected: 1,
      expired: 0,
    });
    expect(summary.stakedUsd).toBe(75);
    expect(summary.settledStakeUsd).toBe(50);
    expect(summary.profitUsd).toBe(-0.25);
    expect(summary.roiPct).toBe(-0.5);
    expect(summary.pendingStakeUsd).toBe(25);
  });
});

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

describe("ledger", () => {
  const createdEvent = (intent: AutobetIntent) =>
    buildLedgerEvent(
      "intent_created",
      intent.intentId,
      NOW,
      "tester",
      intentCreatedEventData(intent),
    );
  const approvedEvent = (intent: AutobetIntent) =>
    buildLedgerEvent("intent_approved", intent.intentId, NOW, "approver", {});
  const filledEvent = (intent: AutobetIntent, fill: PaperFill) =>
    buildLedgerEvent("intent_filled", intent.intentId, NOW, "operator", {
      fill,
    });
  const settledEvent = (intent: AutobetIntent, settlement: Settlement) =>
    buildLedgerEvent("intent_settled", intent.intentId, NOW, "operator", {
      settlement,
    });

  test("append is one JSONL line per event, mode 0600, and folds into intents", async () => {
    const root = makeTemporaryRoot();
    const path = join(root, "ledger.jsonl");
    const intent = makeIntent();
    await appendLedgerEvent(path, createdEvent(intent));
    await appendLedgerEvent(path, approvedEvent(intent));
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const result = await readLedger(path, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(2);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]?.status).toBe("approved");
    expect(result.summary.stakedUsd).toBe(25);
    expect(result.summary.pendingStakeUsd).toBe(25);
  });

  test("a missing ledger reads as an empty book, not zero events", async () => {
    const root = makeTemporaryRoot();
    const result = await readLedger(join(root, "missing.jsonl"), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([]);
    expect(result.intents).toEqual([]);
    expect(result.summary.intents).toBe(0);
    expect(result.summary.profitUsd).toBe(0);
    expect(result.summary.roiPct).toBe(0);
  });

  test("a malformed line is ledger_corrupt with its line number", async () => {
    const root = makeTemporaryRoot();
    const intent = makeIntent();
    const path = join(root, "ledger.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(createdEvent(intent))}\nnot json at all\n`,
    );
    const result = await readLedger(path, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ledger_corrupt");
    expect(result.line).toBe(2);

    writeFileSync(path, `${JSON.stringify(createdEvent(intent))}\n\n`);
    const blank = await readLedger(path, { now: NOW });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.line).toBe(2);
  });

  test("an unknown-intent or out-of-order transition is corrupt, never skipped", async () => {
    const root = makeTemporaryRoot();
    const intent = makeIntent();
    const unknownFirst = join(root, "unknown-first.jsonl");
    writeFileSync(unknownFirst, `${JSON.stringify(approvedEvent(intent))}\n`);
    const unknown = await readLedger(unknownFirst, { now: NOW });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.line).toBe(1);

    const doubleApprove = join(root, "double-approve.jsonl");
    writeFileSync(
      doubleApprove,
      `${JSON.stringify(createdEvent(intent))}\n${JSON.stringify(
        approvedEvent(intent),
      )}\n${JSON.stringify(approvedEvent(intent))}\n`,
    );
    const corrupt = await readLedger(doubleApprove, { now: NOW });
    expect(corrupt.ok).toBe(false);
    if (corrupt.ok) return;
    expect(corrupt.line).toBe(3);
    expect(corrupt.message).toContain("not allowed after approved");
  });

  test("lifecycle events fold into a settled intent with paper P&L", async () => {
    const root = makeTemporaryRoot();
    const path = join(root, "ledger.jsonl");
    const intent = makeIntent();
    const fill = fakeFill({ stakeUsd: 25, payoutIfWinUsd: 24.75 });
    const settlement = fakeSettlement({ profitUsd: 24.75, payoutUsd: 49.75 });
    await appendLedgerEvent(path, createdEvent(intent));
    await appendLedgerEvent(path, approvedEvent(intent));
    await appendLedgerEvent(path, filledEvent(intent, fill));
    await appendLedgerEvent(path, settledEvent(intent, settlement));

    const result = await readLedger(path, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(4);
    const folded = result.intents[0];
    expect(folded?.status).toBe("settled");
    expect(folded?.fill?.referenceSource).toBe(AUTOBET_REFERENCE_SOURCE);
    expect(folded?.settlement?.profitUsd).toBe(24.75);
    expect(result.summary.settledStakeUsd).toBe(25);
    expect(result.summary.profitUsd).toBe(24.75);
    expect(result.summary.roiPct).toBe(99);
  });

  test("expiry is derived at read time and releases the reserved stake", async () => {
    const root = makeTemporaryRoot();
    const path = join(root, "ledger.jsonl");
    const intent = makeIntent({
      status: "approved",
      expiresAt: "2026-11-04T13:00:00.000Z",
    });
    await appendLedgerEvent(path, createdEvent(intent));
    await appendLedgerEvent(
      path,
      buildLedgerEvent("intent_approved", intent.intentId, NOW, "op", {}),
    );
    const later = new Date("2026-11-04T14:01:00.000Z");
    const result = await readLedger(path, { now: later });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents[0]?.status).toBe("expired");
    expect(computeCapUsage(result.intents, later).dailyStakeUsedUsd).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI contract (spawned)                                                      */
/* -------------------------------------------------------------------------- */

describe("CLI contract", () => {
  test("usage errors exit 2 with usage_error on stdout and stderr", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    const cases: ReadonlyArray<readonly string[]> = [
      ["nonsense"],
      ["status", "--bogus"],
      ["signals", "--limit", "500"],
      ["watch", "--interval-seconds", "10"],
      ["approve", "wa-x"],
      ["reject", "wa-x", "--actor", "op"],
      ["settle", "wa-x", "--result", "draw"],
      ["status", "extra-positional"],
    ];
    for (const args of cases) {
      const result = runCli(root, args);
      expect(result.code).toBe(2);
      const error = recordValue(result.body["error"]);
      expect(stringValue(error["code"])).toBe("usage_error");
      expect(result.stderr.trim().length).toBeGreaterThan(0);
      expect(booleanValue(result.body["success"])).toBe(false);
      expect(numberValue(result.body["schemaVersion"])).toBe(1);
    }
  });

  test("a missing config file is config_missing (exit 1)", () => {
    const root = makeTemporaryRoot();
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(1);
    expect(stringValue(recordValue(result.body["error"])["code"])).toBe(
      "config_missing",
    );
  });

  test("missing artifacts and ledger are MISSING, never reported as zero records", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);

    const status = runCli(root, ["status"]);
    expect(status.code).toBe(0);
    expect(booleanValue(status.body["success"])).toBe(true);
    const ledger = recordValue(status.body["ledger"]);
    expect(booleanValue(ledger["exists"])).toBe(false);
    expect(numberValue(ledger["events"])).toBe(0);
    const sources = arrayValue(status.body["sources"]);
    expect(sources).toHaveLength(3);
    for (const source of sources) {
      const record = recordValue(source);
      expect(stringValue(record["path"]).length).toBeGreaterThan(0);
      expect(booleanValue(record["exists"])).toBe(false);
      expect(record["ageSeconds"]).toBeNull();
      expect(booleanValue(record["stale"])).toBe(true);
    }

    const signals = runCli(root, ["signals"]);
    expect(signals.code).toBe(0);
    const counts = recordValue(signals.body["counts"]);
    expect(numberValue(counts["total"])).toBe(0);
    expect(numberValue(counts["eligible"])).toBe(0);

    const enqueue = runCli(root, ["enqueue"]);
    expect(enqueue.code).toBe(0);
    expect(arrayValue(enqueue.body["created"])).toHaveLength(0);
  });

  test("a corrupt ledger fails journal with ledger_corrupt and the line number", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    mkdirSync(join(root, "Scratch", "watchlist-autobet"), { recursive: true });
    const intent = makeIntent();
    writeFileSync(
      ledgerFile(root),
      `${JSON.stringify(
        buildLedgerEvent(
          "intent_created",
          intent.intentId,
          NOW,
          "tester",
          intentCreatedEventData(intent),
        ),
      )}\n{truncated\n`,
    );
    const result = runCli(root, ["journal"]);
    expect(result.code).toBe(1);
    const error = recordValue(result.body["error"]);
    expect(stringValue(error["code"])).toBe("ledger_corrupt");
    const details = recordValue(error["details"]);
    expect(numberValue(details["line"])).toBe(2);
    expect(result.stderr).toContain("ledger_corrupt");
  });

  test("fixture and stale signals are shown but never eligible", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeSignalArtifacts(root, {
      fixtureFeed: true,
      observedAt: "2026-11-04T08:00:00.000Z",
    });

    const hidden = runCli(root, ["signals"]);
    expect(hidden.code).toBe(0);
    expect(arrayValue(hidden.body["signals"])).toHaveLength(0);

    const shown = runCli(root, ["signals", "--include-rejected"]);
    expect(shown.code).toBe(0);
    const counts = recordValue(shown.body["counts"]);
    expect(numberValue(counts["total"])).toBe(2);
    expect(numberValue(counts["eligible"])).toBe(0);
    expect(numberValue(counts["rejected"])).toBe(2);
    const first = recordValue(arrayValue(shown.body["signals"])[0]);
    const gate = recordValue(first["gate"]);
    expect(booleanValue(gate["eligible"])).toBe(false);
    expect(gate["reasons"]).toEqual(["fixture_provenance", "freshness"]);
    const signal = recordValue(first["signal"]);
    const signalProvenance = recordValue(signal["provenance"]);
    expect(booleanValue(signalProvenance["fixture"])).toBe(true);

    const enqueue = runCli(root, ["enqueue"]);
    expect(enqueue.code).toBe(0);
    expect(arrayValue(enqueue.body["created"])).toHaveLength(0);
    const skipped = arrayValue(enqueue.body["skipped"]);
    expect(skipped).toHaveLength(2);
    expect(arrayValue(recordValue(skipped[0])["reasons"])).toContain(
      "fixture_provenance",
    );
  });

  test("approving an expired intent refuses with intent_expired and records expiry once", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    mkdirSync(join(root, "Scratch", "watchlist-autobet"), { recursive: true });
    const intent = makeIntent({
      expiresAt: "2026-11-04T12:01:00.000Z",
    });
    writeFileSync(
      ledgerFile(root),
      `${JSON.stringify(
        buildLedgerEvent(
          "intent_created",
          intent.intentId,
          NOW,
          "tester",
          intentCreatedEventData(intent),
        ),
      )}\n`,
    );
    const laterIso = "2026-11-04T12:05:00.000Z";

    const first = runCli(
      root,
      ["approve", intent.intentId, "--actor", "operator"],
      laterIso,
    );
    expect(first.code).toBe(3);
    expect(stringValue(recordValue(first.body["error"])["code"])).toBe(
      "intent_expired",
    );

    const journalAfterFirst = runCli(root, ["journal"], laterIso);
    const events = arrayValue(journalAfterFirst.body["events"]);
    expect(events).toHaveLength(2);
    expect(stringValue(recordValue(events[1])["type"])).toBe("intent_expired");

    const second = runCli(
      root,
      ["approve", intent.intentId, "--actor", "operator"],
      laterIso,
    );
    expect(second.code).toBe(3);
    const journalAfterSecond = runCli(root, ["journal"], laterIso);
    expect(arrayValue(journalAfterSecond.body["events"])).toHaveLength(2);
  });

  test("end-to-end paper lifecycle in a temp root", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeSignalArtifacts(root);

    // 1. status: config present, empty ledger, three live sources.
    const status = runCli(root, ["status"]);
    expect(status.code).toBe(0);
    expect(status.body["success"]).toBe(true);
    expect(stringValue(status.body["command"])).toBe("status");
    expect(numberValue(status.body["schemaVersion"])).toBe(
      AUTOBET_SCHEMA_VERSION,
    );
    expect(status.stdout.trim().split("\n")).toHaveLength(1);
    const effective = recordValue(
      recordValue(status.body["config"])["effective"],
    );
    expect(stringValue(effective["mode"])).toBe("paper");
    expect(numberValue(effective["stakeUsd"])).toBe(25);
    const ledgerBefore = recordValue(status.body["ledger"]);
    expect(booleanValue(ledgerBefore["exists"])).toBe(false);
    expect(numberValue(recordValue(ledgerBefore["intents"])["total"])).toBe(0);
    const safety = recordValue(status.body["safety"]);
    expect(booleanValue(safety["liveExecution"])).toBe(false);
    expect(stringValue(safety["reason"])).toBe("paper_mode_only");
    const sources = arrayValue(status.body["sources"]);
    expect(sources).toHaveLength(3);
    for (const source of sources) {
      expect(booleanValue(recordValue(source)["exists"])).toBe(true);
    }

    // 2. signals: two fresh, non-fixture signals, both eligible.
    const signals = runCli(root, ["signals"]);
    expect(signals.code).toBe(0);
    const signalCounts = recordValue(signals.body["counts"]);
    expect(numberValue(signalCounts["total"])).toBe(2);
    expect(numberValue(signalCounts["eligible"])).toBe(2);
    expect(numberValue(signalCounts["rejected"])).toBe(0);
    const signalRows = arrayValue(signals.body["signals"]);
    expect(signalRows).toHaveLength(2);
    const firstSignalRow = recordValue(signalRows[0]);
    expect(booleanValue(recordValue(firstSignalRow["gate"])["eligible"])).toBe(
      true,
    );
    const firstSignal = recordValue(firstSignalRow["signal"]);
    expect(
      booleanValue(recordValue(firstSignal["provenance"])["fixture"]),
    ).toBe(false);
    expect(arrayValue(signals.body["sources"])).toHaveLength(3);

    // 3. plan: dry run queues both, nothing written.
    const plan = runCli(root, ["plan"]);
    expect(plan.code).toBe(0);
    const wouldQueue = arrayValue(plan.body["wouldQueue"]);
    expect(wouldQueue).toHaveLength(2);
    expect(arrayValue(plan.body["skipped"])).toHaveLength(0);
    const caps = recordValue(plan.body["caps"]);
    expect(numberValue(caps["dailyStakeCapUsd"])).toBe(500);
    expect(numberValue(caps["dailyStakeUsedUsd"])).toBe(0);
    expect(numberValue(caps["remainingUsd"])).toBe(500);
    expect(numberValue(caps["perLeagueDailyStakeCapUsd"])).toBe(250);
    expect(
      numberValue(
        recordValue(runCli(root, ["status"]).body["ledger"])["events"],
      ),
    ).toBe(0);

    // 4. enqueue creates both intents; a second run is idempotent.
    const enqueue = runCli(root, ["enqueue", "--actor", "e2e-operator"]);
    expect(enqueue.code).toBe(0);
    const created = arrayValue(enqueue.body["created"]);
    expect(created).toHaveLength(2);
    const intentA = recordValue(created[0]);
    const intentB = recordValue(created[1]);
    const intentAId = stringValue(intentA["intentId"]);
    const intentBId = stringValue(intentB["intentId"]);
    expect(intentAId.startsWith("wa-")).toBe(true);
    expect(stringValue(intentA["createdBy"])).toBe("e2e-operator");
    expect(stringValue(intentA["status"])).toBe("queued");
    const enqueueLedger = recordValue(enqueue.body["ledger"]);
    expect(numberValue(recordValue(enqueueLedger["intents"])["queued"])).toBe(
      2,
    );
    expect(numberValue(enqueueLedger["events"])).toBe(2);

    const enqueueAgain = runCli(root, ["enqueue"]);
    expect(enqueueAgain.code).toBe(0);
    expect(arrayValue(enqueueAgain.body["created"])).toHaveLength(0);
    const skippedAgain = arrayValue(enqueueAgain.body["skipped"]);
    expect(skippedAgain).toHaveLength(2);
    for (const skipped of skippedAgain) {
      const record = recordValue(skipped);
      expect(arrayValue(record["reasons"])).toContain("duplicate_intent");
      expect(stringValue(record["existingIntentId"]).startsWith("wa-")).toBe(
        true,
      );
    }

    // 5. list: both queued.
    const queuedList = runCli(root, ["list", "--status", "queued"]);
    expect(queuedList.code).toBe(0);
    expect(arrayValue(queuedList.body["intents"])).toHaveLength(2);

    // 6. execution is refused before approval.
    const executeQueued = runCli(root, ["execute", intentAId]);
    expect(executeQueued.code).toBe(3);
    expect(stringValue(recordValue(executeQueued.body["error"])["code"])).toBe(
      "invalid_transition",
    );

    // 7. approve (human decision), then every out-of-order action is refused.
    const approve = runCli(root, [
      "approve",
      intentAId,
      "--actor",
      "e2e-approver",
      "--note",
      "paper approval",
    ]);
    expect(approve.code).toBe(0);
    expect(stringValue(recordValue(approve.body["intent"])["status"])).toBe(
      "approved",
    );

    const approveAgain = runCli(root, [
      "approve",
      intentAId,
      "--actor",
      "e2e-approver",
    ]);
    expect(approveAgain.code).toBe(3);
    expect(stringValue(recordValue(approveAgain.body["error"])["code"])).toBe(
      "invalid_transition",
    );

    const settleBeforeFill = runCli(root, [
      "settle",
      intentAId,
      "--result",
      "won",
    ]);
    expect(settleBeforeFill.code).toBe(3);

    // 8. live venue is refused by code, before any state read.
    const liveExecute = runCli(root, [
      "execute",
      intentAId,
      "--venue",
      "draftkings",
    ]);
    expect(liveExecute.code).toBe(3);
    expect(stringValue(recordValue(liveExecute.body["error"])["code"])).toBe(
      "live_disabled",
    );

    // 9. paper fill (default venue) at the slipped reference price.
    const execute = runCli(root, ["execute", intentAId]);
    expect(execute.code).toBe(0);
    const fill = recordValue(execute.body["fill"]);
    expect(stringValue(fill["venue"])).toBe("paper");
    expect(stringValue(fill["referenceSource"])).toBe(
      "watchlist_signal.fairProb",
    );
    expect(numberValue(fill["stakeUsd"])).toBe(25);
    expect(numberValue(fill["slippageBps"])).toBe(50);
    const payoutIfWinUsd = numberValue(fill["payoutIfWinUsd"]);
    expect(payoutIfWinUsd).toBeGreaterThan(0);
    expect(stringValue(recordValue(execute.body["intent"])["status"])).toBe(
      "filled",
    );

    // 10. settle for a win: profit matches the fill, summary aggregates it.
    const settle = runCli(root, ["settle", intentAId, "--result", "won"]);
    expect(settle.code).toBe(0);
    const settlement = recordValue(settle.body["settlement"]);
    expect(stringValue(settlement["result"])).toBe("won");
    expect(numberValue(settlement["profitUsd"])).toBe(payoutIfWinUsd);
    expect(Math.round(numberValue(settlement["payoutUsd"]) * 100)).toBe(
      2_500 + Math.round(payoutIfWinUsd * 100),
    );
    const ledgerSummary = recordValue(settle.body["ledgerSummary"]);
    expect(numberValue(ledgerSummary["settledStakeUsd"])).toBe(25);
    expect(numberValue(ledgerSummary["profitUsd"])).toBe(payoutIfWinUsd);
    expect(numberValue(ledgerSummary["roiPct"])).toBeGreaterThan(0);
    expect(stringValue(recordValue(settle.body["intent"])["status"])).toBe(
      "settled",
    );

    // 11. reject the second intent, then terminal statuses are immutable.
    const reject = runCli(root, [
      "reject",
      intentBId,
      "--actor",
      "e2e-approver",
      "--reason",
      "operator veto",
    ]);
    expect(reject.code).toBe(0);
    expect(stringValue(recordValue(reject.body["intent"])["status"])).toBe(
      "rejected",
    );

    const rejectAgain = runCli(root, [
      "reject",
      intentBId,
      "--actor",
      "e2e-approver",
      "--reason",
      "again",
    ]);
    expect(rejectAgain.code).toBe(3);
    expect(stringValue(recordValue(rejectAgain.body["error"])["code"])).toBe(
      "invalid_transition",
    );

    const rejectSettled = runCli(root, [
      "reject",
      intentAId,
      "--actor",
      "e2e-approver",
      "--reason",
      "too late",
    ]);
    expect(rejectSettled.code).toBe(3);
    expect(stringValue(recordValue(rejectSettled.body["error"])["code"])).toBe(
      "invalid_transition",
    );

    // 12. list by derived status.
    const settledList = runCli(root, ["list", "--status", "settled"]);
    expect(settledList.code).toBe(0);
    expect(arrayValue(settledList.body["intents"])).toHaveLength(1);
    const rejectedList = runCli(root, ["list", "--status", "rejected"]);
    expect(arrayValue(rejectedList.body["intents"])).toHaveLength(1);

    // 13. journal: created A, created B, approved, filled, settled, rejected.
    const journal = runCli(root, ["journal", "--limit", "500"]);
    expect(journal.code).toBe(0);
    const events = arrayValue(journal.body["events"]);
    expect(events).toHaveLength(6);
    expect(
      events.map((event) => stringValue(recordValue(event)["type"])),
    ).toEqual([
      "intent_created",
      "intent_created",
      "intent_approved",
      "intent_filled",
      "intent_settled",
      "intent_rejected",
    ]);
    const journalSummary = recordValue(journal.body["summary"]);
    expect(numberValue(journalSummary["intents"])).toBe(2);
    expect(
      numberValue(recordValue(journalSummary["byStatus"])["settled"]),
    ).toBe(1);
    expect(
      numberValue(recordValue(journalSummary["byStatus"])["rejected"]),
    ).toBe(1);
    expect(numberValue(journalSummary["stakedUsd"])).toBe(25);
    expect(numberValue(journalSummary["profitUsd"])).toBe(payoutIfWinUsd);

    // 14. final status reflects the folded ledger.
    const finalStatus = runCli(root, ["status"]);
    const finalLedger = recordValue(finalStatus.body["ledger"]);
    expect(booleanValue(finalLedger["exists"])).toBe(true);
    expect(numberValue(finalLedger["events"])).toBe(6);
    const finalCounts = recordValue(finalLedger["intents"]);
    expect(numberValue(finalCounts["total"])).toBe(2);
    expect(numberValue(finalCounts["settled"])).toBe(1);
    expect(numberValue(finalCounts["rejected"])).toBe(1);
    expect(stringValue(finalLedger["lastEventAt"])).toBe(NOW_ISO);

    // 15. a rejected intent releases its dedupe slot and stake: only A still blocks.
    const planAfter = runCli(root, ["plan"]);
    expect(planAfter.code).toBe(0);
    expect(arrayValue(planAfter.body["wouldQueue"])).toHaveLength(1);
    const skippedAfter = arrayValue(planAfter.body["skipped"]);
    expect(skippedAfter).toHaveLength(1);
    expect(stringValue(recordValue(skippedAfter[0])["existingIntentId"])).toBe(
      intentAId,
    );
    const signalsAfter = runCli(root, ["signals", "--include-rejected"]);
    const countsAfter = recordValue(signalsAfter.body["counts"]);
    expect(numberValue(countsAfter["total"])).toBe(2);
    expect(numberValue(countsAfter["eligible"])).toBe(1);
    expect(numberValue(countsAfter["rejected"])).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI help and short flags                                                    */
/* -------------------------------------------------------------------------- */

describe("CLI help and short flags", () => {
  const COMMAND_NAMES = [
    "status",
    "signals",
    "plan",
    "enqueue",
    "list",
    "approve",
    "reject",
    "execute",
    "settle",
    "journal",
    "watch",
  ] as const;

  test("root help prints the command table, global flags, exit codes and examples", () => {
    for (const flag of ["--help", "-h"]) {
      const result = runCliRaw([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "Usage: bun run autobet <command> [flags] [args]",
      );
      expect(result.stdout).toContain("Commands:");
      expect(result.stdout).toContain("Global flags:");
      expect(result.stdout).toContain("Exit codes:");
      expect(result.stdout).toContain("Examples:");
      expect(result.stdout).toContain("-h, --help");
      expect(result.stdout).toContain("-j, --json");
      expect(result.stdout).toContain("-r, --root <path>");
      expect(result.stdout).toContain("-c, --config <path>");
      expect(result.stdout).toContain("-n, --now <iso>");
      for (const name of COMMAND_NAMES) {
        expect(result.stdout).toContain(name);
      }
      expect(result.stdout).not.toContain('"success"');
    }
  });

  test("every command has detailed --help: usage, arguments/flags and examples", () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      status: ["Config", "Options:", "Examples:"],
      signals: [
        "-l, --limit <N>",
        "-m, --min-confidence <0..100>",
        "-i, --include-rejected",
        "Examples:",
      ],
      plan: ["same planner as `enqueue`", "Examples:"],
      enqueue: ["-a, --actor <name>", "idempotent", "Examples:"],
      list: ["-s, --status <status>", "-l, --limit <N>", "Examples:"],
      approve: [
        "Arguments:",
        "<intentId>",
        "-a, --actor <name>",
        "-o, --note <text>",
        "human decision",
        "Examples:",
      ],
      reject: ["-R, --reason <text>", "required", "Examples:"],
      execute: ["-v, --venue <venue>", "live_disabled", "Examples:"],
      settle: ["-e, --result <won|lost|void>", "Examples:"],
      journal: ["-l, --limit <N>", "Examples:"],
      watch: [
        "-i, --interval-seconds <N>",
        "NEVER approves or executes",
        "Examples:",
      ],
    };
    for (const name of COMMAND_NAMES) {
      for (const flag of ["--help", "-h"]) {
        // A missing root/config must not matter: help exits before any read.
        const result = runCliRaw([
          name,
          flag,
          "--root",
          "/definitely-not-a-real-autobet-root",
          "--json",
        ]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`Usage: bun run autobet ${name}`);
        expect(result.stdout).toContain("Options:");
        expect(result.stdout).toContain("-h, --help");
        for (const fragment of expected[name] ?? []) {
          expect(result.stdout).toContain(fragment);
        }
      }
    }
  });

  test("unknown flag and unknown command point at the help topic", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    const unknownFlag = runCli(root, ["signals", "--bogus"]);
    expect(unknownFlag.code).toBe(2);
    const flagError = recordValue(unknownFlag.body["error"]);
    expect(stringValue(flagError["code"])).toBe("usage_error");
    expect(stringValue(flagError["message"])).toContain(
      "bun run autobet signals --help",
    );

    const unknownCommand = runCli(root, ["nonsense"]);
    expect(unknownCommand.code).toBe(2);
    expect(
      stringValue(recordValue(unknownCommand.body["error"])["message"]),
    ).toContain("bun run autobet --help");
  });

  test("global short flags -j -r -c -n are accepted", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeFileSync(
      join(root, "config", "alt.json"),
      `${JSON.stringify(validConfigRaw({ stakeUsd: 10 }), null, 2)}\n`,
    );
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        CLI_PATH,
        "status",
        "-j",
        "-r",
        root,
        "-c",
        "config/alt.json",
        "-n",
        NOW_ISO,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const body = recordValue(JSON.parse(proc.stdout.toString()));
    expect(booleanValue(body["success"])).toBe(true);
    expect(stringValue(body["generatedAt"])).toBe(NOW_ISO);
    const config = recordValue(body["config"]);
    expect(stringValue(config["path"])).toBe("config/alt.json");
    expect(numberValue(recordValue(config["effective"])["stakeUsd"])).toBe(10);
  });

  test("command short flags drive the whole paper lifecycle", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeSignalArtifacts(root);

    const enqueue = runCli(root, ["enqueue", "-a", "short-actor"]);
    expect(enqueue.code).toBe(0);
    const created = arrayValue(enqueue.body["created"]).map(recordValue);
    expect(created).toHaveLength(2);
    expect(stringValue(created[0]?.["createdBy"])).toBe("short-actor");
    const intentA = stringValue(created[0]?.["intentId"]);
    const intentB = stringValue(created[1]?.["intentId"]);

    // -a and -o, with the flag before the positional.
    const approve = runCli(root, [
      "approve",
      "-a",
      "short-actor",
      intentA,
      "-o",
      "short-note",
    ]);
    expect(approve.code).toBe(0);
    const queued = runCli(root, ["list", "-s", "queued", "-l", "1"]);
    expect(queued.code).toBe(0);
    expect(arrayValue(queued.body["intents"])).toHaveLength(1);

    const execute = runCli(root, ["execute", intentA, "-v", "paper"]);
    expect(execute.code).toBe(0);
    expect(stringValue(recordValue(execute.body["fill"])["venue"])).toBe(
      "paper",
    );
    const live = runCli(root, ["execute", intentB, "-v", "live"]);
    expect(live.code).toBe(3);
    expect(stringValue(recordValue(live.body["error"])["code"])).toBe(
      "live_disabled",
    );

    const settle = runCli(root, ["settle", intentA, "-e", "won"]);
    expect(settle.code).toBe(0);
    const reject = runCli(root, [
      "reject",
      intentB,
      "-a",
      "short-actor",
      "-R",
      "short reason",
    ]);
    expect(reject.code).toBe(0);

    const journal = runCli(root, ["journal", "-l", "500"]);
    expect(journal.code).toBe(0);
    const events = arrayValue(journal.body["events"]).map(recordValue);
    const approvals = events.filter(
      (event) => stringValue(event["type"]) === "intent_approved",
    );
    expect(approvals).toHaveLength(1);
    expect(stringValue(recordValue(approvals[0]?.["data"])["note"])).toBe(
      "short-note",
    );
    expect(
      events.filter((event) => stringValue(event["type"]) === "intent_settled"),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => stringValue(event["type"]) === "intent_rejected",
      ),
    ).toHaveLength(1);

    const signals = runCli(root, ["signals", "-i", "-m", "60", "-l", "1"]);
    expect(signals.code).toBe(0);
    expect(arrayValue(signals.body["signals"])).toHaveLength(1);

    // watch -i with --help must print help instead of starting the loop.
    const watchHelp = runCliRaw(["watch", "-i", "30", "--help"]);
    expect(watchHelp.code).toBe(0);
    expect(watchHelp.stdout).toContain("Usage: bun run autobet watch");
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency safety                                                          */
/* -------------------------------------------------------------------------- */

describe("concurrency safety", () => {
  test("parallel enqueues serialize: one intent per signal and no corruption", async () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeSignalArtifacts(root);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => runCliAsync(root, ["enqueue"])),
    );
    expect(results.every((result) => result.code === 0)).toBe(true);
    const created = results.reduce(
      (sum, result) => sum + arrayValue(result.body["created"]).length,
      0,
    );
    // Two eligible signals in the fixture: the first writer creates both, the rest skip them.
    expect(created).toBe(2);

    const list = runCli(root, ["list"]);
    expect(list.code).toBe(0);
    expect(arrayValue(list.body["intents"])).toHaveLength(2);

    const journal = runCli(root, ["journal", "--limit", "500"]);
    expect(journal.code).toBe(0);
    const events = arrayValue(journal.body["events"]);
    expect(
      events.filter(
        (event) => stringValue(recordValue(event)["type"]) === "intent_created",
      ),
    ).toHaveLength(2);
  });

  test("parallel enqueues cannot breach the desk-day stake cap", async () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root, validConfigRaw({ dailyStakeCapUsd: 40 }));
    writeSignalArtifacts(root);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => runCliAsync(root, ["enqueue"])),
    );
    expect(results.every((result) => result.code === 0)).toBe(true);
    const created = results.flatMap((result) =>
      arrayValue(result.body["created"]).map(recordValue),
    );
    const stakedUsd = created.reduce(
      (sum, intent) => sum + numberValue(intent["stakeUsd"]),
      0,
    );
    expect(created).toHaveLength(1);
    expect(stakedUsd).toBeLessThanOrEqual(40);

    const list = runCli(root, ["list"]);
    expect(arrayValue(list.body["intents"])).toHaveLength(1);
    expect(runCli(root, ["journal"]).code).toBe(0);
  });

  test("parallel approvals of one queued intent: exactly one wins, ledger stays readable", async () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeSignalArtifacts(root);
    const enqueue = runCli(root, ["enqueue"]);
    expect(enqueue.code).toBe(0);
    const intentId = stringValue(
      recordValue(arrayValue(enqueue.body["created"])[0])["intentId"],
    );
    expect(intentId).not.toBe("");

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runCliAsync(root, ["approve", intentId, "--actor", "parallel-test"]),
      ),
    );
    const accepted = results.filter((result) => result.code === 0);
    expect(accepted).toHaveLength(1);
    for (const refused of results.filter((result) => result.code !== 0)) {
      expect(refused.code).toBe(3);
      expect(stringValue(recordValue(refused.body["error"])["code"])).toBe(
        "invalid_transition",
      );
    }

    // The regression this guards: a second approve appending after the first used to make every
    // later read ledger_corrupt. The ledger must still fold, with exactly one approval.
    const journal = runCli(root, ["journal", "--limit", "500"]);
    expect(journal.code).toBe(0);
    const approvals = arrayValue(journal.body["events"]).filter(
      (event) => stringValue(recordValue(event)["type"]) === "intent_approved",
    );
    expect(approvals).toHaveLength(1);
    const list = runCli(root, ["list", "--status", "approved"]);
    expect(list.code).toBe(0);
    expect(arrayValue(list.body["intents"])).toHaveLength(1);
  });

  test("a held ledger lock is a ledger_locked refusal, and the callback never runs", async () => {
    const root = makeTemporaryRoot();
    const ledgerPath = ledgerFile(root);
    mkdirSync(join(root, "Scratch", "watchlist-autobet"), { recursive: true });
    const lockPath = ledgerLockPathFor(ledgerPath);
    writeFileSync(lockPath, "held by another test process\n");

    let ran = false;
    const error = await captureAsyncAutobetError(
      withLedgerLock(
        ledgerPath,
        async () => {
          ran = true;
        },
        { timeoutMs: 150, retryMs: 10, staleMs: 30_000 },
      ),
    );
    expect(error.code).toBe("ledger_locked");
    expect(ran).toBe(false);
    expect(statSync(lockPath).isFile()).toBe(true);
    rmSync(lockPath, { force: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Discovery: candidates CLI                                                   */
/* -------------------------------------------------------------------------- */

describe("candidates discovery", () => {
  test("candidates lists unwatched accounts and stays advisory", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeCandidateArtifacts(root);

    const result = runCli(root, ["candidates"]);
    expect(result.code).toBe(0);
    expect(stringValue(result.body["command"])).toBe("candidates");
    const counts = recordValue(result.body["counts"]);
    expect(numberValue(counts["total"])).toBe(2);
    expect(numberValue(counts["returned"])).toBe(2);
    expect(numberValue(counts["riskUsd"])).toBe(224_216);
    const candidates = arrayValue(result.body["candidates"]);
    expect(candidates).toHaveLength(2);
    const first = recordValue(candidates[0]);
    expect(stringValue(first["login"])).toBe("CC364");
    expect(stringValue(first["agentId"])).toBe("HRGROUP");
    expect(numberValue(first["riskUsd"])).toBe(224_000);
    expect(arrayValue(first["sources"])).toEqual(["data/live-bets.json"]);
    // Advisory only: nothing is queued and no ledger is created.
    expect(existsSync(ledgerFile(root))).toBe(false);
    const queue = runCli(root, ["list"]);
    expect(queue.code).toBe(0);
    expect(arrayValue(queue.body["intents"])).toHaveLength(0);
  });

  test("limit and min-risk-usd bound the list; bad values are usage errors", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeCandidateArtifacts(root);

    const limited = runCli(root, ["candidates", "--limit", "1"]);
    expect(limited.code).toBe(0);
    expect(numberValue(recordValue(limited.body["counts"])["returned"])).toBe(
      1,
    );
    expect(arrayValue(limited.body["candidates"])).toHaveLength(1);

    const filtered = runCli(root, ["candidates", "--min-risk-usd", "1000"]);
    expect(filtered.code).toBe(0);
    expect(
      arrayValue(filtered.body["candidates"]).map((entry) =>
        stringValue(recordValue(entry)["login"]),
      ),
    ).toEqual(["CC364"]);

    const cases: ReadonlyArray<readonly string[]> = [
      ["candidates", "--limit", "0"],
      ["candidates", "--limit", "500"],
      ["candidates", "--min-risk-usd", "-5"],
      ["candidates", "--bogus"],
    ];
    for (const args of cases) {
      const error = runCli(root, args);
      expect(error.code).toBe(2);
      expect(stringValue(recordValue(error.body["error"])["code"])).toBe(
        "usage_error",
      );
    }
  });

  test("the signals payload carries the discovery summary", () => {
    const root = makeTemporaryRoot();
    writeAutobetConfig(root);
    writeCandidateArtifacts(root);

    const result = runCli(root, ["signals", "--include-rejected"]);
    expect(result.code).toBe(0);
    expect(numberValue(recordValue(result.body["counts"])["candidates"])).toBe(
      2,
    );
    const candidates = arrayValue(result.body["candidates"]);
    expect(candidates).toHaveLength(2);
    expect(stringValue(recordValue(candidates[0])["login"])).toBe("CC364");
    // Advisory data never enters derivation: candidate logins are not in any signal.
    const signalLogins = arrayValue(result.body["signals"]).flatMap((entry) =>
      arrayValue(recordValue(recordValue(entry)["signal"])["accounts"]).map(
        (account) => stringValue(recordValue(account)["login"]),
      ),
    );
    expect(signalLogins).not.toContain("CC364");
    expect(signalLogins).not.toContain("JP1833");
  });

  test("the command table and help document candidates", () => {
    const rootHelp = runCliRaw(["--help"]);
    expect(rootHelp.code).toBe(0);
    expect(rootHelp.stdout).toContain("candidates");
    const help = runCliRaw(["candidates", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(
      "candidates [--limit N] [--min-risk-usd 0..]",
    );
    expect(help.stdout).toContain("--min-risk-usd");
  });
});

/* -------------------------------------------------------------------------- */
/* Freshness window: one truth across status and the gate                      */
/* -------------------------------------------------------------------------- */

function freshnessCheckOf(result: CliResult): Record<string, unknown> | null {
  const first = recordValue(arrayValue(result.body["signals"])[0]);
  const checks = arrayValue(recordValue(first["gate"])["checks"]);
  const found = checks.find(
    (check) => stringValue(recordValue(check)["check"]) === "freshness",
  );
  return found === undefined ? null : recordValue(found);
}

function feedSourceOf(result: CliResult): Record<string, unknown> | null {
  const found = arrayValue(result.body["sources"]).find(
    (source) =>
      stringValue(recordValue(source)["path"]) === "docs/graph-live-feed.json",
  );
  return found === undefined ? null : recordValue(found);
}

describe("freshness window", () => {
  test("config.maxSignalAgeSeconds governs the source chip and the gate alike", () => {
    const observedAt = "2026-11-04T11:50:00.000Z";

    const wide = makeTemporaryRoot();
    writeAutobetConfig(wide, validConfigRaw({ maxSignalAgeSeconds: 900 }));
    writeSignalArtifacts(wide, { observedAt });
    const wideMtime = new Date(NOW.getTime() - 600_000);
    utimesSync(join(wide, "docs/graph-live-feed.json"), wideMtime, wideMtime);

    const wideSignals = runCli(wide, ["signals", "--include-rejected"]);
    expect(wideSignals.code).toBe(0);
    const wideFreshness = freshnessCheckOf(wideSignals);
    expect(booleanValue(wideFreshness?.["ok"])).toBe(true);
    const wideStatus = runCli(wide, ["status"]);
    expect(booleanValue(feedSourceOf(wideStatus)?.["stale"])).toBe(false);

    // Tighten the one window below the signal's age: chip and gate flip together.
    const tight = makeTemporaryRoot();
    writeAutobetConfig(tight, validConfigRaw({ maxSignalAgeSeconds: 300 }));
    writeSignalArtifacts(tight, { observedAt });
    const tightMtime = new Date(NOW.getTime() - 600_000);
    utimesSync(
      join(tight, "docs/graph-live-feed.json"),
      tightMtime,
      tightMtime,
    );

    const tightSignals = runCli(tight, ["signals", "--include-rejected"]);
    expect(tightSignals.code).toBe(0);
    const tightFreshness = freshnessCheckOf(tightSignals);
    expect(booleanValue(tightFreshness?.["ok"])).toBe(false);
    expect(recordValue(tightFreshness?.["actual"])["ageSeconds"]).toBe(600);
    const tightStatus = runCli(tight, ["status"]);
    expect(booleanValue(feedSourceOf(tightStatus)?.["stale"])).toBe(true);
  });
});
