#!/usr/bin/env bun
/**
 * Stage 1 of two: prove DSH can LOAD this plugin under Bun, and that its tools REFUSE
 * input they do not understand.
 *
 * WHAT THIS PROVES: the module imports, `apply` registers exactly the thirteen tools, every tool
 * declaration is complete (description, parameters, output schema/render, execute), and the
 * closed sets reject unknown names — including prototype keys such as `toString` and
 * `__proto__`, which a plain `in` check would let through.
 *
 * WHAT IT DOES NOT PROVE: that a tool executes in production. `bun test` and this script run
 * under Bun, but the Host plugin shim runs in Electron's Node, where the `Bun` global does not
 * exist. That is stage 2 (`verify-runtime.mjs`), under the host's own runtime.
 *
 * Run: bun dsh-plugin/verify-load.mjs
 */

import {
  GSLIVE_BET_HISTORY_STATES,
  GSLIVE_GROUP_KINDS,
} from "../lib/gslive_manager_deeplink_sidecar.ts";
import { resolve } from "node:path";

const HERE = import.meta.dir;
/** Every expected count below is read from this checkout, never written down. */
const REPO = resolve(HERE, "..");

/**
 * Configuration is duplicated from `cordis.patch.yml` on purpose: the loader applies the
 * Schema defaults, but this script calls `apply` directly, exactly as the loader would after
 * parsing the patch.
 */
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
function check(label, body) {
  try {
    body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}
async function checkAsync(label, body) {
  try {
    await body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}

let plugin;
try {
  plugin = await import(`${HERE}/index.js`);
} catch (error) {
  console.error(
    `\nFAIL  cannot import ./index.js: ${error?.message ?? error}\n\n` +
      "This bundle is dependency-free by design: it must import nothing outside node: builtins.\n",
  );
  process.exit(1);
}
const SOURCE = await Bun.file(`${HERE}/index.js`).text();

const registered = [];
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
    },
  },
};
plugin.apply(ctx, CONFIG);

const byName = new Map(registered.map((tool) => [tool.name, tool]));

/**
 * The v2 wager-state fixture used by the sportsdesk_wagers checks. Each check writes it to a
 * gitignored `scratch/` temp directory and deletes that directory in a `finally`, so the real
 * artifact (gitignored, absent in a fresh checkout) is never required and never mutated.
 */
const WAGERS_FIXTURE = {
  schemaVersion: 2,
  source: {
    kind: "offline-csv",
    path: "/tmp/fixture/bet-report.csv",
    mtime: "2026-10-25T01:54:46.516Z",
    dateFilterBy: null,
  },
  window: {
    observedStart: "2026-10-19T03:55:27.000Z",
    observedEnd: "2026-10-25T01:50:49.000Z",
    spanHours: 141.9,
    fromEpochSec: null,
    toEpochSec: null,
    ageMinutes: 999,
    snapshotLagMinutes: 4,
  },
  identity: {
    ticketField: "Ticket",
    coveragePct: 100,
    distinctWagers: 17345,
    spanningWagers: 571,
    multiLegWagers: 1037,
  },
  totals: {
    legs: 19086,
    wagers: 17345,
    spanning: 571,
    legRisk: 3475096.5,
    legToWin: 0,
    legResult: 0,
    wagerRisk: 3356737.71,
  },
  states: [
    {
      state: "pending",
      legs: 1263,
      wagers: 1137,
      wagerRiskAttributed: 244807.4,
      legRisk: 168651.44,
      legToWin: 242356.93,
      legResult: 0,
      pendingAgeMinutes: { gt1h: 808, gt6h: 45, gt24h: 33, gt72h: 0 },
      gradeLagMinutesP50: null,
    },
    {
      state: "win",
      legs: 8281,
      wagers: 7624,
      wagerRiskAttributed: 1612450.12,
      legRisk: 1643813.93,
      legToWin: 1237089.49,
      legResult: 1237089.43,
      pendingAgeMinutes: null,
      gradeLagMinutesP50: 61,
    },
    {
      state: "cancel",
      legs: 37,
      wagers: 37,
      wagerRiskAttributed: 9897.83,
      legRisk: 9897.83,
      legToWin: 11019.74,
      legResult: 0,
      pendingAgeMinutes: null,
      gradeLagMinutesP50: null,
    },
  ],
  quality: {
    ticketCoveragePct: 100,
    unparsedBetTimes: 0,
    unknownStates: [],
    numericStateCodes: [],
    coherenceViolations: { winResultNonPositive: 0, loseResultNonNegative: 0 },
    gradeLagMinutes: { p50: 68, p90: 168, p99: 231, settledLegs: 17629 },
    pendingAgeMinutes: { gt1h: 808, gt6h: 45, gt24h: 33, gt72h: 0 },
  },
  moneyScope:
    "wager columns deduped/allocated by Ticket; leg columns are leg-scoped diagnostics",
  notes: [],
};

/**
 * Automation fixtures for the `report:"automation"` / `report:"trends"` checks. They follow the
 * frozen `scratch/wagers-automation.schema.v1.json` contract and are written to a gitignored
 * `scratch/` temp directory, never to the real journal/history/alerts paths.
 */
const WAGERS_CAPTURE_TIMES = [
  "2026-11-03T19:30:00.000Z",
  "2026-11-03T19:45:00.000Z",
  "2026-11-03T20:00:00.000Z",
];

function wagersRun(index, ok, error = null) {
  const finishedAt = new Date(
    Date.parse("2026-11-03T20:00:00.000Z") - (8 - index) * 60_000,
  ).toISOString();
  return {
    startedAt: new Date(Date.parse(finishedAt) - 10_000).toISOString(),
    finishedAt,
    ok,
    sourceKind: "live-ajax.php",
    ajaxUrl: "http://127.0.0.1:9/ajax.php",
    fromEpochSec: 1793000000,
    toEpochSec: 1793600000,
    dateFilterBy: "logTime",
    legs: ok ? 19086 : null,
    wagers: ok ? 17345 : null,
    states: ok ? 3 : null,
    error,
  };
}

const WAGERS_JOURNAL = (() => {
  const runs = [
    wagersRun(1, true),
    wagersRun(2, true),
    wagersRun(3, true),
    wagersRun(4, true),
    wagersRun(5, true),
    wagersRun(6, true),
    wagersRun(7, false, "latest capture failed"),
  ];
  return {
    schemaVersion: 1,
    runs,
    lastSuccess: runs[5],
    lastFailure: runs[6],
  };
})();

const WAGERS_ALERTS = {
  schemaVersion: 1,
  generatedAt: "2026-11-03T20:00:00.000Z",
  sourceCapturedAt: "2026-11-03T20:00:00.000Z",
  alerts: [
    {
      code: "pending_aging",
      severity: "warn",
      summary: "33 pending legs >24h",
      detail: "gt24h=33",
    },
    {
      code: "unknown_state",
      severity: "info",
      summary: "1 unknown state",
      detail: "state=other",
    },
    { broken: true },
  ],
};

/** Three contract-valid history lines (first delta null, then two with migrations). */
const WAGERS_HISTORY_LINES = [
  {
    schemaVersion: 1,
    capturedAt: WAGERS_CAPTURE_TIMES[0],
    sourceKind: "live-ajax.php",
    totals: { legs: 19010, wagers: 17201, spanning: 560, wagerRisk: 3300000.5 },
    states: [
      {
        state: "pending",
        legs: 1300,
        wagers: 1170,
        wagerRiskAttributed: 158000,
      },
      { state: "win", legs: 8200, wagers: 7550, wagerRiskAttributed: 1570000 },
    ],
    delta: null,
    qualityFlags: [],
    alerts: [],
  },
  {
    schemaVersion: 1,
    capturedAt: WAGERS_CAPTURE_TIMES[1],
    sourceKind: "live-ajax.php",
    totals: {
      legs: 19050,
      wagers: 17300,
      spanning: 565,
      wagerRisk: 3350000.25,
    },
    states: [
      {
        state: "pending",
        legs: 1280,
        wagers: 1150,
        wagerRiskAttributed: 158100,
      },
      { state: "win", legs: 8240, wagers: 7600, wagerRiskAttributed: 1571000 },
    ],
    delta: {
      fromCapturedAt: WAGERS_CAPTURE_TIMES[0],
      toCapturedAt: WAGERS_CAPTURE_TIMES[1],
      newTickets: 5,
      goneTickets: 1,
      migrations: [{ from: "pending", to: "win", tickets: 2 }],
      perState: [],
    },
    qualityFlags: [],
    alerts: [
      {
        code: "state_spike",
        severity: "warn",
        summary: "win legs moved +25%",
        detail: "+40 on 160",
      },
    ],
  },
  {
    schemaVersion: 1,
    capturedAt: WAGERS_CAPTURE_TIMES[2],
    sourceKind: "live-ajax.php",
    totals: {
      legs: 19086,
      wagers: 17345,
      spanning: 571,
      wagerRisk: 3356787.71,
    },
    states: [
      {
        state: "pending",
        legs: 1263,
        wagers: 1137,
        wagerRiskAttributed: 158170.91,
      },
      {
        state: "win",
        legs: 8281,
        wagers: 7624,
        wagerRiskAttributed: 1577779.93,
      },
    ],
    delta: {
      fromCapturedAt: WAGERS_CAPTURE_TIMES[1],
      toCapturedAt: WAGERS_CAPTURE_TIMES[2],
      newTickets: 12,
      goneTickets: 3,
      migrations: [{ from: "pending", to: "win", tickets: 2 }],
      perState: [],
    },
    qualityFlags: [],
    alerts: [],
  },
];

/**
 * The history file text: three valid captures, then a malformed JSON line and a line with an
 * unknown schemaVersion. Both must be counted and skipped rather than thrown, which is the
 * tolerance this contract promises a consumer.
 */
function wagersHistoryText() {
  return (
    [
      ...WAGERS_HISTORY_LINES.map((line) => JSON.stringify(line)),
      "{ this is not json",
      JSON.stringify({
        schemaVersion: 2,
        capturedAt: "2026-11-03T20:15:00.000Z",
      }),
    ].join("\n") + "\n"
  );
}

/** Apply the plugin a second time with config overrides, for artifact-path checks. */
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

/** A path under the gitignored scratch/ directory, unique per check run. */
function wagersTempDir(label) {
  return `${REPO}/scratch/dsh-plugin-verify-${label}-${crypto.randomUUID()}`;
}

/**
 * Configure all four wager paths under one temp directory, so a check can write only the files it
 * needs and leave the others genuinely absent.
 */
function wagersPaths(directory) {
  return {
    wagersArtifact: `${directory}/gslive-wagers-by-state.summary.json`,
    wagersStatus: `${directory}/wagers-by-state.status.json`,
    wagersAlerts: `${directory}/wagers-by-state.alerts.json`,
    wagersHistory: `${directory}/wagers-by-state.history.jsonl`,
  };
}

