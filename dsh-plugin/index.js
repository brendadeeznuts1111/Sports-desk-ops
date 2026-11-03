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
 * `sportsdesk_dev` and `sportsdesk_security` are the only tools that EXECUTE anything.
 * `sportsdesk_dev` runs the repo's own verification gates over a CLOSED set and refuses any
 * other name; `sportsdesk_security` runs exactly two repo commands (`check:secrets` and the
 * `lib/identifier_scan.ts` scanner) and accepts no command from the caller. Those gates and
 * scans read artifacts and check invariants; they do not deploy, capture or mutate.
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
// ast-grep-ignore: node-fs-read-write-file -- same runtime: Bun.file() is not defined in Electron's Node, so whole-file reads and the capture-store listing go through node:fs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  // Relative to repoPath, so moving the checkout does not leave this pointing at an old one.
  wagersArtifact: "Scratch/gslive-wagers-by-state.summary.json",
  // The automation trio: the capture journal (authoritative for attempt success/failure), the
  // append-only capture history (JSONL) and the derived alerts document. Keep these in step with
  // WAGERS_AUTOMATION below.
  wagersStatus: "Scratch/wagers-by-state.status.json",
  wagersHistory: "Scratch/wagers-by-state.history.jsonl",
  wagersAlerts: "Scratch/wagers-by-state.alerts.json",
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
  if (
    typeof given.wagersArtifact === "string" &&
    given.wagersArtifact.trim() !== ""
  ) {
    config.wagersArtifact = given.wagersArtifact.trim();
  }
  for (const key of ["timeoutMs", "gateTimeoutMs", "staleAfterMinutes"]) {
    const value = given[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      config[key] = value;
    }
  }
  for (const key of ["wagersStatus", "wagersHistory", "wagersAlerts"]) {
    const value = given[key];
    if (typeof value === "string" && value.trim() !== "") {
      config[key] = value.trim();
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
 * The wager-state table artifact: the interface between
 * `scripts/gslive_wagers_by_state.ts` (producer, `--json`) and `sportsdesk_wagers` (consumer).
 *
 * WHY A SEPARATE CONFIG FIELD: the artifact is gitignored (`Scratch/`), so a fresh checkout does
 * not have one. The tool reports MISSING explicitly instead of an empty table, and an operator can
 * point `wagersArtifact` at another path (absolute, or relative to `repoPath`) without editing
 * code. The consumer knows schemaVersion 2 only; anything else is UNSUPPORTED, never
 * best-effort parsed.
 */
const WAGERS_ARTIFACT = {
  path: "Scratch/gslive-wagers-by-state.summary.json",
  schemaVersion: 2,
  role: "Wager table by GSLive wager state: legs vs wagers (distinct Ticket), deduped wagerRisk vs legRisk, spanning, per-state rows and a computed quality block.",
};

/**
 * The automation side of the wager pipeline: the capture journal, the append-only capture history
 * and the derived alerts document, per `Scratch/wagers-automation.schema.v1.json` (the frozen
 * contract shared with `scripts/wagers_by_state_capture.ts`).
 *
 * WHY THESE ARE SEPARATE FROM THE ARTIFACT: the artifact is one snapshot and says nothing about
 * whether the automation ran. Each of these files is independently MISSING-able (a fresh checkout
 * has none of them) and independently versioned, so the tool reports one status PER FILE instead
 * of collapsing three evidence gaps into a single verdict. The journal is authoritative for
 * attempt success/failure; alerts are derived and never replace it; history holds successful
 * captures only, so it must never be read as an attempt log.
 */
const WAGERS_AUTOMATION = {
  status: {
    path: "Scratch/wagers-by-state.status.json",
    schemaVersion: 1,
    role: "Capture journal: one capped entry per attempt, plus lastSuccess and lastFailure. Authoritative for success/failure.",
  },
  history: {
    path: "Scratch/wagers-by-state.history.jsonl",
    schemaVersion: 1,
    role: "Append-only capture history (one JSONL line per SUCCESSFUL capture): totals, per-state rows, delta, qualityFlags and alerts. Carries no ticket ids.",
  },
  alerts: {
    path: "Scratch/wagers-by-state.alerts.json",
    schemaVersion: 1,
    role: "Derived, thresholded alerts from the latest successful capture (empty array is a measured value).",
  },
};

/** Reports `sportsdesk_wagers` understands. */
const WAGERS_REPORTS = ["summary", "states", "quality", "automation", "trends"];

/**
 * The live artifacts the desk serves, with the age after which each is stale. The budgets are
 * policy (a feed captured four hours ago is stale for a live board), not measured numbers; the
 * ages are read from the files and the capture run journal at call time.
 */
const LIVE_ARTIFACTS = [
  {
    name: "live-bets",
    path: "data/live-bets.json",
    budgetMinutes: 120,
    capturePath: "api",
    pasteFileName: null,
    role: "Pending report -> scoreboard feed (rebuilt by capture:all from Report/Pending).",
  },
  {
    name: "live-wagers",
    path: "data/live-wagers.json",
    budgetMinutes: 120,
    capturePath: "api",
    pasteFileName: null,
    role: "getBetTicker list -> bet ticker feed (rebuilt by capture:all from getBetTicker).",
  },
  {
    name: "scoreboard",
    path: "data/scoreboard.json",
    budgetMinutes: 360,
    capturePath: "paste",
    pasteFileName: "scoreboard.json",
    role: "Scoreboard snapshot.",
  },
  {
    name: "game-admin-board",
    path: "data/game-admin-board.json",
    budgetMinutes: 720,
    capturePath: "paste",
    pasteFileName: "game-admin-board.json",
    role: "Game admin board snapshot.",
  },
  {
    name: "contests",
    path: "data/contests.json",
    budgetMinutes: 1_440,
    capturePath: "paste",
    pasteFileName: "contests.html",
    role: "Contest entries.",
  },
  {
    name: "customer-profiles",
    path: "data/customer-profiles.json",
    budgetMinutes: 1_440,
    capturePath: "derived",
    pasteFileName: null,
    role: "Derived customer profiles.",
  },
  {
    name: "analysis-cp-baseball",
    path: "data/analysis-cp-baseball-2026-11-01.json",
    budgetMinutes: 1_440,
    capturePath: "paste",
    pasteFileName: "analysis-cp-baseball.json",
    role: "Customer-performance analysis snapshot.",
  },
];

/** PII-free capture run journal written by `bun run capture:all`. */
const CAPTURE_HEALTH = {
  path: "data/capture-health.json",
  role: "One record per live source: outcome, HTTP status, rows, bytes, artifact written, error.",
};

/** Stable command labels the capture report hands back, so a stale artifact has a next action. */
const CAPTURE_REFRESH_COMMANDS = {
  api: "bun run capture:all --agent <id> --customer <id>",
  paste: "bun run capture:dom --input <paste dir>",
  derived:
    "regenerate the derived artifact from its generator (not a live capture)",
};

/**
 * Provenance stamps an artifact may carry. The first string wins, so a file that keeps its own
 * convention (capturedAt vs observedAt vs generatedAt) is still dated by its own claim rather
 * than only by mtime.
 */
const ARTIFACT_STAMP_FIELDS = [
  "capturedAt",
  "observedAt",
  "extractedAt",
  "generatedAt",
  "generatedAtIso",
];

/**
 * Evidence artifacts the endpoint, security and weblog scans read. Every count those scans
 * report is derived from these files at call time; none is checked in. A missing artifact is
 * reported as missing, never as zero endpoints, zero findings or a clean capture set.
 */
const EVIDENCE = {
  ledger: {
    path: "docs/evidence/ledger.json",
    role: "Evidence ledger: operations (tier, capturedResponse, requiredCapture) and surfaces — the operations/surface SSOT.",
  },
  spec: {
    path: "dist/openapi.json",
    role: "Published OpenAPI 3.1 spec: the routes the published docs claim.",
  },
  captures: {
    path: "docs/evidence/captures/manifest.json",
    store: "docs/evidence/captures",
    role: "Capture manifest: one redacted record per wire capture, with its operation and redaction summary.",
  },
  weblogFixture: {
    path: "tests/fixtures/captures/getWebLog.mock.json",
    role: "Committed getWebLog mock fixture: a shape sample, not a wire capture.",
  },
  forensicModes: {
    path: "lib/forensic_diagnostic_modes.ts",
    role: "Forensic runbook: the getWebLog mode letters the repo defines.",
  },
};

/** Evidence tiers strongest to weakest: A is a captured contract, C an authored claim. */
const TIER_ORDER = ["A", "B", "C", "D", "E"];

/**
 * The identifier scan that `sportsdesk_security` runs.
 *
 * WHY A SPAWNED PROGRAM: the F402 login shape lives in `lib/identifier_scan.ts`, and the Host
 * plugin shim runs in Electron's Node, which cannot import TypeScript. Re-implementing the
 * shape here would drift from the repo's one implementation, so Bun runs a tiny program that
 * imports that module. It prints COUNTS and PATHS only: returning an identifier literal would
 * make the security tool the leak it exists to find.
 */
const IDENTIFIER_SCAN_PROGRAM = `
import { suspiciousIdentifiers } from "./lib/identifier_scan.ts";
const tracked = Bun.spawnSync(["git", "ls-files", "-z"]);
if (tracked.exitCode !== 0) {
  console.error("git ls-files failed with exit code " + tracked.exitCode);
  process.exit(2);
}
// Internal agent logins are a different class from customer logins: the downline snapshot
// names the desk's own agents, so a hit that matches one is classified rather than counted
// as an unexplained identifier.
const agents = new Set();
const downline = await Bun.file("sportsdesk_downline_data.json").json().catch(() => null);
for (const agent of downline?.agents ?? []) {
  if (agent?.agent) agents.add(String(agent.agent));
}
const files = new TextDecoder()
  .decode(tracked.stdout)
  .split("\\0")
  .filter((path) => /^(data|docs|static)\\//.test(path))
  .filter((path) => /\\.(json|html|js|mjs|css)$/.test(path));
const hits = [];
let scanned = 0;
for (const file of files) {
  const text = await Bun.file(file).text().catch(() => null);
  if (text === null) continue;
  scanned += 1;
  const found = suspiciousIdentifiers(text);
  if (found.length === 0) continue;
  hits.push({
    path: file,
    count: found.length,
    knownAgent: found.filter((value) => agents.has(value)).length,
  });
}
// Labeled-safe fixtures: the identifier shape was calibrated to report zero on these
// artifacts (tests/public_route_identifiers.test.ts). A non-zero result means the scanner
// has drifted, not that the fixture grew PII.
const calibration = [];
for (const file of ["data/contests.json", "data/scoreboard.json"]) {
  const text = await Bun.file(file).text().catch(() => null);
  calibration.push({
    path: file,
    count: text === null ? null : suspiciousIdentifiers(text).length,
  });
}
console.log(JSON.stringify({ scanned, hits, calibration }));
`;

/**
 * The probe catalog that `sportsdesk_endpoints` joins against the ledger.
 *
 * PROBE_OPS is the repo's capture-suite catalog, and it lives in TypeScript that the Host
 * runtime cannot import. Bun reads it and prints only the operation names and read-only flags;
 * nothing is re-declared here, so the join cannot drift from the suite.
 */
const PROBE_CATALOG_PROGRAM = `
import { PROBE_OPS } from "./lib/f402_probe.ts";
console.log(
  JSON.stringify(
    PROBE_OPS.map((op) => ({
      operation: op.operation,
      readOnly: op.readOnly === true,
    })),
  ),
);
`;

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
 * Pearson correlation over paired finite values, or null when a pair cannot be measured.
 * Used to report whether two "signals" are actually independent on the current book; a
 * near-collinear pair means an OR rule contributes little and the answer should say so.
 *
 * @param {Array<[number | null, number | null]>} pairs
 */
function pearsonOf(pairs) {
  const usable = pairs.filter((pair) => pair[0] !== null && pair[1] !== null);
  if (usable.length < 3) return null;
  const meanX =
    usable.reduce((total, pair) => total + pair[0], 0) / usable.length;
  const meanY =
    usable.reduce((total, pair) => total + pair[1], 0) / usable.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of usable) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
    varianceY += (y - meanY) ** 2;
  }
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
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

/** RFC 5737 documentation ranges: a subnet that cannot belong to a real customer. */
const DOCUMENTATION_SUBNET_PREFIXES = ["192.0.2.", "198.51.100.", "203.0.113."];

/** `CHURN_049` -> `A_#`, `RF2003` -> `A#`: the shape, not the value. */
function idFamily(customerId) {
  return String(customerId)
    .replace(/[0-9]+/g, "#")
    .replace(/[A-Za-z]+/g, "A");
}

function subnetOctets(subnet) {
  const match = /^(\d+)\.(\d+)\.(\d+)\./.exec(String(subnet).trim());
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Derived provenance audit of the book. Every check below is measured from the rows; none of
 * the feature names is asserted. The point is to keep a fixture-derived ranking from reading
 * as an observation of real customers: a book whose ip_subnet values are documentation ranges,
 * whose ids fall into one generated shape, and whose 1,100 tickets share 19 timestamps is a
 * generated dataset, and its "whales" and "multi-account clusters" describe how it was built.
 */
function bookIntegrity(rows) {
  const families = new Map();
  for (const row of rows) {
    const family = idFamily(row?.customer_id ?? "");
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  const familyEntries = [...families.entries()].sort(
    (left, right) => right[1] - left[1],
  );
  const topFamily = familyEntries[0] ?? ["", 0];
  const topFamilyShare = rows.length === 0 ? null : topFamily[1] / rows.length;

  const placeholderPattern = /^(Selection #\d+|Game Matchup \d+)$/;
  let tickets = 0;
  let placeholderTickets = 0;
  const selections = new Set();
  for (const row of rows) {
    for (const ticket of row?.recent_tickets ?? []) {
      tickets += 1;
      const selection = String(ticket?.selection ?? "");
      selections.add(selection);
      if (placeholderPattern.test(selection)) placeholderTickets += 1;
    }
  }

  const subnetCounts = new Map();
  for (const row of rows) {
    const subnet = String(row?.ip_subnet ?? "").trim();
    if (subnet !== "")
      subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1);
  }
  const documentationRange = [...subnetCounts.keys()].filter((subnet) =>
    DOCUMENTATION_SUBNET_PREFIXES.some((prefix) => subnet.startsWith(prefix)),
  ).length;
  const reusedSubnets = [...subnetCounts.values()].filter(
    (count) => count > 1,
  ).length;
  const octetsByPrefix = new Map();
  for (const subnet of subnetCounts.keys()) {
    const octets = subnetOctets(subnet);
    if (octets === null) continue;
    const prefix = `${octets[0]}.${octets[1]}`;
    const list = octetsByPrefix.get(prefix) ?? [];
    list.push(octets[2]);
    octetsByPrefix.set(prefix, list);
  }
  let sequentialSubnets = 0;
  for (const octets of octetsByPrefix.values()) {
    const sorted = [...new Set(octets)].sort((left, right) => left - right);
    let run = 1;
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] === sorted[index - 1] + 1) {
        run += 1;
      } else {
        if (run >= 8) sequentialSubnets += run;
        run = 1;
      }
    }
    if (run >= 8) sequentialSubnets += run;
  }
  const sequentialShare =
    subnetCounts.size === 0 ? null : sequentialSubnets / subnetCounts.size;

  const timestamps = new Map();
  let maxPerTimestamp = 0;
  for (const row of rows) {
    for (const ticket of row?.recent_tickets ?? []) {
      const placed = String(ticket?.placed_at ?? "");
      if (placed === "") continue;
      const next = (timestamps.get(placed) ?? 0) + 1;
      timestamps.set(placed, next);
      if (next > maxPerTimestamp) maxPerTimestamp = next;
    }
  }

  const ticketCounts = new Map();
  for (const row of rows) {
    const count = Array.isArray(row?.recent_tickets)
      ? row.recent_tickets.length
      : 0;
    ticketCounts.set(count, (ticketCounts.get(count) ?? 0) + 1);
  }
  const modalTicketCount = [...ticketCounts.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0] ?? [0, 0];

  let holdPctMaxError = 0;
  for (const row of rows) {
    const volume = Number(row?.lifetime_volume_usd);
    const net = Number(row?.lifetime_net_usd);
    const hold = Number(row?.hold_pct);
    if (!Number.isFinite(volume) || volume === 0) continue;
    if (!Number.isFinite(net) || !Number.isFinite(hold)) continue;
    holdPctMaxError = Math.max(
      holdPctMaxError,
      Math.abs((net / volume) * 100 - hold),
    );
  }

  const rollupKeys = new Map();
  for (const row of rows) {
    const key = [
      row?.lifetime_volume_usd,
      row?.lifetime_net_usd,
      row?.hold_pct,
      row?.clv_bps,
      row?.sharp_score,
      row?.churn_hazard,
      row?.sports_7d_volume_usd,
      row?.sports_7d_net_usd,
    ].join("|");
    rollupKeys.set(key, (rollupKeys.get(key) ?? 0) + 1);
  }
  const rollupDuplicateGroups = [...rollupKeys.values()].filter(
    (count) => count > 1,
  ).length;

  const features = [];
  const addFeature = (id, observed, detail) =>
    features.push({ id, observed, detail });
  if (documentationRange > 0) {
    addFeature(
      "documentation-ip-ranges",
      documentationRange,
      `${documentationRange} of ${subnetCounts.size} distinct ip_subnet values are RFC 5737 documentation ranges`,
    );
  }
  if (sequentialShare !== null && sequentialShare >= 0.2) {
    addFeature(
      "sequential-subnets",
      Number(sequentialShare.toFixed(3)),
      `${Math.round(sequentialShare * 100)}% of distinct ip_subnet values sit in consecutive third-octet runs of 8 or more`,
    );
  }
  if (placeholderTickets > 0) {
    addFeature(
      "placeholder-selections",
      placeholderTickets,
      `${placeholderTickets} of ${tickets} sampled tickets use placeholder selections (Selection #N / Game Matchup N)`,
    );
  }
  if (topFamilyShare !== null && topFamilyShare >= 0.25) {
    addFeature(
      "generated-id-family",
      Number(topFamilyShare.toFixed(3)),
      `the most common customer-id shape (${topFamily[0]}) covers ${Math.round(topFamilyShare * 100)}% of the book`,
    );
  }
  if (timestamps.size > 0 && timestamps.size <= 20 && tickets >= 100) {
    addFeature(
      "coarse-timestamp-grid",
      timestamps.size,
      `${tickets} tickets share only ${timestamps.size} distinct placed_at values (max ${maxPerTimestamp} per instant)`,
    );
  }
  if (ticketCounts.size === 1 && rows.length >= 50) {
    addFeature(
      "uniform-ticket-count",
      modalTicketCount[0],
      `every customer carries exactly ${modalTicketCount[0]} sampled tickets`,
    );
  }
  if (rollupDuplicateGroups > 0) {
    addFeature(
      "rollup-duplicates",
      rollupDuplicateGroups,
      `${rollupDuplicateGroups} exact duplicate rollup groups`,
    );
  }

  const character =
    features.length >= 3
      ? "generated-fixture"
      : features.length >= 1
        ? "partially-generated"
        : "unremarkable";
  return {
    character,
    matchedFeatures: features.length,
    features,
    identityFamilies: Object.fromEntries(
      familyEntries.slice(0, 5).map(([family, count]) => [family, count]),
    ),
    selections: {
      tickets,
      distinct: selections.size,
      placeholderCount: placeholderTickets,
      placeholderShare: tickets === 0 ? null : placeholderTickets / tickets,
    },
    subnets: {
      distinct: subnetCounts.size,
      reused: reusedSubnets,
      documentationRange,
      sequentialShare,
    },
    timestamps: {
      distinct: timestamps.size,
      maxTicketsPerTimestamp: maxPerTimestamp,
    },
    ticketCounts: {
      distinct: ticketCounts.size,
      modal: modalTicketCount[0],
      modalShare: rows.length === 0 ? null : modalTicketCount[1] / rows.length,
    },
    holdPctMaxError,
    rollupDuplicateGroups,
    implication:
      character === "unremarkable"
        ? "No provenance anomaly was detected; derived rankings still describe this book only."
        : `This book reports ${features.length} provenance feature(s) of generated/demo data (${features
            .map((feature) => feature.id)
            .join(
              ", ",
            )}), so derived rankings and signals describe fixture construction, not observed customer behavior.`,
  };
}

