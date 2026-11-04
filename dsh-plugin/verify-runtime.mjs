#!/usr/bin/env node
/**
 * Stage 2 of two: prove the plugin EXECUTES under the HOST's real runtime.
 *
 * WHY THIS EXISTS
 *
 * `verify-load.mjs` runs under Bun, which is the one runtime that cannot detect the bug that
 * actually shipped in the reference plugin: it used `Bun.spawn`, loaded fine, and passed every
 * test — because `bun test` runs under Bun. The first real tool call failed with
 * "Bun is not defined", because the Host plugin shim runs in Electron's Node main process.
 *
 * This script runs under the host runtime and imports the ACTUAL module (which is why the
 * plugin is plain JavaScript: Node cannot import TypeScript), then calls every tool against
 * the real checkout. A crash here is a production crash.
 *
 * Run under the host binary, not plain node:
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     dsh-plugin/verify-runtime.mjs
 *
 * `node dsh-plugin/verify-runtime.mjs` also works when the local Node matches (20+), but the
 * Electron binary is the runtime that matters.
 */

// ast-grep-ignore: node-fs-read-write-file -- stage 2 runs under Electron's Node, where Bun.file does not exist; reading the real files and writing throwaway fixtures is the point.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Derive the checkout from this script, not from the operator's home: a copied/linked plugin or a
// second worktree would otherwise run its gates against a checkout that is not the one it lives in.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = {
  repoPath: REPO,
  bunPath: "bun",
  serviceUrl: "http://127.0.0.1:4020",
  timeoutMs: 60_000,
  gateTimeoutMs: 900_000,
  staleAfterMinutes: 1_440,
};

let failed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(label, body) {
  try {
    await body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}

const runtime = process.versions.bun
  ? `Bun ${process.versions.bun}`
  : process.versions.electron
    ? `Electron ${process.versions.electron} / Node ${process.versions.node}`
    : `Node ${process.versions.node}`;
console.log(`verify-runtime: ${runtime}\n`);

if (process.versions.bun) {
  console.log(
    "  WARN  running under Bun: this does not prove the Electron-Node Host runtime.\n",
  );
}

const plugin = await import(new URL("./index.js", import.meta.url).href);
const registered = [];
plugin.apply(
  {
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
  },
  CONFIG,
);
const byName = new Map(registered.map((tool) => [tool.name, tool]));

/** Apply the plugin again with config overrides, for fixture-path checks. */
function applyWith(overrides) {
  const tools = [];
  plugin.apply(
    {
      tools: {
        register(definition) {
          tools.push(definition);
        },
      },
    },
    { ...CONFIG, ...overrides },
  );
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/**
 * Recursively prove a tool result survives JSON transport. The Host rejects a tool result that is
 * not lossless JSON, so this looks for values `JSON.stringify` silently changes: undefined/
 * function/symbol/bigint members, non-finite numbers and array holes. The comparator then checks
 * key presence in the round-trip, because `JSON.stringify` drops an undefined-valued KEY on both
 * sides of a naive round-trip (the `files.artifact.exists: undefined` defect class).
 */
function losslessJsonProblems(value, path = "result", problems = []) {
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    problems.push(`${path}: ${typeof value}`);
    return problems;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    problems.push(`${path}: ${value}`);
    return problems;
  }
  if (value === null || typeof value !== "object") return problems;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) problems.push(`${path}[${index}]: array hole`);
      else losslessJsonProblems(value[index], `${path}[${index}]`, problems);
    }
    return problems;
  }
  for (const key of Object.keys(value)) {
    losslessJsonProblems(value[key], `${path}.${key}`, problems);
  }
  return problems;
}

/** Structural comparison of an original value against its JSON.parse(JSON.stringify()) copy. */
function losslessJsonMismatches(
  original,
  roundTrip,
  path = "result",
  problems = [],
) {
  if (original === null || typeof original !== "object") {
    if (!Object.is(original, roundTrip)) problems.push(`${path}: changed`);
    return problems;
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(roundTrip)) {
      problems.push(`${path}: array became ${typeof roundTrip}`);
      return problems;
    }
    for (let index = 0; index < original.length; index += 1) {
      if (index >= roundTrip.length) {
        problems.push(`${path}[${index}]: missing after round-trip`);
      } else {
        losslessJsonMismatches(
          original[index],
          roundTrip[index],
          `${path}[${index}]`,
          problems,
        );
      }
    }
    return problems;
  }
  if (
    roundTrip === null ||
    typeof roundTrip !== "object" ||
    Array.isArray(roundTrip)
  ) {
    problems.push(`${path}: object became ${typeof roundTrip}`);
    return problems;
  }
  for (const key of Object.keys(original)) {
    if (!Object.hasOwn(roundTrip, key)) {
      problems.push(`${path}.${key}: dropped by round-trip`);
    } else {
      losslessJsonMismatches(
        original[key],
        roundTrip[key],
        `${path}.${key}`,
        problems,
      );
    }
  }
  for (const key of Object.keys(roundTrip)) {
    if (!Object.hasOwn(original, key)) {
      problems.push(`${path}.${key}: invented by round-trip`);
    }
  }
  return problems;
}

