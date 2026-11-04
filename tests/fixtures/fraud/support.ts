/**
 * Test support for the fraud-core suites: hermetic temp roots, fixture copying, and a deterministic
 * synthetic getBetReport corpus large enough for `model fit` (>= 500 rows, >= 20 labeled accounts).
 *
 * No network, no real corpus reads: every test builds its own root under the OS temp directory so
 * `model fit --write` can never touch the real `reports/security/`.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_DIR = import.meta.dir;
export const BASE_EPOCH_SEC = 1_793_163_600;
/** Pinned clock for tests; fixture artifacts are dated around it. */
export const FIXED_NOW_ISO = "2026-11-04T20:00:00.000Z";
export const CLI_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "cli",
  "sportsdesk_fraud_cli.ts",
);

export function fixedNow(): Date {
  return new Date(FIXED_NOW_ISO);
}

export function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

export function readFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as unknown;
}

export function fixtureText(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

/** Fresh temp root; the caller removes it in afterEach/afterAll. */
export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "fraud-core-"));
}

export function writeAt(
  root: string,
  relative: string,
  content: unknown,
): string {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(
    absolute,
    typeof content === "string"
      ? content
      : `${JSON.stringify(content, null, 2)}\n`,
  );
  return absolute;
}

export function copyFixtureAt(
  root: string,
  relative: string,
  name: string,
): void {
  writeAt(root, relative, fixtureText(name));
}

export interface FixtureRootOptions {
  /** Copy the small crafted bet-report corpus (16 rows) as the primary corpus path. */
  readonly corpus?: boolean;
  /** Add `Scratch/security/corpus/sha256.txt` for the copied corpus. */
  readonly corpusSidecar?: boolean;
  /** Copy the crafted F402 WebLog rollup. */
  readonly weblogRollup?: boolean;
  /** Copy the crafted live ticket captures. */
  readonly liveTickets?: boolean;
  /** Copy the crafted agent index + tree. */
  readonly agentIndex?: boolean;
  /** Copy the crafted GSLive WebLog activity artifact. */
  readonly gsliveWeblogs?: boolean;
  /** Copy the crafted suspect audit (with the known --help defect). */
  readonly suspectAudit?: boolean;
  /** Copy the crafted getWebLog evidence capture (empty LIST shape sample). */
  readonly capture?: boolean;
  /** Copy the generated customer-book fixture (a two-row stand-in). */
  readonly customerBook?: boolean;
  /** Copy the hardcoded IP-tracker fixture stand-in (a one-line TS file). */
  readonly ipTrackerFixture?: boolean;
  /** Detector overrides written to config/fraud-model.json (merged over the defaults). */
  readonly detectors?: Readonly<Record<string, unknown>>;
}

export const CORPUS_PRIMARY_REL =
  "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json";

/**
 * Write a complete fixture root. Every path is the real repo-relative path, so the discovery code
 * under test exercises the same globs/sidecars/fallbacks as production.
 */
export function buildFixtureRoot(options: FixtureRootOptions = {}): string {
  const root = makeRoot();
  if (options.corpus !== false) {
    copyFixtureAt(root, CORPUS_PRIMARY_REL, "betreport-small.json");
    if (options.corpusSidecar !== false) {
      writeAt(
        root,
        "Scratch/security/corpus/sha256.txt",
        `${sha256Of(fixtureText("betreport-small.json"))}  ${CORPUS_PRIMARY_REL}\n`,
      );
    }
  }
  if (options.weblogRollup !== false) {
    copyFixtureAt(
      root,
      "Scratch/weblog/rollup-2026-11-02.json",
      "weblog-rollup-2026-11-02.json",
    );
  }
  if (options.liveTickets !== false) {
    copyFixtureAt(root, "data/live-bets.json", "live-bets.json");
    copyFixtureAt(root, "data/live-wagers.json", "live-wagers.json");
  }
  if (options.agentIndex !== false) {
    copyFixtureAt(root, "data/agent-index.json", "agent-index.json");
    copyFixtureAt(root, "data/agent-tree.json", "agent-tree.json");
  }
  if (options.gsliveWeblogs === true) {
    copyFixtureAt(
      root,
      "Scratch/gslive-weblogs/latest.json",
      "gslive-weblogs-latest.json",
    );
  }
  if (options.suspectAudit !== false) {
    copyFixtureAt(
      root,
      "reports/gslive-suspect-all-states-audit.json",
      "suspect-audit.json",
    );
  }
  if (options.capture !== false) {
    copyFixtureAt(
      root,
      "docs/evidence/captures/2026-10-31/getWebLog.post.json",
      "getWebLog.post.json",
    );
  }
  if (options.customerBook !== false) {
    writeAt(root, "enriched_customers_full.json", [
      { customer_id: "FIXTURE-1", note: "generated fixture; never fitted" },
      { customer_id: "FIXTURE-2" },
    ]);
  }
  if (options.ipTrackerFixture !== false) {
    writeAt(
      root,
      "lib/bet_ticker_ip_tracker_bridge.ts",
      "// hardcoded fixture stand-in for tests\n",
    );
  }
  const config: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "fraud-model-config",
    detectors: {
      // The crafted fixture is 16 rows: lower the counting thresholds so each detector can fire.
      sharedIpMinAccounts: 2,
      sharedIpTop: 5,
      accountFanoutMinIps: 2,
      accountFanoutHighIps: 3,
      agentFlagMinBets: 2,
      agentFlagMinRate: 0.2,
      agentFlagTop: 5,
      stateMixMinWinShare: 0.01,
      longshotMinTickets: 2,
      burstMinTickets: 2,
      burstWindowSeconds: 600,
      roundStakeStepCents: 10000,
      vipStakeMultiple: 2,
      agentConcentrationMinShare: 0.2,
      ...options.detectors,
    },
  };
  writeAt(root, "config/fraud-model.json", config);
  return root;
}