/** The compact integrity block every intelligence answer carries. */
function compactIntegrity(integrity) {
  return {
    character: integrity.character,
    matchedFeatures: integrity.matchedFeatures,
    features: integrity.features.map((feature) => ({
      id: feature.id,
      detail: feature.detail,
    })),
    implication: integrity.implication,
  };
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
 * Read one evidence artifact and stat it. A missing or unparseable file is reported as such,
 * never as an empty catalog.
 *
 * @param {string} repoPath
 * @param {string} path
 * @returns {{ path: string, exists: boolean, bytes: number | null, mtime: string | null, ageMinutes: number | null, ok: boolean, value: unknown }}
 */
function readEvidence(repoPath, path) {
  const absolute = `${repoPath}/${path}`;
  const stats = statFile(absolute);
  const parsed = parseJson(readText(absolute));
  return {
    path,
    ...stats,
    ok: stats.exists && parsed.ok,
    value: parsed.ok ? parsed.value : null,
  };
}

/** The compact projection of an evidence artifact carried by every scan answer. */
function evidenceStamp(evidence) {
  return {
    path: evidence.path,
    exists: evidence.exists,
    bytes: evidence.bytes,
    mtime: evidence.mtime,
    ageMinutes: evidence.ageMinutes,
    parsed: evidence.ok,
  };
}

/** Age of an ISO stamp in minutes, or null when the stamp does not parse. */
function ageMinutesSince(iso) {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isFinite(ms)
    ? Math.max(0, Math.round((Date.now() - ms) / 60_000))
    : null;
}

/**
 * The latest capture per operation path. `operation.path` is the join key; a manifest entry for
 * a path the ledger does not carry is reported separately rather than silently dropped.
 *
 * @param {unknown[]} captures
 * @returns {Map<string, any>}
 */
function latestCaptureByPath(captures) {
  const latest = new Map();
  for (const capture of Array.isArray(captures) ? captures : []) {
    if (typeof capture !== "object" || capture === null) continue;
    const path = String(capture.operation?.path ?? "");
    if (path === "") continue;
    const previous = latest.get(path);
    if (
      previous === undefined ||
      String(capture.capturedAt ?? "") > String(previous.capturedAt ?? "")
    ) {
      latest.set(path, capture);
    }
  }
  return latest;
}

/** The capture fields an answer may quote; the response body is never inlined. */
function captureSummary(capture) {
  if (capture === null || capture === undefined) return null;
  return {
    file: capture.file ?? null,
    mode: capture.mode ?? null,
    capturedAt: capture.capturedAt ?? null,
    ageMinutes: ageMinutesSince(capture.capturedAt),
    responseStatus: capture.responseStatus ?? null,
    responseBytes: capture.responseBytes ?? null,
    derivedTier: capture.derivedTier ?? null,
  };
}

/** Trim a long evidence string for transport without pretending it is the whole text. */
function truncate(text, limit) {
  const clean = String(text ?? "").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

/**
 * Evidence growth read from the capture store's own apply journal.
 *
 * `applied-*.json` is written by `scripts/apply_captures.ts` on every install and records the
 * ledger tier counts before/after plus upgrades, skips and rejections. That makes it a measured
 * time series, so the endpoint scan can report a delta instead of only a snapshot. The series
 * is read from the files; no snapshot count is checked in.
 *
 * @param {string} repoPath
 * @param {number} limit
 */
function evidenceTrend(repoPath, limit) {
  const directory = `${repoPath}/${EVIDENCE.captures.store}`;
  let names;
  try {
    // ast-grep-ignore: node-fs-read-write-file -- Electron Node has no Bun.file; listing the capture store is the join key.
    names = readdirSync(directory);
  } catch {
    return {
      available: false,
      reason: "capture_store_missing",
      message: `${EVIDENCE.captures.store} does not exist. This is NOT an empty evidence history.`,
    };
  }
  const files = names.filter((name) => /^applied-.*\.json$/.test(name)).sort();
  const snapshots = [];
  const unreadable = [];
  for (const file of files) {
    const evidence = readEvidence(
      repoPath,
      `${EVIDENCE.captures.store}/${file}`,
    );
    if (!evidence.ok) {
      unreadable.push(file);
      continue;
    }
    const value =
      typeof evidence.value === "object" && evidence.value !== null
        ? evidence.value
        : {};
    const before =
      typeof value.ledgerCountsBefore === "object" &&
      value.ledgerCountsBefore !== null
        ? value.ledgerCountsBefore
        : null;
    const after =
      typeof value.ledgerCountsAfter === "object" &&
      value.ledgerCountsAfter !== null
        ? value.ledgerCountsAfter
        : null;
    const countOf = (value_, key) =>
      Array.isArray(value_ ? value_[key] : null)
        ? value_[key].length
        : Number.isFinite(Number(value_ ? value_[key] : null))
          ? Number(value_[key])
          : null;
    const upgrades = countOf(value, "upgrades");
    const skips = countOf(value, "skips");
    const rejections = countOf(value, "rejections");
    const decided = [upgrades, skips, rejections].filter(
      (count) => count !== null,
    );
    const decidedTotal = decided.reduce((total, count) => total + count, 0);
    const delta = {};
    for (const tier of TIER_ORDER) {
      const from = Number(before?.[tier]);
      const to = Number(after?.[tier]);
      delta[tier] =
        Number.isFinite(from) && Number.isFinite(to) ? to - from : null;
    }
    snapshots.push({
      file,
      appliedAt: value.appliedAt ?? null,
      before,
      after,
      delta,
      upgrades,
      skips,
      rejections,
      rejectionRatePct:
        rejections === null || decidedTotal === 0
          ? null
          : (rejections / decidedTotal) * 100,
      verifyOk: value.verify?.ok ?? null,
    });
  }
  if (snapshots.length === 0) {
    return {
      available: false,
      reason: "no_apply_snapshots",
      message:
        "No readable applied-*.json in the capture store. This is NOT a flat evidence trend.",
      unreadable,
    };
  }
  const latest = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const latestA = Number(latest.after?.A);
  const firstA = Number(first.before?.A);
  return {
    available: true,
    source: `${EVIDENCE.captures.store}/applied-*.json`,
    snapshots: snapshots.slice(-limit),
    truncated: snapshots.length > limit,
    unreadable,
    latest: {
      file: latest.file,
      appliedAt: latest.appliedAt,
      tierA: Number.isFinite(latestA) ? latestA : null,
      deltaA: latest.delta.A,
      rejections: latest.rejections,
      rejectionRatePct: latest.rejectionRatePct,
      verifyOk: latest.verifyOk,
    },
    changeSinceFirst:
      Number.isFinite(latestA) && Number.isFinite(firstA)
        ? { tierA: latestA - firstA }
        : null,
    note:
      "A growing tier A is evidence the capture suite is converting authored claims " +
      "into captured contracts; a rising rejection rate is evidence the apply gate is " +
      "refusing more, not that the store is improving.",
  };
}

/**
 * Load the enriched customer book once for the tools that scan it.
 *
 * A missing file and an unparseable file are different failures, and neither is an empty book:
 * a caller must never read "0 customers" out of "no evidence was gathered".
 *
 * @param {string} repoPath
 * @returns {{ ok: true, rows: any[], source: Record<string, unknown> } | { ok: false, reason: string, message: string, source: Record<string, unknown> }}
 */
function readCustomerBook(repoPath) {
  const absolute = `${repoPath}/${CUSTOMER_BOOK.path}`;
  const stats = statFile(absolute);
  const parsed = parseJson(readText(absolute));
  if (!stats.exists || !parsed.ok || !Array.isArray(parsed.value)) {
    return {
      ok: false,
      reason: stats.exists ? "book_unparseable" : "book_missing",
      message: stats.exists
        ? `${absolute} exists but is not a JSON array. This is NOT an empty customer book.`
        : `${absolute} does not exist. This is NOT an empty customer book — no customer was measured.`,
      source: { path: CUSTOMER_BOOK.path, ...stats },
    };
  }
  return {
    ok: true,
    rows: parsed.value,
    source: {
      path: CUSTOMER_BOOK.path,
      role: CUSTOMER_BOOK.role,
      ...stats,
      note: "Derived at call time from the checked-in customer book; not a live F402 feed.",
    },
  };
}

/**
 * Resolve one configured path against the checkout. Absolute paths win; a relative one is joined
 * under `repoPath`, which is how the defaults (`Scratch/...`) are derived.
 *
 * @param {string} repoPath
 * @param {string} configured
 * @param {string} fallback
 * @returns {string}
 */
function resolveRepoPath(repoPath, configured, fallback) {
  const candidate =
    typeof configured === "string" && configured.trim() !== ""
      ? configured.trim()
      : fallback;
  return candidate.startsWith("/") ? candidate : `${repoPath}/${candidate}`;
}

/**
 * Resolve the configured wagers artifact against the checkout.
 *
 * @param {string} repoPath
 * @param {string} configured
 * @returns {string}
 */
function resolveArtifactPath(repoPath, configured) {
  return resolveRepoPath(repoPath, configured, WAGERS_ARTIFACT.path);
}

/**
 * Describe one automation file as the desk sees it: path, role, bytes, mtime and age. A missing
 * file reports `exists:false` and `ageMinutes:null`; it never borrows another file's freshness.
 *
 * @param {string} absolute
 * @param {{ path: string, role: string, schemaVersion: number }} spec
 * @param {number} staleAfterMinutes
 */
function automationFileSource(absolute, spec, staleAfterMinutes) {
  const stats = statFile(absolute);
  return {
    kind: "wagers-automation-file",
    role: spec.role,
    path: absolute,
    exists: stats.exists,
    bytes: stats.bytes,
    mtime: stats.mtime,
    ageMinutes: stats.ageMinutes,
    stale:
      stats.ageMinutes === null ? null : stats.ageMinutes > staleAfterMinutes,
    schemaVersion: null,
    supportedSchemaVersion: spec.schemaVersion,
    note: "File on disk; not a live feed.",
  };
}

/**
 * Project the artifact's data window with freshness recomputed at call time. `observedEnd` comes
 * from the data, so `ageMinutes` here is the age of the DATA, while `source.ageMinutes` is the age
 * of the FILE. An unparseable end reports null rather than a made-up age.
 *
 * @param {Record<string, any>} window
 */
function wagerWindowReport(window) {
  const observedEnd =
    typeof window.observedEnd === "string" ? window.observedEnd : null;
  const endMs = observedEnd === null ? Number.NaN : Date.parse(observedEnd);
  const ageMinutes = Number.isFinite(endMs)
    ? Math.max(0, Math.round((Date.now() - endMs) / 60_000))
    : null;
  return {
    observedStart: window.observedStart ?? null,
    observedEnd,
    spanHours: window.spanHours ?? null,
    fromEpochSec: window.fromEpochSec ?? null,
    toEpochSec: window.toEpochSec ?? null,
    ageMinutes,
    snapshotLagMinutes: window.snapshotLagMinutes ?? null,
    note:
      ageMinutes === null
        ? "ageMinutes is null: observedEnd did not parse, so data freshness was not measured."
        : "ageMinutes is recomputed at call time from observedEnd (data), not from a CLI flag; snapshotLagMinutes is the artifact's own mtime-minus-data lag.",
  };
}

/**
 * Turn the artifact's computed quality block into named flags. Every flag is a condition the
 * producer measured; an empty list means "no measured flag", never a clean bill of health.
 *
 * @param {Record<string, any>} quality
 */
function wagerQualityFlags(quality) {
  const flags = [];
  const unknownStates = Array.isArray(quality.unknownStates)
    ? quality.unknownStates
    : [];
  if (unknownStates.length > 0) {
    flags.push({
      code: "unknown_states",
      count: unknownStates.length,
      states: unknownStates,
    });
  }
  const numericStateCodes = Array.isArray(quality.numericStateCodes)
    ? quality.numericStateCodes
    : [];
  if (numericStateCodes.length > 0) {
    flags.push({
      code: "numeric_state_codes",
      count: numericStateCodes.length,
      codes: numericStateCodes,
    });
  }
  const coverage = Number(quality.ticketCoveragePct);
  if (Number.isFinite(coverage) && coverage < 100) {
    flags.push({
      code: "ticket_coverage_incomplete",
      ticketCoveragePct: coverage,
    });
  }
  const unparsedBetTimes = Number(quality.unparsedBetTimes);
  if (Number.isFinite(unparsedBetTimes) && unparsedBetTimes > 0) {
    flags.push({ code: "unparsed_bet_times", count: unparsedBetTimes });
  }
  const violations = quality.coherenceViolations;
  if (typeof violations === "object" && violations !== null) {
    const win = Number(violations.winResultNonPositive);
    const lose = Number(violations.loseResultNonNegative);
    if (Number.isFinite(win) && win > 0) {
      flags.push({
        code: "coherence_violations",
        rule: "winResultNonPositive",
        count: win,
      });
    }
    if (Number.isFinite(lose) && lose > 0) {
      flags.push({
        code: "coherence_violations",
        rule: "loseResultNonNegative",
        count: lose,
      });
    }
  }
  return flags;
}

/**
 * Aggregate the producer's quality block for `report:"quality"`. Nothing is recomputed from raw
 * rows here, so the tool cannot disagree with the artifact; a missing component is null.
 *
 * @param {Record<string, any>} quality
 */
function wagerQualitySummary(quality) {
  const violations = quality.coherenceViolations;
  const parts = [];
  if (typeof violations === "object" && violations !== null) {
    for (const key of ["winResultNonPositive", "loseResultNonNegative"]) {
      const value = Number(violations[key]);
      if (Number.isFinite(value)) parts.push(value);
    }
  }
  return {
    coherenceViolationTotal:
      parts.length === 0
        ? null
        : parts.reduce((total, value) => total + value, 0),
    settledLegs: quality.gradeLagMinutes?.settledLegs ?? null,
    ticketCoveragePct: quality.ticketCoveragePct ?? null,
    unparsedBetTimes: quality.unparsedBetTimes ?? null,
    unknownStates: Array.isArray(quality.unknownStates)
      ? [...quality.unknownStates]
      : null,
    note: "Aggregated from the artifact's computed quality block; nothing here is recomputed from raw rows.",
  };
}

/**
 * Load and validate the v2 wager-state artifact.
 *
 * The failure modes are deliberately distinct: MISSING (no file), UNPARSEABLE (not a JSON
 * object), UNSUPPORTED (a schemaVersion this consumer does not know) and MALFORMED (claims v2 but
 * lacks a contract field). None of them is an empty table, and none is best-effort parsed.
 *
 * @param {string} absolute
 * @param {number} staleAfterMinutes
 * @returns {{ ok: true, value: Record<string, any>, source: Record<string, unknown> } | { ok: false, reason: string, message: string, source: Record<string, unknown>, supportedSchemaVersion?: number, observedSchemaVersion?: number | null, missingFields?: string[] }}
 */
function loadWagersArtifact(absolute, staleAfterMinutes) {
  const stats = statFile(absolute);
  /** @type {Record<string, unknown>} */
  const source = {
    kind: "wagers-by-state-snapshot",
    path: absolute,
    exists: stats.exists,
    mtime: stats.mtime,
    ageMinutes: stats.ageMinutes,
    stale:
      stats.ageMinutes === null ? null : stats.ageMinutes > staleAfterMinutes,
    bytes: stats.bytes,
    schemaVersion: null,
    note: "Snapshot artifact on disk; not a live feed.",
  };
  if (!stats.exists) {
    return {
      ok: false,
      reason: "artifact_missing",
      source,
      message:
        `${absolute} does not exist. This is MISSING, not zero states — no wager was measured. ` +
        "Write the v2 artifact there with the repo's wagers-by-state producer (bun run wagers:by-state ... --json <path>), " +
        "or point the plugin's wagersArtifact config at one.",
    };
  }
  const parsed = parseJson(readText(absolute));
  const value =
    parsed.ok &&
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    !Array.isArray(parsed.value)
      ? parsed.value
      : null;
  if (value === null) {
    return {
      ok: false,
      reason: "artifact_unparseable",
      source,
      message: `${absolute} exists but does not parse as a JSON object. This is NOT a wager table with zero rows.`,
    };
  }
  source.schemaVersion =
    typeof value.schemaVersion === "number" ? value.schemaVersion : null;
  if (value.schemaVersion !== WAGERS_ARTIFACT.schemaVersion) {
    return {
      ok: false,
      reason: "schema_unsupported",
      source,
      observedSchemaVersion:
        typeof value.schemaVersion === "number" ? value.schemaVersion : null,
      supportedSchemaVersion: WAGERS_ARTIFACT.schemaVersion,
      message:
        `schemaVersion ${JSON.stringify(value.schemaVersion ?? null)} is UNSUPPORTED: this consumer ` +
        `supports schemaVersion ${WAGERS_ARTIFACT.schemaVersion} only and refuses to best-effort parse an unknown contract.`,
    };
  }
  const missingFields = [];
  for (const key of ["source", "window", "identity", "totals", "quality"]) {
    const field = value[key];
    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      missingFields.push(key);
    }
  }
  if (!Array.isArray(value.states)) missingFields.push("states");
  if (typeof value.moneyScope !== "string") missingFields.push("moneyScope");
  if (!Array.isArray(value.notes)) missingFields.push("notes");
  if (missingFields.length === 0) {
    for (let index = 0; index < value.states.length; index += 1) {
      const row = value.states[index];
      if (
        typeof row !== "object" ||
        row === null ||
        typeof row.state !== "string"
      ) {
        missingFields.push(`states[${index}]`);
        break;
      }
    }
  }
  if (missingFields.length > 0) {
    return {
      ok: false,
      reason: "artifact_malformed",
      source,
      missingFields,
      message:
        `${absolute} claims schemaVersion ${WAGERS_ARTIFACT.schemaVersion} but ` +
        `${missingFields.join(", ")} ${missingFields.length === 1 ? "is" : "are"} missing or malformed. ` +
        "This is NOT an empty table — the contract is not satisfied.",
    };
  }
  return { ok: true, value, source };
}

/**
 * Project one capture-journal run entry. The producer's `CaptureRun` is the journal's own shape
 * (a superset of the frozen history contract): every field the consumer does not recognize is
 * omitted rather than guessed, and a wrongly typed field reads as null.
 *
 * @param {Record<string, unknown>} run
 */
function captureRunReport(run) {
  return {
    startedAt: typeof run.startedAt === "string" ? run.startedAt : null,
    finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : null,
    ok: typeof run.ok === "boolean" ? run.ok : null,
    sourceKind: typeof run.sourceKind === "string" ? run.sourceKind : null,
    ajaxUrl: typeof run.ajaxUrl === "string" ? run.ajaxUrl : null,
    fromEpochSec: Number.isFinite(run.fromEpochSec) ? run.fromEpochSec : null,
    toEpochSec: Number.isFinite(run.toEpochSec) ? run.toEpochSec : null,
    dateFilterBy:
      typeof run.dateFilterBy === "string" ? run.dateFilterBy : null,
    legs: Number.isFinite(run.legs) ? run.legs : null,
    wagers: Number.isFinite(run.wagers) ? run.wagers : null,
    states: Number.isFinite(run.states) ? run.states : null,
    error: typeof run.error === "string" ? run.error : null,
    // Task-5 adds a compact alert-code list to the journal entry; absent means null, not [].
    alertCodes: Array.isArray(run.alertCodes)
      ? run.alertCodes.filter((code) => typeof code === "string")
      : null,
  };
}

/**
 * Load and validate the capture journal (the status file). It is authoritative for attempt
 * success/failure, so a file that cannot be read is reported as such — never as "zero failures".
 *
 * @param {string} absolute
 * @param {number} staleAfterMinutes
 */
function loadCaptureJournal(absolute, staleAfterMinutes) {
  const source = automationFileSource(
    absolute,
    WAGERS_AUTOMATION.status,
    staleAfterMinutes,
  );
  if (!source.exists) {
    return {
      ok: false,
      reason: "journal_missing",
      source,
      message:
        `${absolute} does not exist. The capture journal is MISSING — this is NOT "no failures", ` +
        `NOT "no runs" and NOT a clean automation; no attempt was measured.`,
    };
  }
  const parsed = parseJson(readText(absolute));
  const value =
    parsed.ok &&
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    !Array.isArray(parsed.value)
      ? parsed.value
      : null;
  if (value === null) {
    return {
      ok: false,
      reason: "journal_unparseable",
      source,
      message: `${absolute} exists but does not parse as a JSON object. This is NOT a journal with zero runs.`,
    };
  }
  source.schemaVersion =
    typeof value.schemaVersion === "number" ? value.schemaVersion : null;
  if (value.schemaVersion !== WAGERS_AUTOMATION.status.schemaVersion) {
    return {
      ok: false,
      reason: "journal_schema_unsupported",
      source,
      observedSchemaVersion: source.schemaVersion,
      supportedSchemaVersion: WAGERS_AUTOMATION.status.schemaVersion,
      message:
        `Capture journal schemaVersion ${JSON.stringify(value.schemaVersion ?? null)} is UNSUPPORTED: ` +
        `this consumer supports schemaVersion ${WAGERS_AUTOMATION.status.schemaVersion} only and refuses to best-effort parse it.`,
    };
  }
  if (!Array.isArray(value.runs)) {
    return {
      ok: false,
      reason: "journal_malformed",
      source,
      missingFields: ["runs"],
      message: `${absolute} claims schemaVersion 1 but its runs field is missing or not an array. This is NOT a journal with zero attempts.`,
    };
  }
  const runs = [];
  const malformedRunEntries = [];
  value.runs.forEach((run, index) => {
    if (typeof run === "object" && run !== null && !Array.isArray(run)) {
      runs.push(run);
    } else {
      malformedRunEntries.push(`runs[${index}]`);
    }
  });
  const malformedFields = [];
  const runOrNull = (field) => {
    const entry = value[field];
    if (entry === null || entry === undefined) return null;
    if (typeof entry === "object" && !Array.isArray(entry)) {
      return captureRunReport(entry);
    }
    malformedFields.push(field);
    return null;
  };
  return {
    ok: true,
    runs,
    lastSuccess: runOrNull("lastSuccess"),
    lastFailure: runOrNull("lastFailure"),
    runsInJournal: value.runs.length,
    malformedRunEntries,
    malformedFields,
    source,
  };
}

/**
 * Project the alerts document's alert rows. A malformed row is skipped and counted, never
 * promoted to an alert and never silently dropped from the count of what was skipped.
 *
 * @param {unknown[]} alerts
 */
function alertRowsReport(alerts) {
  const rows = [];
  const malformed = [];
  const bySeverity = { info: 0, warn: 0, critical: 0 };
  alerts.forEach((alert, index) => {
    if (
      typeof alert !== "object" ||
      alert === null ||
      Array.isArray(alert) ||
      typeof alert.code !== "string" ||
      typeof alert.severity !== "string"
    ) {
      malformed.push(`alerts[${index}]`);
      return;
    }
    const row = {
      code: alert.code,
      severity: alert.severity,
      summary: typeof alert.summary === "string" ? alert.summary : null,
      detail: typeof alert.detail === "string" ? alert.detail : null,
    };
    if (Object.hasOwn(bySeverity, row.severity)) {
      bySeverity[row.severity] += 1;
    }
    rows.push(row);
  });
  return { rows, malformed, bySeverity };
}

/**
 * Load and validate the derived alerts document.
 *
 * @param {string} absolute
 * @param {number} staleAfterMinutes
 */
function loadWagersAlerts(absolute, staleAfterMinutes) {
  const source = automationFileSource(
    absolute,
    WAGERS_AUTOMATION.alerts,
    staleAfterMinutes,
  );
  if (!source.exists) {
    return {
      ok: false,
      reason: "alerts_missing",
      source,
      message:
        `${absolute} does not exist. The alerts document is MISSING — this is NOT "zero alerts"; ` +
        `no alert document was measured.`,
    };
  }
  const parsed = parseJson(readText(absolute));
  const value =
    parsed.ok &&
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    !Array.isArray(parsed.value)
      ? parsed.value
      : null;
  if (value === null) {
    return {
      ok: false,
      reason: "alerts_unparseable",
      source,
      message: `${absolute} exists but does not parse as a JSON object. This is NOT an alerts document with zero alerts.`,
    };
  }
  source.schemaVersion =
    typeof value.schemaVersion === "number" ? value.schemaVersion : null;
  if (value.schemaVersion !== WAGERS_AUTOMATION.alerts.schemaVersion) {
    return {
      ok: false,
      reason: "alerts_schema_unsupported",
      source,
      observedSchemaVersion: source.schemaVersion,
      supportedSchemaVersion: WAGERS_AUTOMATION.alerts.schemaVersion,
      message:
        `Alerts schemaVersion ${JSON.stringify(value.schemaVersion ?? null)} is UNSUPPORTED: this consumer ` +
        `supports schemaVersion ${WAGERS_AUTOMATION.alerts.schemaVersion} only and refuses to best-effort parse it.`,
    };
  }
  if (!Array.isArray(value.alerts)) {
    return {
      ok: false,
      reason: "alerts_malformed",
      source,
      missingFields: ["alerts"],
      message: `${absolute} claims schemaVersion 1 but its alerts field is missing or not an array. This is NOT a document with zero alerts.`,
    };
  }
  const projection = alertRowsReport(value.alerts);
  return {
    ok: true,
    generatedAt:
      typeof value.generatedAt === "string" ? value.generatedAt : null,
    sourceCapturedAt:
      typeof value.sourceCapturedAt === "string"
        ? value.sourceCapturedAt
        : null,
    alerts: projection.rows,
    malformedAlerts: projection.malformed,
    bySeverity: projection.bySeverity,
    source,
  };
}

/**
 * Which attempt was more recent? Derived by parsing the journal's own timestamps; null when the
 * answer cannot be measured (no timestamps, unparseable timestamps, or an exact tie).
 *
 * @param {{ finishedAt: string | null } | null} lastSuccess
 * @param {{ finishedAt: string | null } | null} lastFailure
 * @returns {"success" | "failure" | null}
 */
function captureOutcome(lastSuccess, lastFailure) {
  const successMs =
    typeof lastSuccess?.finishedAt === "string"
      ? Date.parse(lastSuccess.finishedAt)
      : Number.NaN;
  const failureMs =
    typeof lastFailure?.finishedAt === "string"
      ? Date.parse(lastFailure.finishedAt)
      : Number.NaN;
  if (!Number.isFinite(successMs) && !Number.isFinite(failureMs)) return null;
  if (!Number.isFinite(failureMs)) return "success";
  if (!Number.isFinite(successMs)) return "failure";
  if (failureMs > successMs) return "failure";
  if (successMs > failureMs) return "success";
  return null;
}

/** Status label for one of the automation files, from the loader's failure reason. */
function automationStatus(reason) {
  return (
    {
      artifact_missing: "MISSING",
      artifact_unparseable: "UNPARSEABLE",
      schema_unsupported: "UNSUPPORTED",
      artifact_malformed: "MALFORMED",
      journal_missing: "MISSING",
      journal_unparseable: "UNPARSEABLE",
      journal_schema_unsupported: "UNSUPPORTED",
      journal_malformed: "MALFORMED",
      alerts_missing: "MISSING",
      alerts_unparseable: "UNPARSEABLE",
      alerts_schema_unsupported: "UNSUPPORTED",
      alerts_malformed: "MALFORMED",
    }[reason] ?? "UNKNOWN"
  );
}

/**
 * `report:"automation"` — automation health from three independent files: the artifact (what the
 * desk last derived, and how old it is), the capture journal (authoritative attempt outcome) and
 * the alerts document (derived, never a substitute for the journal).
 *
 * MISSING is per file, and a missing journal is never reported as "no failures": the files carry
 * different evidence, so the answer keeps them separate. Nothing here is synthesized from an
 * absent file.
 *
 * @param {{ artifactAbsolute: string, statusAbsolute: string, alertsAbsolute: string, staleAfterMinutes: number, recentRuns?: number }} options
 */
function wagersAutomationReport(options) {
  const {
    artifactAbsolute,
    statusAbsolute,
    alertsAbsolute,
    staleAfterMinutes,
  } = options;
  const artifact = loadWagersArtifact(artifactAbsolute, staleAfterMinutes);
  const journal = loadCaptureJournal(statusAbsolute, staleAfterMinutes);
  const alerts = loadWagersAlerts(alertsAbsolute, staleAfterMinutes);
  const recentRunsLimit = Math.min(Math.max(options.recentRuns ?? 5, 1), 5);
  const artifactStatus = artifact.ok ? "ok" : automationStatus(artifact.reason);
  const journalStatus = journal.ok ? "ok" : automationStatus(journal.reason);
  const alertsStatus = alerts.ok ? "ok" : automationStatus(alerts.reason);

  const files = {
    artifact: {
      status: artifactStatus,
      path: artifact.source.path,
      exists: artifact.source.exists,
      mtime: artifact.source.mtime,
      ageMinutes: artifact.source.ageMinutes,
      stale: artifact.source.stale,
      bytes: artifact.source.bytes,
    },
    journal: {
      status: journalStatus,
      path: journal.source.path,
      exists: journal.source.exists,
      mtime: journal.source.mtime,
      ageMinutes: journal.source.ageMinutes,
      stale: journal.source.stale,
      bytes: journal.source.bytes,
    },
    alerts: {
      status: alertsStatus,
      path: alerts.source.path,
      exists: alerts.source.exists,
      mtime: alerts.source.mtime,
      ageMinutes: alerts.source.ageMinutes,
      stale: alerts.source.stale,
      bytes: alerts.source.bytes,
    },
  };

  const artifactBlock = {
    status: artifactStatus,
    ok: artifact.ok,
    source: artifact.source,
    artifactSource: artifact.ok ? artifact.value.source : null,
    message: artifact.ok ? null : artifact.message,
    observedSchemaVersion:
      artifact.observedSchemaVersion === undefined
        ? null
        : artifact.observedSchemaVersion,
    supportedSchemaVersion: WAGERS_ARTIFACT.schemaVersion,
  };

  const recentRuns = journal.ok
    ? journal.runs.slice(-recentRunsLimit).reverse().map(captureRunReport)
    : [];
  const journalBlock = {
    status: journalStatus,
    ok: journal.ok,
    source: journal.source,
    message: journal.ok ? null : journal.message,
    observedSchemaVersion:
      journal.observedSchemaVersion === undefined
        ? null
        : journal.observedSchemaVersion,
    supportedSchemaVersion: WAGERS_AUTOMATION.status.schemaVersion,
    runsInJournal: journal.ok ? journal.runsInJournal : null,
    runsReturned: recentRuns.length,
    recentRuns,
    malformedRunEntries: journal.ok ? journal.malformedRunEntries : [],
    malformedFields: journal.ok ? journal.malformedFields : [],
    lastSuccess: journal.ok ? journal.lastSuccess : null,
    lastFailure: journal.ok ? journal.lastFailure : null,
  };

  const alertsBlock = {
    status: alertsStatus,
    ok: alerts.ok,
    source: alerts.source,
    message: alerts.ok ? null : alerts.message,
    observedSchemaVersion:
      alerts.observedSchemaVersion === undefined
        ? null
        : alerts.observedSchemaVersion,
    supportedSchemaVersion: WAGERS_AUTOMATION.alerts.schemaVersion,
    generatedAt: alerts.ok ? alerts.generatedAt : null,
    sourceCapturedAt: alerts.ok ? alerts.sourceCapturedAt : null,
    count: alerts.ok ? alerts.alerts.length : null,
    bySeverity: alerts.ok ? alerts.bySeverity : null,
    alerts: alerts.ok ? alerts.alerts : [],
    malformedAlerts: alerts.ok ? alerts.malformedAlerts : [],
    note: alerts.ok
      ? "Alerts are derived from the latest successful capture. An empty alerts array here is a measured zero; a MISSING document is not."
      : "No alert count is reported: the alerts document was not read.",
  };

  const allMissing =
    artifactStatus === "MISSING" &&
    journalStatus === "MISSING" &&
    alertsStatus === "MISSING";
  const notes = [
    "Each file is reported independently; MISSING is never rendered as a zero. The journal is authoritative for success/failure, alerts are derived, and the artifact is only the latest snapshot.",
    "artifact.ageMinutes is the file's mtime age; the artifact's own window.ageMinutes (data age) is in report summary/quality.",
  ];
  if (journal.ok && journal.lastSuccess === null) {
    notes.push(
      "lastSuccess is null in a readable journal: the capped journal holds no successful run. That is not a failure count.",
    );
  }
  if (journal.ok && journal.lastFailure === null) {
    notes.push(
      "lastFailure is null in a readable journal: it records no failed attempt. That is not a claim that the automation is clean.",
    );
  }
  if (!journal.ok) {
    notes.push(
      "Attempt success/failure is unmeasured here: the capture journal was not read.",
    );
  }
  if (!alerts.ok) {
    notes.push(
      "Alert count is unmeasured here: the alerts document was not read.",
    );
  }

  const result = {
    available: !allMissing,
    ok: !allMissing,
    report: "automation",
    readOnly: true,
    snapshot: true,
    message: allMissing
      ? "MISSING: the artifact, the capture journal and the alerts document are all absent. Nothing about automation health was measured — this is not a healthy or a failing pipeline."
      : "Automation health read from three files on disk; each file's status is reported separately. Not a live feed.",
    ...(allMissing ? { reason: "automation_all_missing" } : {}),
    files,
    artifact: artifactBlock,
    journal: journalBlock,
    alerts: alertsBlock,
    health: {
      staleAfterMinutes,
      artifactFresh:
        artifact.source.stale === null ? null : !artifact.source.stale,
      lastOutcome: journal.ok
        ? captureOutcome(journal.lastSuccess, journal.lastFailure)
        : null,
      lastSuccessFinishedAt: journal.ok
        ? (journal.lastSuccess?.finishedAt ?? null)
        : null,
      lastFailureFinishedAt: journal.ok
        ? (journal.lastFailure?.finishedAt ?? null)
        : null,
      alertCount: alerts.ok ? alerts.alerts.length : null,
      note: "lastOutcome is derived from the journal's own timestamps and is null when they cannot decide it. Unread files contribute no value.",
    },
    notes,
  };
  return result;
}

/**
 * Validate one JSONL history line against the frozen history contract (schemaVersion 1).
 *
 * @param {unknown} parsed
 * @returns {{ status: "valid", value: Record<string, any> } | { status: "unsupported_schema", schemaVersion: number } | { status: "malformed", fields: string[] }}
 */
function validateHistoryLine(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "malformed", fields: ["line"] };
  }
  if (typeof parsed.schemaVersion !== "number") {
    return { status: "malformed", fields: ["schemaVersion"] };
  }
  if (parsed.schemaVersion !== WAGERS_AUTOMATION.history.schemaVersion) {
    return {
      status: "unsupported_schema",
      schemaVersion: parsed.schemaVersion,
    };
  }
  const fields = [];
  if (typeof parsed.capturedAt !== "string") fields.push("capturedAt");
  if (
    typeof parsed.totals !== "object" ||
    parsed.totals === null ||
    Array.isArray(parsed.totals)
  ) {
    fields.push("totals");
  }
  if (!Array.isArray(parsed.states)) {
    fields.push("states");
  } else {
    for (let index = 0; index < parsed.states.length; index += 1) {
      const row = parsed.states[index];
      if (
        typeof row !== "object" ||
        row === null ||
        typeof row.state !== "string"
      ) {
        fields.push(`states[${index}]`);
        break;
      }
    }
  }
  if (
    parsed.delta !== undefined &&
    parsed.delta !== null &&
    (typeof parsed.delta !== "object" || Array.isArray(parsed.delta))
  ) {
    fields.push("delta");
  }
  if (parsed.alerts !== undefined && !Array.isArray(parsed.alerts)) {
    fields.push("alerts");
  }
  if (
    parsed.qualityFlags !== undefined &&
    !Array.isArray(parsed.qualityFlags)
  ) {
    fields.push("qualityFlags");
  }
  if (fields.length > 0) return { status: "malformed", fields };
  return { status: "valid", value: parsed };
}

