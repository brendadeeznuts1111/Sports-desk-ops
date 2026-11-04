/**
 * The surveillance dashboard's measurements, derived once on the server.
 *
 * `docs/graph.html` used to state its own measurements as literals: a commit hash, a test
 * count, a route count, bridge row counts and operator-run dates. Nothing recomputed them, so
 * the page kept claiming yesterday's number as today's. This module is the one place that
 * derives them, and every section carries its provenance: `source`, `asOf`, `ageSeconds`,
 * `stale` — or an explicit `not_measured` with the reason and the command that would measure it.
 *
 * Two rules decide the shape:
 *
 * 1. A missing artifact is `not_measured`, never `0`. `junit-report.xml` is git-ignored, so a
 *    fresh checkout has no test count; reporting zero tests would be a fabricated observation.
 * 2. Every derivation is a pure function of parsed inputs (`parseJunitSummary`,
 *    `deriveRouteSummary`, `buildBridges`, …) so the rules can be tested without the artifacts,
 *    and the file reads are cached by `mtime:size` so a 5s SSE tick is a handful of stats.
 *
 * `GET /api/graph/summary` returns {@link DashboardSummary}; `GET /api/graph/stream` re-derives
 * it only when {@link graphFingerprint} changes. Keep this module free of network I/O: the
 * weblog lookup uses `loadWeblogLatestLocal`, because an R2 fallback inside a 5s tick is a hung
 * request, not a measurement.
 */
import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { cachedJsonFile } from "./artifact_cache.ts";
import {
  DAEMON_PREFIX_ROUTES,
  DAEMON_ROUTES,
  type DaemonRoute,
} from "./daemon_routes.ts";
import { STALE_AFTER_SECONDS } from "./desk_kpis.ts";
import {
  findWeblogLatestLocalPath,
  loadWeblogLatestLocal,
} from "./f402_weblog_latest.ts";
import {
  CITING_DOCS,
  collectDocCitations,
  type Citation,
} from "../scripts/check_spec_citations.ts";

/** Bumped when a consumer-visible field changes meaning. Envelope-level, not per-section. */
export const DASHBOARD_SUMMARY_SCHEMA_VERSION = 1;

/** The feed poller runs every minute (`schedulerEngine`); three missed cycles is stale. */
export const FEED_STALE_AFTER_SECONDS = 180;
/** A committed census is a dated design artifact; a week is when it stops describing the wire. */
export const CENSUS_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;
/** A weblog rollup covers a capture window; a week is when it stops describing the book. */
export const WEBLOG_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;
/** Junit output older than a day no longer describes the checkout it sits in. */
export const JUNIT_STALE_AFTER_SECONDS = 24 * 60 * 60;
/** The cited docs move with the code; a week without a touch is a review prompt, not an error. */
export const CITATIONS_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

export const FEED_PATH = "docs/graph-live-feed.json";
export const JUNIT_PATH = "junit-report.xml";
export const CENSUS_DIR = "docs/design/census";
export const LIVE_BETS_PATH = "data/live-bets.json";

const DEFAULT_ROOT = resolve(import.meta.dir, "..");

const FEED_COMMAND =
  "bun run scripts/graph_feed_poller_daemon.ts --once --live";
const TESTS_COMMAND =
  "bun test --reporter junit --reporter-outfile junit-report.xml";
const TYPECHECK_COMMAND = "bun run typecheck";
const DOCS_COMMAND = "bun run verify:docs";
const ROUTE_COMMAND = "bun run check:route-surface";
const CITATIONS_COMMAND = "bun run check:spec-citations";
const LIVE_BETS_COMMAND = "bun run build:live-bets";
const WEBLOG_COMMAND = "bun run weblog:rollup";
const CENSUS_COMMAND = "bun run bridge3c:rollup";
const BRIDGE_3A_COMMAND = "./bin/dx poll --live-f402";

/* -------------------------------------------------------------------------- */
/* Typed provenance                                                           */
/* -------------------------------------------------------------------------- */

export interface NotMeasured {
  readonly status: "not_measured";
  readonly reason: string;
  readonly command: string;
}

/* -------------------------------------------------------------------------- */
/* Feed                                                                       */
/* -------------------------------------------------------------------------- */

export interface FeedCounts {
  readonly activeWallets: number | null;
  readonly configuredWallets: number | null;
  readonly openLegs: number | null;
  readonly openExposureUsd: number | null;
  readonly pendingBets: number | null;
  readonly walletProfiles: number | null;
  readonly ipClusters: number | null;
  readonly liveTicks: number | null;
}