/** Write the artifact, journal, alerts document and history fixture into a temp directory. */
async function writeWagersAutomationFixture(directory) {
  const paths = wagersPaths(directory);
  await Bun.write(
    paths.wagersArtifact,
    JSON.stringify(WAGERS_FIXTURE, null, 2),
  );
  await Bun.write(paths.wagersStatus, JSON.stringify(WAGERS_JOURNAL, null, 2));
  await Bun.write(paths.wagersAlerts, JSON.stringify(WAGERS_ALERTS, null, 2));
  await Bun.write(paths.wagersHistory, wagersHistoryText());
}

/**
 * Recursively prove a tool result survives JSON transport. The Host rejects a tool result that is
 * not lossless JSON, so the check has to look for values `JSON.stringify` silently changes:
 * undefined/function/symbol/bigint members, non-finite numbers and array holes. `JSON.stringify`
 * drops an undefined-valued KEY on both sides of a naive round-trip, which is why the comparator
 * below also checks key presence — this is the `files.artifact.exists: undefined` defect class.
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

const EXPECTED = [
  "sportsdesk_customer",
  "sportsdesk_data",
  "sportsdesk_dev",
  "sportsdesk_downline",
  "sportsdesk_endpoints",
  "sportsdesk_links",
  "sportsdesk_markets",
  "sportsdesk_security",
  "sportsdesk_sharp",
  "sportsdesk_status",
  "sportsdesk_ticker",
  "sportsdesk_wagers",
  "sportsdesk_weblogs",
];

console.log("verify-load: plugin shape");

check("module exports the cordis apply/name/inject contract", () => {
  assert(typeof plugin.apply === "function", "apply must be a function");
  assert(plugin.name === "sportsdesk-ops", `name is ${plugin.name}`);
  assert(
    Array.isArray(plugin.inject) && plugin.inject.includes("tools"),
    `inject is ${JSON.stringify(plugin.inject)}`,
  );
  // The bundle must stay dependency-free: a directory install is a link whose imports
  // resolve from this checkout, not from the profile (measured ERR_MODULE_NOT_FOUND).
  const imports = SOURCE.match(/from\s+"[^"]+"/g) ?? [];
  for (const specifier of imports) {
    assert(
      !specifier.includes("@deepseek-ai/"),
      `index.js imports a peer package: ${specifier}`,
    );
  }
});

check("registers exactly the thirteen read-only tools", () => {
  assert(
    registered.length === EXPECTED.length,
    `registered ${registered.length} tools`,
  );
  const names = registered.map((tool) => tool.name).sort();
  assert(
    Bun.deepEquals(names, EXPECTED, true),
    `names are ${JSON.stringify(names)}`,
  );
});

check("no tool name promises a writing action", () => {
  const WRITE = /deploy|ship|capture|dispatch|mutate|sync|import|resolve|write/;
  for (const tool of registered) {
    assert(!WRITE.test(tool.name), `${tool.name} looks like a writing tool`);
  }
});

for (const tool of registered) {
  check(`${tool.name} declares a complete contract`, () => {
    assert(
      typeof tool.description === "string" && tool.description.length > 80,
      "description must explain the capability",
    );
    assert(
      typeof tool.parameters === "object" && tool.parameters !== null,
      "parameters must be an object root",
    );
    assert(typeof tool.output?.schema === "object", "output.schema must exist");
    assert(
      typeof tool.output?.render === "function",
      "output.render must exist",
    );
    assert(typeof tool.execute === "function", "execute must exist");
  });
}

console.log("\nverify-load: closed sets refuse instead of guessing");

await checkAsync(
  "sportsdesk_links refuses unobserved states and bad windows",
  async () => {
    const tool = byName.get("sportsdesk_links");
    const unknown = await tool.execute({
      customerId: "CCC107",
      state: "settled",
    });
    assert(unknown.available === false, "an unobserved state was accepted");
    assert(
      unknown.reason === "invalid_arguments",
      `reason is ${unknown.reason}`,
    );
    for (const state of GSLIVE_BET_HISTORY_STATES) {
      assert(
        unknown.message.includes(JSON.stringify(state)),
        `refusal does not list the lib state ${JSON.stringify(state)}`,
      );
    }
    assert(
      unknown.message.includes("(observed values only)"),
      "refusal lost the observed-only caveat",
    );
    for (const windowDays of [0, 32, 1.5, "7"]) {
      const result = await tool.execute({ customerId: "CCC107", windowDays });
      assert(
        result.available === false,
        `windowDays ${JSON.stringify(windowDays)} was accepted`,
      );
      assert(
        result.reason === "invalid_arguments",
        `windowDays ${JSON.stringify(windowDays)} reason is ${result.reason}`,
      );
    }
    const missing = await tool.execute({});
    assert(
      missing.available === false && missing.reason === "invalid_arguments",
      "a missing customerId was accepted",
    );
    const unknownFilter = await tool.execute({
      customerId: "CCC107",
      filters: { betPrice: "1" },
    });
    assert(
      unknownFilter.available === false &&
        unknownFilter.reason === "invalid_arguments",
      "an unknown filters key was accepted",
    );
    assert(
      unknownFilter.message.includes("betPrice"),
      "the filters refusal does not name the rejected key",
    );
    const badKind = await tool.execute({
      customerId: "CCC107",
      filters: { kind: "bogus" },
    });
    assert(
      badKind.available === false && badKind.reason === "invalid_arguments",
      "an unknown Group Kind was accepted",
    );
    for (const kind of GSLIVE_GROUP_KINDS) {
      assert(
        badKind.message.includes(kind),
        `kind refusal does not list the lib kind ${kind}`,
      );
    }
    const nonStringFilter = await tool.execute({
      customerId: "CCC107",
      filters: { agent: 7 },
    });
    assert(
      nonStringFilter.available === false &&
        nonStringFilter.reason === "invalid_arguments",
      "a non-string filter value was accepted",
    );
  },
);

await checkAsync(
  "sportsdesk_links reproduces the observed canceled 7-day window through the CLI",
  async () => {
    const result = await byName.get("sportsdesk_links").execute({
      customerId: "ccc107",
      state: "canceled",
      windowDays: 7,
      date: "2026-11-03",
      filters: {
        agent: "AG1",
        betId: "b123,b456",
        kind: "player",
        groupName: "Group A",
        period: "3rd Quarter",
        sportId: "2",
        marketIds: "m1,m2",
      },
    });
    assert(
      result.available === true,
      `link builder unavailable: ${result.message}`,
    );
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
      "toTime=86399",
    ]) {
      assert(
        links.playerCanceledBetHistoryDeepLinkUrl.includes(expected),
        `canceled link is missing ${expected}`,
      );
    }
    for (const expected of [
      "agent=AG1",
      "betId=123%20456",
      "kind=player",
      "groupName=Group%20A",
      "period=s3",
      "sId=2",
      "mId=m1%2Cm2",
    ]) {
      assert(
        links.playerCanceledBetHistoryDeepLinkUrl.includes(expected),
        `canceled link is missing the serialised filter ${expected}`,
      );
    }
    assert(
      !links.playerCanceledBetHistoryDeepLinkUrl.includes("betGroupId="),
      "a filter that was not requested was serialised",
    );
    // The hash-route state filter is observed; the getBetReport payload's state is not.
    assert(
      links.getBetReportObservedPayload.state === "",
      "the payload state was fabricated",
    );
    assert(
      result.command.includes("cli/sportsdesk_cli.ts gslive"),
      `command is ${result.command}`,
    );
  },
);

await checkAsync("sportsdesk_dev refuses unknown gates", async () => {
  for (const gate of [
    "nuke",
    "toString",
    "__proto__",
    "constructor",
    "env",
    "tokens",
  ]) {
    const result = await byName.get("sportsdesk_dev").execute({ run: [gate] });
    assert(result.available === false, `${gate} was accepted`);
    assert(
      result.reason === "unknown_gate",
      `${gate} reason is ${result.reason}`,
    );
  }
});

await checkAsync("sportsdesk_dev refuses a non-array run", async () => {
  // Raw registration does not validate arguments, so the body owns this refusal.
  const result = await byName.get("sportsdesk_dev").execute({ run: "secrets" });
  assert(result.available === false, "a non-array run was accepted");
  assert(result.reason === "invalid_run", `reason is ${result.reason}`);
});

await checkAsync("sportsdesk_data refuses an unknown dataset", async () => {
  const result = await byName.get("sportsdesk_data").execute({
    dataset: "not_a_dataset",
  });
  assert(result.reason === "unknown_dataset", `reason is ${result.reason}`);
});

await checkAsync("sportsdesk_data reports live-capture freshness", async () => {
  const tool = byName.get("sportsdesk_data");
  const capture = await tool.execute({ report: "capture" });
  assert(capture.available === true, "capture report was unavailable");
  assert(Array.isArray(capture.artifacts), "capture artifacts missing");
  const liveBets = capture.artifacts.find(
    (entry) => entry.name === "live-bets",
  );
  assert(liveBets !== undefined, "live-bets artifact not reported");
  assert(typeof liveBets.exists === "boolean", "exists must be a boolean");
  assert(liveBets.budgetMinutes === 120, "live-bets budget drifted");
  assert(
    typeof capture.ledger.present === "boolean",
    "ledger presence must be a boolean",
  );
  if (capture.ledger.present === false) {
    assert(
      String(capture.ledger.note).includes("MISSING"),
      "an absent journal must read MISSING, not zero sources",
    );
  }
  for (const artifact of capture.artifacts) {
    const effectiveAge =
      artifact.stampAgeMinutes ?? artifact.artifactAgeMinutes;
    assert(
      artifact.stale === null ||
        artifact.stale === effectiveAge > artifact.budgetMinutes,
      `stale flag disagrees with its own age for ${artifact.name}`,
    );
    assert(
      ["api", "paste", "derived"].includes(artifact.capturePath),
      `unknown capturePath for ${artifact.name}: ${artifact.capturePath}`,
    );
    assert(
      typeof artifact.refresh === "string",
      `no refresh command for ${artifact.name}`,
    );
    if (artifact.capturePath === "paste") {
      assert(
        typeof artifact.pasteFileName === "string",
        `a paste artifact must name its input file: ${artifact.name}`,
      );
    }
  }
  assert(
    Array.isArray(capture.stalePasteArtifacts),
    "stalePasteArtifacts is missing from the capture report",
  );
  for (const entry of capture.stalePasteArtifacts) {
    assert(
      typeof entry.pasteFileName === "string",
      `stale paste artifact ${entry.name} has no input file name`,
    );
  }
  const unknownReport = await tool.execute({ report: "nope" });
  assert(
    unknownReport.reason === "unknown_report",
    "an unknown report was accepted",
  );
});

await checkAsync(
  "sportsdesk_downline refuses unknown subcommands",
  async () => {
    for (const subcommand of ["winners", "losers", "leaderboard", "drop"]) {
      const result = await byName
        .get("sportsdesk_downline")
        .execute({ subcommand });
      assert(result.available === false, `${subcommand} was accepted`);
      assert(
        result.reason === "unknown_subcommand",
        `${subcommand} reason is ${result.reason}`,
      );
    }
  },
);

await checkAsync("sportsdesk_downline validation refusals", async () => {
  const tool = byName.get("sportsdesk_downline");
  const missingId = await tool.execute({ subcommand: "agent" });
  assert(missingId.reason === "invalid_agent_id", "missing agentId accepted");
  const badLimit = await tool.execute({ subcommand: "top", limit: 0 });
  assert(badLimit.reason === "invalid_limit", "limit 0 accepted");
  const badSort = await tool.execute({ subcommand: "top", sortBy: "profit" });
  assert(badSort.reason === "unknown_sort", "unknown sort accepted");
});

console.log("\nverify-load: report form executes nothing");

await checkAsync(
  "sportsdesk_dev with no run names leaves every gate not_run",
  async () => {
    const result = await byName.get("sportsdesk_dev").execute({});
    assert(result.ok === null, `ok is ${JSON.stringify(result.ok)}`);
    assert(result.executed.length === 0, "something was executed");
    const statuses = new Set(
      Object.values(result.gates).map((gate) => gate.status),
    );
    assert(
      statuses.size === 1 && statuses.has("not_run"),
      `statuses are ${JSON.stringify([...statuses])}`,
    );
  },
);

console.log("\nverify-load: read-only tools answer against the real repo");

await checkAsync("sportsdesk_status reads the checkout", async () => {
  const result = await byName.get("sportsdesk_status").execute({
    service: false,
  });
  assert(result.available === true, "status was unavailable");
  assert(result.repo?.git?.available === true, "git state was unavailable");
  assert(typeof result.repo.git.branch === "string", "branch missing");
  JSON.stringify(result);
});

await checkAsync("sportsdesk_data inventories the datasets", async () => {
  const result = await byName.get("sportsdesk_data").execute({});
  assert(result.available === true, "data was unavailable");
  assert(
    Array.isArray(result.datasets) && result.datasets.length > 0,
    "no datasets were reported",
  );
  // EXPECTED counts come from the source files, not from this script.
  const downlineSource = await Bun.file(
    `${REPO}/sportsdesk_downline_data.json`,
  ).json();
  const downline = result.datasets.find((entry) => entry.name === "downline");
  assert(downline?.exists === true, "downline snapshot missing");
  assert(
    downline.records === downlineSource.agents.length,
    `downline records ${downline.records} != source ${downlineSource.agents.length}`,
  );
  const bookSource = await Bun.file(
    `${REPO}/enriched_customers_full.json`,
  ).json();
  const customers = result.datasets.find((entry) => entry.name === "customers");
  assert(
    customers?.records === bookSource.length,
    `customer records ${customers?.records} != source ${bookSource.length}`,
  );
});

await checkAsync("sportsdesk_data inlines one requested dataset", async () => {
  const result = await byName
    .get("sportsdesk_data")
    .execute({ dataset: "downline" });
  const downline = result.datasets.find((entry) => entry.name === "downline");
  assert(downline?.inlined === true, "downline was not inlined");
  assert(typeof downline.data?.meta === "object", "inlined data has no meta");
});

await checkAsync("sportsdesk_downline summarizes the snapshot", async () => {
  const result = await byName
    .get("sportsdesk_downline")
    .execute({ subcommand: "summary" });
  assert(result.available === true, "downline was unavailable");
  assert(typeof result.source?.mtime === "string", "source mtime missing");
  assert(
    typeof result.meta?.total_sub_agents === "number",
    "meta.total_sub_agents missing",
  );
});

await checkAsync(
  "sportsdesk_downline finds one agent, case-insensitively",
  async () => {
    const result = await byName
      .get("sportsdesk_downline")
      .execute({ subcommand: "agent", agentId: "bigdad" });
    assert(result.found === true, "BIGDAD was not found");
    assert(
      result.agent?.agent === "BIGDAD",
      "agent id was not normalised back",
    );
  },
);

await checkAsync("sportsdesk_downline ranks agents by net", async () => {
  const snapshot = await Bun.file(
    `${REPO}/sportsdesk_downline_data.json`,
  ).json();
  const limit = 3;
  const expected = Math.min(limit, snapshot.agents.length);
  const result = await byName
    .get("sportsdesk_downline")
    .execute({ subcommand: "top", limit });
  assert(
    result.agents?.length === expected,
    `returned ${result.agents?.length}, source has ${snapshot.agents.length}`,
  );
  const nets = result.agents.map((agent) => Number(agent.lifetime_net));
  for (let index = 1; index < nets.length; index += 1) {
    assert(
      nets[index - 1] >= nets[index],
      `not descending: ${JSON.stringify(nets)}`,
    );
  }
});

await checkAsync(
  "sportsdesk_customer derives every count from the book",
  async () => {
    const tool = byName.get("sportsdesk_customer");
    const book = await Bun.file(`${REPO}/enriched_customers_full.json`).json();
    const ticketTotal = book.reduce(
      (total, row) =>
        total +
        (Array.isArray(row.recent_tickets) ? row.recent_tickets.length : 0),
      0,
    );

    const summary = await tool.execute({ report: "summary" });
    assert(summary.available === true, "summary unavailable");
    assert(
      summary.derived?.customers === book.length,
      `customers ${summary.derived?.customers} != source ${book.length}`,
    );
    assert(
      summary.derived?.totalRecentTickets === ticketTotal,
      `tickets ${summary.derived?.totalRecentTickets} != source ${ticketTotal}`,
    );
    assert(
      typeof summary.source?.mtime === "string",
      "summary source mtime missing",
    );

    const limit = 3;
    const top = await tool.execute({ report: "top", sortBy: "net", limit });
    assert(
      top.customers?.length === Math.min(limit, book.length),
      `top returned ${top.customers?.length}`,
    );
    for (let index = 1; index < top.customers.length; index += 1) {
      assert(
        Number(top.customers[index - 1].lifetime_net_usd) >=
          Number(top.customers[index].lifetime_net_usd),
        "top is not descending by net",
      );
    }

    // The 7d window must also be derived from the source rows, not from a fixed list.
    const expectedSevenDay = book
      .filter((row) => (row.sports_7d_net_usd ?? 0) > 0)
      .sort(
        (left, right) =>
          (right.sports_7d_net_usd ?? 0) - (left.sports_7d_net_usd ?? 0),
      )
      .slice(0, Math.min(limit, book.length))
      .map((row) => row.customer_id);
    const sevenDayTop = await tool.execute({
      report: "top",
      sortBy: "net",
      window: "7d",
      limit,
    });
    assert(
      sevenDayTop.customers?.length === expectedSevenDay.length,
      `7d top returned ${sevenDayTop.customers?.length}, source has ${expectedSevenDay.length}`,
    );
    assert(
      sevenDayTop.customers?.[0]?.customer_id === expectedSevenDay[0],
      `7d top ${sevenDayTop.customers?.[0]?.customer_id} != source ${expectedSevenDay[0]}`,
    );
    const badWindow = await tool.execute({ report: "top", window: "month" });
    assert(
      badWindow.reason === "invalid_arguments",
      "an unsupported window was accepted",
    );
    const lifetimeOnlySort = await tool.execute({
      report: "top",
      sortBy: "clv",
      window: "7d",
    });
    assert(
      lifetimeOnlySort.reason === "invalid_arguments",
      "clv was accepted on the 7d window",
    );

    // "sharp" must derive its candidate set from the book, not from a list.
    const threshold = 70;
    const expectedCandidates = book.filter(
      (row) =>
        (row.sharp_score ?? Number.NEGATIVE_INFINITY) >= threshold ||
        (row.clv_bps ?? 0) > 0,
    );
    const sharp = await tool.execute({
      report: "sharp",
      minSharp: threshold,
      limit,
    });
    assert(sharp.available === true, "sharp report unavailable");
    assert(
      sharp.candidates === expectedCandidates.length,
      `sharp candidates ${sharp.candidates} != source ${expectedCandidates.length}`,
    );
    assert(
      sharp.customers?.length === Math.min(limit, expectedCandidates.length),
      `sharp returned ${sharp.customers?.length}`,
    );
    assert(
      sharp.thresholdSource === "caller",
      `explicit threshold source ${sharp.thresholdSource}`,
    );
    const defaultSharp = await tool.execute({ report: "sharp", limit: 1 });
    assert(
      defaultSharp.thresholdSource === "cohort-p90",
      `customer sharp default source ${defaultSharp.thresholdSource}`,
    );
    assert(
      Math.abs(defaultSharp.threshold - defaultSharp.cutoffs.sharpP90) < 1e-9,
      `customer sharp default ${defaultSharp.threshold} != p90 ${defaultSharp.cutoffs.sharpP90}`,
    );
    const badThreshold = await tool.execute({
      report: "sharp",
      minSharp: 101,
    });
    assert(
      badThreshold.reason === "invalid_arguments",
      "an out-of-range minSharp was accepted",
    );

    // "profile" / "signals" / "compare": ranks and cutoffs must be derived from the book.
    const topVolume = book
      .slice()
      .sort(
        (left, right) =>
          (right.lifetime_volume_usd ?? 0) - (left.lifetime_volume_usd ?? 0),
      )[0];
    const profile = await tool.execute({
      report: "profile",
      customerId: topVolume.customer_id,
    });
    assert(
      profile.available === true && profile.found === true,
      "profile was unavailable",
    );
    assert(
      profile.customer_id === topVolume.customer_id,
      `profile id ${profile.customer_id} != source ${topVolume.customer_id}`,
    );
    assert(
      profile.sample?.tickets === (topVolume.recent_tickets ?? []).length,
      `profile tickets ${profile.sample?.tickets} != source ${(topVolume.recent_tickets ?? []).length}`,
    );
    assert(
      profile.cohortRanksPct?.volume >= 90,
      `top-volume rank ${profile.cohortRanksPct?.volume} is below 90`,
    );
    assert(
      profile.cohortRanksPct?.volume <= 100,
      "a percentile above 100 was returned",
    );
    assert(
      profile.cutoffs?.volumeP90 !== null,
      "profile did not return the cohort volume cutoff",
    );
    assert(
      profile.flags?.topDecileVolume ===
        topVolume.lifetime_volume_usd >= profile.cutoffs.volumeP90,
      "profile flag disagrees with its own cutoff",
    );
    const noProfileId = await tool.execute({ report: "profile" });
    assert(
      noProfileId.reason === "invalid_arguments",
      "profile without customerId was accepted",
    );
    const unknownProfile = await tool.execute({
      report: "profile",
      customerId: "NOT-A-CUSTOMER",
    });
    assert(
      unknownProfile.found === false,
      "an unknown profile id was reported as found",
    );

    const signals = await tool.execute({ report: "signals", limit });
    assert(signals.available === true, "signals was unavailable");
    const expectedWhales = book.filter(
      (row) =>
        (row.lifetime_volume_usd ?? Number.NEGATIVE_INFINITY) >=
        signals.cutoffs.volumeP90,
    ).length;
    assert(
      signals.signals?.whales?.matched === expectedWhales,
      `whales ${signals.signals?.whales?.matched} != source ${expectedWhales}`,
    );
    assert(
      signals.signals?.whales?.returned === Math.min(limit, expectedWhales),
      "whales returned count does not match the limit",
    );
    for (const row of signals.signals.whales.customers) {
      assert(
        row.lifetime_volume_usd >= signals.cutoffs.volumeP90,
        "a whale is below the returned cutoff",
      );
    }
    const subnetCounts = new Map();
    for (const row of book) {
      const subnet = String(row.ip_subnet ?? "").trim();
      if (subnet !== "")
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1);
    }
    const expectedNetworks = [...subnetCounts.values()].filter(
      (count) => count >= 2,
    ).length;
    assert(
      signals.multiAccountNetworks?.matched === expectedNetworks,
      `networks ${signals.multiAccountNetworks?.matched} != source ${expectedNetworks}`,
    );

    // Dormant must compare UNROUNDED staleness against the cutoff. Rounding it to one
    // decimal first made every customer fall below p90 and silently reported 0 matches.
    const lastByCustomer = new Map();
    let newestPlaced = "";
    for (const row of book) {
      let last = "";
      for (const ticket of row.recent_tickets ?? []) {
        const placed = String(ticket.placed_at ?? "");
        if (placed > last) last = placed;
        if (placed > newestPlaced) newestPlaced = placed;
      }
      if (last !== "") lastByCustomer.set(row.customer_id, last);
    }
    const newestMs = Date.parse(newestPlaced);
    const expectedDormant = book.filter((row) => {
      const last = lastByCustomer.get(row.customer_id);
      if (last === undefined) return false;
      return (
        (newestMs - Date.parse(last)) / 86_400_000 >=
        signals.cutoffs.dormantDaysP90
      );
    }).length;
    assert(
      signals.signals.dormant.matched === expectedDormant,
      `dormant ${signals.signals.dormant.matched} != source ${expectedDormant}`,
    );
    assert(
      expectedDormant > 0,
      "a book with a staleness spread derived 0 dormant customers",
    );

    // "integrity": the provenance verdict and every feature count must come from the book.
    const integrity = await tool.execute({ report: "integrity" });
    assert(integrity.available === true, "integrity was unavailable");
    const ticketRows = book.flatMap((row) => row.recent_tickets ?? []);
    const documentationPrefixes = ["192.0.2.", "198.51.100.", "203.0.113."];
    const expectedDocSubnets = new Set(
      book
        .map((row) => String(row.ip_subnet ?? "").trim())
        .filter((subnet) =>
          documentationPrefixes.some((prefix) => subnet.startsWith(prefix)),
        ),
    ).size;
    assert(
      integrity.integrity.subnets.documentationRange === expectedDocSubnets,
      `documentation subnets ${integrity.integrity.subnets.documentationRange} != source ${expectedDocSubnets}`,
    );
    const expectedPlaceholders = ticketRows.filter((ticket) =>
      /^(Selection #\d+|Game Matchup \d+)$/.test(
        String(ticket.selection ?? ""),
      ),
    ).length;
    assert(
      integrity.integrity.selections.placeholderCount === expectedPlaceholders,
      `placeholder tickets ${integrity.integrity.selections.placeholderCount} != source ${expectedPlaceholders}`,
    );
    const expectedStamps = new Set(
      ticketRows.map((ticket) => String(ticket.placed_at ?? "")),
    ).size;
    assert(
      integrity.integrity.timestamps.distinct === expectedStamps,
      `timestamps ${integrity.integrity.timestamps.distinct} != source ${expectedStamps}`,
    );
    assert(
      integrity.integrity.ticketCounts.distinct === 1,
      "the book no longer has a uniform sample size; revisit the feature",
    );
    assert(
      integrity.integrity.character === "generated-fixture",
      `expected a generated-fixture verdict, got ${integrity.integrity.character}`,
    );
    assert(
      integrity.integrity.features.length >= 3,
      `expected at least 3 provenance features, got ${integrity.integrity.features.length}`,
    );
    assert(
      profile.bookIntegrity?.character === integrity.integrity.character,
      "profile does not carry the same book character",
    );
    assert(
      signals.bookIntegrity?.character === integrity.integrity.character,
      "signals does not carry the same book character",
    );
    assert(
      typeof signals.multiAccountNetworks?.interpretation === "string",
      "multiAccountNetworks has no provenance interpretation",
    );

    const compare = await tool.execute({
      report: "compare",
      customerIds: [book[0].customer_id, book[1].customer_id],
    });
    assert(compare.available === true, "compare was unavailable");
    assert(
      compare.customers?.length === compare.compared && compare.compared === 2,
      `compare returned ${compare.customers?.length} of ${compare.compared}`,
    );
    const singleCompare = await tool.execute({
      report: "compare",
      customerIds: [book[0].customer_id],
    });
    assert(
      singleCompare.reason === "invalid_arguments",
      "compare accepted a single customer id",
    );

    const byAgent = new Map();
    for (const row of book) {
      const key = row.agent_id;
      const group = byAgent.get(key) ?? { customers: 0, net: 0 };
      group.customers += 1;
      group.net += row.lifetime_net_usd;
      byAgent.set(key, group);
    }
    const agentReport = await tool.execute({ report: "agent", limit });
    assert(agentReport.available === true, "agent report unavailable");
    assert(
      agentReport.totalAgents === byAgent.size,
      `totalAgents ${agentReport.totalAgents} != source ${byAgent.size}`,
    );
    const expectedTopAgent = [...byAgent.entries()].sort(
      (left, right) => right[1].net - left[1].net,
    )[0]?.[0];
    assert(
      agentReport.agents?.[0]?.agent_id === expectedTopAgent,
      `top agent ${agentReport.agents?.[0]?.agent_id} != source ${expectedTopAgent}`,
    );
    const agentFilter = await tool.execute({
      report: "agent",
      agentId: String(expectedTopAgent).toLowerCase(),
    });
    assert(
      agentFilter.agents?.length === 1 &&
        agentFilter.agents[0].agent_id === expectedTopAgent,
      "agent filter did not isolate one agent",
    );

    const firstId = book[0].customer_id;
    const lookup = await tool.execute({
      report: "lookup",
      customerId: String(firstId).toLowerCase(),
    });
    assert(lookup.found === true, `lookup missed ${firstId}`);
    assert(
      lookup.ticketDerived?.count === (book[0].recent_tickets ?? []).length,
      "ticket-derived count does not match the source row",
    );

    const search = await tool.execute({ report: "search", q: String(firstId) });
    assert(
      search.customers?.some((row) => row.customer_id === firstId),
      `search missed ${firstId}`,
    );

    const unknown = await tool.execute({ report: "nope" });
    assert(
      unknown.reason === "unknown_report",
      `unknown reason ${unknown.reason}`,
    );
    const missingId = await tool.execute({ report: "lookup" });
    assert(
      missingId.reason === "invalid_arguments",
      "a lookup without customerId was accepted",
    );
  },
);

await checkAsync("sportsdesk_markets refuses unknown reports", async () => {
  for (const report of ["winners", "toString", "__proto__", "constructor"]) {
    const result = await byName.get("sportsdesk_markets").execute({ report });
    assert(result.available === false, `${report} was accepted`);
    assert(result.reason === "unknown_report", `${report} -> ${result.reason}`);
  }
  const badLimit = await byName
    .get("sportsdesk_markets")
    .execute({ report: "bridge", limit: 0 });
  assert(badLimit.reason === "invalid_arguments", "limit 0 accepted");
});

await checkAsync(
  "sportsdesk_markets summarizes the staged reports",
  async () => {
    const tool = byName.get("sportsdesk_markets");
    const combos = await tool.execute({ report: "combo-uniqueness" });
    assert(combos.available === true, "combo-uniqueness unavailable");
    assert(
      typeof combos.source?.generatedAtIso === "string",
      "generatedAtIso missing",
    );
    assert(combos.gates?.permissive?.kept > 0, "permissive gate kept nothing");
    const bridgeSource = await Bun.file(
      `${REPO}/dist/cross-domain-bridge.json`,
    ).json();
    const leadLimit = 3;
    const bridge = await tool.execute({ report: "bridge", limit: leadLimit });
    assert(
      bridge.leads?.length === Math.min(leadLimit, bridgeSource.leads.length),
      `leads ${bridge.leads?.length}, source ${bridgeSource.leads.length}`,
    );
    const priorities = bridge.leads.map((lead) => Number(lead.priorityUsd));
    assert(
      priorities[0] >= priorities[1] && priorities[1] >= priorities[2],
      `leads not ranked: ${JSON.stringify(priorities)}`,
    );
    const backtest = await tool.execute({ report: "backtest", limit: 2 });
    assert(backtest.available === true, "backtest unavailable");
    assert(
      typeof backtest.totals?.baselineTotalDeskNetUsd4Wk === "number",
      "backtest totals missing",
    );
    const backtestSource = await Bun.file(
      `${REPO}/dist/backtest-4wk-cfb-nba.json`,
    ).json();
    assert(
      backtest.comboFamilies?.length ===
        Math.min(2, backtestSource.comboFamilyBreakdown.length) &&
        backtest.customerLeaderboard?.length ===
          Math.min(2, backtestSource.customerLeaderboard.length),
      "backtest list caps are not derived from source",
    );
  },
);

await checkAsync(
  "sportsdesk_markets filters lists from the source",
  async () => {
    const bridgeArtifact = await Bun.file(
      `${REPO}/dist/cross-domain-bridge.json`,
    ).json();
    const verdict = "POLY_ONLY_UP";
    const expectedLeads = bridgeArtifact.leads.filter(
      (lead) => lead.verdict === verdict,
    ).length;
    const leads = await byName
      .get("sportsdesk_markets")
      .execute({ report: "bridge", verdict, limit: 100 });
    assert(
      leads.leads?.length === Math.min(100, expectedLeads),
      `filtered leads ${leads.leads?.length} != source ${expectedLeads}`,
    );

    const backtestArtifact = await Bun.file(
      `${REPO}/dist/backtest-4wk-cfb-nba.json`,
    ).json();
    const sport = "CFB";
    const expectedFamilies = backtestArtifact.comboFamilyBreakdown.filter(
      (family) => family.sport === sport,
    ).length;
    const families = await byName
      .get("sportsdesk_markets")
      .execute({ report: "backtest", sport, limit: 100 });
    assert(
      families.comboFamilies?.length === Math.min(100, expectedFamilies),
      `filtered families ${families.comboFamilies?.length} != source ${expectedFamilies}`,
    );
  },
);

await checkAsync(
  "sportsdesk_customer subsport derives ROI and CLV per league",
  async () => {
    const book = await Bun.file(`${REPO}/enriched_customers_full.json`).json();
    const tool = byName.get("sportsdesk_customer");
    const result = await tool.execute({ report: "subsport", limit: 100 });
    assert(result.available === true, "subsport unavailable");
    assert(result.dimension === "league", "default dimension is not league");
    assert(result.cohort === "curated-profiles", `cohort ${result.cohort}`);
    assert(typeof result.cohortNote === "string", "cohortNote missing");
    const byLeague = new Map();
    for (const row of book) {
      for (const ticket of row.recent_tickets ?? []) {
        const league = ticket.league ?? "UNKNOWN";
        const bucket = byLeague.get(league) ?? { risk: 0, net: 0 };
        bucket.risk += Number(ticket.risk_usd ?? 0);
        bucket.net += Number(ticket.net_usd ?? 0);
        byLeague.set(league, bucket);
      }
    }
    const topLeague = [...byLeague.entries()].sort(
      (left, right) => right[1].risk - left[1].risk,
    )[0];
    assert(
      result.subsports?.[0]?.league === topLeague?.[0],
      `top league ${result.subsports?.[0]?.league} != source ${topLeague?.[0]}`,
    );
    assert(
      result.subsports?.[0]?.sample?.riskUsd === topLeague?.[1].risk,
      `league risk ${result.subsports?.[0]?.sample?.riskUsd} != source ${topLeague?.[1].risk}`,
    );
    const expectedLifetimeRoi =
      (book.reduce((total, row) => total + row.lifetime_net_usd, 0) /
        book.reduce((total, row) => total + row.lifetime_volume_usd, 0)) *
      100;
    assert(
      Math.abs((result.cohortLifetime?.roiPct ?? 0) - expectedLifetimeRoi) <
        1e-9,
      `cohort lifetime ROI ${result.cohortLifetime?.roiPct} != source ${expectedLifetimeRoi}`,
    );
    assert(
      typeof result.subsports?.[0]?.lifetime?.roiPct === "number",
      "lifetime ROI missing from the row",
    );
    for (const row of result.subsports) {
      assert(
        typeof row.sample === "object" &&
          typeof row.lifetime === "object" &&
          row.sample !== null &&
          row.lifetime !== null,
        "row is missing the sample/lifetime split",
      );
    }
    const badDimension = await tool.execute({
      report: "subsport",
      dimension: "nope",
    });
    assert(
      badDimension.reason === "invalid_arguments",
      "an unsupported dimension was accepted",
    );
  },
);

await checkAsync(
  "sportsdesk_ticker derives pending and wagers from the captures",
  async () => {
    const tool = byName.get("sportsdesk_ticker");
    const pendingSource = await Bun.file(`${REPO}/data/live-bets.json`).json();
    const pending = await tool.execute({ report: "pending", limit: 100 });
    assert(pending.available === true, "pending unavailable");
    assert(
      pending.pendingCount === pendingSource.pendingCount,
      `pendingCount ${pending.pendingCount} != source ${pendingSource.pendingCount}`,
    );
    const expectedWagered = pendingSource.games.reduce(
      (total, game) => total + Number(game.wagered ?? 0),
      0,
    );
    assert(
      pending.wagered === expectedWagered,
      `wagered ${pending.wagered} != source ${expectedWagered}`,
    );
    assert(
      pending.scope === "agent-pending-report",
      `pending scope ${pending.scope}`,
    );
    assert(
      typeof pending.ageMinutes === "number",
      "pending ageMinutes missing",
    );
    assert(
      pending.totalGames === pendingSource.games.length,
      "game count does not match the source",
    );

    const wagersSource = await Bun.file(`${REPO}/data/live-wagers.json`).json();
    const wagers = await tool.execute({ report: "wagers", limit: 100 });
    assert(wagers.available === true, "wagers unavailable");
    assert(
      wagers.totalWagers === wagersSource.LIST.length,
      "wager count does not match the source",
    );
    const expectedAmount = wagersSource.LIST.reduce(
      (total, wager) => total + Number(wager.AmountWagered ?? 0),
      0,
    );
    assert(
      wagers.wagered === expectedAmount,
      `wagered ${wagers.wagered} != source ${expectedAmount}`,
    );
    assert(
      wagers.scope === "clipboard-ticker-sample",
      `wagers scope ${wagers.scope}`,
    );
    assert(wagers.parseWarnings === 0, `parseWarnings ${wagers.parseWarnings}`);
    assert(
      typeof wagers.wagerTypeLegend === "string",
      "wagerTypeLegend missing",
    );
    assert(
      typeof wagers.wagers?.[0]?.descCode === "string",
      "wager descCode missing",
    );

    const reconcile = await tool.execute({ report: "reconcile" });
    assert(
      reconcile.scope === "disjoint",
      `reconcile scope ${reconcile.scope}`,
    );
    assert(reconcile.overlapKeys === 0, "reconcile found an overlap");
    assert(
      typeof reconcile.magnitudeGapWagered === "number",
      "magnitude gap missing",
    );

    const unknown = await tool.execute({ report: "nope" });
    assert(
      unknown.reason === "unknown_report",
      "unknown ticker report accepted",
    );
  },
);

await checkAsync(
  "sportsdesk_endpoints derives coverage from the evidence files",
  async () => {
    const ledger = await Bun.file(`${REPO}/docs/evidence/ledger.json`).json();
    const spec = await Bun.file(`${REPO}/dist/openapi.json`).json();
    const tool = byName.get("sportsdesk_endpoints");

    const summary = await tool.execute({});
    assert(summary.available === true, "summary unavailable");
    assert(
      summary.derived.operations === ledger.operations.length,
      `operations ${summary.derived.operations} != source ${ledger.operations.length}`,
    );
    assert(
      summary.derived.specPaths === Object.keys(spec.paths).length,
      `spec paths ${summary.derived.specPaths} != source ${Object.keys(spec.paths).length}`,
    );
    const tierACount = ledger.operations.filter(
      (operation) => operation.tier === "A",
    ).length;
    assert(
      summary.derived.byTier.A === tierACount,
      `tier A ${summary.derived.byTier.A} != source ${tierACount}`,
    );

    const limit = 3;
    const listed = await tool.execute({ report: "list", tier: "A", limit });
    assert(
      listed.operations.length === Math.min(limit, tierACount),
      `listed ${listed.operations.length} of ${tierACount}`,
    );
    for (const row of listed.operations) {
      assert(row.tier === "A", `${row.path} leaked a non-A tier`);
    }

    const gaps = await tool.execute({ report: "gaps", limit: 5 });
    for (const row of gaps.gaps) {
      assert(
        row.ledgerCaptured === false || row.manifestCaptured === false,
        `${row.path} is a gap without a missing evidence claim`,
      );
      assert(Array.isArray(row.missing), "a gap has no missing list");
    }

    const { PROBE_OPS } = await import(`${REPO}/lib/f402_probe.ts`);
    assert(
      summary.probeCatalog?.available === true,
      "the PROBE_OPS catalog did not load",
    );
    assert(
      summary.probeCatalog.total === PROBE_OPS.length,
      `probe ops ${summary.probeCatalog.total} != source ${PROBE_OPS.length}`,
    );
    assert(
      gaps.probeCatalog?.available === true,
      "the gaps report has no probe catalog",
    );

    const service = await tool.execute({ report: "service" });
    assert(service.available === true, "service report unavailable");
    assert(service.ok === true, "check:route-surface failed");
    assert(
      service.counts?.servedPaths > 0,
      `served paths ${service.counts?.servedPaths}`,
    );
    assert(
      service.counts?.declared > 0,
      `declared ${service.counts?.declared}`,
    );

    // The trend must be derived from the applied-*.json journal, not checked in.
    const appliedFiles = Array.from(
      new Bun.Glob("applied-*.json").scanSync(`${REPO}/docs/evidence/captures`),
    );
    assert(summary.trend?.available === true, "trend unavailable");
    assert(
      summary.trend.snapshots.length === Math.min(20, appliedFiles.length),
      `trend reported ${summary.trend.snapshots.length} of ${appliedFiles.length} snapshots`,
    );
    assert(summary.trend.snapshots.length > 0, "trend reported no snapshots");
    for (const snapshot of summary.trend.snapshots) {
      assert(
        typeof snapshot.after === "object" && snapshot.after !== null,
        `${snapshot.file} has no ledger counts`,
      );
      for (const tier of ["A", "B", "C", "D", "E"]) {
        const from = Number(snapshot.before?.[tier]);
        const to = Number(snapshot.after?.[tier]);
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        assert(
          snapshot.delta[tier] === to - from,
          `${snapshot.file} delta ${tier} disagrees with its own counts`,
        );
      }
    }
    assert(
      summary.trend.latest?.deltaA ===
        Number(summary.trend.latest?.tierA) -
          Number(summary.trend.snapshots.at(-1)?.before?.A),
      "latest deltaA disagrees with the snapshot counts",
    );

    const badTier = await tool.execute({ report: "list", tier: "Z" });
    assert(
      badTier.reason === "invalid_arguments",
      "an unknown tier was accepted",
    );
    const unknown = await tool.execute({ report: "nope" });
    assert(unknown.reason === "unknown_report", "unknown report accepted");
  },
);

await checkAsync(
  "sportsdesk_security audits the capture store and withholds identifiers",
  async () => {
    const manifest = await Bun.file(
      `${REPO}/docs/evidence/captures/manifest.json`,
    ).json();
    const tool = byName.get("sportsdesk_security");

    const captures = await tool.execute({ report: "captures", limit: 100 });
    assert(captures.available === true, "captures unavailable");
    assert(
      captures.total === manifest.captures.length,
      `captures ${captures.total} != source ${manifest.captures.length}`,
    );
    const expectedClean = manifest.captures.filter(
      (entry) => entry.redaction?.clean === true,
    ).length;
    assert(
      captures.clean === expectedClean,
      `clean ${captures.clean} != source ${expectedClean}`,
    );
    assert(
      captures.rows.length === Math.min(100, captures.total),
      "rows do not match the limit",
    );

    const identifiers = await tool.execute({ report: "identifiers", limit: 5 });
    assert(identifiers.available === true, "identifiers unavailable");
    assert(identifiers.ok === true, "the identifier scanner failed");
    assert(
      typeof identifiers.scanned === "number" && identifiers.scanned > 0,
      "the scanner did not report a file count",
    );
    assert(
      !JSON.stringify(identifiers).includes("BILLY666"),
      "the scanner leaked an identifier literal",
    );
    assert(
      identifiers.knownAgentHits + identifiers.unclassifiedIdentifiers ===
        identifiers.totalIdentifiers,
      "the agent/unclassified split does not add up",
    );
    assert(
      identifiers.calibration?.ok === true,
      `calibration fixtures produced hits: ${JSON.stringify(identifiers.calibration)}`,
    );
    assert(
      identifiers.calibration.files.every((entry) => entry.count === 0),
      "a labeled-safe fixture is not zero",
    );
    const expectedSeverity =
      identifiers.totalIdentifiers === 0
        ? "clean"
        : identifiers.unclassifiedIdentifiers === 0
          ? "internal-only"
          : "unclassified";
    assert(
      identifiers.severity === expectedSeverity,
      `severity ${identifiers.severity} != derived ${expectedSeverity}`,
    );
    for (const row of identifiers.files) {
      assert(typeof row.path === "string", "a hit has no path");
      assert(
        Number.isInteger(row.count) && row.count > 0,
        "a hit has no positive count",
      );
      assert(
        row.knownAgent + row.unclassified === row.count,
        `${row.path} split disagrees with its count`,
      );
    }

    const secrets = await tool.execute({ report: "secrets" });
    assert(secrets.available === true, "secrets unavailable");
    assert(
      secrets.ok === (secrets.findingCount === 0),
      "secrets ok disagrees with its own finding count",
    );

    const summary = await tool.execute({});
    assert(summary.available === true, "summary unavailable");
    assert(
      summary.identifiers?.calibration?.ok === true,
      "summary dropped the calibration verdict",
    );
    const expectedVerdict =
      summary.identifiers.unclassifiedIdentifiers > 0 ? "findings" : "clean";
    assert(
      summary.verdict === expectedVerdict,
      `summary verdict ${summary.verdict} != derived ${expectedVerdict}`,
    );

    const unknown = await tool.execute({ report: "nope" });
    assert(unknown.reason === "unknown_report", "unknown report accepted");
  },
);

await checkAsync(
  "sportsdesk_sharp derives candidates and cutoffs from the book",
  async () => {
    const book = await Bun.file(`${REPO}/enriched_customers_full.json`).json();
    const threshold = 70;
    const expected = book.filter(
      (row) =>
        Number(row.sharp_score ?? Number.NEGATIVE_INFINITY) >= threshold ||
        Number(row.clv_bps ?? 0) > 0,
    ).length;
    const tool = byName.get("sportsdesk_sharp");
    const limit = 5;
    const result = await tool.execute({ minSharp: threshold, limit });
    assert(result.available === true, "sharp scan unavailable");
    assert(
      result.summary.candidates === expected,
      `candidates ${result.summary.candidates} != source ${expected}`,
    );
    assert(
      result.customers.length === Math.min(limit, expected),
      `returned ${result.customers.length} of ${expected}`,
    );
    for (const row of result.customers) {
      assert(
        ["sharp", "clv", "both"].includes(row.qualifiesBy),
        `${row.customer_id} has no qualifying rule`,
      );
    }
    assert(
      result.summary.sharpOnly + result.summary.both ===
        result.summary.aboveThreshold,
      "the qualifying split does not add up",
    );
    assert(
      result.summary.clvOnly + result.summary.both ===
        result.summary.clvPositive,
      "the CLV split does not add up",
    );
    assert(
      typeof result.cutoffs?.sharpP90 === "number",
      "the cohort sharp cutoff is missing",
    );
    assert(
      result.bookIntegrity?.character === "generated-fixture",
      `unexpected book character ${result.bookIntegrity?.character}`,
    );

    // The default cutoff must come from the book, not a checked-in 70.
    const defaulted = await tool.execute({ limit: 1 });
    assert(
      defaulted.thresholdSource === "cohort-p90",
      `default threshold source ${defaulted.thresholdSource}`,
    );
    assert(
      Math.abs(defaulted.threshold - defaulted.cutoffs.sharpP90) < 1e-9,
      `default threshold ${defaulted.threshold} != p90 ${defaulted.cutoffs.sharpP90}`,
    );

    // Sensitivity must be derived from the book at each grid point.
    assert(
      Array.isArray(result.sensitivity) && result.sensitivity.length === 5,
      `sensitivity length ${result.sensitivity?.length}`,
    );
    for (const point of result.sensitivity) {
      const expectedAtPoint = book.filter(
        (row) =>
          Number(row.sharp_score ?? Number.NEGATIVE_INFINITY) >=
            point.threshold || Number(row.clv_bps ?? 0) > 0,
      ).length;
      assert(
        point.candidates === expectedAtPoint,
        `sensitivity ${point.threshold}: ${point.candidates} != ${expectedAtPoint}`,
      );
      const expectedSharpAtPoint = book.filter(
        (row) =>
          Number(row.sharp_score ?? Number.NEGATIVE_INFINITY) >=
          point.threshold,
      ).length;
      assert(
        point.bySharpScore === expectedSharpAtPoint,
        `sharp-only ${point.threshold}: ${point.bySharpScore} != ${expectedSharpAtPoint}`,
      );
    }
    // The plateau flag must describe the grid it returned.
    let nearestIndex = 0;
    for (let index = 1; index < result.sensitivity.length; index += 1) {
      if (
        Math.abs(result.sensitivity[index].threshold - result.threshold) <
        Math.abs(result.sensitivity[nearestIndex].threshold - result.threshold)
      ) {
        nearestIndex = index;
      }
    }
    let left = nearestIndex;
    let right = nearestIndex;
    while (
      left > 0 &&
      result.sensitivity[left - 1].candidates ===
        result.sensitivity[nearestIndex].candidates
    ) {
      left -= 1;
    }
    while (
      right < result.sensitivity.length - 1 &&
      result.sensitivity[right + 1].candidates ===
        result.sensitivity[nearestIndex].candidates
    ) {
      right += 1;
    }
    assert(
      result.plateau.from === result.sensitivity[left].threshold &&
        result.plateau.to === result.sensitivity[right].threshold,
      `plateau ${JSON.stringify(result.plateau)} does not match the grid`,
    );
    assert(
      result.thresholdIdentified === (left === right),
      "thresholdIdentified disagrees with the returned plateau",
    );

    // Incremental value and collinearity must be derived, not asserted.
    assert(
      result.summary.incrementalByClv ===
        result.summary.clvPositive - result.summary.both,
      "incrementalByClv does not match its own split",
    );
    const pairs = book
      .map((row) => [Number(row.sharp_score), Number(row.clv_bps)])
      .filter(([sharp, clv]) => Number.isFinite(sharp) && Number.isFinite(clv));
    const meanSharp =
      pairs.reduce((total, pair) => total + pair[0], 0) / pairs.length;
    const meanClv =
      pairs.reduce((total, pair) => total + pair[1], 0) / pairs.length;
    let covariance = 0;
    let varianceSharp = 0;
    let varianceClv = 0;
    for (const [sharp, clv] of pairs) {
      covariance += (sharp - meanSharp) * (clv - meanClv);
      varianceSharp += (sharp - meanSharp) ** 2;
      varianceClv += (clv - meanClv) ** 2;
    }
    const expectedR = covariance / Math.sqrt(varianceSharp * varianceClv);
    assert(
      Math.abs(result.summary.pearsonR - expectedR) < 1e-9,
      `pearsonR ${result.summary.pearsonR} != ${expectedR}`,
    );
    assert(
      result.summary.signalsCollinear === Math.abs(expectedR) >= 0.8,
      "signalsCollinear disagrees with the correlation",
    );

    const market = await tool.execute({ dimension: "market", limit: 2 });
    assert(market.dimension === "market", "dimension was not applied");
    const badDimension = await tool.execute({ dimension: "team" });
    assert(
      badDimension.reason === "invalid_arguments",
      "an unknown dimension was accepted",
    );
    const badThreshold = await tool.execute({ minSharp: 101 });
    assert(
      badThreshold.reason === "invalid_arguments",
      "an out-of-range minSharp was accepted",
    );
  },
);

await checkAsync(
  "sportsdesk_weblogs reports captured evidence without a live call",
  async () => {
    const manifest = await Bun.file(
      `${REPO}/docs/evidence/captures/manifest.json`,
    ).json();
    const fixture = await Bun.file(
      `${REPO}/tests/fixtures/captures/getWebLog.mock.json`,
    ).json();
    const expectedCaptures = manifest.captures.filter((entry) =>
      String(entry.operation?.path ?? "")
        .toLowerCase()
        .includes("/getweblog"),
    ).length;
    const result = await byName.get("sportsdesk_weblogs").execute({});
    assert(result.available === true, "weblogs unavailable");
    assert(
      result.captures.length === expectedCaptures,
      `captures ${result.captures.length} != source ${expectedCaptures}`,
    );
    assert(
      result.fixture.rows === (fixture.response?.body ?? []).length,
      `fixture rows ${result.fixture.rows} != source ${(fixture.response?.body ?? []).length}`,
    );
    assert(
      result.readiness.wireRows ===
        result.captures.reduce((total, row) => total + row.rows, 0),
      "readiness disagrees with the capture rows",
    );
    assert(
      result.modes.defined.includes("A") && result.modes.defined.includes("I"),
      `defined modes ${JSON.stringify(result.modes.defined)}`,
    );
    assert(
      !JSON.stringify(result).includes("203.0.113."),
      "an IP address was returned",
    );
    assert(
      !JSON.stringify(result).includes("198.51.100."),
      "a fixture IP was returned",
    );
  },
);

console.log("\nverify-load: sportsdesk_wagers reads the v2 snapshot contract");

await checkAsync(
  "sportsdesk_wagers refuses wrong report/state/limit types",
  async () => {
    const tool = byName.get("sportsdesk_wagers");
    const reports = [
      ["nope", "unknown_report"],
      [7, "invalid_arguments"],
      [null, "invalid_arguments"],
      [[], "invalid_arguments"],
    ];
    for (const [report, expectedReason] of reports) {
      const result = await tool.execute({ report });
      assert(
        result.available === false,
        `report ${JSON.stringify(report)} was accepted`,
      );
      assert(
        result.reason === expectedReason,
        `report ${JSON.stringify(report)} reason is ${result.reason}, expected ${expectedReason}`,
      );
    }
    for (const state of [7, "", "   ", null]) {
      const result = await tool.execute({ state });
      assert(
        result.available === false && result.reason === "invalid_arguments",
        `state ${JSON.stringify(state)} was accepted (reason ${result.reason})`,
      );
    }
    for (const limit of [0, 101, 1.5, "7", null]) {
      const result = await tool.execute({ limit });
      assert(
        result.available === false && result.reason === "invalid_arguments",
        `limit ${JSON.stringify(limit)} was accepted (reason ${result.reason})`,
      );
    }
  },
);

await checkAsync(
  "sportsdesk_wagers reports MISSING, never zero states",
  async () => {
    const directory = wagersTempDir("missing");
    try {
      const tool = applyWith({
        wagersArtifact: `${directory}/absent.json`,
      }).get("sportsdesk_wagers");
      const result = await tool.execute({});
      assert(result.available === false, "a missing artifact was available");
      assert(
        result.reason === "artifact_missing",
        `reason is ${result.reason}, expected artifact_missing`,
      );
      assert(
        String(result.message).includes("MISSING"),
        "the message does not say MISSING",
      );
      assert(
        !Object.hasOwn(result, "states") && !Object.hasOwn(result, "totals"),
        "a missing artifact returned a table (states/totals present)",
      );
      assert(
        result.source.ageMinutes === null && result.source.stale === null,
        "a missing file reported an age or a stale verdict",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers reports UNSUPPORTED for an unknown schemaVersion",
  async () => {
    const directory = wagersTempDir("unsupported");
    const artifactPath = `${directory}/gslive-wagers-by-state.summary.json`;
    try {
      await Bun.write(
        artifactPath,
        JSON.stringify({
          schemaVersion: 1,
          totals: { legs: 0, wagers: 0 },
          states: [],
        }),
      );
      const tool = applyWith({ wagersArtifact: artifactPath }).get(
        "sportsdesk_wagers",
      );
      const result = await tool.execute({});
      assert(result.available === false, "a v1 artifact was parsed");
      assert(
        result.reason === "schema_unsupported",
        `reason is ${result.reason}, expected schema_unsupported`,
      );
      assert(
        result.observedSchemaVersion === 1,
        `observedSchemaVersion is ${result.observedSchemaVersion}`,
      );
      assert(
        result.supportedSchemaVersion === 2,
        `supportedSchemaVersion is ${result.supportedSchemaVersion}`,
      );
      assert(
        String(result.message).includes("UNSUPPORTED"),
        "the message does not say UNSUPPORTED",
      );
      assert(
        !Object.hasOwn(result, "states") && !Object.hasOwn(result, "totals"),
        "an unsupported schema returned a table (states/totals present)",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers returns the fixture totals and quality unchanged",
  async () => {
    const directory = wagersTempDir("fixture");
    const artifactPath = `${directory}/gslive-wagers-by-state.summary.json`;
    try {
      await Bun.write(artifactPath, JSON.stringify(WAGERS_FIXTURE, null, 2));
      const tool = applyWith({ wagersArtifact: artifactPath }).get(
        "sportsdesk_wagers",
      );
      const summary = await tool.execute({});
      assert(summary.available === true, "the v2 fixture was unavailable");
      assert(summary.readOnly === true, "the tool did not report readOnly");
      assert(summary.snapshot === true, "the tool did not report snapshot");
      assert(
        Bun.deepEquals(summary.totals, WAGERS_FIXTURE.totals, true),
        "totals were altered from the artifact",
      );
      assert(
        Bun.deepEquals(summary.identity, WAGERS_FIXTURE.identity, true),
        "identity was altered from the artifact",
      );
      assert(
        Bun.deepEquals(summary.quality, WAGERS_FIXTURE.quality, true),
        "quality block was altered from the artifact",
      );
      assert(
        Bun.deepEquals(summary.artifactSource, WAGERS_FIXTURE.source, true),
        "artifact provenance was altered",
      );
      assert(
        Bun.deepEquals(summary.notes, WAGERS_FIXTURE.notes, true),
        "notes were altered from the artifact",
      );
      assert(
        summary.source.path === artifactPath &&
          summary.source.schemaVersion === 2,
        `source is ${JSON.stringify(summary.source)}`,
      );
      assert(
        typeof summary.source.ageMinutes === "number" &&
          summary.source.stale === false,
        "source freshness was not derived from the fixture mtime",
      );
      assert(
        typeof summary.window.ageMinutes === "number",
        "data-window age was not derived from observedEnd",
      );
      assert(
        summary.statesInArtifact === WAGERS_FIXTURE.states.length,
        `statesInArtifact ${summary.statesInArtifact}`,
      );
      assert(
        summary.states.length === Math.min(10, WAGERS_FIXTURE.states.length),
        `default limit returned ${summary.states.length} states`,
      );

      const statesReport = await tool.execute({
        report: "states",
        state: "win",
        limit: 5,
      });
      assert(
        statesReport.available === true &&
          statesReport.stateFilter === "win" &&
          statesReport.states.length === 1 &&
          statesReport.states[0].state === "win" &&
          statesReport.statesMatched === 1,
        `state filter returned ${JSON.stringify(statesReport.states)}`,
      );
      const pendingOnly = await tool.execute({ state: "PENDING", limit: 1 });
      assert(
        pendingOnly.states.length === 1 &&
          pendingOnly.states[0].state === "pending",
        "the state filter is not case-insensitive",
      );
      const notFound = await tool.execute({ state: "settled" });
      assert(
        notFound.available === false && notFound.reason === "state_not_found",
        `an unobserved state was not refused (reason ${notFound.reason})`,
      );
      assert(
        String(notFound.message).includes("pending") &&
          String(notFound.message).includes("win"),
        "the refusal does not list the artifact's observed states",
      );

      const quality = await tool.execute({ report: "quality" });
      assert(
        quality.available === true && quality.report === "quality",
        "the quality report was unavailable",
      );
      assert(
        quality.derived.coherenceViolationTotal === 0,
        `derived coherence total is ${quality.derived.coherenceViolationTotal}`,
      );
      assert(
        Array.isArray(quality.qualityFlags) &&
          quality.qualityFlags.length === 0,
        "a clean fixture produced quality flags",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers reports the real artifact honestly",
  async () => {
    const result = await byName.get("sportsdesk_wagers").execute({});
    if (result.available === true) {
      assert(
        result.source.schemaVersion === 2,
        `available with schemaVersion ${result.source.schemaVersion}`,
      );
      assert(
        typeof result.totals === "object" && result.totals !== null,
        "an available table has no totals",
      );
      assert(Array.isArray(result.states), "an available table has no states");
      assert(
        typeof result.quality === "object" && result.quality !== null,
        "an available table has no quality block",
      );
    } else {
      assert(
        [
          "artifact_missing",
          "artifact_unparseable",
          "schema_unsupported",
          "artifact_malformed",
        ].includes(result.reason),
        `unexpected reason ${result.reason}`,
      );
      assert(
        String(result.message).length > 0 &&
          !Object.hasOwn(result, "states") &&
          !Object.hasOwn(result, "totals"),
        "a non-reading result implied a table",
      );
    }
  },
);

console.log(
  "\nverify-load: sportsdesk_wagers reads the automation journal and capture history",
);

await checkAsync(
  'sportsdesk_wagers reports automation MISSING per file, never "no failures"',
  async () => {
    const directory = wagersTempDir("automation-missing");
    try {
      const tool = applyWith(wagersPaths(directory)).get("sportsdesk_wagers");
      const result = await tool.execute({ report: "automation" });
      assert(
        result.available === false &&
          result.reason === "automation_all_missing",
        `reason is ${result.reason}`,
      );
      for (const name of ["artifact", "journal", "alerts"]) {
        assert(
          result.files[name].status === "MISSING",
          `${name} status is ${result.files[name].status}`,
        );
        assert(
          result.files[name].ageMinutes === null &&
            result.files[name].stale === null,
          `${name} reported an age or stale verdict for an absent file`,
        );
      }
      assert(
        result.journal.lastSuccess === null &&
          result.journal.lastFailure === null &&
          result.journal.runsReturned === 0,
        "a missing journal produced an attempt outcome",
      );
      assert(
        result.alerts.count === null && result.alerts.alerts.length === 0,
        `a missing alerts document produced count ${result.alerts.count}`,
      );
      assert(
        result.health.alertCount === null &&
          result.health.lastOutcome === null &&
          result.health.artifactFresh === null,
        "a missing file produced a health value",
      );
      assert(
        String(result.message).includes("MISSING") &&
          !/no failures|zero alerts|no runs/i.test(String(result.message)),
        "the message does not read as MISSING without a synthesized zero",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers reads the fixture journal and alerts",
  async () => {
    const directory = wagersTempDir("automation-fixture");
    try {
      await writeWagersAutomationFixture(directory);
      const tool = applyWith(wagersPaths(directory)).get("sportsdesk_wagers");
      const result = await tool.execute({ report: "automation" });
      assert(
        result.available === true,
        "the automation fixture was unavailable",
      );
      assert(
        result.readOnly === true && result.snapshot === true,
        "the report did not declare readOnly/snapshot",
      );
      for (const name of ["artifact", "journal", "alerts"]) {
        assert(
          result.files[name].status === "ok",
          `${name} status is ${result.files[name].status}`,
        );
      }
      assert(
        result.journal.runsInJournal === 7 && result.journal.runsReturned === 5,
        `runs ${result.journal.runsReturned}/${result.journal.runsInJournal}`,
      );
      assert(
        result.journal.recentRuns[0].finishedAt ===
          WAGERS_JOURNAL.runs[6].finishedAt,
        "recent runs are not newest-first",
      );
      assert(
        result.journal.lastSuccess?.finishedAt ===
          WAGERS_JOURNAL.lastSuccess.finishedAt &&
          result.journal.lastFailure?.error === "latest capture failed",
        "lastSuccess/lastFailure were altered",
      );
      assert(
        result.health.lastOutcome === "failure" &&
          result.health.lastFailureFinishedAt ===
            WAGERS_JOURNAL.lastFailure.finishedAt,
        `lastOutcome is ${result.health.lastOutcome}`,
      );
      assert(
        result.alerts.count === 2 &&
          result.alerts.bySeverity.warn === 1 &&
          result.alerts.bySeverity.info === 1 &&
          result.alerts.malformedAlerts.length === 1,
        `alerts ${result.alerts.count}, malformed ${JSON.stringify(result.alerts.malformedAlerts)}`,
      );
      assert(
        result.artifact.artifactSource?.kind === "offline-csv",
        "artifact provenance was not passed through",
      );
      assert(
        typeof result.artifact.source.ageMinutes === "number" &&
          result.artifact.source.stale === false,
        "artifact freshness was not derived from the fixture mtime",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  'sportsdesk_wagers reports a missing journal as MISSING, not "no failures"',
  async () => {
    const directory = wagersTempDir("automation-journal-missing");
    try {
      const paths = wagersPaths(directory);
      await Bun.write(
        paths.wagersArtifact,
        JSON.stringify(WAGERS_FIXTURE, null, 2),
      );
      await Bun.write(paths.wagersAlerts, JSON.stringify(WAGERS_ALERTS));
      const tool = applyWith(paths).get("sportsdesk_wagers");
      const result = await tool.execute({ report: "automation" });
      assert(
        result.available === true,
        "one missing file made the whole report unavailable",
      );
      assert(
        result.files.journal.status === "MISSING" &&
          result.files.artifact.status === "ok" &&
          result.files.alerts.status === "ok",
        `statuses ${JSON.stringify(Object.fromEntries(Object.entries(result.files).map(([key, value]) => [key, value.status])))}`,
      );
      assert(
        result.journal.lastSuccess === null &&
          result.journal.runsInJournal === null &&
          result.health.lastOutcome === null &&
          result.alerts.count === 2,
        "a missing journal was rendered as a measured outcome",
      );
      assert(
        result.notes.some((note) => note.includes("unmeasured")),
        "the report did not say attempt outcome is unmeasured",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers reports UNSUPPORTED for an unknown journal schemaVersion",
  async () => {
    const directory = wagersTempDir("automation-journal-unsupported");
    try {
      const paths = wagersPaths(directory);
      await Bun.write(
        paths.wagersArtifact,
        JSON.stringify(WAGERS_FIXTURE, null, 2),
      );
      await Bun.write(
        paths.wagersStatus,
        JSON.stringify({ schemaVersion: 2, runs: [] }),
      );
      const tool = applyWith(paths).get("sportsdesk_wagers");
      const result = await tool.execute({ report: "automation" });
      assert(
        result.files.journal.status === "UNSUPPORTED",
        `journal status ${result.files.journal.status}`,
      );
      assert(
        result.journal.observedSchemaVersion === 2 &&
          result.journal.supportedSchemaVersion === 1,
        `journal schemaVersion ${result.journal.observedSchemaVersion}`,
      );
      assert(
        result.journal.lastSuccess === null &&
          result.files.artifact.status === "ok",
        "an unsupported journal produced an outcome or hid the artifact",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers trends MISSING is explicit, never an empty series",
  async () => {
    const directory = wagersTempDir("trends-missing");
    try {
      const tool = applyWith(wagersPaths(directory)).get("sportsdesk_wagers");
      const result = await tool.execute({ report: "trends" });
      assert(
        result.available === false && result.reason === "history_missing",
        `reason is ${result.reason}`,
      );
      assert(
        String(result.message).includes("MISSING") &&
          !Object.hasOwn(result, "series"),
        "a missing history returned a series",
      );
      assert(
        result.source.ageMinutes === null && result.source.stale === null,
        "a missing history reported an age or stale verdict",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers trends reports UNSUPPORTED for an unknown history schemaVersion",
  async () => {
    const directory = wagersTempDir("trends-unsupported");
    try {
      const paths = wagersPaths(directory);
      await Bun.write(
        paths.wagersHistory,
        JSON.stringify({
          schemaVersion: 2,
          capturedAt: WAGERS_CAPTURE_TIMES[0],
          totals: {},
          states: [],
        }) + "\n",
      );
      const tool = applyWith(paths).get("sportsdesk_wagers");
      const result = await tool.execute({ report: "trends" });
      assert(
        result.available === false &&
          result.reason === "history_schema_unsupported",
        `reason is ${result.reason}`,
      );
      assert(
        result.observedSchemaVersions[0] === 2 &&
          result.supportedSchemaVersion === 1,
        `observed ${JSON.stringify(result.observedSchemaVersions)}`,
      );
      assert(
        result.lineCounts.unsupportedSchemaLines === 1 &&
          !Object.hasOwn(result, "series"),
        "an unsupported history returned a series",
      );
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

await checkAsync(
  "sportsdesk_wagers trends skips and counts malformed JSONL lines",
  async () => {
    const directory = wagersTempDir("trends-fixture");
    try {
      const paths = wagersPaths(directory);
      await Bun.write(paths.wagersHistory, wagersHistoryText());
      const tool = applyWith(paths).get("sportsdesk_wagers");
      const result = await tool.execute({ report: "trends" });
      assert(result.available === true, `trends unavailable: ${result.reason}`);
      assert(
        result.series.length === 3 &&
          result.series[0].capturedAt === WAGERS_CAPTURE_TIMES[0] &&
          result.series[2].capturedAt === WAGERS_CAPTURE_TIMES[2],
        `series ${JSON.stringify(result.series.map((entry) => entry.capturedAt))}`,
      );
      assert(
        result.lineCounts.validLines === 3 &&
          result.lineCounts.invalidJsonLines === 1 &&
          result.lineCounts.unsupportedSchemaLines === 1 &&
          result.lineCounts.malformedLines === 0,
        `line counts ${JSON.stringify(result.lineCounts)}`,
      );
      assert(
        result.malformedSamples.some((sample) =>
          sample.includes("not valid JSON"),
        ),
        "the malformed line was not sampled",
      );
      assert(
        result.latest.delta !== null &&
          result.latest.newTickets === 12 &&
          result.latest.goneTickets === 3 &&
          result.latest.migrations.length === 1 &&
          result.latest.migrations[0].from === "pending",
        `latest delta ${JSON.stringify(result.latest)}`,
      );
      assert(
        result.series[0].delta === null &&
          result.series[0].totals.legs === 19010,
        "the first capture's null delta or totals were altered",
      );
      assert(
        result.truncation.truncated === false &&
          result.truncation.rotated === false &&
          result.truncation.limitTruncated === false,
        `truncation ${JSON.stringify(result.truncation)}`,
      );

      const limited = await tool.execute({ report: "trends", limit: 2 });
      assert(
        limited.series.length === 2 &&
          limited.series[1].capturedAt === WAGERS_CAPTURE_TIMES[2] &&
          limited.window.limitTruncated === true &&
          limited.truncation.limitTruncated === true,
        `limit 2 returned ${limited.series.length}`,
      );
      const filtered = await tool.execute({ report: "trends", state: "WIN" });
      assert(
        filtered.series.length === 3 &&
          filtered.series.every(
            (entry) =>
              entry.states.length === 1 && entry.states[0].state === "win",
          ),
        "the trends state filter did not apply per capture",
      );
      const missingState = await tool.execute({
        report: "trends",
        state: "settled",
      });
      assert(
        missingState.available === false &&
          missingState.reason === "state_not_found",
        `an unobserved state was not refused (reason ${missingState.reason})`,
      );
      const malformedOnly = `${directory}/malformed-only.jsonl`;
      await Bun.write(
        malformedOnly,
        `${JSON.stringify({ schemaVersion: 1, totals: {}, states: [] })}\n`,
      );
      const malformedTool = applyWith({
        wagersHistory: malformedOnly,
      }).get("sportsdesk_wagers");
      const malformedResult = await malformedTool.execute({ report: "trends" });
      assert(
        malformedResult.available === false &&
          malformedResult.reason === "history_unparseable" &&
          malformedResult.lineCounts.malformedLines === 1,
        `malformed-only reason ${malformedResult.reason}`,
      );
      for (const limit of [0, 101, 1.5]) {
        const invalid = await tool.execute({ report: "trends", limit });
        assert(
          invalid.available === false && invalid.reason === "invalid_arguments",
          `limit ${limit} was accepted (reason ${invalid.reason})`,
        );
      }
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

console.log(
  "\nverify-load: sportsdesk_wagers results are lossless JSON in every branch",
);

await checkAsync(
  "sportsdesk_wagers real-repo defaults round-trip losslessly",
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
        `${args.report} on real repo defaults`,
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

await checkAsync(
  "sportsdesk_wagers failure branches round-trip losslessly",
  async () => {
    const directory = wagersTempDir("lossless");
    try {
      const paths = wagersPaths(directory);
      const reports = [
        { report: "summary" },
        { report: "states" },
        { report: "quality" },
        { report: "automation" },
        { report: "trends" },
        { report: "trends", state: "pending", limit: 2 },
      ];
      const assertAllReports = async (label, overrides) => {
        const tool = applyWith(overrides).get("sportsdesk_wagers");
        for (const args of reports) {
          assertLosslessJson(
            `${label} ${args.report}`,
            await tool.execute(args),
          );
        }
      };

      await assertAllReports("all four files missing", paths);

      await Bun.write(paths.wagersArtifact, "{ not json");
      await assertAllReports("artifact unparseable", paths);

      await Bun.write(
        paths.wagersArtifact,
        JSON.stringify({ schemaVersion: 1 }),
      );
      await assertAllReports("artifact unsupported schemaVersion", paths);

      await Bun.write(
        paths.wagersArtifact,
        JSON.stringify({ schemaVersion: 2, states: [] }),
      );
      await assertAllReports("artifact malformed", paths);

      // A valid fixture, then each automation file broken one at a time.
      await writeWagersAutomationFixture(directory);
      await assertAllReports("fixture all present", paths);
      const fixtureTool = applyWith(paths).get("sportsdesk_wagers");
      assertLosslessJson(
        "fixture state_not_found (states)",
        await fixtureTool.execute({ report: "states", state: "settled" }),
      );
      assertLosslessJson(
        "fixture state_not_found (trends)",
        await fixtureTool.execute({ report: "trends", state: "settled" }),
      );

      const branches = [
        ["journal unparseable", paths.wagersStatus, "{ not json"],
        [
          "journal unsupported schemaVersion",
          paths.wagersStatus,
          JSON.stringify({ schemaVersion: 2, runs: [] }),
        ],
        [
          "journal malformed",
          paths.wagersStatus,
          JSON.stringify({ schemaVersion: 1 }),
        ],
        ["alerts unparseable", paths.wagersAlerts, "{ not json"],
        [
          "alerts unsupported schemaVersion",
          paths.wagersAlerts,
          JSON.stringify({ schemaVersion: 2, alerts: [] }),
        ],
        [
          "alerts malformed",
          paths.wagersAlerts,
          JSON.stringify({ schemaVersion: 1 }),
        ],
        ["history unparseable", paths.wagersHistory, "{ not json\n"],
        [
          "history unsupported schemaVersion",
          paths.wagersHistory,
          `${JSON.stringify({ schemaVersion: 2 })}\n`,
        ],
        [
          "history malformed lines only",
          paths.wagersHistory,
          `${JSON.stringify({ schemaVersion: 1, totals: {}, states: [] })}\n`,
        ],
        [
          "history mixed valid and malformed",
          paths.wagersHistory,
          `${JSON.stringify(WAGERS_HISTORY_LINES[0])}\n{ not json\n`,
        ],
      ];
      for (const [label, path, content] of branches) {
        await writeWagersAutomationFixture(directory);
        await Bun.write(path, content);
        await assertAllReports(label, paths);
      }
    } finally {
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
);

console.log(
  failed === 0
    ? "\nverify-load: PASS — 13 tools load and refuse invalid input (stage 1/2)."
    : `\nverify-load: ${failed} FAILURE(S) (stage 1/2).`,
);
process.exit(failed === 0 ? 0 : 1);