/**
 * Project one validated history capture for `report:"trends"`. The producer's totals and state
 * rows are passed through unchanged (the consumer never recomputes them).
 *
 * @param {{ lineNumber: number, value: Record<string, any> }} entry
 * @param {string | null} wantedState lower-cased state filter, or null for every state
 */
function wagersHistoryEntryReport(entry, wantedState) {
  const line = entry.value;
  const states =
    wantedState === null
      ? line.states
      : line.states.filter(
          (row) => String(row.state).toLowerCase() === wantedState,
        );
  return {
    line: entry.lineNumber,
    capturedAt: line.capturedAt,
    sourceKind: typeof line.sourceKind === "string" ? line.sourceKind : null,
    totals: line.totals,
    states,
    stateRows: states.length,
    qualityFlags: Array.isArray(line.qualityFlags) ? line.qualityFlags : null,
    alerts: Array.isArray(line.alerts) ? line.alerts : null,
    delta: line.delta ?? null,
  };
}

/**
 * `report:"trends"` — read the append-only capture history (JSONL) and return the last N
 * successful captures as a series, with the newest line's delta and alerts.
 *
 * Malformed lines are skipped and counted; a file of nothing but unknown schemaVersions is
 * UNSUPPORTED, never best-effort parsed; an absent file is MISSING, never an empty series. The
 * history carries no ticket ids: counts, deltas, timestamps and alert text only.
 *
 * @param {{ absolute: string, limit: number, stateFilter: string | null, staleAfterMinutes: number }} options
 */