/** Assert one tool result is valid, key-preserving JSON. */
function assertLosslessJson(label, value) {
  const problems = [
    ...losslessJsonProblems(value),
    ...losslessJsonMismatches(value, JSON.parse(JSON.stringify(value))),
  ];
  assert(
    problems.length === 0,
    `${label}: not lossless JSON (${problems.slice(0, 5).join("; ")})`,
  );
}

await check("the shim has Node globals the plugin relies on", () => {
  assert(typeof fetch === "function", "fetch is missing");
  assert(typeof process.versions === "object", "process.versions is missing");
});

await check("the module loaded and registered thirteen tools", () => {
  assert(registered.length === 13, `registered ${registered.length} tools`);
});

await check(
  "sportsdesk_status executes (git spawn, no Bun global)",
  async () => {
    const result = await byName
      .get("sportsdesk_status")
      .execute({ service: false });
    assert(result.available === true, "status was unavailable");
    assert(result.repo?.git?.available === true, "git was not readable");
    JSON.stringify(result);
  },
);

await check("sportsdesk_data executes (node:fs reads)", async () => {
  const result = await byName.get("sportsdesk_data").execute({});
  assert(result.available === true, "data was unavailable");
  const snapshot = JSON.parse(
    // ast-grep-ignore: node-fs-read-async -- same runtime split: this script must run under Node.
    readFileSync(`${REPO}/sportsdesk_downline_data.json`, "utf8"),
  );
  const downline = result.datasets.find((entry) => entry.name === "downline");
  assert(
    downline.records === snapshot.agents.length,
    `downline records ${downline.records} != source ${snapshot.agents.length}`,
  );
  JSON.stringify(result);
});

await check("sportsdesk_downline executes (snapshot parse)", async () => {
  const result = await byName
    .get("sportsdesk_downline")
    .execute({ subcommand: "summary" });
  assert(result.available === true, "downline was unavailable");
  JSON.stringify(result);
});

await check(
  "sportsdesk_links executes (CLI spawn, canceled 7-day window)",
  async () => {
    const result = await byName.get("sportsdesk_links").execute({
      customerId: "ccc107",
      state: "canceled",
      windowDays: 7,
      date: "2026-11-03",
      filters: {
        agent: "AG1",
        kind: "player",
        sportId: "2",
        period: "3rd Quarter",
        marketIds: "m1,m2",
      },
    });
    assert(result.available === true, `links unavailable: ${result.message}`);
    const links = result.links;
    assert(
      links.playerBetHistoryWindowDays === 7,
      `windowDays is ${links.playerBetHistoryWindowDays}`,
    );
    for (const expected of [
      "state=canceled",
      "partnerUserId=CCC107",
      "from=1793163600",
      "to=1793685600",
      "agent=AG1",
      "kind=player",
      "sId=2",
      "period=s3",
      "mId=m1%2Cm2",
    ]) {
      assert(
        links.playerCanceledBetHistoryDeepLinkUrl.includes(expected),
        `canceled link is missing ${expected}`,
      );
    }
    assert(
      links.getBetReportObservedPayload.state === "",
      "the payload state was fabricated",
    );
  },
);

await check("sportsdesk_customer executes (derived book counts)", async () => {
  const book = JSON.parse(
    // ast-grep-ignore: node-fs-read-async -- same runtime split: this script must run under Node.
    readFileSync(`${REPO}/enriched_customers_full.json`, "utf8"),
  );
  const result = await byName
    .get("sportsdesk_customer")
    .execute({ report: "summary" });
  assert(result.available === true, "summary was unavailable");
  assert(
    result.derived.customers === book.length,
    `customers ${result.derived.customers} != source ${book.length}`,
  );
  JSON.stringify(result);
});

