/**
 * SportsDesk ops — a read-only DSH plugin for the SportsDesk/Fantasy402 desk.
 *
 * WHY THIS EXISTS
 *
 * The desk's operator surfaces are shell commands: git state, artifact freshness, the local
 * webview service, the downline snapshot, and the repo's verification gates. An agent could
 * reach them by shelling out and scraping stdout, but then "the service is down" and "the
 * route answered JSON saying nothing" look the same, and quoting a gate name into a shell is
 * how a typo becomes an unrelated command. This plugin exposes the same capabilities as
 * native tools with typed arguments and structured results.
 *
 * WHY READ-ONLY
 *
 * Deploying (`./bin/dx deploy` / `ship`), capturing feeds, dispatching Telegram reports,
 * syncing R2 and the Fantasy402 `wire` mutations all change state, and a model must not
 * trigger them as a side effect of answering a question. None of them are exposed here.
 * `sportsdesk_dev` is the only tool that EXECUTES anything: the repo's own verification
 * gates over a CLOSED set, and it refuses any other name. Those gates read artifacts and
 * check invariants; they do not deploy, capture or mutate.
 *
 * WHY IT SHELLS BUN
 *
 * There are two runtimes. The repo runs under Bun 1.4.4; the Host plugin shim runs in
 * Electron's Node main process, where the `Bun` global is undefined. So anything the tools
 * RUN — verification gates and git — is spawned as the existing command under Bun, and
 * anything they READ is the same file, route or checkout the operator would read. Nothing
 * is reimplemented, so there is no drift between the plugin and the desk's own tooling.
 *
 * WHAT IT REFUSES TO DO
 *
 * `cli/sportsdesk_cli.ts` answers `winners`, `losers` and `leaderboard` with hard-coded demo
 * rows. Exposing those here would feed a model fabricated numbers with a real-looking shape,
 * so they are deliberately absent. `sportsdesk_downline` reads `sportsdesk_downline_data.json`
 * itself and always reports the file's path, mtime and age, because a snapshot is not a live
 * feed. When something is missing the tools say MISSING; they never report it as zero.
 *
 * @module dsh-plugin-sportsdesk-ops
 */

// ast-grep-ignore: node-child-process -- Host plugin code runs in Electron's Node main process, where the Bun global does not exist; spawning bun is the shim's whole job.
import { execFile } from "node:child_process";
// ast-grep-ignore: node-fs-read-write-file -- same runtime: Bun.file() is not defined in Electron's Node, so whole-file reads go through node:fs.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const name = "sportsdesk-ops";

export const inject = ["tools"];

/**
 * Defaults for the bundle row's `config`.
 *
 * WHY THIS PLUGIN DECLARES NO `Config` SCHEMA: a Schemastery schema would import
 * `@deepseek-ai/schemastery`, and a directory-installed bundle is a LINK whose imports resolve
 * from its realpath (this checkout), not from the profile. That import fails unless the bundle
 * carries hand-made peer symlinks, which nothing automates. This bundle is dependency-free
 * instead; the loader then passes the row config through unvalidated, so values are normalized
 * here and a malformed value falls back to its default rather than reaching a spawn.
 */
const DEFAULT_CONFIG = {
  repoPath: "/Users/nolarose/code/sportsdesk-ops",
  bunPath: "bun",
  serviceUrl: "http://127.0.0.1:4020",
  timeoutMs: 60_000,
  gateTimeoutMs: 900_000,
  staleAfterMinutes: 1_440,
};

/**
 * Merge the row's config over the defaults, keeping only values of the right shape.
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
function normalizeConfig(raw) {
  const given = typeof raw === "object" && raw !== null ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  if (typeof given.repoPath === "string" && given.repoPath !== "") {
    config.repoPath = given.repoPath;
  }
  if (typeof given.bunPath === "string" && given.bunPath !== "") {
    config.bunPath = given.bunPath;
  }
  if (typeof given.serviceUrl === "string" && given.serviceUrl !== "") {
    config.serviceUrl = given.serviceUrl;
  }
  for (const key of ["timeoutMs", "gateTimeoutMs", "staleAfterMinutes"]) {
    const value = given[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      config[key] = value;
    }
  }
  return config;
}

/** Every tool returns one JSON object; the render callback owns the text projection. */
const TEXT_OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [
    { type: "text", text: JSON.stringify(value, null, 2) },
  ],
};

/**
 * Build a raw ToolDefinition without importing `@deepseek-ai/dsh-tools`.
 *
 * WHY RAW: `defineTool` lives in a peer package. A directory-installed bundle is a LINK, and
 * Node resolves a linked module's imports from its realpath (this checkout), not from the
 * profile — measured as `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/dsh-tools` unless the bundle
 * hand-symlinks the peers. A raw definition needs no such symlinks, which is what the
 * documented "a Host-only bundle needs no dependencies" contract means.
 *
 * The trade-off: raw `register` does NOT validate arguments (only `defineTool` wraps
 * `execute` with schema validation), so every tool validates its own arguments and returns a
 * structured refusal instead of throwing.
 *
 * @param {{ name: string, description: string, parameters: object, output: object, isConcurrencySafe?: (args: any) => boolean, execute: (args: any, exec: any) => Promise<unknown> }} spec
 * @returns {object}
 */
function defineReadTool(spec) {
  const definition = {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: spec.output,
    execute: spec.execute,
  };
  if (typeof spec.isConcurrencySafe === "function") {
    definition.isConcurrencySafe = spec.isConcurrencySafe;
  }
  return definition;
}

/**
 * Structured refusal for a malformed argument (raw registration does not validate input).
 *
 * @param {string} message
 * @returns {{ available: false, reason: string, message: string }}
 */
function invalidArguments(message) {
  return { available: false, reason: "invalid_arguments", message };
}

/** How much captured stdout/stderr a result keeps before eliding the rest. */
const MAX_EXCERPT = 4_000;

/** How large an inlined dataset may be before the tool refuses to dump it. */
const MAX_INLINE_JSON = 120_000;

/**
 * The repo's verification surface, in the order the gates run. `kind` decides the timeout:
 * `check` entries are cheap invariant readers, `gate` entries are the CI steps. The table has
 * a null prototype so a caller cannot reach `constructor` or `__proto__` through a lookup.
 */
const DEV_CHECKS = Object.assign(Object.create(null), {
  secrets: {
    kind: "check",
    argv: ["run", "check:secrets"],
    description: "No credential shapes in tracked files.",
  },
  release: {
    kind: "check",
    argv: ["run", "audit:release", "--json"],
    json: true,
    description: "Release registry matches the docs-v* tags that exist.",
  },
  archives: {
    kind: "check",
    argv: ["run", "audit:archives"],
    description: "Archive provenance / no tracked archives.",
  },
  ledger: {
    kind: "check",
    argv: ["run", "check:ledger-consistency"],
    description: "Evidence ledger parses and stays consistent.",
  },
  citations: {
    kind: "check",
    argv: ["run", "check:spec-citations"],
    description: "Spec citations resolve to real anchors.",
  },
  routes: {
    kind: "check",
    argv: ["run", "check:route-surface"],
    description: "Served routes = ledger = OpenAPI spec.",
  },
  pm: {
    kind: "check",
    argv: ["run", "pm:doctor", "--json"],
    json: true,
    description: "Bun package-manager policy (runtime pin, lock drift).",
  },
  "customer-book": {
    kind: "check",
    argv: ["run", "audit:customer-book", "--json"],
    json: true,
    description: "Customer-book integrity audit.",
  },
  artifacts: {
    kind: "check",
    argv: ["run", "artifacts:lock", "--json"],
    json: true,
    description: "Generator inputs unchanged since the last regeneration.",
  },
  format: {
    kind: "gate",
    argv: ["run", "format:check"],
    description: "Formatting (bun fmt --check).",
  },
  typecheck: {
    kind: "gate",
    argv: ["run", "typecheck"],
    description: "Type check across the deep tsconfig.",
  },
  lint: {
    kind: "gate",
    argv: ["run", "lint:check"],
    description: "oxlint with no autofix.",
  },
  unit: {
    kind: "gate",
    argv: ["test", "tests/", "--parallel"],
    description: "The CI test suite.",
  },
  docs: {
    kind: "gate",
    argv: ["run", "verify:docs"],
    restoresGeneratedFiles: true,
    description: "Docs gates (fabricated-contract, freshness, headers, dist).",
  },
  ci: {
    kind: "gate",
    argv: ["run", "ci:local"],
    restoresGeneratedFiles: true,
    description: "The whole .github/workflows/ci.yml chain, in order.",
  },
  "ci-all": {
    kind: "gate",
    argv: ["run", "ci:local", "--keep-going"],
    restoresGeneratedFiles: true,
    description: "Every CI step, continuing past failures: the full inventory.",
  },
});

/** Deterministic gate order: cheap invariant reads first, then the long CI steps. */
const DEV_ORDER = Object.keys(DEV_CHECKS);

/**
 * The datasets the desk actually keeps on disk. `records` is a per-dataset reader of the
 * record count, reported only when the JSON parses; a file that does not parse is an error,
 * not an empty dataset. `required` means the portal/evidence chain cannot be trusted without it.
 */
const DATASETS = [
  {
    name: "downline",
    path: "sportsdesk_downline_data.json",
    role: "Master downline snapshot (agents and lifetime rollups).",
    required: true,
    records: (value) => recordCount(value, ["agents", "meta"]),
  },
  {
    name: "customers",
    path: "enriched_customers_full.json",
    role: "Enriched customer book (the churn/forensics input).",
    required: true,
    records: (value) => (Array.isArray(value) ? value.length : null),
  },
  {
    name: "agent-index",
    path: "data/agent-index.json",
    role: "Agent index built by the ingestion pipeline.",
    required: false,
    records: (value) => recordCount(value, ["agents"]),
  },
  {
    name: "agent-tree",
    path: "data/agent-tree.json",
    role: "Agent hierarchy tree with roots and collisions.",
    required: false,
    records: (value) => recordCount(value, ["nodes"]),
  },
  {
    name: "live-bets",
    path: "data/live-bets.json",
    role: "Live bet feed snapshot (agents and games).",
    required: false,
    records: (value) => recordCount(value, ["games"]),
  },
  {
    name: "live-wagers",
    path: "data/live-wagers.json",
    role: "Observed wager list (partial capture note included).",
    required: false,
    records: (value) => recordCount(value, ["LIST"]),
  },
  {
    name: "contests",
    path: "data/contests.json",
    role: "Extracted contest entries.",
    required: false,
    records: (value) => recordCount(value, ["entries"]),
  },
  {
    name: "scoreboard",
    path: "data/scoreboard.json",
    role: "Scoreboard snapshot.",
    required: false,
    records: (value) => recordCount(value, ["games"]),
  },
  {
    name: "analysis-cp-baseball",
    path: "data/analysis-cp-baseball-2026-11-01.json",
    role: "Analysis report rows for the CP baseball run.",
    required: false,
    records: (value) => recordCount(value, ["rows"]),
  },
  {
    name: "customer-profiles",
    path: "data/customer-profiles.json",
    role: "Built customer profiles.",
    required: false,
    records: (value) => recordCount(value, ["profiles"]),
  },
  {
    name: "game-admin-board",
    path: "data/game-admin-board.json",
    role: "Game admin board snapshot.",
    required: false,
    records: (value) => recordCount(value, ["games"]),
  },
  {
    name: "evidence-ledger",
    path: "docs/evidence/ledger.json",
    role: "Evidence ledger (route surface and operations SSOT).",
    required: true,
    records: (value) => recordCount(value, ["operations", "surfaces"]),
  },
  {
    name: "openapi",
    path: "dist/openapi.json",
    role: "Published OpenAPI 3.1 spec.",
    required: true,
    records: (value) => recordCount(value, ["paths"]),
  },
];

/** Dataset lookup with a null prototype, so `__proto__` is not a dataset. */
const DATASETS_BY_NAME = Object.assign(
  Object.create(null),
  Object.fromEntries(DATASETS.map((dataset) => [dataset.name, dataset])),
);

/**
 * The enriched customer book: every customer count, ticket count and ranking the
 * `sportsdesk_customer` tool reports is computed from THIS file at call time. Nothing about
 * how many customers or bets exist is written down in the plugin.
 */
const CUSTOMER_BOOK = {
  path: "enriched_customers_full.json",
  role: "Enriched customer book: lifetime rollups plus a sample of recent tickets per customer.",
};