function wagersTrendsReport(options) {
  const { absolute, limit, stateFilter, staleAfterMinutes } = options;
  const source = automationFileSource(
    absolute,
    WAGERS_AUTOMATION.history,
    staleAfterMinutes,
  );
  const readOnlyFailure = (reason, message, extra = {}) => ({
    available: false,
    ok: false,
    report: "trends",
    readOnly: true,
    snapshot: true,
    reason,
    message,
    source,
    ...extra,
  });
  if (!source.exists) {
    return readOnlyFailure(
      "history_missing",
      `${absolute} does not exist. The capture history is MISSING — this is NOT "no captures", ` +
        `NOT "no change" and NOT a flat trend; no successful capture was recorded there.`,
    );
  }
  const text = readText(absolute);
  if (text === null) {
    return readOnlyFailure(
      "history_unreadable",
      `${absolute} exists but could not be read. This is NOT an empty history.`,
    );
  }
  const rawLines = text.split(/\r?\n/);
  const counts = {
    totalLines: rawLines.length,
    blankLines: 0,
    validLines: 0,
    invalidJsonLines: 0,
    unsupportedSchemaLines: 0,
    malformedLines: 0,
  };
  const entries = [];
  const malformedSamples = [];
  const observedSchemaVersions = new Set();
  const addSample = (message) => {
    if (malformedSamples.length < 5) malformedSamples.push(message);
  };
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index].trim();
    if (raw === "") {
      counts.blankLines += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      counts.invalidJsonLines += 1;
      addSample(`line ${index + 1}: not valid JSON`);
      continue;
    }
    const validated = validateHistoryLine(parsed);
    if (validated.status === "unsupported_schema") {
      counts.unsupportedSchemaLines += 1;
      observedSchemaVersions.add(validated.schemaVersion);
      continue;
    }
    if (validated.status === "malformed") {
      counts.malformedLines += 1;
      addSample(
        `line ${index + 1}: ${validated.fields.join(", ")} missing or malformed`,
      );
      continue;
    }
    counts.validLines += 1;
    entries.push({ lineNumber: index + 1, value: validated.value });
  }
  const lineCounts = {
    ...counts,
    observedSchemaVersions: [...observedSchemaVersions].sort(
      (left, right) => left - right,
    ),
  };
  if (entries.length === 0 && counts.unsupportedSchemaLines > 0) {
    return readOnlyFailure(
      "history_schema_unsupported",
      `${absolute} has ${counts.unsupportedSchemaLines} line(s) whose schemaVersion is ` +
        `${JSON.stringify(lineCounts.observedSchemaVersions)}; this consumer supports schemaVersion ` +
        `${WAGERS_AUTOMATION.history.schemaVersion} only and refuses to best-effort parse an unknown history contract. ` +
        "Lines are counted, never thrown.",
      {
        lineCounts,
        observedSchemaVersions: lineCounts.observedSchemaVersions,
        supportedSchemaVersion: WAGERS_AUTOMATION.history.schemaVersion,
        malformedSamples,
      },
    );
  }
  if (
    entries.length === 0 &&
    counts.invalidJsonLines + counts.malformedLines > 0
  ) {
    return readOnlyFailure(
      "history_unparseable",
      `${absolute} exists but none of its ${counts.totalLines} line(s) satisfy the schemaVersion ` +
        `${WAGERS_AUTOMATION.history.schemaVersion} history contract ` +
        `(${counts.invalidJsonLines} invalid JSON, ${counts.malformedLines} malformed). ` +
        "This is NOT an empty history — malformed lines are skipped and counted, never thrown.",
      { lineCounts, malformedSamples },
    );
  }
  const wantedState =
    stateFilter === null ? null : stateFilter.trim().toLowerCase();
  const selected = entries.slice(-limit);
  const series = selected.map((entry) =>
    wagersHistoryEntryReport(entry, wantedState),
  );
  if (wantedState !== null && !series.some((entry) => entry.stateRows > 0)) {
    const observedStates = new Set();
    for (const entry of selected) {
      for (const row of entry.value.states) observedStates.add(row.state);
    }
    return readOnlyFailure(
      "state_not_found",
      `No state ${JSON.stringify(stateFilter)} in the ${selected.length} selected capture(s). ` +
        `Observed states: ${[...observedStates].join(", ") || "none"}.`,
      {
        stateFilter,
        lineCounts,
        statesObserved: [...observedStates],
      },
    );
  }
  const latestEntry = series.at(-1) ?? null;
  const latest =
    latestEntry === null
      ? null
      : (() => {
          const delta = latestEntry.delta;
          return {
            line: latestEntry.line,
            capturedAt: latestEntry.capturedAt,
            delta,
            fromCapturedAt:
              typeof delta?.fromCapturedAt === "string"
                ? delta.fromCapturedAt
                : null,
            toCapturedAt:
              typeof delta?.toCapturedAt === "string"
                ? delta.toCapturedAt
                : null,
            newTickets: Number.isFinite(delta?.newTickets)
              ? delta.newTickets
              : null,
            goneTickets: Number.isFinite(delta?.goneTickets)
              ? delta.goneTickets
              : null,
            migrations: Array.isArray(delta?.migrations)
              ? delta.migrations
              : null,
            alerts: latestEntry.alerts,
            qualityFlags: latestEntry.qualityFlags,
            note:
              delta === null
                ? "delta is null in the latest line: the first successful capture records null (no previous tickets file), which is NOT zero churn."
                : "Delta is the producer's comparison against the previous tickets file: counts only (newTickets, goneTickets, migrations), never ticket ids.",
          };
        })();
  const limitTruncated = entries.length > series.length;
  return {
    available: true,
    ok: true,
    report: "trends",
    readOnly: true,
    snapshot: true,
    message:
      series.length === 0
        ? "The capture history exists but has no valid capture lines yet. That is an empty history, not MISSING."
        : "Derived from an append-only capture-history file on disk; one line per successful capture. Not a live feed.",
    source: {
      ...source,
      schemaVersion: WAGERS_AUTOMATION.history.schemaVersion,
    },
    limit,
    stateFilter,
    lineCounts,
    malformedSamples,
    window: {
      capturesRequested: limit,
      capturesReturned: series.length,
      validLines: counts.validLines,
      totalLines: counts.totalLines,
      limitTruncated,
      firstCapturedAt: entries.at(0)?.value.capturedAt ?? null,
      lastCapturedAt: entries.at(-1)?.value.capturedAt ?? null,
      note: "The series is the last `limit` valid captures in file order (append order), not a re-sort by timestamp.",
    },
    truncation: {
      truncated: false,
      rotated: false,
      limitTruncated,
      note: "truncated/rotated are false because this consumer CANNOT observe the producer's atomic rotation or retention from JSONL content; that is not a claim that no rotation ever happened. limitTruncated=true means older captures were omitted from THIS report by `limit`, not that the file lost them.",
    },
    series,
    latest,
    notes: [
      "History carries no ticket ids by contract; this report exposes counts, deltas, timestamps and alert text only.",
      "qualityFlags/alerts are null when a line did not record the field, and [] when the producer measured zero; those are different answers.",
    ],
  };
}

/**
 * Parse `bun run check:secrets`. A non-zero exit is DATA — the repo's checks exit 1 for
 * "measured a problem" — so findings are reported rather than thrown. The check masks every
 * value itself; this projection adds no raw text.
 *
 * @param {{ ok: boolean, exitCode: number | null, timedOut: boolean, spawnError: string | null, stdout: string, stderr: string, durationMs: number }} result
 */
function secretScanReport(result) {
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const scannedMatch = /(\d+) tracked file\(s\)/.exec(text);
  const findings = [];
  for (const line of text.split("\n")) {
    const match = /^\s+(.+):(\d+) \[([a-z-]+)\] (.+)$/.exec(line);
    if (match === null) continue;
    findings.push({
      path: match[1],
      line: Number(match[2]),
      kind: match[3],
      masked: match[4].trim(),
    });
  }
  return {
    ok: result.ok && !result.timedOut && result.spawnError === null,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    durationMs: result.durationMs,
    scanned: scannedMatch === null ? null : Number(scannedMatch[1]),
    findingCount: findings.length,
    findings,
    output: excerpt(text),
  };
}

/**
 * Audit the capture store. A capture is "clean" only when it carries a redaction block that
 * says so; an absent block is reported as absent, never as clean. `bodyRecorded` distinguishes
 * "the redaction pass found nothing" from "no response text was recorded at all".
 *
 * @param {string} repoPath
 * @param {ReturnType<typeof readEvidence>} manifest
 */
function captureAuditReport(repoPath, manifest) {
  const manifestValue =
    manifest.ok && typeof manifest.value === "object" && manifest.value !== null
      ? manifest.value
      : null;
  const captures =
    manifestValue !== null && Array.isArray(manifestValue.captures)
      ? manifestValue.captures
      : [];
  const rows = [];
  for (const entry of captures) {
    if (typeof entry !== "object" || entry === null) continue;
    const file = String(entry.file ?? "");
    const capture =
      file === ""
        ? null
        : readEvidence(repoPath, `${EVIDENCE.captures.store}/${file}`);
    const value =
      capture !== null &&
      capture.ok &&
      typeof capture.value === "object" &&
      capture.value !== null
        ? capture.value
        : null;
    const redaction = value?.redaction ?? entry.redaction ?? null;
    const fieldsRedacted = Array.isArray(redaction?.fieldsRedacted)
      ? redaction.fieldsRedacted.length
      : Number.isFinite(Number(redaction?.fieldsRedacted))
        ? Number(redaction.fieldsRedacted)
        : null;
    const piiRedacted = Array.isArray(redaction?.piiRedacted)
      ? redaction.piiRedacted.length
      : Number.isFinite(Number(redaction?.piiRedacted))
        ? Number(redaction.piiRedacted)
        : null;
    const provenanceBody =
      value?.provenance?.body ?? entry?.provenance?.body ?? null;
    const responseBytes = Number(
      value?.response?.bytes ?? entry?.responseBytes ?? Number.NaN,
    );
    rows.push({
      file,
      path: entry.operation?.path ?? null,
      mode: entry.mode ?? null,
      capturedAt: entry.capturedAt ?? null,
      ageMinutes: ageMinutesSince(entry.capturedAt),
      derivedTier: entry.derivedTier ?? null,
      captureFileExists: capture?.exists === true,
      redaction: {
        present: redaction !== null && redaction !== undefined,
        clean: redaction?.clean === true,
        fieldsRedacted,
        piiRedacted,
      },
      provenanceBody,
      responseBytes: Number.isFinite(responseBytes) ? responseBytes : null,
      bodyRecorded:
        provenanceBody !== "none" &&
        Number.isFinite(responseBytes) &&
        responseBytes > 0,
    });
  }
  const sumRedacted = (key) =>
    rows.reduce(
      (total, row) =>
        total + (Number.isFinite(row.redaction[key]) ? row.redaction[key] : 0),
      0,
    );
  return {
    total: rows.length,
    redactionPresent: rows.filter((row) => row.redaction.present).length,
    clean: rows.filter((row) => row.redaction.clean).length,
    notClean: rows.filter(
      (row) => row.redaction.present && !row.redaction.clean,
    ).length,
    missingRedaction: rows.filter((row) => !row.redaction.present).length,
    captureFileMissing: rows.filter((row) => !row.captureFileExists).length,
    fieldsRedacted: sumRedacted("fieldsRedacted"),
    piiRedacted: sumRedacted("piiRedacted"),
    bodiesRecorded: rows.filter((row) => row.bodyRecorded).length,
    bodiesNotRecorded: rows.filter((row) => !row.bodyRecorded).length,
    byDerivedTier: countField(rows, "derivedTier"),
    rows,
  };
}

/**
 * Parse the identifier scanner's JSON. Literal identifiers never leave the scanner, so this
 * projection can only carry counts and paths.
 *
 * @param {{ ok: boolean, timedOut: boolean, spawnError: string | null, stdout: string, stderr: string }} result
 * @param {number} limit
 */