await check(
  "sportsdesk_customer profile executes (derived ranks)",
  async () => {
    const book = JSON.parse(
      // ast-grep-ignore: node-fs-read-async -- same runtime split: this script must run under Node.
      readFileSync(`${REPO}/enriched_customers_full.json`, "utf8"),
    );
    const top = book
      .slice()
      .sort(
        (left, right) =>
          (right.lifetime_volume_usd ?? 0) - (left.lifetime_volume_usd ?? 0),
      )[0];
    const result = await byName.get("sportsdesk_customer").execute({
      report: "profile",
      customerId: top.customer_id,
    });
    assert(result.available === true, "profile was unavailable");
    assert(
      result.found === true,
      "profile did not find the top-volume customer",
    );
    assert(
      typeof result.cohortRanksPct?.volume === "number",
      "profile returned no volume percentile",
    );
    assert(
      typeof result.cutoffs?.volumeP90 === "number",
      "profile returned no cohort cutoff",
    );
    JSON.stringify(result);
  },
);

await check(
  "sportsdesk_customer integrity executes (derived provenance)",
  async () => {
    const book = JSON.parse(
      // ast-grep-ignore: node-fs-read-async -- same runtime split: this script must run under Node.
      readFileSync(`${REPO}/enriched_customers_full.json`, "utf8"),
    );
    const result = await byName
      .get("sportsdesk_customer")
      .execute({ report: "integrity" });
    assert(result.available === true, "integrity was unavailable");
    assert(
      typeof result.integrity?.character === "string",
      "integrity returned no character verdict",
    );
    const tickets = book.flatMap((row) => row.recent_tickets ?? []);
    const stamps = new Set(
      tickets.map((ticket) => String(ticket.placed_at ?? "")),
    ).size;
    assert(
      result.integrity.timestamps.distinct === stamps,
      "integrity timestamp count != source",
    );
    JSON.stringify(result);
  },
);

await check("sportsdesk_markets executes (dist artifact parse)", async () => {
  const result = await byName
    .get("sportsdesk_markets")
    .execute({ report: "backtest", limit: 2 });
  assert(result.available === true, "backtest was unavailable");
  assert(
    typeof result.totals?.baselineTotalDeskNetUsd4Wk === "number",
    "backtest totals missing",
  );
  JSON.stringify(result);
});

await check("sportsdesk_ticker executes (ticker captures)", async () => {
  const result = await byName
    .get("sportsdesk_ticker")
    .execute({ report: "wagers", limit: 3 });
  assert(result.available === true, "wagers was unavailable");
  JSON.stringify(result);
});

await check("sportsdesk_endpoints executes (evidence joins)", async () => {
  const tool = byName.get("sportsdesk_endpoints");
  const result = await tool.execute({ report: "list", limit: 3 });
  assert(result.available === true, "endpoints was unavailable");
  assert(
    result.operations?.length === Math.min(3, result.totalOperations),
    `returned ${result.operations?.length} of ${result.totalOperations}`,
  );
  const summary = await tool.execute({});
  assert(
    summary.probeCatalog?.available === true,
    "the spawned PROBE_OPS catalog did not load under the host runtime",
  );
  assert(
    summary.probeCatalog.total > 0,
    "the probe catalog reported no operations",
  );
  assert(
    summary.trend?.available === true,
    "the applied-*.json trend did not load under the host runtime",
  );
  assert(
    Array.isArray(summary.trend.snapshots) &&
      summary.trend.snapshots.length > 0,
    "the trend reported no snapshots",
  );
  JSON.stringify(summary);
});

await check(
  "sportsdesk_security executes (spawned identifier scanner)",
  async () => {
    const tool = byName.get("sportsdesk_security");
    const captures = await tool.execute({ report: "captures", limit: 2 });
    assert(captures.available === true, "captures was unavailable");
    assert(typeof captures.total === "number", "captures total missing");
    const identifiers = await tool.execute({ report: "identifiers", limit: 3 });
    assert(identifiers.available === true, "identifiers was unavailable");
    assert(identifiers.ok === true, "the spawned scanner failed under Node");
    assert(
      typeof identifiers.scanned === "number" && identifiers.scanned > 0,
      "the scanner reported no files",
    );
    assert(
      !JSON.stringify(identifiers).includes("BILLY666"),
      "the scanner leaked an identifier literal",
    );
    assert(
      identifiers.calibration?.ok === true,
      "the labeled-safe calibration fixtures produced hits",
    );
    assert(
      identifiers.knownAgentHits + identifiers.unclassifiedIdentifiers ===
        identifiers.totalIdentifiers,
      "the agent/unclassified split does not add up",
    );
    JSON.stringify(identifiers);
  },
);

