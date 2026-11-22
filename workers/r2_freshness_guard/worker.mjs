/**
 * Cron-only Cloudflare Worker: private source-data freshness guard.
 * No HTTP route, no upstream calls, no object writes, no stored credentials.
 */
export const TARGETS = Object.freeze([
  { id: "ticker", key: "f402-bet-ticker/latest.json", maxAgeMinutes: 60 },
  { id: "gslive", key: "gslive-tally/latest.json", maxAgeMinutes: 60 },
  { id: "weblog", key: "f402-weblog/latest.json", maxAgeMinutes: 90 },
  { id: "wagers", key: "wagers-by-state/latest.json", maxAgeMinutes: 60 },
]);

const MAX_JSON_BYTES = 65_536;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finiteTimestamp = (value) => {
  const ms = typeof value === "number" ? value :
    typeof value === "string" && value.trim() !== "" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const validCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

async function readObject(bucket, key) {
  try {
    const object = await bucket.get(key);
    if (object === null) return { kind: "missing" };
    if (!Number.isSafeInteger(object.size) || object.size > MAX_JSON_BYTES || object.size < 1) {
      return { kind: "invalid" };
    }
    const value = JSON.parse(await object.text());
    return isRecord(value) ? { kind: "ok", value } : { kind: "invalid" };
  } catch {
    // A network/binding error is not evidence that an object is absent.
    return { kind: "unverified" };
  }
}

function sourceTime(id, value) {
  if (id === "ticker" || id === "weblog") {
    return { time: finiteTimestamp(value.data_window_max_epoch_ms), basis: "data_window_max_epoch_ms" };
  }
  if (id === "wagers") {
    return { time: finiteTimestamp(value.capturedAt), basis: "capturedAt" };
  }
  return { time: finiteTimestamp(value.generatedAt), basis: "generatedAt" };
}

function safeCoverage(value) {
  const coverage = isRecord(value) ? value : {};
  return {
    wholeBookComplete: coverage.wholeBookComplete === true,
    scope: typeof coverage.scope === "string" && /^[a-z0-9_-]{1,64}$/.test(coverage.scope)
      ? coverage.scope : "unknown",
    requestedAccounts: validCount(coverage.requestedAccounts),
    completedAccounts: validCount(coverage.completedAccounts),
    failedAccounts: validCount(coverage.failedAccounts),
    snapshotTicketRows: validCount(coverage.snapshotTicketRows),
    unidentifiedTicketRows: validCount(coverage.unidentifiedTicketRows),
    activityRows: validCount(coverage.activityRows),
  };
}

async function inspectTarget(bucket, target, nowMs) {
  const result = await readObject(bucket, target.key);
  const baseline = { id: target.id, status: result.kind, ageMinutes: null, sourceAt: null };
  if (result.kind !== "ok") return baseline;
  const value = result.value;
  const clock = sourceTime(target.id, value);
  if (clock.time === null || clock.time > nowMs + MAX_CLOCK_SKEW_MS) {
    return { ...baseline, status: "invalid", timestampBasis: clock.basis };
  }
  const ageMinutes = Math.max(0, Math.floor((nowMs - clock.time) / 60_000));
  let status = ageMinutes > target.maxAgeMinutes ? "stale" : "fresh";
  let details = {};
  if (target.id === "wagers" && isRecord(value.staleness) && value.staleness.stale === true) {
    status = "stale";
  }
  if (target.id === "gslive") {
    const key = value.key;
    if (typeof key !== "string" || !/^gslive-tally\/\d{4}-\d{2}-\d{2}\/rollup\.json$/.test(key)) {
      return { ...baseline, status: "invalid", timestampBasis: clock.basis };
    }
    const archive = await readObject(bucket, key);
    if (archive.kind !== "ok") {
      return { ...baseline, status: archive.kind, timestampBasis: clock.basis };
    }
    const count = validCount(archive.value.rowCount);
    if (count === null) return { ...baseline, status: "invalid", timestampBasis: clock.basis };
    details = { rowCount: count };
    if (count === 0 && status === "fresh") status = "empty";
  }
  if (target.id === "weblog") {
    const coverage = safeCoverage(value.coverage);
    details = { coverage };
    if (status === "fresh" && !coverage.wholeBookComplete) status = "partial";
  }
  return {
    ...baseline,
    status,
    ageMinutes,
    sourceAt: new Date(clock.time).toISOString(),
    timestampBasis: clock.basis,
    ...details,
  };
}

/** Public for injected-R2 deterministic unit tests; no object values are returned. */
export async function inspectPrivateReports(bucket, nowMs = Date.now()) {
  const checks = await Promise.all(TARGETS.map((target) => inspectTarget(bucket, target, nowMs)));
  const degraded = checks.filter((x) => x.status !== "fresh" && x.status !== "partial");
  const partial = checks.filter((x) => x.status === "partial");
  return {
    event: "sportsdesk_r2_source_freshness",
    checkedAt: new Date(nowMs).toISOString(),
    checks,
    degradedCount: degraded.length,
    partialCount: partial.length,
  };
}

export default {
  // Fail closed even if a workers.dev hostname is accidentally enabled.
  fetch() {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const report = await inspectPrivateReports(env.REPORTS);
      // Logs contain only approved keys, timestamps and aggregates, never raw object content.
      console.log(JSON.stringify(report));
      if (report.degradedCount > 0) {
        console.error(JSON.stringify({
          event: "sportsdesk_r2_source_degraded",
          checkedAt: report.checkedAt,
          degraded: report.checks.filter((x) => x.status !== "fresh" && x.status !== "partial")
            .map(({ id, status, ageMinutes }) => ({ id, status, ageMinutes })),
        }));
      }
      if (report.partialCount > 0) {
        console.warn(JSON.stringify({
          event: "sportsdesk_r2_coverage_partial",
          checkedAt: report.checkedAt,
          streams: report.checks.filter((x) => x.status === "partial").map((x) => x.id),
        }));
      }
    })());
  },
};