export function sha256Of(text: string): string {
  return Bun.CryptoHasher.hash("sha256", text, "hex");
}

/* -------------------------------------------------------------------------- */
/* Synthetic getBetReport corpus                                               */
/* -------------------------------------------------------------------------- */

export interface SyntheticOptions {
  /** Rows to generate (default 700). */
  readonly rows?: number;
  /** Accounts to cycle through (default 30). */
  readonly accounts?: number;
  /** Accounts whose rows carry the desk-flag proxy (default accounts - 5). */
  readonly labeledAccounts?: number;
  /** Base epoch seconds (default BASE_EPOCH_SEC). */
  readonly baseEpochSec?: number;
  /** Seconds between rows (default 60). */
  readonly stepSeconds?: number;
}

export interface SyntheticCorpus {
  readonly rows: Record<string, unknown>[];
  readonly accountIds: readonly string[];
  readonly agentIds: readonly string[];
}

/**
 * Deterministic corpus: row i belongs to account `U(i % accounts)` and agent `AG(i % 10)`.
 * Accounts below `labeledAccounts` are flagged on alternating passes through the account ring,
 * alternating suspected-bot and reversed-credit passes, so both proxies span all labeled
 * accounts and produce stable train/holdout positives. IPs cycle through a small pool so
 * shared-IP clusters and fan-out also exist.
 */
export function syntheticBetReport(
  options: SyntheticOptions = {},
): SyntheticCorpus {
  const rows = options.rows ?? 700;
  const accounts = options.accounts ?? 30;
  const labeledAccounts = options.labeledAccounts ?? Math.max(0, accounts - 5);
  const baseEpochSec = options.baseEpochSec ?? BASE_EPOCH_SEC;
  const stepSeconds = options.stepSeconds ?? 60;
  const rowsOut: Record<string, unknown>[] = [];
  const accountIds: string[] = [];
  const agentIds: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const accountIndex = index % accounts;
    const accountId = `U${String(accountIndex).padStart(3, "0")}`;
    const agentId = `AG${String(index % 10).padStart(2, "0")}`;
    if (!accountIds.includes(accountId)) accountIds.push(accountId);
    if (!agentIds.includes(agentId)) agentIds.push(agentId);
    // Cycle parity keeps every labeled account positive on alternating passes through the
    // account ring, so both proxies span all labeled accounts instead of one residue class.
    const cycle = Math.floor(index / accounts);
    const labeled = accountIndex < labeledAccounts && cycle % 2 === 0;
    // Alternate the two proxies across labeled passes so EVERY labeled account contributes
    // to both `suspected_bot` and `reversed_credit` (the narrower proxy fits need that).
    const bot = labeled && Math.floor(cycle / 2) % 2 === 0;
    const reversed = labeled && Math.floor(cycle / 2) % 2 === 1;
    const logTime = baseEpochSec + index * stepSeconds;
    const stake = 50 + (index % 5) * 25;
    rowsOut.push({
      id: String(9_000_000 + index),
      betGroupId: String(8_000_000 + Math.floor(index / 2)),
      ticketNumber: String(7_000_000 + index),
      ipAddress: `47.223.${36 + (index % 4)}.${100 + (accountIndex % 7)}`,
      userID: accountId,
      agent: agentId,
      sID: "8",
      displaySportId: "8",
      eID: String(1_000 + (index % 5)),
      fVal: "2.00",
      fVal_new: index % 4 === 0 ? "2.10" : "2.00",
      bet: String(stake),
      betGroupToWin: String(stake * 2),
      result: "-100",
      period: index % 2 === 0 ? "m" : "s1",
      type: "0",
      logTime: String(logTime),
      // Numeric epoch seconds: parseGsliveTimestampMs treats < 1e12 numbers as seconds.
      acceptTime: String(logTime + 6),
      delay: "5",
      accept: "1",
      state: index % 10 === 0 ? "1" : index % 7 === 0 ? "3" : "2",
      isSuspectedBot: bot ? "1" : "0",
      reversedCredit: reversed ? "100" : null,
      manualLogExists: "0",
      adminUser: null,
      partnerUserID: `PR${String(accountIndex).padStart(6, "0")}`,
      profile: `PLAYER_PR${String(accountIndex).padStart(6, "0")}`,
    });
  }
  return { rows: rowsOut, accountIds, agentIds };
}

export function syntheticDocument(
  corpus: SyntheticCorpus,
): Record<string, unknown> {
  return {
    r: { bets: corpus.rows },
    e: 0,
    d: "",
    from: BASE_EPOCH_SEC,
    to: BASE_EPOCH_SEC + 7 * 24 * 3600,
  };
}

/** Write a synthetic corpus (>= model minimums) at the primary corpus path. */
export function buildSyntheticRoot(
  options: SyntheticOptions = {},
  detectors?: Readonly<Record<string, unknown>>,
): { root: string; corpus: SyntheticCorpus } {
  const root = buildFixtureRoot(detectors === undefined ? {} : { detectors });
  const corpus = syntheticBetReport(options);
  writeAt(root, CORPUS_PRIMARY_REL, syntheticDocument(corpus));
  writeAt(
    root,
    "Scratch/security/corpus/sha256.txt",
    `${sha256Of(`${JSON.stringify(syntheticDocument(corpus), null, 2)}\n`)}  ${CORPUS_PRIMARY_REL}\n`,
  );
  return { root, corpus };
}