await check("sportsdesk_sharp executes (cohort scan)", async () => {
  const tool = byName.get("sportsdesk_sharp");
  const result = await tool.execute({ minSharp: 70, limit: 3 });
  assert(result.available === true, "sharp scan was unavailable");
  assert(
    typeof result.summary?.candidates === "number",
    "sharp candidates missing",
  );
  assert(
    result.customers?.length === Math.min(3, result.summary.candidates),
    `returned ${result.customers?.length} of ${result.summary?.candidates}`,
  );
  assert(
    Array.isArray(result.sensitivity) && result.sensitivity.length === 5,
    "sensitivity grid missing",
  );
  const defaulted = await tool.execute({ limit: 1 });
  assert(
    defaulted.thresholdSource === "cohort-p90",
    `default threshold source ${defaulted.thresholdSource}`,
  );
  JSON.stringify(result);
});

await check("sportsdesk_weblogs executes (getWebLog evidence)", async () => {
  const result = await byName.get("sportsdesk_weblogs").execute({});
  assert(result.available === true, "weblogs was unavailable");
  assert(Array.isArray(result.captures), "weblog captures missing");
  assert(Array.isArray(result.modes?.defined), "defined modes missing");
  assert(
    !JSON.stringify(result).includes("203.0.113."),
    "an IP address was returned",
  );
  JSON.stringify(result);
});

await check(
  "sportsdesk_wagers executes (v2 snapshot artifact reads under Node)",
  async () => {
    const result = await byName.get("sportsdesk_wagers").execute({});
    if (result.available === true) {
      assert(
        result.source.schemaVersion === 2,
        `available with schemaVersion ${result.source.schemaVersion}`,
      );
      assert(
        typeof result.totals === "object" && result.totals !== null,
        "an available wager table has no totals",
      );
      assert(
        Array.isArray(result.states) && result.states.length > 0,
        "an available wager table has no states",
      );
      assert(
        typeof result.quality === "object" && result.quality !== null,
        "an available wager table has no quality block",
      );
      JSON.stringify(result);
      return;
    }
    // The artifact is gitignored and may be absent (or still be an older schemaVersion) in a
    // fresh checkout; that must read as an explicit MISSING/UNSUPPORTED, never as zero states.
    assert(
      [
        "artifact_missing",
        "schema_unsupported",
        "artifact_unparseable",
      ].includes(result.reason),
      `unexpected reason ${result.reason}`,
    );
    assert(
      String(result.message).length > 0 &&
        !Object.hasOwn(result, "states") &&
        !Object.hasOwn(result, "totals"),
      "a non-reading result implied a wager table",
    );
    JSON.stringify(result);
  },
);