/**
 * Sum one numeric field across rows; missing/non-numeric values contribute nothing.
 *
 * @param {unknown[]} rows
 * @param {string} key
 * @returns {number}
 */
function sumField(rows, key) {
  let total = 0;
  for (const row of rows) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/**
 * Mean of one numeric field, or `null` when no row carries it (not 0 — an absent metric is
 * absent).
 *
 * @param {unknown[]} rows
 * @param {string} key
 * @returns {number | null}
 */
function meanField(rows, key) {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }
  return count === 0 ? null : total / count;
}

/**
 * Count how often each distinct value of a field occurs. The value set comes from the data,
 * never from a checked-in list, so a new status or churn mode appears in the answer.
 *
 * @param {unknown[]} rows
 * @param {string} key
 * @returns {Record<string, number>}
 */
function countField(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = String(row?.[key] ?? "UNKNOWN");
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

/**
 * The compact projection returned by list reports; the full record stays available through
 * `lookup`.
 *
 * @param {any} row
 * @returns {Record<string, unknown>}
 */
function slimCustomer(row) {
  return {
    customer_id: row?.customer_id ?? null,
    agent_id: row?.agent_id ?? null,
    status: row?.status ?? null,
    context_type: row?.context_type ?? null,
    lifetime_volume_usd: row?.lifetime_volume_usd ?? null,
    lifetime_net_usd: row?.lifetime_net_usd ?? null,
    // Both windows are projected: a 7d ranking must not display only lifetime numbers,
    // or the row would appear to contradict the order it is sorted by.
    sports_7d_volume_usd: row?.sports_7d_volume_usd ?? null,
    sports_7d_net_usd: row?.sports_7d_net_usd ?? null,
    hold_pct: row?.hold_pct ?? null,
    clv_bps: row?.clv_bps ?? null,
    sharp_score: row?.sharp_score ?? null,
    churn_hazard: row?.churn_hazard ?? null,
    churn_mode: row?.churn_mode ?? null,
    recent_ticket_count: Array.isArray(row?.recent_tickets)
      ? row.recent_tickets.length
      : 0,
  };
}

/**
 * Customer-intelligence helpers. Every rank, quantile and flag below is derived from the book
 * rows at call time; no cutoff, tie-break or segment label is checked in. A field with no
 * finite value in the book yields `null`, never zero, so a missing measurement cannot read as
 * a measured one.
 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Linear-interpolated quantile over an ascending-sorted numeric array. */
function quantile(sorted, fraction) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  const below = sorted[low];
  const above = sorted[high];
  return below + (above - below) * (position - low);
}

/**
 * Midrank percentile (0-100): half credit for exact ties, so a book where every customer has
 * the same value does not report 100 for the last row it happens to scan.
 */
function percentileRank(sorted, value) {
  if (!Number.isFinite(value) || sorted.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const candidate of sorted) {
    if (candidate < value) below += 1;
    else if (candidate === value) equal += 1;
    else break;
  }
  return ((below + equal * 0.5) / sorted.length) * 100;
}

function medianOf(values) {
  const finite = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 1
    ? finite[middle]
    : (finite[middle - 1] + finite[middle]) / 2;
}

/**
 * One pass over the book that every intelligence report shares: sorted numeric columns for
 * percentile work, agent and ip_subnet groups, and each customer's last sampled ticket time.
 */
function buildCustomerCohort(rows) {
  const sortedField = (key) =>
    rows
      .map((row) => Number(row?.[key]))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
  const byAgent = new Map();
  const bySubnet = new Map();
  const lastPlaced = new Map();
  let newestPlacedAt = "";
  for (const row of rows) {
    const customer = String(row?.customer_id ?? "");
    const agent = String(row?.agent_id ?? "UNKNOWN");
    const agentRows = byAgent.get(agent) ?? [];
    agentRows.push(row);
    byAgent.set(agent, agentRows);
    const subnet = String(row?.ip_subnet ?? "").trim();
    if (subnet !== "") bySubnet.set(subnet, (bySubnet.get(subnet) ?? 0) + 1);
    const tickets = Array.isArray(row?.recent_tickets)
      ? row.recent_tickets
      : [];
    let last = "";
    for (const ticket of tickets) {
      const placed = String(ticket?.placed_at ?? "");
      if (placed > last) last = placed;
      if (placed > newestPlacedAt) newestPlacedAt = placed;
    }
    if (last !== "") lastPlaced.set(customer, last);
  }
  const newestMs = Date.parse(newestPlacedAt) || 0;
  const staleness = rows
    .map((row) => {
      const last = lastPlaced.get(String(row?.customer_id ?? ""));
      if (last === undefined || newestMs === 0) return null;
      return (newestMs - Date.parse(last)) / 86_400_000;
    })
    .filter((days) => days !== null)
    .sort((left, right) => left - right);
  return {
    volume: sortedField("lifetime_volume_usd"),
    net: sortedField("lifetime_net_usd"),
    clv: sortedField("clv_bps"),
    sharp: sortedField("sharp_score"),
    churn: sortedField("churn_hazard"),
    hold: sortedField("hold_pct"),
    wagerLimit: sortedField("wager_limit_usd"),
    delay: sortedField("delay_seconds"),
    staleness,
    byAgent,
    bySubnet,
    newestPlacedAt,
  };
}

/** The cohort p90 cutoffs the flags refer to, returned with every answer so none is hidden. */
function cohortCutoffs(cohort) {
  return {
    volumeP90: quantile(cohort.volume, 0.9),
    netP90: quantile(cohort.net, 0.9),
    sharpP90: quantile(cohort.sharp, 0.9),
    churnP90: quantile(cohort.churn, 0.9),
    holdP90: quantile(cohort.hold, 0.9),
    dormantDaysP90: quantile(cohort.staleness, 0.9),
  };
}

/** The sampled-ticket behavior of one customer. Never mixed with the lifetime rollup. */
function sampleOf(row, cohort) {
  const tickets = Array.isArray(row?.recent_tickets) ? row.recent_tickets : [];
  const risk = tickets
    .map((ticket) => Number(ticket?.risk_usd))
    .filter((value) => Number.isFinite(value));
  const net = tickets
    .map((ticket) => Number(ticket?.net_usd))
    .filter((value) => Number.isFinite(value));
  const wins = tickets.filter((ticket) => ticket?.result === "WIN").length;
  const decisive = tickets.filter(
    (ticket) => ticket?.result === "WIN" || ticket?.result === "LOSS",
  ).length;
  const hourHistogramUtc = Array.from({ length: 24 }, () => 0);
  for (const ticket of tickets) {
    const when = Date.parse(String(ticket?.placed_at ?? ""));
    if (Number.isFinite(when))
      hourHistogramUtc[new Date(when).getUTCHours()] += 1;
  }
  const placed = tickets
    .map((ticket) => String(ticket?.placed_at ?? ""))
    .filter((value) => value !== "")
    .sort();
  const firstPlacedAt = placed.length === 0 ? null : placed[0];
  const lastPlacedAt = placed.length === 0 ? null : placed[placed.length - 1];
  const newestMs = Date.parse(cohort.newestPlacedAt) || 0;
  // Deliberately unrounded: this value is compared against the unrounded staleness
  // cutoff, and rounding it first made every tied customer fall just below p90.
  const daysSinceLastTicket =
    lastPlacedAt === null || newestMs === 0
      ? null
      : (newestMs - Date.parse(lastPlacedAt)) / 86_400_000;
  const riskUsd = risk.reduce((total, value) => total + value, 0);
  const netUsd = net.reduce((total, value) => total + value, 0);
  return {
    tickets: tickets.length,
    riskUsd,
    netUsd,
    roiPct: riskUsd === 0 ? null : (netUsd / riskUsd) * 100,
    winPct: decisive === 0 ? null : (wins / decisive) * 100,
    wins,
    decisive,
    avgRiskUsd: risk.length === 0 ? null : riskUsd / risk.length,
    medianRiskUsd: medianOf(risk),
    maxRiskUsd: risk.length === 0 ? null : Math.max(...risk),
    firstPlacedAt,
    lastPlacedAt,
    daysSinceLastTicket,
    results: countField(tickets, "result"),
    leagues: countField(tickets, "league"),
    markets: countField(tickets, "market"),
    channels: countField(tickets, "channel"),
    hourHistogramUtc,
  };
}

function customerRanks(row, cohort) {
  return {
    volume: percentileRank(
      cohort.volume,
      finiteNumber(row?.lifetime_volume_usd),
    ),
    net: percentileRank(cohort.net, finiteNumber(row?.lifetime_net_usd)),
    clv: percentileRank(cohort.clv, finiteNumber(row?.clv_bps)),
    sharp: percentileRank(cohort.sharp, finiteNumber(row?.sharp_score)),
    churn: percentileRank(cohort.churn, finiteNumber(row?.churn_hazard)),
    hold: percentileRank(cohort.hold, finiteNumber(row?.hold_pct)),
    wagerLimit: percentileRank(
      cohort.wagerLimit,
      finiteNumber(row?.wager_limit_usd),
    ),
    delay: percentileRank(cohort.delay, finiteNumber(row?.delay_seconds)),
  };
}

/** Deep profile of one customer. Used by `profile` and `compare`, so both cannot drift. */
function customerProfile(row, cohort, cutoffs) {
  const customerId = String(row?.customer_id ?? "");
  const volume = finiteNumber(row?.lifetime_volume_usd);
  const net = finiteNumber(row?.lifetime_net_usd);
  const clv = finiteNumber(row?.clv_bps);
  const sharp = finiteNumber(row?.sharp_score);
  const churn = finiteNumber(row?.churn_hazard);
  const hold = finiteNumber(row?.hold_pct);
  const sample = sampleOf(row, cohort);
  const subnet = String(row?.ip_subnet ?? "").trim();
  const peerCustomers =
    subnet === "" ? 0 : (cohort.bySubnet.get(subnet) ?? 1) - 1;
  const agentId = String(row?.agent_id ?? "UNKNOWN");
  const agentRows = cohort.byAgent.get(agentId) ?? [row];
  const rankWithin = (key) => {
    const ordered = agentRows.slice().sort((left, right) => {
      const leftValue = finiteNumber(left?.[key]) ?? Number.NEGATIVE_INFINITY;
      const rightValue = finiteNumber(right?.[key]) ?? Number.NEGATIVE_INFINITY;
      return rightValue - leftValue;
    });
    const index = ordered.findIndex(
      (candidate) => String(candidate?.customer_id ?? "") === customerId,
    );
    return index < 0 ? null : index + 1;
  };
  const dormant =
    sample.daysSinceLastTicket !== null &&
    cutoffs.dormantDaysP90 !== null &&
    sample.daysSinceLastTicket >= cutoffs.dormantDaysP90;
  return {
    customer_id: row?.customer_id ?? null,
    identity: {
      agent_id: row?.agent_id ?? null,
      master_agent: row?.master_agent ?? null,
      status: row?.status ?? null,
      context_type: row?.context_type ?? null,
      churn_mode: row?.churn_mode ?? null,
      wager_limit_usd: row?.wager_limit_usd ?? null,
      delay_seconds: row?.delay_seconds ?? null,
    },
    lifetime: {
      volumeUsd: volume,
      netUsd: net,
      holdPct: hold,
      sports7dVolumeUsd: finiteNumber(row?.sports_7d_volume_usd),
      sports7dNetUsd: finiteNumber(row?.sports_7d_net_usd),
      clvBps: clv,
      sharpScore: sharp,
      churnHazard: churn,
    },
    cohortRanksPct: customerRanks(row, cohort),
    sample,
    agentPeers: {
      agent_id: agentId,
      customers: agentRows.length,
      rankByNet: rankWithin("lifetime_net_usd"),
      rankByVolume: rankWithin("lifetime_volume_usd"),
    },
    network: {
      sharedNetworkIdentity: peerCustomers > 0,
      peerCustomers,
    },
    flags: {
      positiveClv: clv !== null && clv > 0,
      topDecileVolume:
        volume !== null &&
        cutoffs.volumeP90 !== null &&
        volume >= cutoffs.volumeP90,
      topDecileSharp:
        sharp !== null &&
        cutoffs.sharpP90 !== null &&
        sharp >= cutoffs.sharpP90,
      highChurn:
        churn !== null &&
        cutoffs.churnP90 !== null &&
        churn >= cutoffs.churnP90,
      highHold:
        hold !== null && cutoffs.holdP90 !== null && hold >= cutoffs.holdP90,
      dormant,
      sharedNetworkIdentity: peerCustomers > 0,
    },
  };
}