function identifierScanReport(result, limit) {
  if (!result.ok) {
    return {
      ok: false,
      reason: result.timedOut ? "scanner_timed_out" : "scanner_failed",
      message: result.spawnError ?? "the identifier scanner did not complete",
      output: excerpt(
        [result.stdout, result.stderr].filter(Boolean).join("\n"),
      ),
    };
  }
  const parsed = parseJson(result.stdout);
  const value =
    parsed.ok && typeof parsed.value === "object" && parsed.value !== null
      ? parsed.value
      : null;
  if (value === null) {
    return {
      ok: false,
      reason: "scanner_output_unparseable",
      message:
        "the scanner exited 0 but its stdout was not the expected JSON object",
      output: excerpt(result.stdout),
    };
  }
  const hits = (Array.isArray(value.hits) ? value.hits : [])
    .filter(
      (hit) =>
        typeof hit === "object" &&
        hit !== null &&
        typeof hit.path === "string" &&
        Number.isFinite(Number(hit.count)),
    )
    .map((hit) => {
      const count = Number(hit.count);
      const knownAgent = Number.isFinite(Number(hit.knownAgent))
        ? Math.min(count, Math.max(0, Number(hit.knownAgent)))
        : 0;
      return {
        path: hit.path,
        count,
        knownAgent,
        unclassified: count - knownAgent,
        class: hit.path.split("/")[0] ?? "unknown",
      };
    })
    .sort((left, right) => right.count - left.count);
  const calibration = (
    Array.isArray(value.calibration) ? value.calibration : []
  )
    .filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.path === "string",
    )
    .map((entry) => ({
      path: entry.path,
      count: Number.isFinite(Number(entry.count)) ? Number(entry.count) : null,
    }));
  const calibrationComplete =
    calibration.length > 0 &&
    calibration.every((entry) => entry.count !== null);
  const calibrationHits = calibration.reduce(
    (total, entry) => total + (entry.count ?? 0),
    0,
  );
  const totalIdentifiers = hits.reduce((total, hit) => total + hit.count, 0);
  const knownAgentHits = hits.reduce((total, hit) => total + hit.knownAgent, 0);
  const byClass = {};
  for (const hit of hits) {
    const bucket = byClass[hit.class] ?? {
      files: 0,
      identifiers: 0,
      knownAgent: 0,
    };
    bucket.files += 1;
    bucket.identifiers += hit.count;
    bucket.knownAgent += hit.knownAgent;
    byClass[hit.class] = bucket;
  }
  const scanned = Number(value.scanned);
  const unclassifiedIdentifiers = totalIdentifiers - knownAgentHits;
  return {
    ok: true,
    scanned: Number.isFinite(scanned) ? scanned : null,
    filesWithIdentifiers: hits.length,
    totalIdentifiers,
    knownAgentHits,
    unclassifiedIdentifiers,
    byClass,
    severity:
      totalIdentifiers === 0
        ? "clean"
        : unclassifiedIdentifiers === 0
          ? "internal-only"
          : "unclassified",
    calibration: {
      files: calibration,
      hits: calibrationHits,
      ok: calibrationComplete && calibrationHits === 0,
      complete: calibrationComplete,
      note:
        "Labeled-safe fixtures (contests, scoreboard). A non-zero count means the scanner " +
        "drifted; a null count means the fixture was missing, which is not a pass.",
    },
    files: hits.slice(0, limit),
    truncated: hits.length > limit,
    scope:
      "git-tracked data/, docs/ and static/ files with a JSON/HTML/JS/MJS/CSS extension",
    withheld:
      "Identifier literals are withheld on purpose: the scanner returns counts and paths " +
      "only, so this tool cannot become the PII leak it reports.",
  };
}

/**
 * Parse `check:route-surface`'s count line. Returns null when the line is absent (a failing
 * check prints findings instead), so an unreadable count is never reported as zero routes.
 *
 * The line looks like:
 *   check:route-surface: ok — 50 served path(s) (41/41 local-route + 9 UI aliases),
 *   52 declared (41 local-route, 2 upstream-route, 9 documented-not-implemented)
 *
 * @param {string} text
 */