await check(
  "sportsdesk_wagers automation and trends execute under Node on a fixture",
  async () => {
    const directory = mkdtempSync(`${tmpdir()}/dsh-wagers-`);
    try {
      const artifact = {
        schemaVersion: 2,
        source: { kind: "fixture" },
        window: { observedEnd: "2026-11-03T20:00:00.000Z" },
        identity: {},
        totals: { legs: 2, wagers: 2 },
        quality: {},
        states: [],
        moneyScope: "fixture",
        notes: [],
      };
      const run = (ok, finishedAt, error = null) => ({
        startedAt: finishedAt,
        finishedAt,
        ok,
        sourceKind: "live-ajax.php",
        ajaxUrl: "http://127.0.0.1:9/ajax.php",
        fromEpochSec: null,
        toEpochSec: null,
        dateFilterBy: null,
        legs: ok ? 2 : null,
        wagers: ok ? 2 : null,
        states: ok ? 0 : null,
        error,
      });
      const success = run(true, "2026-11-03T19:45:00.000Z");
      const failure = run(false, "2026-11-03T20:00:00.000Z", "boom");
      const journal = {
        schemaVersion: 1,
        runs: [success, failure],
        lastSuccess: success,
        lastFailure: failure,
      };
      const alerts = {
        schemaVersion: 1,
        generatedAt: "2026-11-03T20:00:00.000Z",
        sourceCapturedAt: "2026-11-03T20:00:00.000Z",
        alerts: [
          {
            code: "state_spike",
            severity: "warn",
            summary: "fixture",
            detail: null,
          },
        ],
      };
      const historyLines = [
        {
          schemaVersion: 1,
          capturedAt: "2026-11-03T19:45:00.000Z",
          sourceKind: "live-ajax.php",
          totals: { legs: 2, wagers: 2 },
          states: [{ state: "pending", legs: 2, wagers: 2 }],
          delta: null,
          qualityFlags: [],
          alerts: [],
        },
        {
          schemaVersion: 1,
          capturedAt: "2026-11-03T20:00:00.000Z",
          sourceKind: "live-ajax.php",
          totals: { legs: 3, wagers: 3 },
          states: [{ state: "pending", legs: 3, wagers: 3 }],
          delta: {
            fromCapturedAt: "2026-11-03T19:45:00.000Z",
            toCapturedAt: "2026-11-03T20:00:00.000Z",
            newTickets: 1,
            goneTickets: 0,
            migrations: [],
            perState: [],
          },
          qualityFlags: [],
          alerts: [],
        },
      ];
      const paths = {
        wagersArtifact: `${directory}/artifact.json`,
        wagersStatus: `${directory}/status.json`,
        wagersAlerts: `${directory}/alerts.json`,
        wagersHistory: `${directory}/history.jsonl`,
      };
      writeFileSync(paths.wagersArtifact, JSON.stringify(artifact));
      writeFileSync(paths.wagersStatus, JSON.stringify(journal));
      writeFileSync(paths.wagersAlerts, JSON.stringify(alerts));
      writeFileSync(
        paths.wagersHistory,
        `${historyLines.map((line) => JSON.stringify(line)).join("\n")}\n{not json}\n`,
      );
      const tool = applyWith(paths).get("sportsdesk_wagers");
      const automation = await tool.execute({ report: "automation" });
      assert(automation.available === true, "automation was unavailable");
      assert(
        automation.files.journal.status === "ok" &&
          automation.journal.runsReturned === 2 &&
          automation.health.lastOutcome === "failure" &&
          automation.alerts.count === 1,
        `automation ${JSON.stringify(automation.files)}`,
      );
      const trends = await tool.execute({ report: "trends", limit: 1 });
      assert(trends.available === true, "trends was unavailable");
      assert(
        trends.series.length === 1 &&
          trends.latest.newTickets === 1 &&
          trends.lineCounts.invalidJsonLines === 1,
        `trends ${JSON.stringify(trends.lineCounts)}`,
      );
      const missing = applyWith({
        wagersArtifact: `${directory}/absent.json`,
        wagersStatus: `${directory}/absent.json`,
        wagersAlerts: `${directory}/absent.json`,
        wagersHistory: `${directory}/absent.json`,
      }).get("sportsdesk_wagers");
      const missingAutomation = await missing.execute({ report: "automation" });
      const missingTrends = await missing.execute({ report: "trends" });
      assert(
        missingAutomation.reason === "automation_all_missing" &&
          missingTrends.reason === "history_missing",
        "MISSING was not explicit under Node",
      );
      assertLosslessJson("fixture automation", automation);
      assertLosslessJson("fixture trends", trends);
      assertLosslessJson("fixture automation (all missing)", missingAutomation);
      assertLosslessJson("fixture trends (missing)", missingTrends);
      JSON.stringify(automation);
      JSON.stringify(trends);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

await check(
  "every sportsdesk_wagers report is lossless JSON on the real repo",
  async () => {
    const tool = byName.get("sportsdesk_wagers");
    for (const args of [
      { report: "summary" },
      { report: "states" },
      { report: "quality" },
      { report: "automation" },
      { report: "trends" },
      { report: "states", state: "pending" },
      { report: "automation", state: "pending" },
      { report: "trends", state: "pending", limit: 2 },
    ]) {
      assertLosslessJson(
        `${args.report} on the real checkout`,
        await tool.execute(args),
      );
    }
    const automation = await tool.execute({ report: "automation" });
    assert(
      typeof automation.files.artifact.exists === "boolean",
      `files.artifact.exists is ${typeof automation.files.artifact.exists}; the Host rejects undefined members`,
    );
  },
);

await check("sportsdesk_dev executes a real gate (spawns bun)", async () => {
  const result = await byName
    .get("sportsdesk_dev")
    .execute({ run: ["secrets"] });
  assert(
    result.gates?.secrets?.status === "passed",
    `secrets gate is ${JSON.stringify(result.gates?.secrets)}`,
  );
  JSON.stringify(result);
});

await check("the report form still executes nothing", async () => {
  const result = await byName.get("sportsdesk_dev").execute({});
  assert(result.ok === null, `ok is ${JSON.stringify(result.ok)}`);
  assert(result.executed.length === 0, "a gate was executed");
});

await check("bun is resolvable from the host runtime", () => {
  assert(
    CONFIG.bunPath === "bun" &&
      (existsSync(`${homedir()}/.bun/bin/bun`) || CONFIG.bunPath !== "bun"),
    "no bun at ~/.bun/bin/bun — set config.bunPath to an absolute path",
  );
});

console.log(
  failed === 0
    ? "\nverify-runtime: PASS — every tool executed in the host runtime (stage 2/2)."
    : `\nverify-runtime: ${failed} FAILURE(S) (stage 2/2).`,
);
process.exit(failed === 0 ? 0 : 1);