/**
 * `label >= cutoff`, or an explicit "no finite values" so a null cutoff is never printed as
 * a number and never silently becomes `>= null`.
 */
function cutoffRule(label, cutoff) {
  return cutoff === null
    ? `${label} (no finite values in this book)`
    : `${label} >= ${cutoff}`;
}

/**
 * The staged market reports `./bin/dx stage` publishes into `dist/`. These are REPORTS, not
 * inputs: each carries its own `generatedAtIso`, and the tool reports both that and the file's
 * mtime, so a caller can tell a fresh build from a stale one.
 */
const MARKET_REPORTS = Object.assign(Object.create(null), {
  "combo-uniqueness": {
    path: "dist/combo-uniqueness.json",
    role: "Combo identity gates (permissive / all-legs-cfb / full-game), dedupe and unresolved-leg diagnostics.",
  },
  bridge: {
    path: "dist/cross-domain-bridge.json",
    role: "Customer-to-Polymarket-wallet attribution: coverage, value, ranked leads, quarantined rows.",
  },
  backtest: {
    path: "dist/backtest-4wk-cfb-nba.json",
    role: "4-week parlay counterfactual: combo families with CLV, guard attribution, customer leaderboard.",
  },
});

/**
 * Backtest fields that describe the report rather than measure it, kept out of `totals`.
 */
const BACKTEST_META_KEYS = new Set([
  "schemaVersion",
  "generatedAtIso",
  "generatedAtCdt",
  "windowStartIso",
  "windowEndIso",
  "dataBasis",
]);

/**
 * Sort rows by one numeric field, descending, and keep at most `limit`.
 *
 * WHY: every report below is a LIST that can be long. A tool
 * result is a summary, so the list is ranked and capped instead of dumped; `limit` owns the cap.
 *
 * @param {unknown} rows
 * @param {string} key
 * @param {number} limit
 * @returns {unknown[]}
 */
function topBy(rows, key, limit) {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice()
    .sort((left, right) => Number(right?.[key] ?? 0) - Number(left?.[key] ?? 0))
    .slice(0, limit);
}

/**
 * Keep rows whose one field equals `wanted`, case-insensitively; an empty filter keeps all.
 *
 * @param {unknown} rows
 * @param {string} key
 * @param {unknown} wanted
 * @returns {unknown[]}
 */
function filterBy(rows, key, wanted) {
  const list = Array.isArray(rows) ? rows : [];
  if (typeof wanted !== "string" || wanted === "") return list;
  const upper = wanted.toUpperCase();
  return list.filter((row) => String(row?.[key] ?? "").toUpperCase() === upper);
}

/**
 * Pull the sport token out of a ticker ShortDesc, which carries a wager-type/keys prefix and a
 * leading carriage return ("M.G319748913\r\nFootball - ...", "P.Football #263 ...").
 *
 * @param {unknown} desc
 * @returns {string}
 */
/**
 * The bet ticker's `WagerType` is a RAW code set, distinct from the grading panel's bet-type
 * enum. Pinned from docs/evidence/surfaces.md: the panel labels `betType:M` "Money Line" but on a
 * DIFFERENT screen (it does not document the ticker); `M` has no documented meaning in the ticker
 * (docs/evidence/capture-requests.md — "carried as a raw code rather than guessed"); the panel's
 * `Straight` betType is the comma set `S,M,L,E,C` and `I` is if-bets/action reverses. The ticker
 * codes observed in the artifacts are M, L, S, P, I, T, G, A, C, N.
 */
const TICKER_WAGER_TYPES = new Set([
  "M",
  "L",
  "S",
  "P",
  "I",
  "T",
  "G",
  "A",
  "C",
  "N",
]);

const TICKER_WAGER_TYPE_FACTS =
  "The ticker WagerType is a raw code set (observed: M, L, S, P, I, T, G, A, C, N), distinct " +
  "from the grading panel's bet-type enum (Straight = S,M,L,E,C; I = if-bets/action reverses). " +
  "M has no documented meaning in the ticker; the panel's betType:M is 'Money Line' on a " +
  "different screen, so these codes must not be joined across screens.";

/**
 * Structurally split a ticker ShortDesc into its wager-type code, optional game id and sport. The
 * leading token before the first `.`/`:` is the wager type; `G<digits>` may follow; the sport is
 * the next whitespace-delimited token. A leading token outside the known ticker set is flagged
 * `unknown` instead of silently passing through as a sport.
 *
 * @param {unknown} desc
 * @returns {{ wagerType: string | null, gameNumber: string | null, descCode: string | null, sport: string | null, unknown: boolean }}
 */
function tokenizeShortDesc(desc) {
  const text = String(desc ?? "").trim();
  const typeMatch = text.match(/^([A-Z]+)[.:]/);
  if (typeMatch === null) {
    return {
      wagerType: null,
      gameNumber: null,
      descCode: null,
      sport: null,
      unknown: true,
    };
  }
  const wagerType = typeMatch[1];
  let rest = text.slice(typeMatch[0].length);
  let gameNumber = null;
  const gameMatch = rest.match(/^G(\d+)/);
  if (gameMatch !== null) {
    gameNumber = gameMatch[1];
    rest = rest.slice(gameMatch[0].length);
  }
  rest = rest.replace(/^[\r\n]+/, "");
  const sportToken = (rest.split(/\s+/)[0] ?? "").replace(/[-\u2013].*$/, "");
  return {
    wagerType,
    gameNumber,
    descCode: typeMatch[0] + (gameNumber ?? ""),
    sport: sportToken === "" ? null : sportToken,
    unknown: !TICKER_WAGER_TYPES.has(wagerType),
  };
}

/**
 * Read a record count out of a parsed JSON value.
 *
 * WHY THIS EXISTS AT ALL: a dataset can parse and still carry no records container (a
 * truncated write, a schema change). Returning `null` keeps that distinct from a genuine `0`,
 * which is the difference between "the capture is empty" and "nobody has looked".
 *
 * The repo stores some collections as ARRAYS (`agents`, `games`, `rows`) and others as
 * OBJECT MAPS keyed by id (`agent-index.json` `agents`, `agent-tree.json` `nodes`,
 * `openapi.json` `paths`). Both are counted: an object map's record count is its key count,
 * which is the only honest reading of a keyed map.
 *
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {number | null}
 */
function recordCount(value, keys) {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object" || value === null) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.length;
    if (typeof candidate === "object" && candidate !== null) {
      return Object.keys(candidate).length;
    }
  }
  return null;
}

/**
 * Find the bun executable that will run the repo commands.
 *
 * The Host is Electron's Node, where `process.execPath` is the harness binary — valid only if
 * that binary is Bun. Resolution order: an explicit absolute `bunPath`, then the running
 * binary when we ARE Bun, then the known install locations, then a bare `bun` so a spawn
 * failure is reported as "could not start" rather than silently misreported.
 *
 * @param {string} preferred
 * @returns {string}
 */
function resolveBun(preferred) {
  if (preferred && preferred !== "bun" && existsSync(preferred))
    return preferred;
  if (process.versions && process.versions.bun) return process.execPath;
  const home = homedir();
  for (const candidate of [
    `${home}/.bun/bin/bun`,
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return preferred || "bun";
}

/**
 * Read a whole UTF-8 file. Returns `null` when it does not exist or cannot be read, so callers
 * report MISSING instead of an exception or a plausible-looking empty value.
 *
 * @param {string} path
 * @returns {string | null}
 */
function readText(path) {
  try {
    // ast-grep-ignore: node-fs-read-write-file -- Electron Node has no Bun.file; this is the one read site.
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Stat a path without throwing. Missing is data here, not an error.
 *
 * @param {string} path
 * @returns {{ exists: boolean, bytes: number | null, mtime: string | null, ageMinutes: number | null }}
 */
function statFile(path) {
  try {
    const stats = statSync(path);
    const ageMinutes = Math.max(
      0,
      Math.round((Date.now() - stats.mtimeMs) / 60_000),
    );
    return {
      exists: true,
      bytes: stats.size,
      mtime: new Date(stats.mtimeMs).toISOString(),
      ageMinutes,
    };
  } catch {
    return { exists: false, bytes: null, mtime: null, ageMinutes: null };
  }
}

/**
 * Parse JSON without throwing.
 *
 * @param {string | null} text
 * @returns {{ ok: boolean, value: unknown }}
 */
function parseJson(text) {
  if (text === null) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Trim a captured stream for transport.
 *
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  const clean = String(text ?? "").trim();
  if (clean.length <= MAX_EXCERPT) return clean;
  const dropped = clean.length - MAX_EXCERPT;
  return `${clean.slice(0, MAX_EXCERPT)}\n... (${dropped} more characters)`;
}

/**
 * Spawn one process and report its outcome WITHOUT throwing.
 *
 * A non-zero exit is DATA, not an exception: the repo's checks exit 1 for "measured a problem"
 * and 2 for "bad argument", and collapsing those into a thrown error would hide which one
 * happened. A timeout is reported as timed_out, never as a failed gate or a pass.
 *
 * @param {string} bin
 * @param {string[]} argv
 * @param {{ cwd: string, timeoutMs: number }} options
 * @returns {Promise<{ ok: boolean, exitCode: number | null, timedOut: boolean, stdout: string, stderr: string, durationMs: number, spawnError: string | null }>}
 */
async function runProcess(bin, argv, options) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      // ast-grep-ignore: perf-now-timing -- the Host runtime is Electron Node, where Bun.nanoseconds is undefined; this duration is reported, not used for ordering.
      durationMs: Date.now() - startedAt,
      spawnError: null,
    };
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const timedOut = error?.killed === true && error?.signal === "SIGTERM";
    const spawnError =
      exitCode === null && !timedOut
        ? `could not start ${bin}: ${error?.message ?? String(error)}`
        : null;
    return {
      ok: false,
      exitCode,
      timedOut,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? String(error)),
      // ast-grep-ignore: perf-now-timing -- the Host runtime is Electron Node, where Bun.nanoseconds is undefined; this duration is reported, not used for ordering.
      durationMs: Date.now() - startedAt,
      spawnError,
    };
  }
}

/**
 * GET a URL and parse JSON, keeping the HTTP status. A reachable service that answers
 * non-JSON is reported as such instead of being treated as absent.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number | null, body: unknown, ok: boolean, error: string | null }>}
 */
