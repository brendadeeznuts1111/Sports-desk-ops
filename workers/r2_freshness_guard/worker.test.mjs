import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { TARGETS, inspectPrivateReports } from "./worker.mjs";

const NOW = Date.parse("2026-11-22T06:15:00.000Z");
const SHA = "a".repeat(64);
const GSLIVE_KEY = "gslive-tally/2026-11-22/rollup.json";
const WEBLOG_KEY = "f402-weblog/2026-11-22/rollup.json";
const GSLIVE_OLD = NOW - 13 * 86400_000;
const WEBLOG_TIME = NOW - 5 * 60_000;
const coverage = {
  wholeBookComplete: false,
  scope: "live-pending-accounts",
  requestedAccounts: 18,
  completedAccounts: 18,
  failedAccounts: 0,
  snapshotTicketRows: 146,
  unidentifiedTicketRows: 93,
  activityRows: 338,
};
function fixture() {
  return {
    "f402-bet-ticker/latest.json": {
      data_window_max_epoch_ms: NOW - 10 * 60_000,
      rowCount: 236,
      raw: [{ login: "PRIVATE_DO_NOT_LOG" }],
    },
    "gslive-tally/latest.json": {
      deskDate: "2026-11-22",
      key: GSLIVE_KEY,
      sha256: SHA,
      generatedAt: new Date(NOW).toISOString(),
    },
    [GSLIVE_KEY]: {
      kind: "gslive-tally", deskDate: "2026-11-22",
      generatedAt: new Date(NOW).toISOString(), sourceSha256: SHA,
      window: { fromEpochSec: GSLIVE_OLD / 1000 - 60, toEpochSec: GSLIVE_OLD / 1000 },
      rowCount: 0, tickets: [{ login: "PRIVATE_DO_NOT_LOG" }],
    },
    "f402-weblog/latest.json": {
      deskDate: "2026-11-22", key: WEBLOG_KEY,
      sha256: SHA, data_window_max_epoch_ms: WEBLOG_TIME,
      coverage: { ...coverage, logins: ["PRIVATE_DO_NOT_LOG"] },
    },
    [WEBLOG_KEY]: {
      kind: "f402-weblog", sourceSha256: SHA,
      data_window_max_epoch_ms: WEBLOG_TIME,
      window: { fromMs: WEBLOG_TIME - 10 * 60_000, toMs: WEBLOG_TIME },
      coverage: { ...coverage, logins: ["PRIVATE_DO_NOT_LOG"] },
      rows: [{ login: "PRIVATE_DO_NOT_LOG" }],
    },
    "wagers-by-state/latest.json": {
      capturedAt: new Date(GSLIVE_OLD).toISOString(),
      generatedAt: new Date(NOW).toISOString(),
      staleness: { stale: true },
      states: [{ login: "PRIVATE_DO_NOT_LOG" }],
    },
  };
}
function store(values = fixture()) {
  return {
    async get(key) {
      const value = Object.hasOwn(values, key) ? values[key] : undefined;
      return value === undefined ? null : {
        size: JSON.stringify(value).length,
        text: async () => JSON.stringify(value),
      };
    },
  };
}
const check = (report, id) => report.checks.find(x => x.id === id);

test("fixed four targets; no arbitrarily selected keys", () => {
  assert.deepEqual(TARGETS.map(x => x.id), ["ticker", "gslive", "weblog", "wagers"]);
});

test("reports source age, not pointer publish time, with separate coverage health", async () => {
  const report = await inspectPrivateReports(store(), NOW);
  assert.deepEqual(report.checks.map(x => x.status), ["fresh", "stale", "partial", "stale"]);
  assert.equal(report.degradedCount, 2);
  assert.equal(report.partialCount, 1);
  assert.ok(check(report, "gslive").ageMinutes > 18_000);
  assert.equal(check(report, "gslive").rowCount, 0);
  assert.equal(check(report, "gslive").archiveVerified, true);
  assert.equal(check(report, "weblog").archiveVerified, true);
  assert.equal(check(report, "weblog").coverage.unidentifiedTicketRows, 93);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_DO_NOT_LOG"));
});

test("republishing a GSLive pointer never makes an old archive look fresh", async () => {
  const data = fixture();
  data["gslive-tally/latest.json"].generatedAt = new Date(NOW).toISOString();
  data[GSLIVE_KEY].generatedAt = new Date(NOW).toISOString();
  const result = await inspectPrivateReports(store(data), NOW);
  assert.equal(check(result, "gslive").status, "stale");
  assert.equal(check(result, "gslive").timestampBasis, "archive.window.toEpochSec");
});

test("pointer and archive must have the same provenance fingerprint", async () => {
  const data = fixture();
  data[WEBLOG_KEY].sourceSha256 = "b".repeat(64);
  const result = await inspectPrivateReports(store(data), NOW);
  assert.equal(check(result, "weblog").status, "invalid");
  assert.equal(check(result, "weblog").reason, "provenance_mismatch");
  assert.equal(check(result, "weblog").stage, "archive");
});