function parseRouteSurfaceCounts(text) {
  const served = /(\d+) served path\(s\)/.exec(text);
  const local = /\((\d+)\/(\d+) local-route/.exec(text);
  const ui = /(\d+) UI aliases/.exec(text);
  const declared = /(\d+) declared \(([^)]*)\)/.exec(text);
  if (served === null && declared === null) return null;
  const declaredByCategory = {};
  if (declared !== null) {
    for (const part of declared[2].split(",")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(part);
      if (match !== null) declaredByCategory[match[2]] = Number(match[1]);
    }
  }
  return {
    servedPaths: served === null ? null : Number(served[1]),
    localRoutes: local === null ? null : Number(local[1]),
    servedLocalRoutes: local === null ? null : Number(local[2]),
    uiAliases: ui === null ? null : Number(ui[1]),
    declared: declared === null ? null : Number(declared[1]),
    declaredByCategory,
  };
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
        'stale flag is a reported heuristic, not a verdict. report="capture" switches to ' +
        "the live-capture view: each live artifact's own provenance stamp (capturedAt / " +
        "observedAt / extractedAt / generatedAt), its age against a freshness budget, and " +
        "the latest run per source from data/capture-health.json (written by bun run " +
        "capture:all). An absent journal is reported MISSING, not as zero sources.",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description:
              'inventory (default) lists every dataset; "capture" reports live-artifact freshness and the capture run journal.',
          },
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
        if (
          request.report !== undefined &&
          (typeof request.report !== "string" ||
            !["inventory", "capture"].includes(request.report))
        ) {
          return {
            available: false,
            reason: "unknown_report",
            message: `Unknown report ${JSON.stringify(request.report)}. Allowed: inventory, capture.`,
          };
        }
        if (request.report === "capture") {
          const nowMs = Date.now();
          const artifacts = LIVE_ARTIFACTS.map((artifact) => {
            const absolute = `${repoPath}/${artifact.path}`;
            const stats = statFile(absolute);
            const parsed = stats.exists
              ? parseJson(readText(absolute))
              : { ok: false, value: null };
            let stampField = null;
            let stampedAt = null;
            if (parsed.ok && parsed.value !== null) {
              for (const field of ARTIFACT_STAMP_FIELDS) {
                const value = parsed.value[field];
                if (typeof value === "string" && value !== "") {
                  stampField = field;
                  stampedAt = value;
                  break;
                }
              }
            }
            const stampMs =
              stampedAt === null ? Number.NaN : Date.parse(stampedAt);
            const stampAgeMinutes = Number.isFinite(stampMs)
              ? Math.max(0, Math.round((nowMs - stampMs) / 60_000))
              : null;
            const effectiveAgeMinutes = stampAgeMinutes ?? stats.ageMinutes;
            const stale =
              effectiveAgeMinutes === null
                ? null
                : effectiveAgeMinutes > artifact.budgetMinutes;
            return {
              name: artifact.name,
              path: artifact.path,
              role: artifact.role,
              capturePath: artifact.capturePath,
              pasteFileName: artifact.pasteFileName,
              refresh: CAPTURE_REFRESH_COMMANDS[artifact.capturePath] ?? null,
              exists: stats.exists,
              bytes: stats.bytes,
              mtime: stats.mtime,
              artifactAgeMinutes: stats.ageMinutes,
              stampField,
              stampedAt,
              stampAgeMinutes,
              budgetMinutes: artifact.budgetMinutes,
              stale,
            };
          });

          const healthAbsolute = `${repoPath}/${CAPTURE_HEALTH.path}`;
          const healthStats = statFile(healthAbsolute);
          const healthParsed = healthStats.exists
            ? parseJson(readText(healthAbsolute))
            : { ok: false, value: null };
          const healthValue =
            healthParsed.ok && typeof healthParsed.value === "object"
              ? healthParsed.value
              : null;
          const ledgerPresent =
            healthValue !== null && healthValue.schemaVersion === 1;
          const ledgerSources = [];
          if (ledgerPresent && typeof healthValue.sources === "object") {
            for (const [source, record] of Object.entries(
              healthValue.sources,
            )) {
              if (record === null || typeof record !== "object") continue;
              const finishedMs = Date.parse(String(record.finishedAt ?? ""));
              ledgerSources.push({
                source,
                operation: record.operation ?? source,
                artifact: record.artifact ?? null,
                outcome: record.outcome ?? "unknown",
                transport: record.transport ?? null,
                httpStatus: record.httpStatus ?? null,
                rows: record.rows ?? null,
                bytes: record.bytes ?? null,
                artifactWritten: record.artifactWritten === true,
                keptPreviousArtifact: record.keptPreviousArtifact === true,
                error: record.error ?? null,
                finishedAt: record.finishedAt ?? null,
                ageMinutes: Number.isFinite(finishedMs)
                  ? Math.max(0, Math.round((nowMs - finishedMs) / 60_000))
                  : null,
              });
            }
          }
          const staleArtifacts = artifacts
            .filter((artifact) => artifact.stale === true)
            .map((artifact) => artifact.name);
          const failedSources = ledgerSources
            .filter((source) => source.outcome === "failed")
            .map((source) => source.source);
          return {
            available: true,
            ok: true,
            report: "capture",
            source: {
              artifacts: LIVE_ARTIFACTS.length,
              health: CAPTURE_HEALTH.path,
            },
            artifacts,
            ledger: ledgerPresent
              ? {
                  present: true,
                  path: CAPTURE_HEALTH.path,
                  updatedAt: healthValue.updatedAt ?? null,
                  transport: healthValue.transport ?? null,
                  ageMinutes: healthStats.ageMinutes,
                  sources: ledgerSources,
                }
              : {
                  present: false,
                  path: CAPTURE_HEALTH.path,
                  note: `MISSING — no capture run has written ${CAPTURE_HEALTH.path}; this is not "0 sources captured".`,
                },
            staleArtifacts,
            failedSources,
            stalePasteArtifacts: artifacts
              .filter(
                (artifact) =>
                  artifact.stale === true && artifact.capturePath === "paste",
              )
              .map((artifact) => ({
                name: artifact.name,
                pasteFileName: artifact.pasteFileName,
                refresh: artifact.refresh,
              })),
            nextStep:
              staleArtifacts.length > 0 || failedSources.length > 0
                ? [
                    "bun run capture:all --agent <id> --customer <id>",
                    "bun run capture:dom --input <paste dir>",
                  ].join(" then ")
                : "no stale artifact and no failed source reported by the last run",
          };
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
  // sportsdesk_wagers — the v2 wager-state table, read from the snapshot artifact
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_wagers",
      description:
        "Read-only wager table by GSLive wager state, from the v2 snapshot artifact " +
        "(Scratch/gslive-wagers-by-state.summary.json, produced by " +
        "scripts/gslive_wagers_by_state.ts): legs vs wagers (distinct Ticket), deduped wagerRisk " +
        "vs leg-scoped legRisk, spanning wagers, per-state rows, the producer's computed quality " +
        'block and file freshness. Reports: "summary" (default: identity, totals, limited states, ' +
        'quality), "states" (the per-state rows, optionally filtered by state), "quality" (the ' +
        'computed data-quality block and its derived flags), "automation" (capture journal ' +
        "lastSuccess/lastFailure/recent runs, current alerts, and the artifact age/stale — each " +
        'file reported independently, so a missing journal is MISSING, never "no failures") and ' +
        '"trends" (the last N captures from the append-only capture history JSONL: per-capture ' +
        "totals and state rows, the latest delta.migrations/newTickets/goneTickets, latest alerts; " +
        "malformed JSONL lines are skipped and counted). A missing artifact is MISSING, an " +
        "unparseable one is an explicit error, and a schemaVersion other than 2 is UNSUPPORTED — " +
        "never an empty table and never a best-effort parse. This is a snapshot, not a live feed.",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description:
              "One of: summary (default), states, quality, automation, trends.",
          },
          state: {
            type: "string",
            description:
              "Optional filter on one observed GSLive wager state (case-insensitive, e.g. pending). Applies to the state rows in summary/states and to each capture's rows in trends; an unobserved state is refused with the observed states.",
          },
          limit: {
            type: "number",
            description:
              "Rows for list reports: state rows for summary/states, or captures for trends (1-100, default 10).",
          },
        },
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        const report =
          request.report === undefined ? "summary" : request.report;
        if (typeof report !== "string") {
          return invalidArguments(
            `report must be one of: ${WAGERS_REPORTS.join(", ")}.`,
          );
        }
        if (!WAGERS_REPORTS.includes(report)) {
          return {
            available: false,
            reason: "unknown_report",
            message: `Unknown report ${JSON.stringify(report)}. Allowed: ${WAGERS_REPORTS.join(", ")}.`,
          };
        }
        if (
          request.state !== undefined &&
          (typeof request.state !== "string" || request.state.trim() === "")
        ) {
          return invalidArguments(
            "state must be a non-empty string when provided.",
          );
        }
        const stateFilter =
          request.state === undefined ? null : request.state.trim();
        const requestedLimit = request.limit === undefined ? 10 : request.limit;
        if (
          typeof requestedLimit !== "number" ||
          !Number.isInteger(requestedLimit) ||
          requestedLimit < 1 ||
          requestedLimit > 100
        ) {
          return invalidArguments("limit must be an integer from 1 to 100.");
        }
        if (report === "automation") {
          return wagersAutomationReport({
            artifactAbsolute: resolveArtifactPath(
              repoPath,
              settings.wagersArtifact,
            ),
            statusAbsolute: resolveRepoPath(
              repoPath,
              settings.wagersStatus,
              WAGERS_AUTOMATION.status.path,
            ),
            alertsAbsolute: resolveRepoPath(
              repoPath,
              settings.wagersAlerts,
              WAGERS_AUTOMATION.alerts.path,
            ),
            staleAfterMinutes,
            recentRuns: 5,
          });
        }
        if (report === "trends") {
          return wagersTrendsReport({
            absolute: resolveRepoPath(
              repoPath,
              settings.wagersHistory,
              WAGERS_AUTOMATION.history.path,
            ),
            limit: requestedLimit,
            stateFilter,
            staleAfterMinutes,
          });
        }
        const absolute = resolveArtifactPath(repoPath, settings.wagersArtifact);
        const loaded = loadWagersArtifact(absolute, staleAfterMinutes);
        if (!loaded.ok) {
          return {
            available: false,
            ok: false,
            report,
            reason: loaded.reason,
            message: loaded.message,
            source: loaded.source,
            ...(loaded.observedSchemaVersion === undefined
              ? {}
              : { observedSchemaVersion: loaded.observedSchemaVersion }),
            ...(loaded.supportedSchemaVersion === undefined
              ? {}
              : { supportedSchemaVersion: loaded.supportedSchemaVersion }),
            ...(loaded.missingFields === undefined
              ? {}
              : { missingFields: loaded.missingFields }),
          };
        }
        const value = loaded.value;
        const statesInArtifact = value.states;
        let matched = statesInArtifact;
        if (stateFilter !== null) {
          const wanted = stateFilter.toLowerCase();
          matched = statesInArtifact.filter(
            (row) => String(row.state).toLowerCase() === wanted,
          );
          if (matched.length === 0) {
            return {
              available: false,
              ok: false,
              report,
              reason: "state_not_found",
              message: `No state ${JSON.stringify(stateFilter)} in the artifact. Observed states: ${statesInArtifact
                .map((row) => row.state)
                .join(", ")}.`,
              source: {
                ...loaded.source,
                schemaVersion: WAGERS_ARTIFACT.schemaVersion,
              },
              stateFilter,
              statesInArtifact: statesInArtifact.length,
            };
          }
        }
        const states = matched.slice(0, requestedLimit);
        const result = {
          available: true,
          ok: true,
          report,
          readOnly: true,
          snapshot: true,
          message:
            "Derived from a snapshot artifact, not a live feed. " +
            (typeof value.moneyScope === "string" ? value.moneyScope : ""),
          source: {
            ...loaded.source,
            schemaVersion: WAGERS_ARTIFACT.schemaVersion,
            generatedAt:
              typeof value.generatedAt === "string" ? value.generatedAt : null,
          },
          artifactSource: value.source,
          window: wagerWindowReport(value.window),
          identity: value.identity,
          totals: value.totals,
          states,
          statesInArtifact: statesInArtifact.length,
          statesMatched: matched.length,
          statesReturned: states.length,
          stateFilter,
          quality: value.quality,
          qualityFlags: wagerQualityFlags(value.quality),
          qualityFlagsNote:
            "Derived at call time from the artifact's computed quality block; an empty list means no measured flag, not a clean bill.",
          moneyScope: value.moneyScope,
          notes: value.notes,
        };
        if (report === "quality") {
          result.derived = wagerQualitySummary(value.quality);
        }
        return result;
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
        'or with positive CLV, ranked by sharp score; the cutoff defaults to the cohort p90. "agent" rolls the book ' +
        "up per agent (customers, tickets, volume, net, CLV, sharp, churn), optionally " +
        'filtered by agentId. "profile" returns deep intelligence for one customerId: ' +
        "cohort percentile ranks (volume, net, CLV, sharp, churn, hold, wager limit, delay), " +
        "sampled-ticket behavior (risk distribution, ROI, win rate, leagues, markets, " +
        "channels, UTC hour histogram, days since the last sampled ticket), agent-peer " +
        "position, shared-ip_subnet peers and derived flags, with the cohort p90 cutoffs and " +
        'flag definitions returned. "signals" ranks cohort-wide derived signals (sharp money, ' +
        "high churn, whales, book-profitable, dormant, multi-account networks) and returns " +
        'the cutoff each rule used. "compare" places 2-5 customerIds side by side using the ' +
        "same derived profile. All ranks/cutoffs are recomputed from the book at call time. " +
        '"integrity" measures provenance features (documentation IP ranges, sequential ' +
        "subnets, placeholder selections, generated id families, coarse timestamp grids, " +
        "uniform sample sizes, duplicate rollups) and returns a derived character verdict, " +
        "so a fixture-derived ranking cannot be read as an observation of real customers.",
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
              'For "sharp": sharp_score cutoff, 0-100. Omit to use the cohort p90; positive CLV also qualifies.',
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
          "integrity",
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
        const book = readCustomerBook(repoPath);
        if (!book.ok) {
          return {
            available: false,
            reason: book.reason,
            message: book.message,
            source: book.source,
          };
        }
        const rows = book.rows;
        const source = book.source;
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
          // Same default as sportsdesk_sharp: the book's p90, not a checked-in 70, so the
          // two surfaces cannot disagree about what "sharp" means on the same book.
          const sharpCutoffs = cohortCutoffs(buildCustomerCohort(rows));
          const derivedThreshold = sharpCutoffs.sharpP90;
          const threshold = request.minSharp ?? derivedThreshold ?? 70;
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
            thresholdSource:
              request.minSharp !== undefined
                ? "caller"
                : derivedThreshold !== null
                  ? "cohort-p90"
                  : "fallback-policy",
            cutoffs: sharpCutoffs,
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
          const bookAudit = bookIntegrity(rows);
          return {
            available: true,
            ok: true,
            report: request.report,
            found: true,
            customerId: match.customer_id,
            totalCustomers: rows.length,
            source,
            bookIntegrity: compactIntegrity(bookAudit),
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
          const bookAudit = bookIntegrity(rows);
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
            bookIntegrity: compactIntegrity(bookAudit),
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
              interpretation:
                bookAudit.subnets.documentationRange > 0 ||
                (bookAudit.subnets.sequentialShare ?? 0) >= 0.2
                  ? "ip_subnet values are documentation or sequential test ranges, so these clusters reflect how the fixture was built, not observed multi-accounting."
                  : "No subnet provenance anomaly was detected; clusters still describe this book only.",
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
              "are descriptive, not a recommendation." +
              (bookAudit.matchedFeatures > 0
                ? ` ${bookAudit.implication}`
                : ""),
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
          const bookAudit = bookIntegrity(rows);
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
            bookIntegrity: compactIntegrity(bookAudit),
            cutoffs,
            customers: found.map((row) =>
              customerProfile(row, cohort, cutoffs),
            ),
            note: 'Same derived profile as report "profile"; deltas are for the caller to read off the shared cohort ranks.',
          };
        }
        if (request.report === "integrity") {
          const audit = bookIntegrity(rows);
          const ticketTotal = rows.reduce(
            (total, row) =>
              total +
              (Array.isArray(row?.recent_tickets)
                ? row.recent_tickets.length
                : 0),
            0,
          );
          return {
            available: true,
            ok: true,
            report: request.report,
            book: { customers: rows.length, tickets: ticketTotal },
            source,
            integrity: audit,
            note:
              "Every feature is measured from the book; no feature is asserted by name. " +
              "The character verdict is a count of matched features, not a hand-written label.",
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
  // sportsdesk_links — canonical GSLive Manager deep links for one customer
  // ---------------------------------------------------------------------------

  /**
   * SPA vocabulary for `#/events/bet-history`, mirrored from
   * lib/gslive_manager_deeplink_sidecar.ts (read out of the shipped SPA bundle, 2026-11-03).
   * Stage 1 of the verifier compares both lists so the copy cannot drift silently.
   */
  const GSLIVE_LINK_STATES = [
    "",
    "pending",
    "win",
    "lose",
    "action",
    "canceled",
    "rejected",
    "bad-credit",
    "payment-failed",
    "eco",
    "unknown",
  ];
  const GSLIVE_GROUP_KINDS = ["player", "agent", "custom", "line-type"];
  /** URL-expressible Filters-panel values, mapped to the CLI flag that forwards each one. */
  const GSLIVE_FILTER_FLAGS = {
    agent: "--agent",
    betId: "--bet-id",
    betGroupId: "--bet-group-id",
    freeBetId: "--free-bet-id",
    kind: "--kind",
    groupName: "--group-name",
    period: "--period",
    sportId: "--sport",
    marketIds: "--market",
  };

  ctx.tools.register(
    defineReadTool({
      name: "sportsdesk_links",
      description:
        "Canonical GSLive Manager (Partner 118) deep links for one customer, built by the repo's " +
        "own link contract: `#/reports/users` 7-day, 14-day and churn windows, the " +
        "`#/events/bet-history` calcTime/betTime sidecars, and the per-player bet-history link " +
        "over `windowDays` desk days ending on `date` (1-31, default 1). `state` filters the " +
        "per-player links with the SPA's own state-select vocabulary, and `filters` adds the " +
        "remaining URL-expressible Filters-panel values (agent, bet ids, group kind/name, period, " +
        'sport, market). The grid\'s "Filters" tool panel is client-side AG Grid state: "Bet ' +
        'price" is a hidden grid column, not a query parameter, so it cannot be a link filter. ' +
        "Shells `bun cli/sportsdesk_cli.ts gslive … --json`, " +
        "so the window/DST/filter contract has one implementation. Read-only: no live manager " +
        "call, and every link carries a fresh cache-buster tick.",
      parameters: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: 'Customer login, e.g. "CCC107" or "player_CCC107".',
          },
          state: {
            type: "string",
            description:
              'SPA state filter for #/events/bet-history: "" (all, default), pending, win, lose, action, canceled, rejected, bad-credit, payment-failed, eco, unknown.',
          },
          windowDays: {
            type: "number",
            description:
              "Desk days in the per-player bet-history window, 1-31 (default 1).",
          },
          date: {
            type: "string",
            description:
              "Desk date (YYYY-MM-DD, America/Chicago) the window ends on; defaults to today.",
          },
          filters: {
            type: "object",
            description:
              "URL-expressible Filters-panel values for the #/events/bet-history links. The grid's " +
              'own Filters panel is AG Grid state and is not accepted here; in particular "Bet ' +
              'price" is a hidden grid column (fVal_new) with no URL parameter.',
            additionalProperties: false,
            properties: {
              agent: { type: "string", description: "Agent login filter." },
              betId: {
                type: "string",
                description:
                  'Bet ids, e.g. "b123 b456" or "123,456"; the leading b is stripped by the SPA.',
              },
              betGroupId: {
                type: "string",
                description:
                  'Bet-group ids, e.g. "g777"; the leading g is stripped by the SPA.',
              },
              freeBetId: { type: "string", description: "Free-bet id filter." },
              kind: {
                type: "string",
                description: "Group Kind: player, agent, custom, or line-type.",
              },
              groupName: { type: "string", description: "Group name filter." },
              period: {
                type: "string",
                description:
                  'Period code (h1/h2/ht/s1-s10) or a console label such as "3rd Quarter"; a label requires sportId and is resolved against the captured sportPeriods vocabulary.',
              },
              sportId: {
                type: "string",
                description: 'Sport id (sId); "-1" means all sports.',
              },
              marketIds: {
                type: "string",
                description:
                  'Market ids, e.g. "m1,m2"; the SPA comma-joins them.',
              },
            },
          },
        },
        required: ["customerId"],
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        if (
          typeof request.customerId !== "string" ||
          request.customerId.trim() === ""
        ) {
          return invalidArguments(
            "customerId must be a non-empty customer login.",
          );
        }
        const state = request.state ?? "";
        if (typeof state !== "string" || !GSLIVE_LINK_STATES.includes(state)) {
          return invalidArguments(
            `state must be one of: ${GSLIVE_LINK_STATES.map((entry) => JSON.stringify(entry)).join(", ")} (observed values only).`,
          );
        }
        const windowDays = request.windowDays ?? 1;
        if (
          !Number.isInteger(windowDays) ||
          windowDays < 1 ||
          windowDays > 31
        ) {
          return invalidArguments("windowDays must be an integer 1-31.");
        }
        const date = request.date ?? "";
        if (
          typeof date !== "string" ||
          (date !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(date))
        ) {
          return invalidArguments("date must be YYYY-MM-DD when provided.");
        }
        const filters = request.filters ?? {};
        if (
          typeof filters !== "object" ||
          filters === null ||
          Array.isArray(filters)
        ) {
          return invalidArguments(
            "filters must be an object of Filters-panel values.",
          );
        }
        for (const [key, value] of Object.entries(filters)) {
          if (!Object.hasOwn(GSLIVE_FILTER_FLAGS, key)) {
            return invalidArguments(
              `unknown filters key ${JSON.stringify(key)}. Allowed: ${Object.keys(GSLIVE_FILTER_FLAGS).join(", ")}.`,
            );
          }
          if (typeof value !== "string" || value.trim() === "") {
            return invalidArguments(
              `filters.${key} must be a non-empty string.`,
            );
          }
        }
        if (
          filters.kind !== undefined &&
          !GSLIVE_GROUP_KINDS.includes(filters.kind)
        ) {
          return invalidArguments(
            `filters.kind must be one of: ${GSLIVE_GROUP_KINDS.join(", ")}.`,
          );
        }

        const argv = [
          "cli/sportsdesk_cli.ts",
          "gslive",
          request.customerId.trim(),
          "--json",
          "--window",
          String(windowDays),
        ];
        if (state !== "") argv.push("--state", state);
        if (date !== "") argv.push("--date", date);
        for (const [key, flag] of Object.entries(GSLIVE_FILTER_FLAGS)) {
          const value = filters[key];
          if (typeof value === "string" && value.trim() !== "") {
            argv.push(flag, value.trim());
          }
        }
        const command = `bun ${argv.join(" ")}`;
        const result = await runBun(argv, settings.timeoutMs);
        const parsed = parseJson(result.stdout.trim());
        if (!result.ok || !parsed.ok) {
          return {
            available: false,
            reason: result.timedOut ? "timed_out" : "cli_failed",
            message:
              result.spawnError === null
                ? `\`${command}\` exited ${result.exitCode}${result.timedOut ? " (timed out)" : ""} without a JSON descriptor.`
                : `Could not run the link builder: ${result.spawnError}`,
            command,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            stderr: truncate(result.stderr, MAX_EXCERPT),
          };
        }

        return {
          available: true,
          ok: true,
          command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          links: parsed.value,
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
  // sportsdesk_endpoints — what does the endpoint catalog actually prove?
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_endpoints",
      description:
        "Read-only endpoint evidence scan over docs/evidence/ledger.json, " +
        "dist/openapi.json, the capture manifest and the repo's PROBE_OPS catalog. " +
        "Everything is DERIVED at call time: the operation count, the tier distribution " +
        "(A captured contract .. E operation surface), which operations the ledger marks " +
        "captured, which ledger paths the published spec omits, which spec paths have no " +
        "ledger row (upstream /cloud/api routes separated from local daemon routes), the " +
        "probe-catalog operations the ledger does not carry, and the evidence surfaces " +
        'still missing from the spec. Reports: "summary" (counts and source freshness), ' +
        '"list" (one row per operation with its latest capture; filter by q/tier/captured), ' +
        '"gaps" (operations without a captured response or a capture file, each with the ' +
        'ledger\'s requiredCapture text), "surfaces", and "service" (runs the repo\'s ' +
        "check:route-surface — the served-vs-declared-vs-published comparison — and parses " +
        "its counts; it does not call the running process). A missing ledger, spec or " +
        "manifest is reported as missing, never as zero endpoints; ledgerCaptured and " +
        "manifestCaptured are different evidence claims and are not merged.",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description:
              "One of: summary (default), list, gaps, surfaces, service.",
          },
          q: {
            type: "string",
            description:
              'For "list": case-insensitive substring of the path, tag or operationId.',
          },
          tier: {
            type: "string",
            description: 'For "list": one evidence tier — A, B, C, D or E.',
          },
          captured: {
            type: "boolean",
            description:
              'For "list": true keeps operations with a capture file, false keeps those without one.',
          },
          limit: {
            type: "number",
            description: "Rows for list reports (1-100, default 20).",
          },
        },
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        const reports = ["summary", "list", "gaps", "surfaces", "service"];
        const report = request.report ?? "summary";
        if (typeof report !== "string" || !reports.includes(report)) {
          return {
            available: false,
            reason: "unknown_report",
            message: `Unknown report ${JSON.stringify(request.report)}. Allowed: ${reports.join(", ")}.`,
          };
        }
        const limit = request.limit ?? 20;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        ) {
          return invalidArguments("limit must be an integer from 1 to 100.");
        }
        if (request.q !== undefined && typeof request.q !== "string") {
          return invalidArguments("q must be a string.");
        }
        if (request.tier !== undefined && !TIER_ORDER.includes(request.tier)) {
          return invalidArguments(
            `tier must be one of ${TIER_ORDER.join(", ")}.`,
          );
        }
        if (
          request.captured !== undefined &&
          typeof request.captured !== "boolean"
        ) {
          return invalidArguments("captured must be a boolean.");
        }

        const ledger = readEvidence(repoPath, EVIDENCE.ledger.path);
        if (!ledger.ok) {
          return {
            available: false,
            reason: ledger.exists ? "ledger_unparseable" : "ledger_missing",
            message: ledger.exists
              ? `${EVIDENCE.ledger.path} exists but does not parse as JSON. This is NOT an empty endpoint catalog.`
              : `${EVIDENCE.ledger.path} does not exist. This is NOT an empty endpoint catalog — no operation was measured.`,
            sources: { ledger: evidenceStamp(ledger) },
          };
        }
        const ledgerValue =
          typeof ledger.value === "object" && ledger.value !== null
            ? ledger.value
            : {};
        const operations = Array.isArray(ledgerValue.operations)
          ? ledgerValue.operations
          : [];
        const surfaces = Array.isArray(ledgerValue.surfaces)
          ? ledgerValue.surfaces
          : [];

        const spec = readEvidence(repoPath, EVIDENCE.spec.path);
        const specValue =
          spec.ok && typeof spec.value === "object" && spec.value !== null
            ? spec.value
            : null;
        const specPaths =
          specValue !== null &&
          typeof specValue.paths === "object" &&
          specValue.paths !== null
            ? new Set(Object.keys(specValue.paths))
            : null;

        const manifest = readEvidence(repoPath, EVIDENCE.captures.path);
        const manifestValue =
          manifest.ok &&
          typeof manifest.value === "object" &&
          manifest.value !== null
            ? manifest.value
            : null;
        const captures =
          manifestValue !== null && Array.isArray(manifestValue.captures)
            ? manifestValue.captures
            : [];
        const byPath = latestCaptureByPath(captures);

        const operationPaths = new Set(
          operations
            .map((operation) => String(operation?.path ?? ""))
            .filter((path) => path !== ""),
        );
        const tierRank = (tier) => {
          const index = TIER_ORDER.indexOf(String(tier ?? ""));
          return index === -1 ? TIER_ORDER.length : index;
        };
        const rows = operations.map((operation) => {
          const path = String(operation?.path ?? "");
          const capture = byPath.get(path) ?? null;
          return {
            path,
            method: String(operation?.method ?? "").toUpperCase(),
            operationId: operation?.operationId ?? null,
            tag: operation?.tag ?? null,
            tier: operation?.tier ?? null,
            ledgerCaptured: operation?.capturedResponse === true,
            manifestCaptured: capture !== null,
            requiredCapture:
              typeof operation?.requiredCapture === "string"
                ? truncate(operation.requiredCapture, 400)
                : null,
            capture: captureSummary(capture),
          };
        });
        const sources = {
          ledger: evidenceStamp(ledger),
          spec: evidenceStamp(spec),
          captures: evidenceStamp(manifest),
        };
        /**
         * Join the repo's capture-suite catalog against the ledger. The match is the
         * operation name, which is the last segment of the ledger path, so a probe operation
         * the ledger does not carry is a coverage gap rather than a silent omission.
         */
        const loadProbeCatalog = async () => {
          const result = await runBun(
            ["-e", PROBE_CATALOG_PROGRAM],
            settings.timeoutMs,
          );
          if (!result.ok) {
            return {
              available: false,
              reason: result.timedOut
                ? "probe_catalog_timed_out"
                : "probe_catalog_failed",
              message:
                result.spawnError ??
                "the PROBE_OPS catalog did not load under Bun",
              output: excerpt(
                [result.stdout, result.stderr].filter(Boolean).join("\n"),
              ),
            };
          }
          const parsed = parseJson(result.stdout);
          if (!parsed.ok || !Array.isArray(parsed.value)) {
            return {
              available: false,
              reason: "probe_catalog_unparseable",
              message:
                "the catalog program exited 0 but its stdout was not a JSON array",
              output: excerpt(result.stdout),
            };
          }
          const probe = parsed.value
            .filter(
              (operation) =>
                typeof operation === "object" &&
                operation !== null &&
                typeof operation.operation === "string",
            )
            .map((operation) => ({
              operation: operation.operation,
              readOnly: operation.readOnly === true,
            }));
          const ledgerByName = new Set(
            rows
              .map((row) => row.path.split("/").filter(Boolean).pop())
              .filter((name) => name !== undefined),
          );
          const missing = probe
            .filter((operation) => !ledgerByName.has(operation.operation))
            .map((operation) => operation.operation);
          return {
            available: true,
            source: "lib/f402_probe.ts PROBE_OPS",
            matching: "operation name = last segment of the ledger path",
            total: probe.length,
            readOnly: probe.filter((operation) => operation.readOnly).length,
            inLedger: probe.length - missing.length,
            missingFromLedger: missing.length,
            operationsMissingFromLedger: missing,
          };
        };

        if (report === "summary") {
          const specPathList = specPaths === null ? null : [...specPaths];
          const specOnlyPaths =
            specPathList === null
              ? null
              : specPathList.filter((path) => !operationPaths.has(path));
          const specOnlyUpstream =
            specOnlyPaths === null
              ? null
              : specOnlyPaths.filter((path) => path.startsWith("/cloud/api/"));
          const capturePathsNotInLedger = [...byPath.keys()].filter(
            (path) => !operationPaths.has(path),
          );
          return {
            available: true,
            ok: true,
            report,
            sources,
            derived: {
              operations: operations.length,
              byTier: countField(operations, "tier"),
              capturedResponse: rows.filter((row) => row.ledgerCaptured).length,
              uncaptured: rows.filter((row) => !row.ledgerCaptured).length,
              withRequiredCapture: rows.filter(
                (row) => row.requiredCapture !== null,
              ).length,
              surfaces: surfaces.length,
              surfacesMissingFromSpec: surfaces.filter(
                (surface) => surface?.missingFromSpec === true,
              ).length,
              specPaths: specPathList === null ? null : specPathList.length,
              operationsMissingFromSpec:
                specPaths === null
                  ? null
                  : rows.filter(
                      (row) => row.path !== "" && !specPaths.has(row.path),
                    ).length,
              specOnlyPaths:
                specOnlyPaths === null ? null : specOnlyPaths.length,
              specOnlyUpstreamPaths:
                specOnlyUpstream === null ? null : specOnlyUpstream.length,
              specOnlyLocalPaths:
                specOnlyUpstream === null
                  ? null
                  : specOnlyPaths.length - specOnlyUpstream.length,
              manifestCaptures: captures.length,
              capturedOperations: byPath.size,
              capturePathsNotInLedger: capturePathsNotInLedger.length,
            },
            probeCatalog: await loadProbeCatalog(),
            trend: evidenceTrend(repoPath, limit),
            note:
              "ledgerCaptured is the ledger's capturedResponse claim; manifestCaptured " +
              "means a redacted capture file exists for the path. A null spec-derived " +
              "count means the spec was missing, not that the count is zero. The trend is " +
              "read from the capture store's applied-*.json journal, not a checked-in series.",
          };
        }

        if (report === "service") {
          const check = await runBun(
            ["run", "check:route-surface"],
            settings.timeoutMs,
          );
          const text = [check.stdout, check.stderr].filter(Boolean).join("\n");
          return {
            available: true,
            ok: check.ok && !check.timedOut && check.spawnError === null,
            report,
            sources,
            check: {
              command: "bun run check:route-surface",
              exitCode: check.exitCode,
              timedOut: check.timedOut,
              spawnError: check.spawnError,
              durationMs: check.durationMs,
            },
            counts: parseRouteSurfaceCounts(text),
            output: excerpt(text),
            note:
              "The same check is the `routes` gate on sportsdesk_dev; this report runs it " +
              "beside the evidence joins. It compares the served route table, the ledger " +
              "surfaces and the published spec — it does not contact the running process.",
          };
        }

        if (report === "list") {
          const wanted =
            typeof request.q === "string" ? request.q.trim().toLowerCase() : "";
          const filtered = rows.filter((row) => {
            if (
              wanted !== "" &&
              !`${row.path} ${row.tag ?? ""} ${row.operationId ?? ""}`
                .toLowerCase()
                .includes(wanted)
            ) {
              return false;
            }
            if (request.tier !== undefined && row.tier !== request.tier) {
              return false;
            }
            if (
              request.captured !== undefined &&
              row.manifestCaptured !== request.captured
            ) {
              return false;
            }
            return true;
          });
          filtered.sort(
            (left, right) =>
              tierRank(left.tier) - tierRank(right.tier) ||
              left.path.localeCompare(right.path),
          );
          return {
            available: true,
            ok: true,
            report,
            sources,
            filters: {
              q: wanted === "" ? null : wanted,
              tier: request.tier ?? null,
              captured: request.captured ?? null,
            },
            totalOperations: rows.length,
            matched: filtered.length,
            returned: Math.min(limit, filtered.length),
            truncated: filtered.length > limit,
            operations: filtered.slice(0, limit),
          };
        }

        if (report === "surfaces") {
          const surfaceRows = surfaces.map((surface) => ({
            id: surface?.id ?? null,
            name: surface?.name ?? null,
            tier: surface?.tier ?? null,
            category: surface?.category ?? null,
            missingFromSpec: surface?.missingFromSpec === true,
            requiredCapture:
              typeof surface?.requiredCapture === "string"
                ? truncate(surface.requiredCapture, 400)
                : null,
          }));
          return {
            available: true,
            ok: true,
            report,
            sources: { ledger: evidenceStamp(ledger) },
            totalSurfaces: surfaceRows.length,
            missingFromSpec: surfaceRows.filter((row) => row.missingFromSpec)
              .length,
            returned: Math.min(limit, surfaceRows.length),
            truncated: surfaceRows.length > limit,
            surfaces: surfaceRows.slice(0, limit),
          };
        }

        const gaps = rows
          .filter((row) => !row.ledgerCaptured || !row.manifestCaptured)
          .map((row) => {
            const missing = [];
            if (!row.ledgerCaptured) missing.push("ledger-captured-response");
            if (!row.manifestCaptured) missing.push("capture-file");
            return { ...row, missing };
          });
        gaps.sort(
          (left, right) =>
            tierRank(right.tier) - tierRank(left.tier) ||
            left.path.localeCompare(right.path),
        );
        const specPathList = specPaths === null ? null : [...specPaths];
        const specOnlyPaths =
          specPathList === null
            ? null
            : specPathList.filter((path) => !operationPaths.has(path));
        return {
          available: true,
          ok: true,
          report,
          sources,
          derived: {
            operationsWithoutLedgerCapture: rows.filter(
              (row) => !row.ledgerCaptured,
            ).length,
            operationsWithoutCaptureFile: rows.filter(
              (row) => !row.manifestCaptured,
            ).length,
            specOnlyPaths: specOnlyPaths === null ? null : specOnlyPaths.length,
            specOnlyUpstreamPaths:
              specOnlyPaths === null
                ? null
                : specOnlyPaths.filter((path) => path.startsWith("/cloud/api/"))
                    .length,
          },
          returned: Math.min(limit, gaps.length),
          truncated: gaps.length > limit,
          gaps: gaps.slice(0, limit),
          specOnlyPaths:
            specOnlyPaths === null ? null : specOnlyPaths.slice(0, limit),
          probeCatalog: await loadProbeCatalog(),
          note:
            "A spec-only upstream path is a documented operation the ledger does not " +
            "carry (no evidence row); a local path is a daemon route, not a F402 wire operation.",
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_security — credential, redaction and identifier scan
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_security",
      description:
        "Read-only security scan of the desk's tracked evidence. " +
        '"secrets" runs the repo\'s own `bun run check:secrets` over git-tracked files ' +
        'and reports the parsed findings (values are already masked by that check). "captures" ' +
        "audits every capture in docs/evidence/captures: whether it carries a redaction " +
        "block, whether the block is clean, how many fields/CAT values it redacted and " +
        'whether a response body was recorded at all. "identifiers" runs the repo\'s ' +
        "lib/identifier_scan.ts (via Bun, because the Host runtime cannot import " +
        "TypeScript) over the published data/, docs/ and static/ artifacts and reports " +
        "counts per file, split into known downline agents and unclassified hits, plus a " +
        "calibration line on the labeled-safe fixtures (contests, scoreboard) that the " +
        'shape was calibrated against. "summary" runs all three. The verdict distinguishes ' +
        '"clean", "internal-only" (only the desk\'s own agent logins), "unclassified", ' +
        '"uncalibrated" and "incomplete" instead of collapsing every token into one boolean. ' +
        "Identifier literals and IP addresses are never returned — counts and paths only — " +
        "so the scanner cannot become the leak it reports. A missing manifest is reported " +
        "as missing, never as clean.",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description:
              "One of: summary (default), secrets, captures, identifiers.",
          },
          limit: {
            type: "number",
            description: "Rows per report (1-100, default 20).",
          },
        },
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        const reports = ["summary", "secrets", "captures", "identifiers"];
        const report = request.report ?? "summary";
        if (typeof report !== "string" || !reports.includes(report)) {
          return {
            available: false,
            reason: "unknown_report",
            message: `Unknown report ${JSON.stringify(request.report)}. Allowed: ${reports.join(", ")}.`,
          };
        }
        const limit = request.limit ?? 20;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        ) {
          return invalidArguments("limit must be an integer from 1 to 100.");
        }

        const manifest = readEvidence(repoPath, EVIDENCE.captures.path);
        const needsManifest = report === "captures" || report === "summary";
        if (!manifest.ok && needsManifest) {
          return {
            available: false,
            reason: manifest.exists
              ? "manifest_unparseable"
              : "manifest_missing",
            message: manifest.exists
              ? `${EVIDENCE.captures.path} exists but does not parse as JSON. This is NOT a clean capture set.`
              : `${EVIDENCE.captures.path} does not exist. This is NOT a clean capture set — no redaction was measured.`,
            sources: { captures: evidenceStamp(manifest) },
          };
        }
        const captures = manifest.ok
          ? captureAuditReport(repoPath, manifest)
          : null;
        const sources = { captures: evidenceStamp(manifest) };

        if (report === "captures") {
          return {
            available: true,
            ok:
              captures.notClean === 0 &&
              captures.missingRedaction === 0 &&
              captures.captureFileMissing === 0,
            report,
            sources,
            ...captures,
            rows: captures.rows.slice(0, limit),
            truncated: captures.rows.length > limit,
          };
        }

        if (report === "secrets") {
          const secrets = secretScanReport(
            await runBun(["run", "check:secrets"], settings.timeoutMs),
          );
          return {
            available: true,
            ok: secrets.ok,
            report,
            sources,
            ...secrets,
            findings: secrets.findings.slice(0, limit),
            truncated: secrets.findings.length > limit,
            note:
              "A non-zero exit is DATA (the repo's checks exit 1 for a measured " +
              "problem), not an exception. Values are masked by check:secrets.",
          };
        }

        if (report === "identifiers") {
          const identifiers = identifierScanReport(
            await runBun(["-e", IDENTIFIER_SCAN_PROGRAM], settings.timeoutMs),
            limit,
          );
          return {
            available: true,
            ok: identifiers.ok,
            report,
            sources,
            ...identifiers,
          };
        }

        const secrets = secretScanReport(
          await runBun(["run", "check:secrets"], settings.timeoutMs),
        );
        const identifiers = identifierScanReport(
          await runBun(["-e", IDENTIFIER_SCAN_PROGRAM], settings.timeoutMs),
          limit,
        );
        const complete =
          secrets.spawnError === null && !secrets.timedOut && identifiers.ok;
        const ok =
          complete &&
          secrets.ok &&
          captures.notClean === 0 &&
          captures.missingRedaction === 0 &&
          captures.captureFileMissing === 0 &&
          identifiers.unclassifiedIdentifiers === 0 &&
          identifiers.calibration.ok === true;
        const verdict = !complete
          ? "incomplete"
          : identifiers.calibration.ok !== true
            ? "uncalibrated"
            : ok
              ? "clean"
              : "findings";
        return {
          available: true,
          ok,
          report,
          checkedAt: new Date().toISOString(),
          sources,
          secrets: {
            ok: secrets.ok,
            exitCode: secrets.exitCode,
            scanned: secrets.scanned,
            findingCount: secrets.findingCount,
            durationMs: secrets.durationMs,
            findings: secrets.findings.slice(0, limit),
            truncated: secrets.findings.length > limit,
          },
          captures: {
            total: captures.total,
            redactionPresent: captures.redactionPresent,
            clean: captures.clean,
            notClean: captures.notClean,
            missingRedaction: captures.missingRedaction,
            captureFileMissing: captures.captureFileMissing,
            bodiesRecorded: captures.bodiesRecorded,
            bodiesNotRecorded: captures.bodiesNotRecorded,
            fieldsRedacted: captures.fieldsRedacted,
            piiRedacted: captures.piiRedacted,
            byDerivedTier: captures.byDerivedTier,
          },
          identifiers,
          verdict,
          note:
            "ok is false when a scan could not complete, when the labeled-safe calibration " +
            "fixtures produce hits, or when an unclassified F402 login, a credential shape " +
            "or a dirty/missing redaction was measured. knownAgentHits are the desk's own " +
            "agent logins and are reported separately from unclassified identifiers; " +
            "literals are withheld.",
          nextStep:
            verdict === "incomplete"
              ? "A scan did not complete: fix the spawn/timeout and re-run before reading a verdict."
              : verdict === "uncalibrated"
                ? "The identifier scanner reports hits on its labeled-safe fixtures: recalibrate the shape before trusting any finding."
                : ok
                  ? "No finding in this scan. Re-run after new captures or artifacts are installed."
                  : "Redact or rotate the credential, fix the capture redaction, and remove the unclassified identifiers from the published artifact (and rotate anything the artifact exposed).",
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_sharp — cohort-wide sharp-money scan
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_sharp",
      description:
        "Read-only sharp-money scan over the enriched customer book. Every count, cutoff, " +
        "rank and share is DERIVED from enriched_customers_full.json at call time. " +
        "Candidates are customers whose sharp_score is at or above the threshold or whose " +
        "lifetime clv_bps is positive; each row states which rule qualified it. The " +
        "threshold defaults to the cohort p90 (the same rule the signals report calls sharp " +
        "money), not a checked-in number; when it is supplied, the answer still reports a " +
        "sensitivity grid (50/60/70/80/90) and whether the cutoff sits inside a plateau, so " +
        "an unidentifiable boundary is visible. It also reports the incremental value of the " +
        "CLV rule and the sharp/CLV correlation, because two near-collinear signals are not " +
        "independent evidence. Returns the cohort p90 cutoffs, the qualifying split " +
        "(sharp-only, CLV-only, both), mean/median sharp and CLV, lifetime volume and net of " +
        "the candidate set, a per-agent concentration table, a per-league (or per-market) " +
        "breakdown of the candidates' SAMPLED tickets, the ranked customers, and the book's " +
        "provenance verdict. The book is a curated cohort, not the platform-wide customer " +
        "base: a sharp ranking over a generated fixture must not read as an observation.",
      parameters: {
        type: "object",
        properties: {
          minSharp: {
            type: "number",
            description:
              "sharp_score cutoff, 0-100. Omit to use the cohort p90 — the same cutoff " +
              "the customer signals report calls sharp money. Positive CLV also qualifies.",
          },
          dimension: {
            type: "string",
            description: 'Ticket breakdown: "league" (default) or "market".',
          },
          limit: {
            type: "number",
            description:
              "Rows per section (agents, dimensions, customers; 1-100, default 10).",
          },
        },
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute(args) {
        const request = args ?? {};
        if (
          request.minSharp !== undefined &&
          (typeof request.minSharp !== "number" ||
            !Number.isFinite(request.minSharp) ||
            request.minSharp < 0 ||
            request.minSharp > 100)
        ) {
          return invalidArguments("minSharp must be a number from 0 to 100.");
        }
        const dimension = request.dimension ?? "league";
        if (dimension !== "league" && dimension !== "market") {
          return invalidArguments('dimension must be "league" or "market".');
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

        const book = readCustomerBook(repoPath);
        if (!book.ok) {
          return {
            available: false,
            reason: book.reason,
            message: book.message,
            source: book.source,
          };
        }
        const rows = book.rows;
        const cohort = buildCustomerCohort(rows);
        const cutoffs = cohortCutoffs(cohort);
        const sharpOf = (row) => finiteNumber(row?.sharp_score);
        const clvOf = (row) => finiteNumber(row?.clv_bps);
        // The default comes from the book's own distribution, not a checked-in number.
        const derivedThreshold = cutoffs.sharpP90;
        const minSharp =
          typeof request.minSharp === "number"
            ? request.minSharp
            : (derivedThreshold ?? 70);
        const thresholdSource =
          typeof request.minSharp === "number"
            ? "caller"
            : derivedThreshold !== null
              ? "cohort-p90"
              : "fallback-policy";
        const candidatesAt = (threshold) =>
          rows.filter((row) => {
            const sharp = sharpOf(row);
            const clv = clvOf(row);
            return (
              (sharp !== null && sharp >= threshold) ||
              (clv !== null && clv > 0)
            );
          }).length;
        const sensitivity = [50, 60, 70, 80, 90].map((threshold) => ({
          threshold,
          candidates: candidatesAt(threshold),
          // The sharp-only count is reported separately because the OR rule (CLV > 0) can
          // keep the candidate set flat while the sharp boundary itself is moving.
          bySharpScore: rows.filter(
            (row) => (sharpOf(row) ?? Number.NEGATIVE_INFINITY) >= threshold,
          ).length,
        }));
        // A cutoff inside a plateau of equal candidate counts is not identified by the book:
        // moving it 20 points changes nothing. Report the plateau instead of hiding it.
        let nearest = 0;
        for (let index = 1; index < sensitivity.length; index += 1) {
          if (
            Math.abs(sensitivity[index].threshold - minSharp) <
            Math.abs(sensitivity[nearest].threshold - minSharp)
          ) {
            nearest = index;
          }
        }
        let left = nearest;
        let right = nearest;
        while (
          left > 0 &&
          sensitivity[left - 1].candidates === sensitivity[nearest].candidates
        ) {
          left -= 1;
        }
        while (
          right < sensitivity.length - 1 &&
          sensitivity[right + 1].candidates === sensitivity[nearest].candidates
        ) {
          right += 1;
        }
        const thresholdIdentified = left === right;
        const plateau = {
          from: sensitivity[left].threshold,
          to: sensitivity[right].threshold,
          candidates: sensitivity[nearest].candidates,
        };
        const candidates = rows.filter((row) => {
          const sharp = sharpOf(row);
          const clv = clvOf(row);
          return (
            (sharp !== null && sharp >= minSharp) || (clv !== null && clv > 0)
          );
        });
        const sharpValues = candidates
          .map((row) => sharpOf(row))
          .filter((value) => value !== null);
        const clvValues = candidates
          .map((row) => clvOf(row))
          .filter((value) => value !== null);
        const aboveThreshold = candidates.filter(
          (row) => (sharpOf(row) ?? Number.NEGATIVE_INFINITY) >= minSharp,
        ).length;
        const clvPositive = candidates.filter(
          (row) => (clvOf(row) ?? Number.NEGATIVE_INFINITY) > 0,
        ).length;
        const both = candidates.filter(
          (row) =>
            (sharpOf(row) ?? Number.NEGATIVE_INFINITY) >= minSharp &&
            (clvOf(row) ?? Number.NEGATIVE_INFINITY) > 0,
        ).length;

        const agentGroups = new Map();
        for (const row of rows) {
          const agentId = String(row?.agent_id ?? "UNKNOWN");
          const group = agentGroups.get(agentId) ?? {
            agentId,
            customers: 0,
            candidates: 0,
            sharpValues: [],
            clvPositive: 0,
            lifetimeVolumeUsd: 0,
            lifetimeNetUsd: 0,
          };
          group.customers += 1;
          agentGroups.set(agentId, group);
        }
        for (const row of candidates) {
          const agentId = String(row?.agent_id ?? "UNKNOWN");
          const group = agentGroups.get(agentId) ?? {
            agentId,
            customers: 0,
            candidates: 0,
            sharpValues: [],
            clvPositive: 0,
            lifetimeVolumeUsd: 0,
            lifetimeNetUsd: 0,
          };
          group.candidates += 1;
          const sharp = sharpOf(row);
          if (sharp !== null) group.sharpValues.push(sharp);
          if ((clvOf(row) ?? 0) > 0) group.clvPositive += 1;
          const volume = finiteNumber(row?.lifetime_volume_usd);
          if (volume !== null) group.lifetimeVolumeUsd += volume;
          const net = finiteNumber(row?.lifetime_net_usd);
          if (net !== null) group.lifetimeNetUsd += net;
          agentGroups.set(agentId, group);
        }
        const agents = [...agentGroups.values()]
          .filter((group) => group.candidates > 0)
          .map((group) => ({
            agentId: group.agentId,
            customers: group.customers,
            candidates: group.candidates,
            candidateSharePct:
              group.customers === 0
                ? null
                : (group.candidates / group.customers) * 100,
            avgSharpScore:
              group.sharpValues.length === 0
                ? null
                : group.sharpValues.reduce((total, value) => total + value, 0) /
                  group.sharpValues.length,
            clvPositive: group.clvPositive,
            lifetimeVolumeUsd: group.lifetimeVolumeUsd,
            lifetimeNetUsd: group.lifetimeNetUsd,
          }))
          .sort(
            (left, right) =>
              right.candidates - left.candidates ||
              (right.avgSharpScore ?? Number.NEGATIVE_INFINITY) -
                (left.avgSharpScore ?? Number.NEGATIVE_INFINITY) ||
              left.agentId.localeCompare(right.agentId),
          );

        const tickets = candidates.flatMap((row) =>
          Array.isArray(row?.recent_tickets) ? row.recent_tickets : [],
        );
        const dimensionGroups = new Map();
        for (const ticket of tickets) {
          const name = String(ticket?.[dimension] ?? "UNKNOWN");
          const group = dimensionGroups.get(name) ?? {
            name,
            tickets: 0,
            riskUsd: 0,
            netUsd: 0,
            wins: 0,
            decisive: 0,
          };
          group.tickets += 1;
          const risk = Number(ticket?.risk_usd);
          if (Number.isFinite(risk)) group.riskUsd += risk;
          const net = Number(ticket?.net_usd);
          if (Number.isFinite(net)) group.netUsd += net;
          if (ticket?.result === "WIN") group.wins += 1;
          if (ticket?.result === "WIN" || ticket?.result === "LOSS") {
            group.decisive += 1;
          }
          dimensionGroups.set(name, group);
        }
        const dimensions = [...dimensionGroups.values()]
          .map((group) => ({
            name: group.name,
            tickets: group.tickets,
            riskUsd: group.riskUsd,
            netUsd: group.netUsd,
            roiPct:
              group.riskUsd === 0 ? null : (group.netUsd / group.riskUsd) * 100,
            winPct:
              group.decisive === 0 ? null : (group.wins / group.decisive) * 100,
          }))
          .sort(
            (left, right) =>
              right.riskUsd - left.riskUsd || right.tickets - left.tickets,
          );

        const ranked = candidates
          .slice()
          .sort(
            (left, right) =>
              (sharpOf(right) ?? Number.NEGATIVE_INFINITY) -
                (sharpOf(left) ?? Number.NEGATIVE_INFINITY) ||
              (clvOf(right) ?? Number.NEGATIVE_INFINITY) -
                (clvOf(left) ?? Number.NEGATIVE_INFINITY),
          )
          .slice(0, limit)
          .map((row) => {
            const bySharp =
              (sharpOf(row) ?? Number.NEGATIVE_INFINITY) >= minSharp;
            const byClv = (clvOf(row) ?? Number.NEGATIVE_INFINITY) > 0;
            return {
              ...slimCustomer(row),
              qualifiesBy:
                bySharp && byClv ? "both" : bySharp ? "sharp" : "clv",
            };
          });

        const bookAudit = bookIntegrity(rows);
        const candidateVolumeUsd = sumField(candidates, "lifetime_volume_usd");
        const candidateNetUsd = sumField(candidates, "lifetime_net_usd");
        const pearsonR = pearsonOf(
          rows.map((row) => [sharpOf(row), clvOf(row)]),
        );
        const incrementalByClv = clvPositive - both;
        return {
          available: true,
          ok: true,
          scan: "sharp",
          source: book.source,
          threshold: minSharp,
          thresholdSource,
          thresholdIdentified,
          sensitivity,
          plateau,
          dimension,
          cutoffs,
          summary: {
            bookCustomers: rows.length,
            candidates: candidates.length,
            candidateSharePct:
              rows.length === 0
                ? null
                : (candidates.length / rows.length) * 100,
            aboveThreshold,
            clvPositive,
            both,
            sharpOnly: aboveThreshold - both,
            clvOnly: clvPositive - both,
            incrementalByClv,
            incrementalBySharp: aboveThreshold - both,
            pearsonR,
            signalsCollinear: pearsonR !== null && Math.abs(pearsonR) >= 0.8,
            avgSharpScore:
              sharpValues.length === 0
                ? null
                : sharpValues.reduce((total, value) => total + value, 0) /
                  sharpValues.length,
            medianSharpScore: medianOf(sharpValues),
            avgClvBps:
              clvValues.length === 0
                ? null
                : clvValues.reduce((total, value) => total + value, 0) /
                  clvValues.length,
            lifetimeVolumeUsd: candidateVolumeUsd,
            lifetimeNetUsd: candidateNetUsd,
            holdPct:
              candidateVolumeUsd === 0
                ? null
                : (candidateNetUsd / candidateVolumeUsd) * 100,
            sampledTickets: tickets.length,
          },
          agents: agents.slice(0, limit),
          agentsTruncated: agents.length > limit,
          dimensions: dimensions.slice(0, limit),
          dimensionsTruncated: dimensions.length > limit,
          customers: ranked,
          returned: ranked.length,
          bookIntegrity: compactIntegrity(bookAudit),
          caveats:
            "recent_tickets is a per-customer sample; lifetime_* fields are the full " +
            "rollup. The book is a curated cohort, not the platform-wide customer base. " +
            "cutoffs and shares are recomputed from this book at call time, and a " +
            "generated-fixture character means the ranking is not an observation of real customers.",
          interpretation: {
            threshold:
              thresholdSource === "cohort-p90"
                ? "The cutoff is the book's own p90, the same rule the signals report uses; it moves when the book moves."
                : thresholdSource === "caller"
                  ? "The cutoff is caller-supplied; compare it with the reported plateau before treating it as a boundary."
                  : "No sharp score was measurable, so the cutoff fell back to 70; treat it as a policy default, not a measurement.",
            plateau: thresholdIdentified
              ? `The candidate set changes within ±10 points of the cutoff (${plateau.from}-${plateau.to} is the reported interval).`
              : (() => {
                  const within = sensitivity.filter(
                    (point) =>
                      point.threshold >= plateau.from &&
                      point.threshold <= plateau.to,
                  );
                  const first = within[0]?.bySharpScore;
                  const last = within.at(-1)?.bySharpScore;
                  return (
                    `Every cutoff from ${plateau.from} to ${plateau.to} selects the same ` +
                    `${plateau.candidates} candidates through the OR rule, so the book does ` +
                    `not identify a boundary there; the sharp-only count over that interval ` +
                    `runs ${first} to ${last}.`
                  );
                })(),
            collinearity:
              incrementalByClv === 0
                ? "The CLV rule adds no candidates: every CLV-positive customer also clears the sharp cutoff on this book, so the two rules are not independent evidence."
                : `The CLV rule adds ${incrementalByClv} candidate(s) beyond the sharp cutoff.`,
          },
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // sportsdesk_weblogs — what does the getWebLog evidence actually carry?
  // ---------------------------------------------------------------------------
  register(
    defineReadTool({
      name: "sportsdesk_weblogs",
      description:
        "Read-only getWebLog (IP tracker) evidence scan. It reads the capture manifest, " +
        "the captured getWebLog files and the committed mock fixture — it NEVER calls the " +
        "live manager API, so a missing row can never be mistaken for a live answer. " +
        "Derived at call time: the capture count and age, each capture's mode, derived tier, " +
        "response bytes and redaction state, whether response ROWS were actually recorded, " +
        "the distinct customer/IP counts and how many IP rows are RFC 5737 documentation " +
        "addresses, the form fields the request skeleton declares, the mode letters the " +
        "repo's forensic runbook defines, and whether IP matching can run on this evidence. " +
        "Customer ids and IP addresses are never returned — counts only. Fixture rows are " +
        "labelled a shape sample, never observations.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
      isConcurrencySafe: () => true,
      async execute() {
        const manifest = readEvidence(repoPath, EVIDENCE.captures.path);
        if (!manifest.ok) {
          return {
            available: false,
            reason: manifest.exists
              ? "manifest_unparseable"
              : "manifest_missing",
            message: manifest.exists
              ? `${EVIDENCE.captures.path} exists but does not parse as JSON. This is NOT an empty weblog store.`
              : `${EVIDENCE.captures.path} does not exist. This is NOT an empty weblog store — no getWebLog evidence was measured.`,
            sources: { captures: evidenceStamp(manifest) },
          };
        }
        const manifestValue =
          typeof manifest.value === "object" && manifest.value !== null
            ? manifest.value
            : {};
        const captures = Array.isArray(manifestValue.captures)
          ? manifestValue.captures
          : [];
        const weblogCaptures = captures.filter(
          (capture) =>
            typeof capture === "object" &&
            capture !== null &&
            String(capture.operation?.path ?? "")
              .toLowerCase()
              .includes("/getweblog"),
        );

        const rows = weblogCaptures.map((entry) => {
          const file = String(entry?.file ?? "");
          const capture =
            file === ""
              ? null
              : readEvidence(repoPath, `${EVIDENCE.captures.store}/${file}`);
          const value =
            capture !== null &&
            capture.ok &&
            typeof capture.value === "object" &&
            capture.value !== null
              ? capture.value
              : null;
          const response = value?.response ?? null;
          const bodyRows = Array.isArray(response?.body) ? response.body : null;
          const ips =
            bodyRows === null
              ? []
              : bodyRows
                  .map((item) => String(item?.ipAddress ?? ""))
                  .filter((ip) => ip !== "");
          const customers =
            bodyRows === null
              ? []
              : bodyRows
                  .map((item) => String(item?.customerID ?? ""))
                  .filter((id) => id !== "");
          const redaction = value?.redaction ?? entry?.redaction ?? null;
          const formFields =
            typeof value?.request?.bodySkeleton?.fields === "object" &&
            value.request.bodySkeleton.fields !== null
              ? Object.keys(value.request.bodySkeleton.fields)
              : [];
          const requestMode = String(
            value?.request?.form?.type ?? value?.request?.body?.type ?? "",
          );
          return {
            file,
            path: entry?.operation?.path ?? null,
            mode: entry?.mode ?? null,
            capturedAt: entry?.capturedAt ?? null,
            ageMinutes: ageMinutesSince(entry?.capturedAt),
            derivedTier: entry?.derivedTier ?? null,
            captureFileExists: capture?.exists === true,
            requestFormFields: formFields,
            requestMode: requestMode === "" ? null : requestMode,
            responseStatus: response?.status ?? entry?.responseStatus ?? null,
            responseBytes: response?.bytes ?? entry?.responseBytes ?? null,
            provenanceBody:
              value?.provenance?.body ?? entry?.provenance?.body ?? null,
            bodyRecorded: bodyRows !== null,
            rows: bodyRows === null ? 0 : bodyRows.length,
            distinctCustomers: new Set(customers).size,
            distinctIps: new Set(ips).size,
            documentationIpRows: ips.filter((ip) =>
              DOCUMENTATION_SUBNET_PREFIXES.some((prefix) =>
                ip.startsWith(prefix),
              ),
            ).length,
            redaction: {
              present: redaction !== null && redaction !== undefined,
              clean: redaction?.clean === true,
            },
          };
        });

        const modesPath = `${repoPath}/${EVIDENCE.forensicModes.path}`;
        const modesStats = statFile(modesPath);
        const modesText = readText(modesPath) ?? "";
        const definedModes = new Set();
        for (const match of modesText.matchAll(/getWebLog \(type=([A-Z])/g)) {
          definedModes.add(match[1]);
        }

        const fixture = readEvidence(repoPath, EVIDENCE.weblogFixture.path);
        const fixtureValue =
          fixture.ok &&
          typeof fixture.value === "object" &&
          fixture.value !== null
            ? fixture.value
            : null;
        const fixtureRows = Array.isArray(fixtureValue?.response?.body)
          ? fixtureValue.response.body
          : [];
        const fixtureIps = fixtureRows
          .map((item) => String(item?.ipAddress ?? ""))
          .filter((ip) => ip !== "");
        const fixtureCustomers = fixtureRows
          .map((item) => String(item?.customerID ?? ""))
          .filter((id) => id !== "");
        const fixtureMode = String(fixtureValue?.request?.form?.type ?? "");

        const wireRows = rows.reduce((total, row) => total + row.rows, 0);
        const wireDocumentationIpRows = rows.reduce(
          (total, row) => total + row.documentationIpRows,
          0,
        );
        const capturesWithRows = rows.filter((row) => row.rows > 0).length;
        const latestCapturedAt = rows
          .map((row) => String(row.capturedAt ?? ""))
          .filter((value) => value !== "")
          .sort()
          .at(-1);
        return {
          available: true,
          ok: true,
          scan: "weblogs",
          sources: {
            captures: evidenceStamp(manifest),
            fixture: evidenceStamp(fixture),
            forensicModes: {
              path: EVIDENCE.forensicModes.path,
              exists: modesStats.exists,
              mtime: modesStats.mtime,
              ageMinutes: modesStats.ageMinutes,
            },
          },
          operation: rows[0]?.path ?? null,
          latestCapturedAt: latestCapturedAt ?? null,
          latestAgeMinutes: ageMinutesSince(latestCapturedAt),
          modes: {
            defined: [...definedModes].sort(),
            observedInCaptures: [
              ...new Set(
                rows
                  .map((row) => row.requestMode)
                  .filter((mode) => mode !== null),
              ),
            ].sort(),
            observedInFixture: fixtureMode === "" ? [] : [fixtureMode],
            note:
              "observedInCaptures is read from the capture's request form when it was kept; " +
              "the current wire capture redacts form values, so it shows none. `defined` is " +
              "derived from lib/forensic_diagnostic_modes.ts.",
          },
          captures: rows,
          fixture: {
            path: EVIDENCE.weblogFixture.path,
            rows: fixtureRows.length,
            distinctCustomers: new Set(fixtureCustomers).size,
            distinctIps: new Set(fixtureIps).size,
            documentationIpRows: fixtureIps.filter((ip) =>
              DOCUMENTATION_SUBNET_PREFIXES.some((prefix) =>
                ip.startsWith(prefix),
              ),
            ).length,
            mode: fixtureMode === "" ? null : fixtureMode,
            capturedAt: fixtureValue?.capturedAt ?? null,
            note: "Committed mock fixture: a shape sample, never a wire observation.",
          },
          readiness: {
            captures: rows.length,
            capturesWithRows,
            wireRows,
            wireDocumentationIpRows,
            fixtureRows: fixtureRows.length,
            rowsAvailable: wireRows > 0,
            reason:
              wireRows > 0
                ? `${wireRows} response row(s) across ${capturesWithRows} capture(s). Treat them as captured evidence, not a live feed.`
                : "No capture holds response rows, so cross-office IP matching cannot run on this evidence. The fixture rows are a shape sample, not observations.",
          },
          caveats:
            "This tool makes no live manager API call: the capture store is the evidence. " +
            "A capture proves the request shape and auth mode, not the response rows; " +
            "absent rows are reported as absent, never as zero customers.",
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