async function fetchJson(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    const parsed = parseJson(text);
    return {
      status: response.status,
      body: parsed.ok ? parsed.value : null,
      ok: response.ok && parsed.ok,
      error: parsed.ok ? null : "response was not JSON",
    };
  } catch (error) {
    return {
      status: null,
      body: null,
      ok: false,
      error: error?.message ?? String(error),
    };
  }
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {import("@deepseek-ai/schemastery").default} config
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const repoPath = settings.repoPath;
  const serviceUrl = String(settings.serviceUrl).replace(/\/+$/, "");
  const staleAfterMinutes = settings.staleAfterMinutes;
  /** Disposers from ctx.tools.register, returned as this plugin's cleanup. */
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };

  /**
   * @param {string[]} argv
   * @param {number} [timeoutMs]
   */
  async function runBun(argv, timeoutMs = settings.timeoutMs) {
    return runProcess(resolveBun(settings.bunPath), argv, {
      cwd: repoPath,
      timeoutMs,
    });
  }

  /**
   * @param {string[]} argv
   * @returns {ReturnType<typeof runProcess>}
   */
  async function runGit(argv) {
    return runProcess("git", ["-C", repoPath, ...argv], {
      cwd: repoPath,
      timeoutMs: 15_000,
    });
  }

  /**
   * The checkout state a "can I claim this works" answer has to start from. A diverged branch
   * is reported with BOTH counts: `ahead` alone hides commits the push would have to reconcile.
   *
   * @returns {Promise<Record<string, unknown>>}
   */
  async function readGitState() {
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      return {
        available: false,
        reason: "not_a_git_checkout",
        message: `${repoPath} is not a git checkout: no branch, no HEAD and no upstream to report.`,
        stderr: inside.stderr ? excerpt(inside.stderr) : null,
      };
    }
    const [branch, head, status, upstream] = await Promise.all([
      runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(["rev-parse", "--short", "HEAD"]),
      runGit(["status", "--porcelain"]),
      runGit(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    ]);
    const dirtyLines = status.ok
      ? status.stdout.split("\n").filter((line) => line !== "")
      : [];
    const modified = dirtyLines.filter((line) => !line.startsWith("??"));
    const untracked = dirtyLines.filter((line) => line.startsWith("??"));
    let upstreamState = null;
    let diverged = null;
    if (upstream.ok) {
      const [behindRaw, aheadRaw] = upstream.stdout.trim().split(/\s+/);
      const behind = Number(behindRaw);
      const ahead = Number(aheadRaw);
      if (Number.isFinite(behind) && Number.isFinite(ahead)) {
        upstreamState = { behind, ahead };
        diverged = behind > 0 && ahead > 0;
      }
    }
    return {
      available: true,
      branch: branch.ok ? branch.stdout.trim() : null,
      head: head.ok ? head.stdout.trim() : null,
      dirty: {
        modified: modified.length,
        untracked: untracked.length,
        paths: dirtyLines.slice(0, 40),
        truncated: dirtyLines.length > 40,
      },
      upstream: upstreamState,
      diverged,
      note:
        upstreamState === null
          ? "No upstream tracking branch: ahead/behind are unknown, not zero."
          : null,
    };
  }

  /**
   * Is the local webview service alive, and is it the CURRENT build?
   *
   * WHY THE SECOND PROBE: `/health` is answered by every revision, so a healthy reply only
   * proves something is listening. The current source also defines `/api/kpis`; a 404 for it
   * means the process predates the code on disk. That is a different problem from "down", and
   * calling it "healthy" is how an operator restarts the wrong thing.
   *
   * @returns {Promise<Record<string, unknown>>}
   */
  async function readServiceState() {
    const health = await fetchJson(`${serviceUrl}/health`, 4_000);
    if (health.status === null) {
      return {
        url: serviceUrl,
        reachable: false,
        error: health.error,
        contract: null,
        stale: null,
        message:
          "The webview service did not answer at that URL. This is NOT an empty dashboard — " +
          "nothing is listening. Start it with: bun run serve",
      };
    }
    const contractProbe = await fetchJson(`${serviceUrl}/api/status`, 4_000);
    const healthBody =
      typeof health.body === "object" && health.body !== null
        ? health.body
        : {};
    const healthKeys = Object.keys(healthBody).length;
    const contract = {
      route: "/api/status",
      status: contractProbe.status,
      // The source defines /api/status. 404 therefore means the RUNNING process is older than
      // the checkout; 401/403 means the route exists but needs the admin bearer token.
      matchesCurrentSource:
        contractProbe.status !== 404 && contractProbe.status !== null,
      authGated: contractProbe.status === 401 || contractProbe.status === 403,
      // A second, independent signal: the current source's /health carries an `ingress`
      // field. Only use it when /health answered a JSON object at all.
      healthHasIngressField:
        healthKeys === 0 ? null : Object.hasOwn(healthBody, "ingress"),
    };
    const stale =
      contractProbe.status === 404 || contract.healthHasIngressField === false;
    return {
      url: serviceUrl,
      reachable: true,
      health: health.body,
      uptimeSeconds: healthBody.uptimeSeconds ?? null,
      contract,
      stale,
      message: stale
        ? "The service answers /health but does not match the current source " +
          (contractProbe.status === 404
            ? "(404 for /api/status, which the source defines)"
            : "(its /health lacks the source's ingress field)") +
          ": the running process is older than the checkout. Restart it: bun run serve"
        : null,
    };
  }

  /**
   * Build the "what next" hint from what was actually measured.
   *
   * @param {Record<string, any>} git
   * @param {Record<string, any>} service
   * @returns {string}
   */
  function nextStepFor(git, service) {
    if (!git.available) {
      return "repoPath is not a git checkout. Point the plugin's repoPath config at the sportsdesk-ops checkout.";
    }
    if (!service.reachable) {
      return "Start the local webview service: bun run serve (from the repo root), then re-run sportsdesk_status.";
    }
    if (service.stale === true) {
      return "The running service predates the current source. Restart it: bun run serve";
    }
    if (git.dirty && git.dirty.modified + git.dirty.untracked > 0) {
      return 'The working tree has uncommitted paths, and ci:local judges the working tree: run sportsdesk_dev with run:["ci"] before claiming a change works.';
    }
    return 'Run sportsdesk_dev with run:["ci"] to replay .github/workflows/ci.yml locally.';
  }

  // ---------------------------------------------------------------------------
  // sportsdesk_status — is the local desk stack alive, current, and clean?
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_status",
      description:
        "Read-only status of the local SportsDesk desk: the checkout (branch, HEAD, modified/" +
        "untracked counts, ahead/behind, diverged), and whether the local webview service is " +
        "reachable, healthy, and serving the CURRENT source (a healthy /health that 404s " +
        "/api/status, or lacks its ingress field, means the running process predates the " +
        "checkout). Returns a measured nextStep. It never reports an unreachable service as " +
        "an empty dashboard.",
      parameters: {
        type: "object",
        properties: {
          service: {
            type: "boolean",
            description:
              "Probe the local webview service. Defaults to true; false keeps the call to git + filesystem only.",
          },
        },
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        if (
          request.service !== undefined &&
          typeof request.service !== "boolean"
        ) {
          return invalidArguments("service must be a boolean.");
        }
        const git = await readGitState();
        const service =
          request.service === false
            ? { url: serviceUrl, reachable: null, skipped: true }
            : await readServiceState();
        const warnings = [];
        if (git.available && git.diverged) {
          warnings.push(
            "The branch has diverged: a plain push is rejected, and resetting to the upstream would discard local commits.",
          );
        }
        if (git.available && git.upstream === null) {
          warnings.push(
            "No upstream tracking branch: ahead/behind are unknown, not zero.",
          );
        }
        return {
          available: true,
          ok:
            git.available === true &&
            (service.reachable === true || service.reachable === null) &&
            service.stale !== true,
          checkedAt: new Date().toISOString(),
          repo: { path: repoPath, git },
          service,
          warnings,
          nextStep: nextStepFor(git, service),
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_data — what the desk has on disk, how big, how old
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_data",
      description:
        "Inventory and freshness of the datasets the desk keeps on disk (downline snapshot, " +
        "customer book, agent index/tree, live feeds, contests, scoreboard, analysis, customer " +
        "profiles, evidence ledger, published OpenAPI). For each: exists, bytes, mtime, age in " +
        "minutes, and record count when the JSON parses. Set dataset=<name> to inline one " +
        "dataset (refused above 120 KB). A missing file is MISSING, never 0 records; the " +
        "stale flag is a reported heuristic, not a verdict.",
      parameters: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            description:
              "One dataset name to inline: downline, customers, agent-index, agent-tree, live-bets, live-wagers, contests, scoreboard, analysis-cp-baseball, customer-profiles, game-admin-board, evidence-ledger, openapi.",
          },
        },
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        if (
          request.dataset !== undefined &&
          typeof request.dataset !== "string"
        ) {
          return invalidArguments("dataset must be a string.");
        }
        const requested = request.dataset;
        if (
          requested !== undefined &&
          !Object.hasOwn(DATASETS_BY_NAME, requested)
        ) {
          return {
            available: false,
            reason: "unknown_dataset",
            message: `Unknown dataset ${JSON.stringify(requested)}. Allowed: ${DATASETS.map((d) => d.name).join(", ")}.`,
          };
        }
        const entries = DATASETS.map((dataset) => {
          const absolute = `${repoPath}/${dataset.path}`;
          const stats = statFile(absolute);
          const entry = {
            name: dataset.name,
            path: dataset.path,
            role: dataset.role,
            required: dataset.required,
            ...stats,
            records: null,
            parseError: null,
            stale:
              stats.ageMinutes === null
                ? null
                : stats.ageMinutes > staleAfterMinutes,
          };
          if (stats.exists) {
            const parsed = parseJson(readText(absolute));
            if (!parsed.ok) {
              entry.parseError = "file exists but is not valid JSON";
            } else {
              entry.records = dataset.records(parsed.value);
            }
            if (requested === dataset.name) {
              const serialized = parsed.ok ? JSON.stringify(parsed.value) : "";
              if (serialized.length > MAX_INLINE_JSON) {
                entry.inlined = false;
                entry.note = `Refusing to inline ${serialized.length} characters; read it from ${absolute} with bash + jq instead.`;
              } else {
                entry.inlined = true;
                entry.data = parsed.value;
              }
            }
          }
          return entry;
        });
        const missingRequired = entries
          .filter((entry) => entry.required && !entry.exists)
          .map((entry) => entry.name);
        const parseErrors = entries
          .filter((entry) => entry.parseError !== null)
          .map((entry) => entry.name);
        const present = entries.filter((entry) => entry.exists);
        const byAge = present
          .slice()
          .sort((a, b) => (a.ageMinutes ?? 0) - (b.ageMinutes ?? 0));
        const warnings = [];
        if (missingRequired.length > 0) {
          warnings.push(
            `Required datasets missing: ${missingRequired.join(", ")}. Missing is not empty: the portal/evidence chain cannot be trusted without them.`,
          );
        }
        if (parseErrors.length > 0) {
          warnings.push(
            `Datasets present but unparseable: ${parseErrors.join(", ")}. A truncated write is not an empty dataset.`,
          );
        }
        return {
          available: true,
          ok: missingRequired.length === 0 && parseErrors.length === 0,
          checkedAt: new Date().toISOString(),
          repo: repoPath,
          staleAfterMinutes,
          datasets: entries,
          missingRequired,
          parseErrors,
          newest: byAge[0] ?? null,
          oldest: byAge[byAge.length - 1] ?? null,
          warnings,
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_downline — questions the downline snapshot can actually answer
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_downline",
      description:
        "Read-only questions over the checked-in SportsDesk downline snapshot " +
        "(sportsdesk_downline_data.json): summary (master meta: agents, active bettors, handle, " +
        "lifetime net hold, derived 50% shared balance), agent <id> (one sub-agent's rollup, " +
        "case-insensitive), top (agents ranked by net, volume or accounts). Every answer carries " +
        "the source path, mtime and age in minutes, because this is a snapshot, not a live F402 " +
        "feed. The CLI's winners/losers/leaderboard tables are hard-coded demo rows and are " +
        "deliberately not exposed here.",
      parameters: {
        type: "object",
        properties: {
          subcommand: {
            type: "string",
            description: "One of: summary, agent, top.",
          },
          agentId: {
            type: "string",
            description: 'Sub-agent id for subcommand "agent", e.g. BIGDAD.',
          },
          limit: {
            type: "number",
            description: 'Rows for "top" (1-100, default 10).',
          },
          sortBy: {
            type: "string",
            description: 'Sort key for "top": net (default), volume, accounts.',
          },
        },
        required: ["subcommand"],
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        if (typeof request.subcommand !== "string") {
          return invalidArguments(
            "subcommand must be one of: summary, agent, top.",
          );
        }
        const subcommand = request.subcommand;
        const allowed = ["summary", "agent", "top"];
        if (!allowed.includes(subcommand)) {
          return {
            available: false,
            reason: "unknown_subcommand",
            message: `Unknown subcommand ${JSON.stringify(subcommand)}. Allowed: ${allowed.join(", ")}.`,
          };
        }
        const sourcePath = `${repoPath}/sportsdesk_downline_data.json`;
        const stats = statFile(sourcePath);
        const parsed = parseJson(readText(sourcePath));
        if (!stats.exists || !parsed.ok) {
          return {
            available: false,
            reason: stats.exists ? "snapshot_unparseable" : "snapshot_missing",
            message: stats.exists
              ? `${sourcePath} exists but does not parse as JSON. This is NOT an empty downline.`
              : `${sourcePath} does not exist. This is NOT an empty downline — no agents were measured.`,
            source: { path: "sportsdesk_downline_data.json", ...stats },
          };
        }
        const snapshot = parsed.value ?? {};
        const meta = snapshot.meta ?? {};
        const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
        const source = {
          path: "sportsdesk_downline_data.json",
          ...stats,
          note: "Checked-in snapshot; not a live F402 feed.",
        };
        if (subcommand === "summary") {
          const netHold = Number(meta.total_lifetime_net_hold);
          return {
            available: true,
            ok: true,
            subcommand,
            source,
            meta,
            derived: {
              agentSharedBalanceUSD: Number.isFinite(netHold)
                ? Math.abs(netHold) * 0.5
                : null,
              note: "50% shared balance is derived from |lifetime net hold| with the same rule as the CLI summary.",
            },
          };
        }
        if (subcommand === "agent") {
          const wanted =
            typeof request.agentId === "string" ? args.agentId.trim() : "";
          if (wanted === "") {
            return {
              available: false,
              reason: "invalid_agent_id",
              message:
                'subcommand "agent" requires agentId (a non-empty string).',
            };
          }
          const match = agents.find(
            (agent) =>
              String(agent?.agent ?? "").toUpperCase() === wanted.toUpperCase(),
          );
          if (match === undefined) {
            return {
              available: true,
              ok: true,
              subcommand,
              found: false,
              agentId: wanted,
              source,
              message: `No sub-agent ${JSON.stringify(wanted)} in the snapshot (${agents.length} agents).`,
            };
          }
          return {
            available: true,
            ok: true,
            subcommand,
            found: true,
            agentId: match.agent,
            source,
            agent: match,
          };
        }
        const sortBy = request.sortBy ?? "net";
        const sorters = Object.assign(Object.create(null), {
          net: (agent) => Number(agent?.lifetime_net),
          volume: (agent) => Number(agent?.sports_vol),
          accounts: (agent) => Number(agent?.total_accounts),
        });
        if (!Object.hasOwn(sorters, sortBy)) {
          return {
            available: false,
            reason: "unknown_sort",
            message: `Unknown sortBy ${JSON.stringify(sortBy)}. Allowed: net, volume, accounts.`,
          };
        }
        const requestedLimit = request.limit ?? 10;
        if (
          typeof requestedLimit !== "number" ||
          !Number.isInteger(requestedLimit) ||
          requestedLimit < 1 ||
          requestedLimit > 100
        ) {
          return {
            available: false,
            reason: "invalid_limit",
            message: "limit must be an integer from 1 to 100.",
          };
        }
        const sorter = sorters[sortBy];
        const ranked = agents
          .map((agent) => ({ agent, key: sorter(agent) }))
          .filter((row) => Number.isFinite(row.key))
          .sort((a, b) => b.key - a.key)
          .slice(0, requestedLimit)
          .map((row) => row.agent);
        return {
          available: true,
          ok: true,
          subcommand,
          sortBy,
          limit: requestedLimit,
          source,
          agents: ranked,
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_customer — counts and rankings DERIVED from the customer book
  // ---------------------------------------------------------------------------
  ctx.tools.register(
    defineReadTool({
      name: "sportsdesk_customer",
      description:
        "Read-only questions over the enriched customer book " +
        "(enriched_customers_full.json). Every number is DERIVED from that file at call " +
        "time — customer count, ticket count, volume, net, CLV and sharp/churn rankings — " +
        "nothing about how many customers or bets exist is checked in. Reports: " +
        '"summary" (derived totals, status/context/churn-mode counts, per-league risk from ' +
        'the sampled tickets), "top" (rank by net, volume, clv, sharp or churn), "lookup" ' +
        '(one customer_id, case-insensitive, with ticket-derived stats), "search" ' +
        "(substring over ids, agent, context and churn mode). The answer carries the source " +
        "path, mtime and age; a missing file is MISSING, not an empty book. Note: " +
        "recent_tickets is a per-customer SAMPLE, while lifetime_* fields are the full rollup. " +
        '"top" accepts window="lifetime" (default) or "7d" for net/volume rankings; ' +
        '"subsport" derives per-league (or per-market) ROI, win rate and CLV for the CURATED ' +
        "customer-book cohort (not platform-wide) from the sampled tickets and their customers. " +
        "clv/sharp/churn exist only in the lifetime rollup. " +
        '"sharp" returns the DERIVED sharp audit: customers at or above minSharp ' +
        '(default 70) or with positive CLV, ranked by sharp score. "agent" rolls the book ' +
        "up per agent (customers, tickets, volume, net, CLV, sharp, churn), optionally " +
        'filtered by agentId. "profile" returns deep intelligence for one customerId: ' +
        "cohort percentile ranks (volume, net, CLV, sharp, churn, hold, wager limit, delay), " +
        "sampled-ticket behavior (risk distribution, ROI, win rate, leagues, markets, " +
        "channels, UTC hour histogram, days since the last sampled ticket), agent-peer " +
        "position, shared-ip_subnet peers and derived flags, with the cohort p90 cutoffs and " +
        'flag definitions returned. "signals" ranks cohort-wide derived signals (sharp money, ' +
        "high churn, whales, book-profitable, dormant, multi-account networks) and returns " +
        'the cutoff each rule used. "compare" places 2-5 customerIds side by side using the ' +
        "same derived profile. All ranks/cutoffs are recomputed from the book at call time.",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description: "One of: summary, top, lookup, search.",
          },
          customerId: {
            type: "string",
            description: 'Customer id for reports "lookup" and "profile".',
          },
          customerIds: {
            type: "array",
            items: { type: "string" },
            description:
              'Customer ids for report "compare" (2-5 ids; missing ids are reported, not thrown).',
          },
          agentId: {
            type: "string",
            description: 'Filter "agent" (and market reports) to one agent id.',
          },
          q: {
            type: "string",
            description: 'Substring for report "search".',
          },
          sortBy: {
            type: "string",
            description:
              'Sort key for "top": net (default), volume, clv, sharp, churn.',
          },
          window: {
            type: "string",
            description:
              'For "top": lifetime (default) or 7d. The 7d window ranks net and volume only.',
          },
          minSharp: {
            type: "number",
            description:
              'For "sharp": sharp_score cutoff, 0-100 (default 70). Positive CLV also qualifies.',
          },
          dimension: {
            type: "string",
            description:
              'For "subsport": "league" (default) or "market" — the outcome-bearing dimension of the sampled tickets.',
          },
          limit: {
            type: "number",
            description: "Rows for list reports (1-100, default 10).",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        const reports = [
          "summary",
          "top",
          "lookup",
          "search",
          "sharp",
          "agent",
          "subsport",
          "profile",
          "signals",
          "compare",
        ];
        if (
          typeof request.report !== "string" ||
          !reports.includes(request.report)
        ) {
          return {
            available: false,
            reason: "unknown_report",
            message: `Unknown report ${JSON.stringify(request.report)}. Allowed: ${reports.join(", ")}.`,
          };
        }
        const limit = request.limit ?? 10;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        ) {
          return invalidArguments("limit must be an integer from 1 to 100.");
        }
        const absolute = `${repoPath}/${CUSTOMER_BOOK.path}`;
        const stats = statFile(absolute);
        const parsed = parseJson(readText(absolute));
        if (!stats.exists || !parsed.ok || !Array.isArray(parsed.value)) {
          return {
            available: false,
            reason: stats.exists ? "book_unparseable" : "book_missing",
            message: stats.exists
              ? `${absolute} exists but is not a JSON array. This is NOT an empty customer book.`
              : `${absolute} does not exist. This is NOT an empty customer book — no customer was measured.`,
            source: { path: CUSTOMER_BOOK.path, ...stats },
          };
        }
        const rows = parsed.value;
        const source = {
          path: CUSTOMER_BOOK.path,
          role: CUSTOMER_BOOK.role,
          ...stats,
          note: "Derived at call time from the checked-in customer book; not a live F402 feed.",
        };
        if (request.report === "summary") {
          const tickets = rows.flatMap((row) =>
            Array.isArray(row?.recent_tickets) ? row.recent_tickets : [],
          );
          const results = countField(tickets, "result");
          const leagueRisk = new Map();
          for (const ticket of tickets) {
            const league = String(ticket?.league ?? "UNKNOWN");
            const risk = Number(ticket?.risk_usd);
            leagueRisk.set(
              league,
              (leagueRisk.get(league) ?? 0) +
                (Number.isFinite(risk) ? risk : 0),
            );
          }
          const byLeague = [...leagueRisk.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, limit)
            .map(([league, riskUsd]) => ({ league, riskUsd }));
          const lifetimeVolumeUsd = sumField(rows, "lifetime_volume_usd");
          const lifetimeNetUsd = sumField(rows, "lifetime_net_usd");
          return {
            available: true,
            ok: true,
            report: request.report,
            source,
            derived: {
              customers: rows.length,
              activeCustomers: rows.filter((row) => row?.status === "Active")
                .length,
              totalRecentTickets: tickets.length,
              recentResults: results,
              recentRiskUsd: sumField(tickets, "risk_usd"),
              recentNetUsd: sumField(tickets, "net_usd"),
              lifetimeVolumeUsd,
              lifetimeNetUsd,
              lifetimeHoldPct:
                lifetimeVolumeUsd === 0
                  ? null
                  : (lifetimeNetUsd / lifetimeVolumeUsd) * 100,
              sports7dVolumeUsd: sumField(rows, "sports_7d_volume_usd"),
              sports7dNetUsd: sumField(rows, "sports_7d_net_usd"),
              avgClvBps: meanField(rows, "clv_bps"),
              avgSharpScore: meanField(rows, "sharp_score"),
              avgChurnHazard: meanField(rows, "churn_hazard"),
              byStatus: countField(rows, "status"),
              byContext: countField(rows, "context_type"),
              byChurnMode: countField(rows, "churn_mode"),
              byLeague,
            },
            note: "recent_tickets is a per-customer sample; lifetime_* fields are the full rollup.",
          };
        }
        if (request.report === "top") {
          const window =
            typeof request.window === "string" ? request.window : "lifetime";
          const windows = Object.assign(Object.create(null), {
            lifetime: {
              net: "lifetime_net_usd",
              volume: "lifetime_volume_usd",
            },
            "7d": { net: "sports_7d_net_usd", volume: "sports_7d_volume_usd" },
          });
          if (!Object.hasOwn(windows, window)) {
            return invalidArguments(
              "window must be one of: lifetime (default), 7d.",
            );
          }
          const sortBy = request.sortBy ?? "net";
          if (window === "7d" && ["clv", "sharp", "churn"].includes(sortBy)) {
            return invalidArguments(
              'clv/sharp/churn exist only in the lifetime rollup; use window "lifetime" for them.',
            );
          }
          const sortKeys = Object.assign(Object.create(null), {
            net: windows[window].net,
            volume: windows[window].volume,
            clv: "clv_bps",
            sharp: "sharp_score",
            churn: "churn_hazard",
          });
          if (!Object.hasOwn(sortKeys, sortBy)) {
            return {
              available: false,
              reason: "unknown_sort",
              message: `Unknown sortBy ${JSON.stringify(sortBy)}. Allowed: net, volume, clv, sharp, churn.`,
            };
          }
          const key = sortKeys[sortBy];
          const ranked = rows
            .slice()
            .sort(
              (left, right) =>
                Number(right?.[key] ?? Number.NEGATIVE_INFINITY) -
                Number(left?.[key] ?? Number.NEGATIVE_INFINITY),
            )
            .slice(0, limit)
            .map(slimCustomer);
          return {
            available: true,
            ok: true,
            report: request.report,
            sortBy,
            window,
            limit,
            returnable: Math.min(limit, rows.length),
            totalCustomers: rows.length,
            source,
            customers: ranked,
          };
        }
        if (request.report === "subsport") {
          const dimension =
            typeof request.dimension === "string"
              ? request.dimension
              : "league";
          if (dimension !== "league" && dimension !== "market") {
            return invalidArguments(
              'dimension must be "league" (default) or "market".',
            );
          }
          const buckets = new Map();
          for (const row of rows) {
            const tickets = Array.isArray(row?.recent_tickets)
              ? row.recent_tickets
              : [];
            const customerId = String(row?.customer_id ?? "UNKNOWN");
            const profile = {
              clv: Number(row?.clv_bps),
              sharp: Number(row?.sharp_score),
              churn: Number(row?.churn_hazard),
              lifetimeVolume: Number(row?.lifetime_volume_usd),
              lifetimeNet: Number(row?.lifetime_net_usd),
            };
            for (const ticket of tickets) {
              const key = String(ticket?.[dimension] ?? "UNKNOWN");
              const bucket = buckets.get(key) ?? {
                tickets: 0,
                riskUsd: 0,
                netUsd: 0,
                wins: 0,
                decisive: 0,
                customers: new Map(),
              };
              bucket.tickets += 1;
              const risk = Number(ticket?.risk_usd);
              const net = Number(ticket?.net_usd);
              if (Number.isFinite(risk)) bucket.riskUsd += risk;
              if (Number.isFinite(net)) bucket.netUsd += net;
              const result = ticket?.result;
              if (result === "WIN" || result === "LOSS") {
                bucket.decisive += 1;
                if (result === "WIN") bucket.wins += 1;
              }
              if (!bucket.customers.has(customerId)) {
                bucket.customers.set(customerId, profile);
              }
              buckets.set(key, bucket);
            }
          }
          const meanOf = (values) => {
            const finite = values.filter((value) => Number.isFinite(value));
            return finite.length === 0
              ? null
              : finite.reduce((a, b) => a + b, 0) / finite.length;
          };
          const lifetimeTotals = (bucket) => {
            let volumeUsd = 0;
            let netUsd = 0;
            for (const profile of bucket.customers.values()) {
              if (Number.isFinite(profile.lifetimeVolume)) {
                volumeUsd += profile.lifetimeVolume;
              }
              if (Number.isFinite(profile.lifetimeNet)) {
                netUsd += profile.lifetimeNet;
              }
            }
            return {
              volumeUsd,
              netUsd,
              roiPct: volumeUsd === 0 ? null : (netUsd / volumeUsd) * 100,
            };
          };
          const subsports = [...buckets.entries()]
            .map(([key, bucket]) => {
              const lifetime = lifetimeTotals(bucket);
              return {
                [dimension]: key,
                customers: bucket.customers.size,
                sample: {
                  tickets: bucket.tickets,
                  riskUsd: bucket.riskUsd,
                  netUsd: bucket.netUsd,
                  roiPct:
                    bucket.riskUsd === 0
                      ? null
                      : (bucket.netUsd / bucket.riskUsd) * 100,
                  winPct:
                    bucket.decisive === 0
                      ? null
                      : (bucket.wins / bucket.decisive) * 100,
                },
                lifetime,
                avgClvBps: meanOf(
                  [...bucket.customers.values()].map((entry) => entry.clv),
                ),
                avgSharpScore: meanOf(
                  [...bucket.customers.values()].map((entry) => entry.sharp),
                ),
                avgChurnHazard: meanOf(
                  [...bucket.customers.values()].map((entry) => entry.churn),
                ),
              };
            })
            .sort((left, right) => right.sample.riskUsd - left.sample.riskUsd)
            .slice(0, limit);
          const cohortLifetimeVolumeUsd = rows.reduce((total, row) => {
            const value = Number(row?.lifetime_volume_usd);
            return total + (Number.isFinite(value) ? value : 0);
          }, 0);
          const cohortLifetimeNetUsd = rows.reduce((total, row) => {
            const value = Number(row?.lifetime_net_usd);
            return total + (Number.isFinite(value) ? value : 0);
          }, 0);
          return {
            available: true,
            ok: true,
            report: request.report,
            dimension,
            cohort: "curated-profiles",
            cohortNote:
              "The customer book is a curated fixture, not the full downline " +
              "(docs/customer-poly-bridge.md), and it is mixed: both positive and negative " +
              "lifetime net. ROI is reported TWICE per row: `sample` covers the per-customer " +
              "5-ticket window and is NOT representative of lifetime returns; `lifetime` sums " +
              "the full rollup for the same customers. Neither is platform-wide. The sample " +
              "carries no parlay-leg marker, so win % treats each sampled ticket as one bet.",
            cohortLifetime: {
              customers: rows.length,
              volumeUsd: cohortLifetimeVolumeUsd,
              netUsd: cohortLifetimeNetUsd,
              roiPct:
                cohortLifetimeVolumeUsd === 0
                  ? null
                  : (cohortLifetimeNetUsd / cohortLifetimeVolumeUsd) * 100,
            },
            source,
            subsports,
          };
        }
        if (request.report === "agent") {
          const wanted =
            typeof request.agentId === "string"
              ? request.agentId.trim().toUpperCase()
              : "";
          const byAgent = new Map();
          for (const row of rows) {
            const key = String(row?.agent_id ?? "UNKNOWN");
            if (wanted !== "" && key.toUpperCase() !== wanted) continue;
            const group = byAgent.get(key) ?? { customers: [], tickets: 0 };
            group.customers.push(row);
            group.tickets += Array.isArray(row?.recent_tickets)
              ? row.recent_tickets.length
              : 0;
            byAgent.set(key, group);
          }
          const distinctAgents = new Set(
            rows.map((row) => String(row?.agent_id ?? "UNKNOWN")),
          ).size;
          if (byAgent.size === 0) {
            return {
              available: true,
              ok: true,
              report: request.report,
              found: false,
              agentId: request.agentId ?? "",
              totalAgents: distinctAgents,
              source,
              message: `No customers under agent ${JSON.stringify(request.agentId ?? "")} in the book.`,
            };
          }
          const agents = [...byAgent.entries()]
            .map(([agentId, group]) => ({
              agent_id: agentId,
              customers: group.customers.length,
              totalRecentTickets: group.tickets,
              lifetimeVolumeUsd: sumField(
                group.customers,
                "lifetime_volume_usd",
              ),
              lifetimeNetUsd: sumField(group.customers, "lifetime_net_usd"),
              avgClvBps: meanField(group.customers, "clv_bps"),
              avgSharpScore: meanField(group.customers, "sharp_score"),
              avgChurnHazard: meanField(group.customers, "churn_hazard"),
              byContext: countField(group.customers, "context_type"),
              byChurnMode: countField(group.customers, "churn_mode"),
            }))
            .sort((left, right) => right.lifetimeNetUsd - left.lifetimeNetUsd)
            .slice(0, limit);
          return {
            available: true,
            ok: true,
            report: request.report,
            totalAgents: distinctAgents,
            returned: agents.length,
            source,
            agents,
          };
        }
        if (request.report === "sharp") {
          const threshold = request.minSharp ?? 70;
          if (
            typeof threshold !== "number" ||
            !Number.isFinite(threshold) ||
            threshold < 0 ||
            threshold > 100
          ) {
            return invalidArguments("minSharp must be a number from 0 to 100.");
          }
          const candidates = rows.filter(
            (row) =>
              Number(row?.sharp_score ?? Number.NEGATIVE_INFINITY) >=
                threshold || Number(row?.clv_bps ?? 0) > 0,
          );
          const ranked = candidates
            .slice()
            .sort(
              (left, right) =>
                Number(right?.sharp_score ?? 0) -
                Number(left?.sharp_score ?? 0),
            )
            .slice(0, limit)
            .map(slimCustomer);
          return {
            available: true,
            ok: true,
            report: request.report,
            threshold,
            bookCustomers: rows.length,
            candidates: candidates.length,
            returned: ranked.length,
            source,
            customers: ranked,
          };
        }
        if (request.report === "profile") {
          const wanted =
            typeof request.customerId === "string"
              ? request.customerId.trim()
              : "";
          if (wanted === "") {
            return invalidArguments(
              'report "profile" requires customerId (a non-empty string).',
            );
          }
          const match = rows.find(
            (row) =>
              String(row?.customer_id ?? "").toUpperCase() ===
              wanted.toUpperCase(),
          );
          if (match === undefined) {
            return {
              available: true,
              ok: true,
              report: request.report,
              found: false,
              customerId: wanted,
              totalCustomers: rows.length,
              source,
              message: `No customer ${JSON.stringify(wanted)} in the book (${rows.length} customers).`,
            };
          }
          const cohort = buildCustomerCohort(rows);
          const cutoffs = cohortCutoffs(cohort);
          return {
            available: true,
            ok: true,
            report: request.report,
            found: true,
            customerId: match.customer_id,
            totalCustomers: rows.length,
            source,
            ...customerProfile(match, cohort, cutoffs),
            cutoffs,
            flagDefinitions: {
              topDecile: "value >= the cohort p90 for the same field",
              highChurn: "churn_hazard >= the cohort p90",
              dormant:
                "days since the last sampled ticket >= the cohort p90 for staleness",
              sharedNetworkIdentity:
                "another customer in the book shares this ip_subnet",
            },
            caveats:
              "recent_tickets is a per-customer sample; lifetime_* fields are the full " +
              "rollup. The book is a curated cohort, not the platform-wide customer base. " +
              "Ranks, cutoffs and days-since are computed from this book at call time.",
          };
        }
        if (request.report === "signals") {
          const cohort = buildCustomerCohort(rows);
          const cutoffs = cohortCutoffs(cohort);
          const ticketTotal = rows.reduce(
            (total, row) =>
              total +
              (Array.isArray(row?.recent_tickets)
                ? row.recent_tickets.length
                : 0),
            0,
          );
          const ranked = (predicate, key) =>
            rows
              .filter(predicate)
              .sort(
                (left, right) =>
                  (finiteNumber(right?.[key]) ?? Number.NEGATIVE_INFINITY) -
                  (finiteNumber(left?.[key]) ?? Number.NEGATIVE_INFINITY),
              );
          const asSignal = (rule, predicate, key) => {
            const matched = ranked(predicate, key);
            return {
              rule,
              matched: matched.length,
              returned: Math.min(limit, matched.length),
              customers: matched.slice(0, limit).map(slimCustomer),
            };
          };
          const clusters = [...cohort.bySubnet.entries()]
            .filter(([, customers]) => customers >= 2)
            .sort((left, right) => right[1] - left[1]);
          return {
            available: true,
            ok: true,
            report: request.report,
            cohort: { customers: rows.length, tickets: ticketTotal },
            cutoffs,
            signals: {
              sharpMoney: asSignal(
                cutoffs.sharpP90 === null
                  ? "clv_bps > 0"
                  : `clv_bps > 0 or sharp_score >= ${cutoffs.sharpP90}`,
                (row) =>
                  Number(row?.clv_bps ?? 0) > 0 ||
                  (finiteNumber(row?.sharp_score) ??
                    Number.NEGATIVE_INFINITY) >=
                    (cutoffs.sharpP90 ?? Number.POSITIVE_INFINITY),
                "clv_bps",
              ),
              highChurn: asSignal(
                cutoffRule("churn_hazard", cutoffs.churnP90),
                (row) => {
                  const churn = finiteNumber(row?.churn_hazard);
                  return (
                    churn !== null &&
                    cutoffs.churnP90 !== null &&
                    churn >= cutoffs.churnP90
                  );
                },
                "churn_hazard",
              ),
              whales: asSignal(
                cutoffRule("lifetime_volume_usd", cutoffs.volumeP90),
                (row) => {
                  const volume = finiteNumber(row?.lifetime_volume_usd);
                  return (
                    volume !== null &&
                    cutoffs.volumeP90 !== null &&
                    volume >= cutoffs.volumeP90
                  );
                },
                "lifetime_volume_usd",
              ),
              bookProfitable: asSignal(
                cutoffRule("hold_pct", cutoffs.holdP90),
                (row) => {
                  const hold = finiteNumber(row?.hold_pct);
                  return (
                    hold !== null &&
                    cutoffs.holdP90 !== null &&
                    hold >= cutoffs.holdP90
                  );
                },
                "hold_pct",
              ),
              dormant: asSignal(
                cutoffRule(
                  "days since the last sampled ticket",
                  cutoffs.dormantDaysP90,
                ),
                (row) => {
                  const days = sampleOf(row, cohort).daysSinceLastTicket;
                  return (
                    days !== null &&
                    cutoffs.dormantDaysP90 !== null &&
                    days >= cutoffs.dormantDaysP90
                  );
                },
                "lifetime_volume_usd",
              ),
            },
            multiAccountNetworks: {
              rule: "two or more customers share an ip_subnet",
              matched: clusters.length,
              returned: Math.min(limit, clusters.length),
              networks: clusters.slice(0, limit).map(([subnet, customers]) => ({
                customers,
                customerIds: rows
                  .filter(
                    (row) => String(row?.ip_subnet ?? "").trim() === subnet,
                  )
                  .map((row) => row?.customer_id ?? null),
              })),
            },
            note:
              "Every rule is derived from the book at call time and states its cutoff. " +
              "A null cutoff means the book has no finite value for that field. Signals " +
              "are descriptive, not a recommendation.",
          };
        }
        if (request.report === "compare") {
          const ids = Array.isArray(request.customerIds)
            ? request.customerIds.filter(
                (id) => typeof id === "string" && id.trim() !== "",
              )
            : [];
          if (ids.length < 2 || ids.length > 5) {
            return invalidArguments(
              'report "compare" requires customerIds with 2 to 5 customer ids.',
            );
          }
          const cohort = buildCustomerCohort(rows);
          const cutoffs = cohortCutoffs(cohort);
          const found = [];
          const missing = [];
          for (const id of ids) {
            const match = rows.find(
              (row) =>
                String(row?.customer_id ?? "").toUpperCase() ===
                id.trim().toUpperCase(),
            );
            if (match === undefined) missing.push(id);
            else found.push(match);
          }
          if (found.length < 2) {
            return {
              available: true,
              ok: true,
              report: request.report,
              found: false,
              missing,
              totalCustomers: rows.length,
              source,
              message: `Only ${found.length} of the requested ids are in the book; compare needs at least 2.`,
            };
          }
          return {
            available: true,
            ok: true,
            report: request.report,
            compared: found.length,
            missing,
            totalCustomers: rows.length,
            source,
            cutoffs,
            customers: found.map((row) =>
              customerProfile(row, cohort, cutoffs),
            ),
            note: 'Same derived profile as report "profile"; deltas are for the caller to read off the shared cohort ranks.',
          };
        }
        if (request.report === "lookup") {
          const wanted =
            typeof request.customerId === "string"
              ? request.customerId.trim()
              : "";
          if (wanted === "") {
            return invalidArguments(
              'report "lookup" requires customerId (a non-empty string).',
            );
          }
          const match = rows.find(
            (row) =>
              String(row?.customer_id ?? "").toUpperCase() ===
              wanted.toUpperCase(),
          );
          if (match === undefined) {
            return {
              available: true,
              ok: true,
              report: request.report,
              found: false,
              customerId: wanted,
              totalCustomers: rows.length,
              source,
              message: `No customer ${JSON.stringify(wanted)} in the book (${rows.length} customers).`,
            };
          }
          const tickets = Array.isArray(match.recent_tickets)
            ? match.recent_tickets
            : [];
          const placedAt = tickets
            .map((ticket) => String(ticket?.placed_at ?? ""))
            .filter((value) => value !== "")
            .sort();
          return {
            available: true,
            ok: true,
            report: request.report,
            found: true,
            customerId: match.customer_id,
            source,
            customer: match,
            ticketDerived: {
              count: tickets.length,
              riskUsd: sumField(tickets, "risk_usd"),
              netUsd: sumField(tickets, "net_usd"),
              results: countField(tickets, "result"),
              leagues: countField(tickets, "league"),
              firstPlacedAt: placedAt[0] ?? null,
              lastPlacedAt: placedAt[placedAt.length - 1] ?? null,
            },
          };
        }
        const needle = typeof request.q === "string" ? request.q.trim() : "";
        if (needle === "") {
          return invalidArguments(
            'report "search" requires q (a non-empty substring).',
          );
        }
        const upper = needle.toUpperCase();
        const fields = [
          "customer_id",
          "agent_id",
          "master_agent",
          "context_type",
          "churn_mode",
          "status",
        ];
        const matches = rows.filter((row) =>
          fields.some((field) =>
            String(row?.[field] ?? "")
              .toUpperCase()
              .includes(upper),
          ),
        );
        return {
          available: true,
          ok: true,
          report: request.report,
          query: request.q,
          matched: matches.length,
          returned: Math.min(limit, matches.length),
          source,
          customers: matches.slice(0, limit).map(slimCustomer),
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_markets — staged combo / CLV / cross-domain reports
  // ---------------------------------------------------------------------------
  ctx.tools.register(
    defineReadTool({
      name: "sportsdesk_markets",
      description:
        "Read-only reports over the staged dist/ market artifacts. Reports: " +
        '"combo-uniqueness" (how many real combos survive each identity gate, the dedupe ' +
        'result, and unresolved-leg diagnostics), "bridge" (customer-to-Polymarket wallet ' +
        "attribution: coverage, value, leads ranked by priority USD, quarantined rows), and " +
        '"backtest" (4-week parlay counterfactual: combo families with average CLV bps, guard ' +
        "attribution, customer leaderboard). Every answer carries the artifact's " +
        "generatedAtIso, mtime and age: these are staged reports, not live feeds. Unknown " +
        "report names are refused; limit caps each returned list (1-100, default 10).",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description: "One of: combo-uniqueness, bridge, backtest.",
          },
          limit: {
            type: "number",
            description: "Rows per returned list (1-100, default 10).",
          },
          agentId: {
            type: "string",
            description:
              "Filter bridge leads and the backtest leaderboard to one agent.",
          },
          verdict: {
            type: "string",
            description: "Filter bridge leads by verdict, e.g. POLY_ONLY_UP.",
          },
          sport: {
            type: "string",
            description:
              "Filter the backtest combo families by sport, e.g. CFB.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        if (
          typeof request.report !== "string" ||
          !Object.hasOwn(MARKET_REPORTS, request.report)
        ) {
          return {
            available: false,
            reason: "unknown_report",
            message: `Unknown report ${JSON.stringify(request.report)}. Allowed: ${Object.keys(MARKET_REPORTS).join(", ")}.`,
          };
        }
        const limit = request.limit ?? 10;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        ) {
          return invalidArguments("limit must be an integer from 1 to 100.");
        }
        const spec = MARKET_REPORTS[request.report];
        const absolute = `${repoPath}/${spec.path}`;
        const stats = statFile(absolute);
        const parsed = parseJson(readText(absolute));
        if (!stats.exists || !parsed.ok) {
          return {
            available: false,
            reason: stats.exists ? "artifact_unparseable" : "artifact_missing",
            message: stats.exists
              ? `${absolute} exists but does not parse as JSON. This is NOT an empty report.`
              : `${absolute} does not exist. This is NOT an empty report — the artifact has not been staged. Run ./bin/dx stage from the repo root.`,
            source: { path: spec.path, ...stats },
          };
        }
        const data =
          typeof parsed.value === "object" && parsed.value !== null
            ? parsed.value
            : {};
        const source = {
          path: spec.path,
          role: spec.role,
          ...stats,
          generatedAtIso:
            typeof data.generatedAtIso === "string"
              ? data.generatedAtIso
              : null,
          note: "Staged report, not a live feed. Regenerate with ./bin/dx stage.",
        };
        if (request.report === "combo-uniqueness") {
          const diagnostics =
            typeof data.diagnostics === "object" && data.diagnostics !== null
              ? data.diagnostics
              : {};
          const unresolved =
            typeof diagnostics.unresolved === "object" &&
            diagnostics.unresolved !== null
              ? diagnostics.unresolved
              : {};
          return {
            available: true,
            ok: true,
            report: request.report,
            source,
            index: data.index ?? null,
            walletsScanned: data.walletsScanned ?? null,
            gates: data.gates ?? null,
            dedupe: data.dedupe ?? null,
            chain: data.chain ?? null,
            diagnostics: {
              ...diagnostics,
              unresolved: {
                ...unresolved,
                top: topBy(unresolved.top, "combos", limit),
              },
            },
          };
        }
        if (request.report === "bridge") {
          let leads = data.leads;
          if (typeof request.verdict === "string" && request.verdict !== "") {
            leads = (Array.isArray(leads) ? leads : []).filter(
              (lead) =>
                String(lead?.verdict ?? "").toUpperCase() ===
                request.verdict.toUpperCase(),
            );
          }
          if (typeof request.agentId === "string" && request.agentId !== "") {
            leads = (Array.isArray(leads) ? leads : []).filter(
              (lead) =>
                String(lead?.agentId ?? "").toUpperCase() ===
                request.agentId.toUpperCase(),
            );
          }
          return {
            available: true,
            ok: true,
            report: request.report,
            source,
            evidence: data.evidence ?? null,
            coverage: data.coverage ?? null,
            value: data.value ?? null,
            leads: topBy(leads, "priorityUsd", limit),
            // `quarantined` is a COUNT in the current artifact and an ARRAY in an older one.
            // Reporting the number as `null` would turn 10 quarantined rows into "unknown",
            // which is exactly the missing-vs-zero confusion this plugin exists to avoid.
            quarantinedTotal:
              typeof data.quarantined === "number"
                ? data.quarantined
                : Array.isArray(data.quarantined)
                  ? data.quarantined.length
                  : null,
            quarantined: Array.isArray(data.quarantined)
              ? data.quarantined.slice(0, limit)
              : [],
          };
        }
        const totals = {};
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "object" && value !== null) continue;
          if (BACKTEST_META_KEYS.has(key)) continue;
          totals[key] = value;
        }
        return {
          available: true,
          ok: true,
          report: request.report,
          source,
          window: {
            startIso: data.windowStartIso ?? null,
            endIso: data.windowEndIso ?? null,
          },
          dataBasis: data.dataBasis ?? null,
          totals,
          weekly: Array.isArray(data.weeklyBreakdown)
            ? data.weeklyBreakdown
            : [],
          comboFamilies: topBy(
            filterBy(data.comboFamilyBreakdown, "sport", request.sport),
            "handleUsd",
            limit,
          ),
          guardAttribution: Array.isArray(data.guardAttribution)
            ? data.guardAttribution
            : [],
          customerLeaderboard: Array.isArray(data.customerLeaderboard)
            ? filterBy(
                data.customerLeaderboard,
                "agentId",
                request.agentId,
              ).slice(0, limit)
            : [],
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_ticker — the live bet ticker and pending report, derived
  // ---------------------------------------------------------------------------
  ctx.tools.register(
    defineReadTool({
      name: "sportsdesk_ticker",
      description:
        'Read-only, derived view of the bet ticker: "pending" (data/live-bets.json — the ' +
        "captured /Report/Pending snapshot: pending count, summed wagered/to-win, by sport, " +
        'sub-sport and wager type, plus the game rows) and "wagers" (data/live-wagers.json — ' +
        "the clipboard ticker rows: count, summed amount/to-win, by agent and wager type). " +
        "Every number is summed at call time; the answer carries the file's capturedAt/observedAt " +
        "and age, because a ticker is a point-in-time sample, not a live feed. Filters: agentId, " +
        "sport, subSport (pending only). limit caps each returned list.",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description: "One of: pending, wagers.",
          },
          agentId: {
            type: "string",
            description: "Filter rows to one agent id.",
          },
          sport: {
            type: "string",
            description:
              'Filter "pending" games (and parsed "wagers" sport) to one sport.',
          },
          subSport: {
            type: "string",
            description: 'Filter "pending" games to one sub-sport.',
          },
          limit: {
            type: "number",
            description: "Rows for the returned lists (1-100, default 10).",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        const reports = ["pending", "wagers", "reconcile"];
        if (
          typeof request.report !== "string" ||
          !reports.includes(request.report)
        ) {
          return {
            available: false,
            reason: "unknown_report",
            message: `Unknown report ${JSON.stringify(request.report)}. Allowed: ${reports.join(", ")}.`,
          };
        }
        const limit = request.limit ?? 10;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        ) {
          return invalidArguments("limit must be an integer from 1 to 100.");
        }
        const filter = (value) =>
          typeof value === "string" && value !== "" ? value.toUpperCase() : "";
        if (request.report === "pending") {
          const absolute = `${repoPath}/data/live-bets.json`;
          const stats = statFile(absolute);
          const parsed = parseJson(readText(absolute));
          if (
            !stats.exists ||
            !parsed.ok ||
            typeof parsed.value !== "object" ||
            parsed.value === null
          ) {
            return {
              available: false,
              reason: stats.exists ? "ticker_unparseable" : "ticker_missing",
              message: stats.exists
                ? `${absolute} exists but is not a JSON object. This is NOT an empty ticker.`
                : `${absolute} does not exist. This is NOT an empty ticker — no capture has run.`,
              source: { path: "data/live-bets.json", ...stats },
            };
          }
          const data = parsed.value;
          const games = Array.isArray(data.games) ? data.games : [];
          const wantedAgent = filter(request.agentId);
          const wantedSport = filter(request.sport);
          const wantedSub = filter(request.subSport);
          const filtered = games.filter(
            (game) =>
              (wantedAgent === "" ||
                String(game?.agent?.id ?? "").toUpperCase() === wantedAgent) &&
              (wantedSport === "" ||
                String(game?.sport ?? "").toUpperCase() === wantedSport) &&
              (wantedSub === "" ||
                String(game?.subSport ?? "").toUpperCase() === wantedSub),
          );
          const sum = (key) =>
            filtered.reduce((total, game) => {
              const value = Number(game?.[key]);
              return total + (Number.isFinite(value) ? value : 0);
            }, 0);
          const agentList = Array.isArray(data.agents?.agents)
            ? data.agents.agents
            : [];
          return {
            available: true,
            ok: true,
            report: request.report,
            scope: "agent-pending-report",
            scopeNote:
              "Agent /Report/Pending snapshot; DISJOINT from the clipboard ticker (data/live-wagers.json).",
            capturedAt: data.capturedAt ?? null,
            ageMinutes: stats.ageMinutes,
            source: {
              path: "data/live-bets.json",
              role: "Captured /Report/Pending snapshot.",
              ...stats,
              capturedAt: data.capturedAt ?? null,
              note: "Point-in-time capture, not a live feed.",
            },
            pendingCount: data.pendingCount ?? null,
            returnedGames: filtered.length,
            totalGames: games.length,
            wagered: sum("wagered"),
            toWin: sum("toWin"),
            bySport: countField(filtered, "sport"),
            bySubSport: countField(filtered, "subSport"),
            byWagerType: countField(filtered, "wagerType"),
            agents: {
              rows: agentList.slice(0, limit),
              count: agentList.length,
              unresolved: Array.isArray(data.agents?.unresolved)
                ? data.agents.unresolved.length
                : null,
              unassignedGames: data.agents?.unassignedGames ?? null,
              maxLevel: data.agents?.maxLevel ?? null,
              hierarchyLoaded: data.agents?.hierarchyLoaded ?? null,
            },
            games: filtered.slice(0, limit).map((game) => ({
              ticketNumber: game?.ticketNumber ?? null,
              customerID: game?.customerID ?? null,
              agentId: game?.agent?.id ?? null,
              status: game?.status ?? null,
              sport: game?.sport ?? null,
              subSport: game?.subSport ?? null,
              period: game?.period ?? null,
              wagerType: game?.wagerType ?? null,
              chosenTeam: game?.chosenTeam ?? null,
              wagered: game?.wagered ?? null,
              toWin: game?.toWin ?? null,
              gameDateTime: game?.gameDateTime ?? null,
            })),
          };
        }
        if (request.report === "reconcile") {
          const pendingPath = `${repoPath}/data/live-bets.json`;
          const wagersPath = `${repoPath}/data/live-wagers.json`;
          const pStats = statFile(pendingPath);
          const wStats = statFile(wagersPath);
          const pParsed = parseJson(readText(pendingPath));
          const wParsed = parseJson(readText(wagersPath));
          const pGames =
            pParsed.ok && Array.isArray(pParsed.value?.games)
              ? pParsed.value.games
              : [];
          const wList =
            wParsed.ok && Array.isArray(wParsed.value?.LIST)
              ? wParsed.value.LIST
              : [];
          const sumNum = (rows, key) =>
            rows.reduce((total, row) => {
              const value = Number(row?.[key]);
              return total + (Number.isFinite(value) ? value : 0);
            }, 0);
          const pendingWagered = sumNum(pGames, "wagered");
          const wagersWagered = sumNum(wList, "AmountWagered");
          const pendingKeys = new Set(
            pGames.map((game) => String(game?.ticketNumber ?? "")),
          );
          const wagerKeys = new Set(
            wList.map((wager) => String(wager?.WagerNumber ?? "")),
          );
          let overlap = 0;
          for (const key of pendingKeys) {
            if (key !== "" && wagerKeys.has(key)) overlap += 1;
          }
          return {
            available: true,
            ok: true,
            report: request.report,
            scope: "disjoint",
            verdict: "disjoint",
            note:
              "The two feeds are DISJOINT sources: pending is the agent /Report/Pending snapshot " +
              "and wagers is a clipboard paste sample, with different keyspaces (ticketNumber vs " +
              "WagerNumber) and a large magnitude gap in wagered. Do not join them.",
            pending: {
              capturedAt: pParsed.ok
                ? (pParsed.value?.capturedAt ?? null)
                : null,
              ageMinutes: pStats.ageMinutes,
              tickets: pGames.length,
              wagered: pendingWagered,
              toWin: sumNum(pGames, "toWin"),
            },
            wagers: {
              observedAt: wParsed.ok
                ? (wParsed.value?.observedAt ?? null)
                : null,
              ageMinutes: wStats.ageMinutes,
              tickets: wList.length,
              wagered: wagersWagered,
              toWin: sumNum(wList, "ToWinAmount"),
            },
            overlapKeys: overlap,
            magnitudeGapWagered:
              wagersWagered === 0 ? null : pendingWagered / wagersWagered,
            captureGapMinutes:
              pStats.ageMinutes === null || wStats.ageMinutes === null
                ? null
                : Math.abs(pStats.ageMinutes - wStats.ageMinutes),
          };
        }
        const absolute = `${repoPath}/data/live-wagers.json`;
        const stats = statFile(absolute);
        const parsed = parseJson(readText(absolute));
        if (
          !stats.exists ||
          !parsed.ok ||
          typeof parsed.value !== "object" ||
          parsed.value === null
        ) {
          return {
            available: false,
            reason: stats.exists ? "ticker_unparseable" : "ticker_missing",
            message: stats.exists
              ? `${absolute} exists but is not a JSON object. This is NOT an empty ticker.`
              : `${absolute} does not exist. This is NOT an empty ticker — no ticker rows were pasted.`,
            source: { path: "data/live-wagers.json", ...stats },
          };
        }
        const data = parsed.value;
        const list = Array.isArray(data.LIST) ? data.LIST : [];
        const wantedAgent = filter(request.agentId);
        const wantedSport = filter(request.sport);
        let parseWarnings = 0;
        const withSport = list.map((wager) => {
          const parsed = tokenizeShortDesc(wager?.ShortDesc);
          if (parsed.unknown) parseWarnings += 1;
          return { ...wager, ...parsed };
        });
        const filtered = withSport.filter(
          (wager) =>
            (wantedAgent === "" ||
              String(wager?.AgentID ?? "").toUpperCase() === wantedAgent) &&
            (wantedSport === "" ||
              (wager.sport ?? "").toUpperCase() === wantedSport),
        );
        const sum = (key) =>
          filtered.reduce((total, wager) => {
            const value = Number(wager?.[key]);
            return total + (Number.isFinite(value) ? value : 0);
          }, 0);
        return {
          available: true,
          ok: true,
          report: request.report,
          scope: "clipboard-ticker-sample",
          scopeNote:
            "Clipboard paste sample; DISJOINT from the agent /Report/Pending snapshot (data/live-bets.json).",
          observedAt: data.observedAt ?? null,
          ageMinutes: stats.ageMinutes,
          parseWarnings,
          wagerTypeLegend: TICKER_WAGER_TYPE_FACTS,
          source: {
            path: "data/live-wagers.json",
            role: "Clipboard bet-ticker rows.",
            ...stats,
            observedAt: data.observedAt ?? null,
            partial: data.partial ?? null,
            note: "Point-in-time sample, not a live feed.",
          },
          returnedWagers: filtered.length,
          totalWagers: list.length,
          wagered: sum("AmountWagered"),
          toWin: sum("ToWinAmount"),
          byAgent: countField(filtered, "AgentID"),
          byWagerType: countField(filtered, "WagerType"),
          bySport: countField(filtered, "sport"),
          wagers: filtered.slice(0, limit).map((wager) => ({
            wagerNumber: wager?.WagerNumber ?? null,
            agentId: wager?.AgentID ?? null,
            customerId: wager?.CustomerID ?? null,
            wagerType: wager?.wagerType ?? null,
            descCode: wager?.descCode ?? null,
            gameNumber: wager?.gameNumber ?? null,
            amountWagered: wager?.AmountWagered ?? null,
            toWinAmount: wager?.ToWinAmount ?? null,
            insertDateTime: wager?.InsertDateTime ?? null,
            sport: wager?.sport ?? null,
            shortDesc: wager?.ShortDesc ?? null,
          })),
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_dev — can "merge-ready" actually be claimed?
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_dev",
      description:
        "Development and verification state of the sportsdesk-ops checkout: branch, HEAD, " +
        "modified/untracked counts, ahead/behind and diverged, plus the repo's verification " +
        "gates. Every gate is reported as not_run unless `run` names it — an unexecuted gate is " +
        "never green, and ok is null when nothing was executed. Closed set: " +
        "secrets, release, archives, ledger, citations, routes, pm, customer-book, " +
        "artifacts (cheap reads) and format, typecheck, lint, unit, docs, ci, ci-all (CI steps; " +
        "unit and the ci gates take minutes; docs and the ci gates re-render generated docs " +
        "then restore identical " +
        "content, so mtimes may change). JSON-capable checks return parsed data. Unknown names " +
        "are refused, not guessed. env:audit and gen:tokens:gate are deliberately absent: the " +
        "first hangs on this checkout's FIFO .env, the second rewrites tracked files.",
      parameters: {
        type: "object",
        properties: {
          run: {
            type: "array",
            items: { type: "string" },
            description:
              'Gates to EXECUTE (e.g. ["secrets","typecheck"]). Omit for a fast report: all gates are not_run.',
          },
        },
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: (args) =>
        !Array.isArray(args?.run) || args.run.length === 0,
      async execute(args) {
        const requestedRaw = args?.run ?? [];
        if (!Array.isArray(requestedRaw)) {
          return {
            available: false,
            reason: "invalid_run",
            message: "run must be an array of gate names.",
          };
        }
        const unknown = [];
        const requestedSet = new Set();
        for (const entry of requestedRaw) {
          if (typeof entry !== "string" || entry === "") {
            return {
              available: false,
              reason: "invalid_run",
              message: "run must contain non-empty strings.",
            };
          }
          if (!Object.hasOwn(DEV_CHECKS, entry)) unknown.push(entry);
          else requestedSet.add(entry);
        }
        if (unknown.length > 0) {
          return {
            available: false,
            reason: "unknown_gate",
            message: `Unknown gate(s) ${unknown.map((entry) => JSON.stringify(entry)).join(", ")}. Allowed: ${DEV_ORDER.join(", ")}.`,
          };
        }
        const requested = DEV_ORDER.filter((entry) => requestedSet.has(entry));
        const git = await readGitState();
        const gates = {};
        for (const gate of DEV_ORDER) {
          const spec = DEV_CHECKS[gate];
          if (!requestedSet.has(gate)) {
            gates[gate] = {
              status: "not_run",
              description: spec.description,
            };
            continue;
          }
          const timeoutMs =
            spec.kind === "gate" ? settings.gateTimeoutMs : settings.timeoutMs;
          const result = await runBun(spec.argv, timeoutMs);
          /** @type {Record<string, unknown>} */
          const entry = {
            status: result.ok
              ? "passed"
              : result.timedOut
                ? "timed_out"
                : "failed",
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            spawnError: result.spawnError,
          };
          if (spec.json) {
            const parsedOutput = parseJson(result.stdout);
            if (parsedOutput.ok) entry.data = parsedOutput.value;
            else
              entry.parseError =
                "expected --json output but stdout did not parse";
          }
          if (spec.restoresGeneratedFiles) {
            entry.note =
              "Re-renders generated docs then restores identical content; mtimes may change.";
          }
          entry.output = excerpt(
            [result.stdout, result.stderr].filter(Boolean).join("\n"),
          );
          gates[gate] = entry;
        }
        const executed = requested;
        const failures = executed.filter(
          (gate) => gates[gate].status !== "passed",
        );
        return {
          available: true,
          ok: executed.length === 0 ? null : failures.length === 0,
          checkedAt: new Date().toISOString(),
          repo: { path: repoPath, git },
          executed,
          gates,
          note:
            executed.length === 0
              ? "No gate was executed. An unexecuted gate is not_run, never green; ok is null."
              : null,
          nextStep: !git.available
            ? "repoPath is not a git checkout; fix the plugin's repoPath config."
            : git.diverged
              ? "The branch has diverged from its upstream: reconcile before pushing; ahead alone hides the missing side."
              : failures.length > 0
                ? `Failing: ${failures.join(", ")}. Fix and re-run the same gates.`
                : 'Requested gates passed. The full CI chain is run:["ci"] (bun run ci:local).',
        };
      },
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