test("pointer mismatch, archive absence, and R2 error remain distinct", async () => {
  const bad = fixture();
  delete bad[WEBLOG_KEY];
  assert.deepEqual(
    {status: check(await inspectPrivateReports(store(bad), NOW), "weblog").status,
     stage: check(await inspectPrivateReports(store(bad), NOW), "weblog").stage},
    {status: "missing", stage: "archive"},
  );
  const failure = await inspectPrivateReports({get: async () => {throw new Error("Bearer PRIVATE_DO_NOT_LOG");}}, NOW);
  assert.ok(failure.checks.every(x => x.status === "unverified"));
  assert.ok(!JSON.stringify(failure).includes("PRIVATE_DO_NOT_LOG"));
  const missing = await inspectPrivateReports(store({}), NOW);
  assert.ok(missing.checks.every(x => x.status === "missing" && x.stage === "latest"));
});

test("corrupt JSON is invalid; failing object body read is unverified", async () => {
  const corrupt = await inspectPrivateReports({get: async () => ({size: 5, text: async () => "{nope"})}, NOW);
  assert.ok(corrupt.checks.every(x => x.status === "invalid"));
  const unreadable = await inspectPrivateReports({get: async () => ({size: 5, text: async () => {throw new Error("PRIVATE_DO_NOT_LOG");}})}, NOW);
  assert.ok(unreadable.checks.every(x => x.status === "unverified"));
});

test("size limits fail before reading JSON body", async () => {
  let reads = 0;
  const oversized = await inspectPrivateReports({get: async () => ({size: 900_000, text: async () => {reads++; return "{}";}})}, NOW);
  assert.ok(oversized.checks.every(x => x.status === "invalid"));
  assert.equal(reads, 0);
});

test("weblog pointer must agree with archive coverage and source window", async () => {
  const badCoverage = fixture();
  badCoverage[WEBLOG_KEY].coverage.wholeBookComplete = true;
  assert.equal(check(await inspectPrivateReports(store(badCoverage), NOW), "weblog").reason, "coverage_mismatch");
  const badWindow = fixture();
  badWindow[WEBLOG_KEY].window.toMs += 60_000;
  assert.equal(check(await inspectPrivateReports(store(badWindow), NOW), "weblog").reason, "invalid_source_window");
});

test("malformed archive date or path traversal never gets fetched", async () => {
  const data = fixture();
  data["gslive-tally/latest.json"].key = "../../customer-data.json";
  const seen = [];
  const bucket = {get: async (key) => {seen.push(key); return store(data).get(key);}};
  const report = await inspectPrivateReports(bucket, NOW);
  assert.equal(check(report, "gslive").reason, "invalid_archive_key");
  assert.ok(!seen.includes("../../customer-data.json"));
});

test("zero-row GSLive source is visible even when it is already stale", async () => {
  const result = await inspectPrivateReports(store(), NOW);
  assert.equal(check(result, "gslive").rowCount, 0);
  assert.equal(check(result, "gslive").empty, true);
  assert.equal(check(result, "gslive").status, "stale");
  const data = fixture();
  data[GSLIVE_KEY].window.toEpochSec = NOW / 1000 - 60;
  data[GSLIVE_KEY].window.fromEpochSec = NOW / 1000 - 120;
  assert.equal(check(await inspectPrivateReports(store(data), NOW), "gslive").status, "empty");
});

test("stale weblog preserves separate partial-coverage warning", async () => {
  const data = fixture();
  const oldTime = NOW - 15 * 60 * 60_000;
  data[WEBLOG_KEY].window.fromMs = oldTime - 10 * 60_000;
  data[WEBLOG_KEY].window.toMs = oldTime;
  data[WEBLOG_KEY].data_window_max_epoch_ms = oldTime;
  data["f402-weblog/latest.json"].data_window_max_epoch_ms = oldTime;
  const report = await inspectPrivateReports(store(data), NOW);
  assert.equal(check(report, "weblog").status, "stale");
  assert.equal(check(report, "weblog").coverageStatus, "partial");
  assert.equal(report.partialCount, 1);
});

test("invalid source windows and future timestamps never appear fresh", async () => {
  const data = fixture();
  data[GSLIVE_KEY].window.toEpochSec = data[GSLIVE_KEY].window.fromEpochSec - 1;
  assert.equal(check(await inspectPrivateReports(store(data), NOW), "gslive").status, "invalid");
  const future = fixture();
  future["f402-bet-ticker/latest.json"].data_window_max_epoch_ms = NOW + 1000 * 60 * 90;
  assert.equal(check(await inspectPrivateReports(store(future), NOW), "ticker").status, "invalid");
});

test("scheduled handler logs only approved aggregates; public HTTP always 404", async () => {
  assert.equal((await worker.fetch()).status, 404);
  const pending = [], events = [];
  const saved = [console.log, console.error, console.warn];
  console.log = value => events.push(value);
  console.error = value => events.push(value);
  console.warn = value => events.push(value);
  try {
    await worker.scheduled({}, {REPORTS: store()}, {waitUntil: promise => pending.push(promise)});
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.ok(events.some(x => x.includes("sportsdesk_r2_source_freshness")));
    assert.ok(events.some(x => x.includes("sportsdesk_r2_source_degraded")));
    assert.ok(events.some(x => x.includes("sportsdesk_r2_coverage_partial")));
    assert.ok(!events.join("\n").includes("PRIVATE_DO_NOT_LOG"));
  } finally {
    [console.log, console.error, console.warn] = saved;
  }
});