export interface FeedSummary {
  readonly status: "measured" | "not_measured";
  readonly schemaVersion: number | null;
  readonly lastUpdatedIso: string | null;
  readonly lastUpdatedCdt: string | null;
  readonly pollEpochMs: number | null;
  readonly pollSequence: number | null;
  readonly dataMode: string | null;
  readonly wssIngestion: string | null;
  /** How the poller is scheduled (`schedulerEngine`), used as the cron panel's engine. */
  readonly schedulerEngine: string | null;
  readonly wsStreamSlaMsFixture: number | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly source: string;
  readonly asOf: string | null;
  readonly reason?: string;
  readonly command: string;
  readonly counts: FeedCounts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number, or `null`. Never `NaN`/`Infinity` in a response body. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.trunc(number);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function recordAt(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/** Seconds since `asOfMs`, floored at zero and `null` when the instant is unparseable. */
function ageSecondsSince(asOfMs: number | null, now: Date): number | null {
  if (asOfMs === null || !Number.isFinite(asOfMs)) return null;
  return Math.max(0, Math.floor((now.getTime() - asOfMs) / 1000));
}

/** A local-time parse of the feed's own publish instant, or `null`. */
function feedEpochMs(record: Record<string, unknown>): number | null {
  const poll = finiteNumber(recordAt(record, "pollEpochMs"));
  if (poll !== null && poll > 0) return poll;
  const iso = nonEmptyString(recordAt(record, "lastUpdatedIso"));
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `null` feed (missing or unreadable file): an explicit gap, never a zero-count feed. */
export function unmeasuredFeedSummary(reason: string): FeedSummary {
  return {
    status: "not_measured",
    schemaVersion: null,
    lastUpdatedIso: null,
    lastUpdatedCdt: null,
    pollEpochMs: null,
    pollSequence: null,
    dataMode: null,
    wssIngestion: null,
    schedulerEngine: null,
    wsStreamSlaMsFixture: null,
    ageSeconds: null,
    stale: false,
    source: FEED_PATH,
    asOf: null,
    reason,
    command: FEED_COMMAND,
    counts: {
      activeWallets: null,
      configuredWallets: null,
      openLegs: null,
      openExposureUsd: null,
      pendingBets: null,
      walletProfiles: null,
      ipClusters: null,
      liveTicks: null,
    },
  };
}

/**
 * Derive the feed section from the parsed `graph-live-feed.json`.
 *
 * The published feed stores its counts as flat top-level fields (`activeSyndicateWalletsCount`,
 * `pendingBets` as an array, …), so the contract's `counts` block is a projection of them, and
 * every field is nullable: a feed that stops publishing one must read as unknown, not as zero.
 */
export function deriveFeedSummary(
  raw: unknown,
  options: { readonly now?: Date; readonly source?: string } = {},
): FeedSummary {
  if (!isRecord(raw))
    return unmeasuredFeedSummary("feed artifact is not an object");
  const now = options.now ?? new Date();
  const source = options.source ?? FEED_PATH;
  const asOfMs = feedEpochMs(raw);
  const ageSeconds = ageSecondsSince(asOfMs, now);
  const lastUpdatedIso = nonEmptyString(recordAt(raw, "lastUpdatedIso"));
  const asOf =
    asOfMs !== null ? new Date(asOfMs).toISOString() : (lastUpdatedIso ?? null);
  return {
    status: "measured",
    schemaVersion: finiteInteger(recordAt(raw, "schemaVersion")),
    lastUpdatedIso,
    lastUpdatedCdt: nonEmptyString(recordAt(raw, "lastUpdatedCdt")),
    pollEpochMs: finiteNumber(recordAt(raw, "pollEpochMs")),
    pollSequence: finiteInteger(recordAt(raw, "pollSequence")),
    dataMode: nonEmptyString(recordAt(raw, "dataMode")),
    wssIngestion: nonEmptyString(recordAt(raw, "wssIngestion")),
    schedulerEngine: nonEmptyString(recordAt(raw, "schedulerEngine")),
    wsStreamSlaMsFixture: finiteNumber(recordAt(raw, "wsStreamSlaMsFixture")),
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > FEED_STALE_AFTER_SECONDS,
    source,
    asOf,
    command: FEED_COMMAND,
    counts: {
      activeWallets: finiteInteger(
        recordAt(raw, "activeSyndicateWalletsCount"),
      ),
      configuredWallets: finiteInteger(recordAt(raw, "configuredWalletsCount")),
      openLegs: finiteInteger(recordAt(raw, "totalOpenLegsCount")),
      openExposureUsd: finiteNumber(recordAt(raw, "totalOpenExposureUsd")),
      pendingBets: arrayLength(recordAt(raw, "pendingBets")),
      walletProfiles: arrayLength(recordAt(raw, "walletProfiles")),
      ipClusters: arrayLength(recordAt(raw, "perOfficeIpTrackerClusters")),
      liveTicks: arrayLength(recordAt(raw, "liveTicks")),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

export interface RouteCatalogEntry {
  readonly path: string;
  readonly method: DaemonRoute["method"];
  /** `null` for a prefix row, whose guard is asserted by its arm rather than by a path match. */
  readonly guard: DaemonRoute["guard"];
  readonly dataClass: DaemonRoute["dataClass"];
  readonly surface: string | null;
}

export interface RouteSummary {
  readonly status: "derived";
  readonly source: string;
  readonly served: number;
  readonly exact: number;
  readonly prefix: number;
  readonly guards: Readonly<Record<DaemonRoute["guard"], number>>;
  readonly dataClasses: Readonly<Record<DaemonRoute["dataClass"], number>>;
  readonly catalog: readonly RouteCatalogEntry[];
  readonly command: string;
}

/** Counts derived from the route table itself, so `served` cannot drift from `check:route-surface`. */
export function deriveRouteSummary(
  routes: readonly DaemonRoute[] = DAEMON_ROUTES,
  prefixRoutes: readonly DaemonRoute[] = DAEMON_PREFIX_ROUTES,
): RouteSummary {
  const guards: Record<DaemonRoute["guard"], number> = {
    none: 0,
    admin: 0,
    pii: 0,
    "telegram-secret": 0,
  };
  const dataClasses: Record<DaemonRoute["dataClass"], number> = {
    static: 0,
    aggregate: 0,
    operational: 0,
    "customer-identifying": 0,
  };
  const catalog: RouteCatalogEntry[] = [];
  for (const route of [...routes, ...prefixRoutes]) {
    guards[route.guard] += 1;
    dataClasses[route.dataClass] += 1;
    catalog.push({
      path: route.path,
      method: route.method,
      guard: route.guard,
      dataClass: route.dataClass,
      surface: route.surface,
    });
  }
  return {
    status: "derived",
    source: "lib/daemon_routes.ts",
    served: routes.length + prefixRoutes.length,
    exact: routes.length,
    prefix: prefixRoutes.length,
    guards,
    dataClasses,
    catalog,
    command: ROUTE_COMMAND,
  };
}

/* -------------------------------------------------------------------------- */
/* Junit                                                                      */
/* -------------------------------------------------------------------------- */

export interface JunitSummary {
  readonly tests: number;
  readonly assertions: number | null;
  readonly failures: number;
  readonly skipped: number;
}

export type TestsCheck =
  | {
      readonly status: "measured";
      readonly tests: number;
      readonly assertions: number | null;
      readonly failures: number;
      readonly skipped: number;
      readonly source: string;
      readonly measuredAt: string;
      readonly ageSeconds: number;
      readonly stale: boolean;
      readonly command: string;
    }
  | NotMeasured;

/**
 * The first `<testsuites …>` tag's counters, or `null` when there is no such root tag.
 *
 * Only the root is read: a `<testsuite>` child carries its file's counts, and summing them is a
 * different (and slower) measurement the report already did for us. `tests` is required — a tag
 * without it is not a measurement of tests — while the others default to zero, which is what the
 * bun junit reporter omits when the count is zero.
 */
export function parseJunitSummary(xml: string): JunitSummary | null {
  const root = /<testsuites\b([^>]*)>/.exec(xml);
  if (root === null) return null;
  const attributes = new Map<string, string>();
  for (const match of (root[1] ?? "").matchAll(
    /([A-Za-z_][\w.-]*)="([^"]*)"/g,
  )) {
    attributes.set(match[1] ?? "", match[2] ?? "");
  }
  const counter = (name: string): number | null => {
    const raw = attributes.get(name);
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  };
  const tests = counter("tests");
  if (tests === null) return null;
  return {
    tests,
    assertions: counter("assertions"),
    failures: counter("failures") ?? 0,
    skipped: counter("skipped") ?? 0,
  };
}

/** The measured/not_measured boundary for the tests gate. */
export function deriveTestsCheck(
  xml: string | null,
  measuredAt: Date | null,
  now: Date = new Date(),
): TestsCheck {
  if (xml === null || measuredAt === null) {
    return {
      status: "not_measured",
      reason: "no junit-report.xml in this checkout",
      command: TESTS_COMMAND,
    };
  }
  const summary = parseJunitSummary(xml);
  if (summary === null) {
    return {
      status: "not_measured",
      reason: "junit-report.xml has no <testsuites> root tag",
      command: TESTS_COMMAND,
    };
  }
  const ageSeconds = ageSecondsSince(measuredAt.getTime(), now) ?? 0;
  return {
    status: "measured",
    ...summary,
    source: JUNIT_PATH,
    measuredAt: measuredAt.toISOString(),
    ageSeconds,
    stale: ageSeconds > JUNIT_STALE_AFTER_SECONDS,
    command: TESTS_COMMAND,
  };
}

/* -------------------------------------------------------------------------- */
/* Citations                                                                  */
/* -------------------------------------------------------------------------- */

export interface CitationsSummary {
  readonly status: "measured" | "not_measured";
  readonly checked: number | null;
  readonly anchors: number | null;
  readonly external: number | null;
  readonly source: string;
  readonly asOf: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly reason?: string;
  readonly command: string;
}

export interface CitationSeed {
  readonly citations: readonly Citation[];
  readonly anchors: ReadonlyMap<string, string>;
  /** Newest mtime among the citing documents, as the observation instant. */
  readonly asOf: Date | null;
}

/**
 * `checked = citations - external` and `anchors = anchors.size`, matching
 * `scripts/check_spec_citations.ts` so the dashboard and the gate report the same arithmetic.
 * `external` counts citation instances, not distinct keys, because that is the number the check
 * subtracts.
 */
export function deriveCitationsSummary(
  seed: CitationSeed,
  now: Date = new Date(),
): CitationsSummary {
  const external = seed.citations.filter(
    (citation) => citation.external,
  ).length;
  const asOfMs = seed.asOf?.getTime() ?? null;
  const ageSeconds = ageSecondsSince(asOfMs, now);
  return {
    status: "measured",
    checked: seed.citations.length - external,
    anchors: seed.anchors.size,
    external,
    source: CITING_DOCS.join(", "),
    asOf: seed.asOf === null ? null : seed.asOf.toISOString(),
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > CITATIONS_STALE_AFTER_SECONDS,
    command: CITATIONS_COMMAND,
  };
}

export function unmeasuredCitationsSummary(reason: string): CitationsSummary {
  return {
    status: "not_measured",
    checked: null,
    anchors: null,
    external: null,
    source: CITING_DOCS.join(", "),
    asOf: null,
    ageSeconds: null,
    stale: false,
    reason,
    command: CITATIONS_COMMAND,
  };
}

/* -------------------------------------------------------------------------- */
/* Bridges                                                                    */
/* -------------------------------------------------------------------------- */

export interface CensusValue {
  readonly legs: number;
  readonly tickets: number;
}

export interface WeblogValue {
  readonly rows: number;
  readonly parsed: number;
  readonly matched: number;
  readonly windowWagers: number;
  readonly matchedPct: number | null;
  readonly negativeControls: number;
  readonly falsePositiveFlags: number;
  /**
   * Population counts the rollup already computed, so the dashboard's Mode 6 evidence cell
   * does not carry its own literals. A rollup that lacks a flag reports `null`, never `0`.
   */
  readonly executionSnipers: number | null;
  readonly sniperTwins: number | null;
  readonly crossOfficeBeards: number | null;
  readonly botRingAccounts: number | null;
  readonly lineShoppers: number | null;
}

export interface DashboardBridge {
  readonly id: string;
  readonly label: string;
  readonly state: "measured" | "not_measured";
  readonly value: Readonly<Record<string, number | null>> | null;
  readonly basis?: "census" | "capture" | "rollup";
  readonly source?: string;
  readonly asOf?: string | null;
  readonly ageSeconds?: number | null;
  readonly stale?: boolean;
  readonly note?: string;
  readonly reason?: string;
  readonly command?: string;
}

export interface CensusInput {
  /** Repo-relative path of the census that answered. */
  readonly source: string;
  /** The census date when it records one, else the file mtime; `null` when neither parsed. */
  readonly asOf: string | null;
  readonly value: CensusValue | null;
}

export interface LiveBetsInput {
  readonly pendingCount: number;
  /** The capture's own `capturedAt`, else the file mtime; `null` when neither parsed. */
  readonly asOf: string | null;
}

export interface WeblogInput {
  readonly source: string;
  readonly asOf: string | null;
  readonly value: WeblogValue | null;
}

export interface BridgeInputs {
  readonly census: CensusInput | null;
  readonly liveBets: LiveBetsInput | null;
  readonly weblog: WeblogInput | null;
  readonly now?: Date;
}

/** The census bridge value: stream 3c's row count and its ticket cardinality. */
export function censusBridgeValue(census: unknown): CensusValue | null {
  if (!isRecord(census)) return null;
  const streams = recordAt(census, "streams");
  if (!isRecord(streams)) return null;
  const tally = recordAt(streams, "3c-gslive-tally");
  if (!isRecord(tally)) return null;
  const legs = finiteInteger(recordAt(tally, "rows"));
  const tickets = finiteInteger(recordAt(tally, "CmaxTickets"));
  return legs === null || tickets === null ? null : { legs, tickets };
}

/** The weblog bridge value, with the match percentage the gate's arithmetic implies. */
export function weblogBridgeValue(rollup: unknown): WeblogValue | null {
  if (!isRecord(rollup)) return null;
  const rows = recordAt(rollup, "rows");
  const join = recordAt(rollup, "join");
  const negativeControls = recordAt(rollup, "negativeControls");
  if (!isRecord(rows) || !isRecord(join)) return null;
  const total = finiteInteger(recordAt(rows, "total"));
  const parsed = finiteInteger(recordAt(rows, "parsed"));
  const matched = finiteInteger(recordAt(join, "matched"));
  const windowWagers = finiteInteger(recordAt(join, "totalWindowWagers"));
  if (
    total === null ||
    parsed === null ||
    matched === null ||
    windowWagers === null
  ) {
    return null;
  }
  const negative = isRecord(negativeControls) ? negativeControls : {};
  const flags = recordAt(rollup, "flags");
  const flag = (key: string): number | null =>
    isRecord(flags) ? finiteInteger(recordAt(flags, key)) : null;
  return {
    rows: total,
    parsed,
    matched,
    windowWagers,
    matchedPct:
      windowWagers > 0
        ? Math.round((matched / windowWagers) * 1000) / 10
        : null,
    negativeControls: finiteInteger(recordAt(negative, "checked")) ?? 0,
    falsePositiveFlags:
      finiteInteger(recordAt(negative, "falsePositiveFlags")) ?? 0,
    executionSnipers: flag("executionSnipers"),
    sniperTwins: flag("sniperTwins"),
    crossOfficeBeards: flag("crossOfficeBeards"),
    botRingAccounts: flag("botRingAccounts"),
    lineShoppers: flag("lineShoppers"),
  };
}

function bridgeAge(
  asOf: string | null,
  now: Date,
  staleAfterSeconds: number,
): { asOf: string | null; ageSeconds: number | null; stale: boolean } {
  const parsed = asOf === null ? Number.NaN : Date.parse(asOf);
  const ageSeconds = ageSecondsSince(
    Number.isFinite(parsed) ? parsed : null,
    now,
  );
  return {
    asOf,
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > staleAfterSeconds,
  };
}

/**
 * The five bridge cards, from already-parsed inputs.
 *
 * Bridge 3a has no committed artifact in this checkout, so it is always `not_measured` with the
 * command that would produce one. Bridge 1 and 3c read the same census capture (the ledger is a
 * single dated row), and bridge 3b reads the Pending capture.
 */
export function buildBridges(inputs: BridgeInputs): readonly DashboardBridge[] {
  const now = inputs.now ?? new Date();
  const censusValue = inputs.census?.value ?? null;
  const censusAge = bridgeAge(
    inputs.census?.asOf ?? null,
    now,
    CENSUS_STALE_AFTER_SECONDS,
  );
  const censusProvenance =
    inputs.census !== null && censusValue !== null
      ? {
          state: "measured" as const,
          value: { legs: censusValue.legs, tickets: censusValue.tickets },
          basis: "census" as const,
          source: inputs.census.source,
          asOf: censusAge.asOf,
          ageSeconds: censusAge.ageSeconds,
          stale: censusAge.stale,
        }
      : {
          state: "not_measured" as const,
          value: null,
          reason:
            inputs.census === null
              ? "no committed census under docs/design/census/"
              : "the latest census does not carry the 3c-gslive-tally rows/CmaxTickets",
          command: CENSUS_COMMAND,
        };

  const liveBetsAge = bridgeAge(
    inputs.liveBets?.asOf ?? null,
    now,
    STALE_AFTER_SECONDS.liveBets,
  );
  const bridge3b: DashboardBridge =
    inputs.liveBets !== null
      ? {
          id: "bridge-3b",
          label: "Bridge 3b · f402-pending",
          state: "measured",
          value: { pendingCount: inputs.liveBets.pendingCount },
          basis: "capture",
          source: LIVE_BETS_PATH,
          asOf: liveBetsAge.asOf,
          ageSeconds: liveBetsAge.ageSeconds,
          stale: liveBetsAge.stale,
          note: "GATE-08 is skipped unless --three-c-rollup is passed",
        }
      : {
          id: "bridge-3b",
          label: "Bridge 3b · f402-pending",
          state: "not_measured",
          value: null,
          reason: "no readable data/live-bets.json in this checkout",
          command: LIVE_BETS_COMMAND,
        };

  const weblogAge = bridgeAge(
    inputs.weblog?.asOf ?? null,
    now,
    WEBLOG_STALE_AFTER_SECONDS,
  );
  const weblogValue = inputs.weblog?.value ?? null;
  const weblog: DashboardBridge =
    inputs.weblog !== null && weblogValue !== null
      ? {
          id: "weblog",
          label: "Bridge WebLog · Mode 6",
          state: "measured",
          // Every rollup counter is published, including the flag populations the Mode 6 cell
          // renders; an absent optional count is null (never 0), which the client renders "—".
          value: { ...weblogValue },
          basis: "rollup",
          source: inputs.weblog.source,
          asOf: weblogAge.asOf,
          ageSeconds: weblogAge.ageSeconds,
          stale: weblogAge.stale,
        }
      : {
          id: "weblog",
          label: "Bridge WebLog · Mode 6",
          state: "not_measured",
          value: null,
          reason:
            inputs.weblog === null
              ? "no local f402-weblog rollup under Scratch/weblog/"
              : "the local weblog rollup has no rows/join counters",
          command: WEBLOG_COMMAND,
        };

  return [
    {
      id: "bridge-1",
      label: "Bridge 1 · wagers-by-state",
      ...censusProvenance,
      note: "committed census; same capture as bridge 3c",
    },
    {
      id: "bridge-3a",
      label: "Bridge 3a · f402-bet-ticker",
      state: "not_measured",
      value: null,
      reason: "no committed ticker archive in this checkout",
      command: BRIDGE_3A_COMMAND,
    },
    bridge3b,
    {
      id: "bridge-3c",
      label: "Bridge 3c · gslive-tally",
      ...censusProvenance,
      note: "committed census; same capture as bridge 1",
    },
    weblog,
  ];
}

/* -------------------------------------------------------------------------- */
/* Git head (no subprocess)                                                   */
/* -------------------------------------------------------------------------- */

export interface GitRef {
  readonly head: string | null;
  readonly branch: string | null;
}

interface GitLayout {
  readonly gitDir: string;
  readonly headFile: string;
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/** `.git` may be a directory or, in a linked worktree, a file containing `gitdir: …`. */
async function resolveGitLayout(root: string): Promise<GitLayout | null> {
  const dotGit = join(root, ".git");
  const head = await readTextFile(join(dotGit, "HEAD"));
  if (head !== null) return { gitDir: dotGit, headFile: join(dotGit, "HEAD") };
  const pointer = await readTextFile(dotGit);
  if (pointer === null) return null;
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (match === null) return null;
  const gitDir = resolve(root, match[1] ?? "");
  const headFile = join(gitDir, "HEAD");
  return (await readTextFile(headFile)) === null ? null : { gitDir, headFile };
}

async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  const direct = await readTextFile(join(gitDir, ref));
  if (direct !== null) {
    const sha = direct.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  }
  const packed = await readTextFile(join(gitDir, "packed-refs"));
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [sha = "", name = ""] = line.trim().split(/\s+/);
    if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return sha;
  }
  return null;
}

/** Short HEAD sha (7 chars) and branch, or nulls when there is no readable checkout. */
export async function readGitRef(root: string = DEFAULT_ROOT): Promise<GitRef> {
  const layout = await resolveGitLayout(root);
  if (layout === null) return { head: null, branch: null };
  const head = (await readTextFile(layout.headFile))?.trim() ?? "";
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim() ?? null;
  if (ref !== null) {
    const sha = await resolveRef(layout.gitDir, ref);
    return {
      head: sha === null ? null : sha.slice(0, 7),
      branch: ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : null,
    };
  }
  return /^[0-9a-f]{40}$/i.test(head)
    ? { head: head.slice(0, 7), branch: null }
    : { head: null, branch: null };
}

/* -------------------------------------------------------------------------- */
/* Status telemetry                                                           */
/* -------------------------------------------------------------------------- */

export interface DashboardStatus {
  readonly ok: boolean;
  readonly checks: Readonly<Record<string, "ok" | "error">>;
  readonly uptimeSeconds: number;
  readonly pid: number;
  readonly memoryRss: number;
  readonly runtime: string;
}

/** Process telemetry, the same shape the summary's `status` block carries. */
export function buildStatusTelemetry(
  checks: Record<string, "ok" | "error"> = {},
): DashboardStatus {
  const memory = process.memoryUsage();
  return {
    ok: Object.values(checks).every((check) => check === "ok"),
    checks: { ...checks },
    uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
    pid: process.pid,
    memoryRss: Math.max(0, Math.trunc(memory.rss)),
    runtime: `Bun v${Bun.version} (${process.arch}-${process.platform})`,
  };
}

/* -------------------------------------------------------------------------- */
/* Automation panel                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Automation state, composed by the service layer and carried verbatim.
 *
 * The lib is deliberately service-free: it cannot import the Telegram bot or the bridge relay,
 * so this is a plain interface the server fills. Keeping it an option means a loader call from a
 * test (or a checkout with no daemon) omits the section instead of inventing "disconnected".
 *
 * Secret rule, enforced by the server's builder rather than by a redaction pass: `bot` and
 * `webhook` are always `null`. Telegram's webhook URL embeds its bearer secret in the path, so
 * forwarding the status object as-is would leak the secret into a PII-guarded response.
 */
export interface AutomationWsRelay {
  readonly status: "connected" | "disconnected" | "no_token" | "unavailable";
  readonly started: boolean;
  readonly lastFrameAtIso: string | null;
  readonly lastFrameAgeSeconds: number | null;
  readonly topics: readonly string[];
  /** URL host only — never the ticket-bearing stream URL. */
  readonly gatewayHost: string | null;
}

export interface AutomationCronSchedule {
  readonly id: string;
  readonly name: string;
  readonly scheduleTime: string;
  readonly enabled: boolean;
}

export interface AutomationCron {
  readonly engine: string;
  readonly total: number;
  readonly enabled: number;
  readonly schedules: readonly AutomationCronSchedule[];
}

export interface AutomationTelegram {
  readonly mode: "simulation" | "live" | null;
  readonly modeReason: string | null;
  readonly tokenConfigured: boolean;
  readonly defaultChatConfigured: boolean;
  readonly authorizedChatCount: number | null;
  readonly inbound: string;
  readonly bot: null;
  readonly webhook: null;
  readonly error: string | null;
}

export interface DashboardAutomation {
  readonly wsRelay: AutomationWsRelay;
  readonly cron: AutomationCron;
  readonly telegram: AutomationTelegram;
}

/**
 * Fill the cron engine from the feed's own `schedulerEngine`, falling back to the caller's
 * value and then to the documented default. The feed is the artifact that records how the
 * poller is scheduled, so reading it here keeps the panel honest even if the caller guessed.
 */
function normalizeAutomation(
  automation: DashboardAutomation,
  feed: FeedSummary,
): DashboardAutomation {
  const engine =
    feed.schedulerEngine ??
    nonEmptyString(automation.cron.engine) ??
    "Bun.cron";
  return engine === automation.cron.engine
    ? automation
    : { ...automation, cron: { ...automation.cron, engine } };
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                               */
/* -------------------------------------------------------------------------- */

export interface RepoChecks {
  readonly routeSurface: {
    readonly status: "derived";
    readonly value: number;
    readonly source: string;
    readonly asOf: string;
    readonly ageSeconds: number;
    readonly stale: boolean;
    readonly command: string;
  };
  readonly tests: TestsCheck;
  readonly typecheck: NotMeasured;
  readonly docs: NotMeasured;
}

export interface RepoSummary {
  readonly head: string | null;
  readonly branch: string | null;
  readonly routes: RouteSummary;
  readonly citations: CitationsSummary;
  readonly checks: RepoChecks;
}

export interface DashboardSummary {
  readonly success: true;
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly feed: FeedSummary;
  readonly repo: RepoSummary;
  readonly bridges: readonly DashboardBridge[];
  readonly status: DashboardStatus;
  /**
   * Present only when the caller supplies automation state (the daemon does; a loader call from
   * a test or a checkout without the relay does not). Omitted — never a zeroed placeholder.
   */
  readonly automation?: DashboardAutomation;
}

/* -------------------------------------------------------------------------- */
/* Cached artifact reads                                                      */
/* -------------------------------------------------------------------------- */

/** One `cachedJsonFile` reader per absolute path; its cache is keyed on mtime+size. */
const jsonReaders = new Map<
  string,
  ReturnType<typeof cachedJsonFile<unknown>>
>();

function jsonReader(path: string): ReturnType<typeof cachedJsonFile<unknown>> {
  let reader = jsonReaders.get(path);
  if (reader === undefined) {
    reader = cachedJsonFile<unknown>(path, (raw) => raw);
    jsonReaders.set(path, reader);
  }
  return reader;
}

async function readJsonArtifact(
  path: string,
): Promise<{ version: string; value: unknown } | null> {
  try {
    return await jsonReader(path).read();
  } catch {
    // Exists but is not JSON: the caller reports it as unreadable, never as zero.
    return null;
  }
}

const textCache = new Map<string, { version: string; value: string | null }>();

async function readTextArtifact(
  path: string,
): Promise<{ version: string; value: string | null; mtime: Date } | null> {
  const stat = await Bun.file(path)
    .stat()
    .catch(() => null);
  if (stat === null) return null;
  const version = `${stat.mtimeMs}:${stat.size}`;
  const hit = textCache.get(path);
  if (hit !== undefined && hit.version === version) {
    return { version, value: hit.value, mtime: stat.mtime };
  }
  let value: string | null = null;
  try {
    value = await Bun.file(path).text();
  } catch {
    value = null;
  }
  textCache.set(path, { version, value });
  return { version, value, mtime: stat.mtime };
}

interface CitationCacheEntry {
  readonly version: string;
  readonly seed: CitationSeed;
}

const citationCache = new Map<string, CitationCacheEntry>();

function repoPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function latestCensusPath(root: string): string | null {
  try {
    const dir = join(root, CENSUS_DIR);
    const names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    const newest = names[0];
    return newest === undefined ? null : join(dir, newest);
  } catch {
    return null;
  }
}

async function loadCensus(root: string): Promise<CensusInput | null> {
  const path = latestCensusPath(root);
  if (path === null) return null;
  const artifact = await readJsonArtifact(path);
  if (artifact === null) return null;
  const stat = await Bun.file(path)
    .stat()
    .catch(() => null);
  const asOf =
    (isRecord(artifact.value)
      ? nonEmptyString(recordAt(artifact.value, "censusDate"))
      : null) ?? (stat === null ? null : stat.mtime.toISOString());
  return {
    source: repoPath(root, path),
    asOf,
    value: censusBridgeValue(artifact.value),
  };
}

async function loadLiveBets(root: string): Promise<LiveBetsInput | null> {
  const path = join(root, LIVE_BETS_PATH);
  const artifact = await readJsonArtifact(path);
  if (artifact === null || !isRecord(artifact.value)) return null;
  const pendingCount = finiteInteger(recordAt(artifact.value, "pendingCount"));
  if (pendingCount === null) return null;
  const stat = await Bun.file(path)
    .stat()
    .catch(() => null);
  const asOf =
    nonEmptyString(recordAt(artifact.value, "capturedAt")) ??
    (stat === null ? null : stat.mtime.toISOString());
  return { pendingCount, asOf };
}

async function loadWeblog(root: string): Promise<WeblogInput | null> {
  const local = loadWeblogLatestLocal(root);
  if (local.status !== "ok") return null;
  const stat = await Bun.file(local.path)
    .stat()
    .catch(() => null);
  const window = recordAt(local.rollup, "window");
  const toMs = isRecord(window) ? finiteNumber(recordAt(window, "toMs")) : null;
  const asOf =
    toMs !== null && toMs > 0
      ? new Date(toMs).toISOString()
      : (stat?.mtime.toISOString() ?? null);
  return {
    source: repoPath(root, local.path),
    asOf,
    value: weblogBridgeValue(local.rollup),
  };
}

async function loadCitations(
  root: string,
  now: Date,
): Promise<CitationsSummary> {
  const stats = await Promise.all(
    CITING_DOCS.map((doc) =>
      Bun.file(join(root, doc))
        .stat()
        .catch(() => null),
    ),
  );
  const missing = CITING_DOCS.filter((_, index) => stats[index] === null);
  if (missing.length > 0) {
    return unmeasuredCitationsSummary(
      `citing doc(s) missing from this checkout: ${missing.join(", ")}`,
    );
  }
  const version = stats
    .map((stat) => (stat === null ? "-" : `${stat.mtimeMs}:${stat.size}`))
    .join("|");
  const cached = citationCache.get(root);
  if (cached !== undefined && cached.version === version) {
    return deriveCitationsSummary(cached.seed, now);
  }
  try {
    const { citations, anchors } = collectDocCitations(root);
    const newestMtime = stats.reduce<Date | null>(
      (newest, stat) =>
        stat === null
          ? newest
          : newest === null || stat.mtime > newest
            ? stat.mtime
            : newest,
      null,
    );
    const seed: CitationSeed = { citations, anchors, asOf: newestMtime };
    citationCache.set(root, { version, seed });
    return deriveCitationsSummary(seed, now);
  } catch (error) {
    return unmeasuredCitationsSummary(
      `citation collection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadFeed(root: string, now: Date): Promise<FeedSummary> {
  const path = join(root, FEED_PATH);
  const artifact = await readJsonArtifact(path);
  if (artifact === null) {
    return unmeasuredFeedSummary(`no readable ${FEED_PATH} in this checkout`);
  }
  return deriveFeedSummary(artifact.value, { now, source: FEED_PATH });
}

/* -------------------------------------------------------------------------- */
/* Fingerprint                                                                */
/* -------------------------------------------------------------------------- */

async function statSignature(path: string | null): Promise<string> {
  if (path === null) return "-";
  const stat = await Bun.file(path)
    .stat()
    .catch(() => null);
  return stat === null ? "-" : `${stat.mtimeMs}:${stat.size}`;
}

/**
 * A cheap change signal for the SSE tick.
 *
 * Stats only for the files: the feed's mtime+size, the junit file, the census/weblog/live-bets
 * artifacts and the compiled route-table length. It is not a hash of the summary (that would
 * re-derive it); a change means "recompute", and an unchanged fingerprint is what makes a 5s tick
 * cheap.
 *
 * `extra` carries the caller's non-file signals (relay status, last frame, telegram mode, cron
 * count). They belong here rather than in a second comparison because the stream has exactly one
 * change check, and a panel that updates on a file-only fingerprint would miss a relay
 * connecting or TELEGRAM_BOT_TOKEN appearing.
 */
export async function graphFingerprint(
  options: { readonly root?: string; readonly extra?: readonly string[] } = {},
): Promise<string> {
  const root = options.root ?? DEFAULT_ROOT;
  const weblogPath = findWeblogLatestLocalPath(root);
  const signals = await Promise.all([
    statSignature(join(root, FEED_PATH)),
    statSignature(join(root, JUNIT_PATH)),
    statSignature(latestCensusPath(root)),
    statSignature(weblogPath),
    statSignature(join(root, LIVE_BETS_PATH)),
    statSignature(join(root, ".git", "HEAD")),
  ]);
  return [
    ...signals,
    ...(options.extra ?? []),
    `routes:${DAEMON_ROUTES.length + DAEMON_PREFIX_ROUTES.length}`,
  ].join("|");
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

export interface LoadDashboardOptions {
  readonly root?: string;
  readonly now?: Date;
  /** Process/report telemetry from the server; defaults to a local derivation. */
  readonly status?: DashboardStatus;
  /**
   * Automation state from the service layer. Omitted in a test/artifact-only call, in which case
   * the response has no `automation` key at all rather than an invented "disconnected" state.
   */
  readonly automation?: DashboardAutomation;
}

/**
 * Derive the whole `/api/graph/summary` body.
 *
 * All section reads are independent and cached by file version, so a summary request is a few
 * stats plus at most one parse of each changed artifact. `now` is injectable so age/stale rules
 * are tested against a fixed clock.
 */
export async function loadDashboardSummary(
  options: LoadDashboardOptions = {},
): Promise<DashboardSummary> {
  const root = options.root ?? DEFAULT_ROOT;
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const [feed, citations, git, census, liveBets, weblog, junit] =
    await Promise.all([
      loadFeed(root, now),
      loadCitations(root, now),
      readGitRef(root),
      loadCensus(root),
      loadLiveBets(root),
      loadWeblog(root),
      readTextArtifact(join(root, JUNIT_PATH)),
    ]);

  const routes = deriveRouteSummary();
  const tests = deriveTestsCheck(
    junit?.value ?? null,
    junit?.mtime ?? null,
    now,
  );
  const automation =
    options.automation === undefined
      ? undefined
      : normalizeAutomation(options.automation, feed);

  return {
    success: true,
    schemaVersion: DASHBOARD_SUMMARY_SCHEMA_VERSION,
    generatedAt,
    feed,
    repo: {
      head: git.head,
      branch: git.branch,
      routes,
      citations,
      checks: {
        routeSurface: {
          status: "derived",
          value: routes.served,
          source: routes.source,
          asOf: generatedAt,
          ageSeconds: 0,
          stale: false,
          command: ROUTE_COMMAND,
        },
        tests,
        typecheck: {
          status: "not_measured",
          reason: "not measured at request time",
          command: TYPECHECK_COMMAND,
        },
        docs: {
          status: "not_measured",
          reason: "not measured at request time",
          command: DOCS_COMMAND,
        },
      },
    },
    bridges: buildBridges({ census, liveBets, weblog, now }),
    status: options.status ?? buildStatusTelemetry(),
    ...(automation === undefined ? {} : { automation }),
  };
}
