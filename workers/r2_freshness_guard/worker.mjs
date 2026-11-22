/**
 * Cron-only Cloudflare Worker: private source-data freshness guard.
 * No HTTP route, no upstream calls, no object writes, no stored credentials.
 */
export const TARGETS = Object.freeze([
  { id: "ticker", key: "f402-bet-ticker/latest.json", maxAgeMinutes: 60 },
  { id: "gslive", key: "gslive-tally/latest.json", maxAgeMinutes: 60 },
  { id: "weblog", key: "f402-weblog/latest.json", maxAgeMinutes: 90 },
  { id: "pending", key: "f402-pending/latest.json", maxAgeMinutes: 60 },
  { id: "wagers", key: "wagers-by-state/latest.json", maxAgeMinutes: 60 },
]);

const MAX_JSON_BYTES = 65_536;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finiteTimestamp = (value) => {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const validCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

async function readObject(bucket, key) {
  let object;
  try {
    object = await bucket.get(key);
  } catch {
    return { kind: "unverified" };
  }
  if (object === null) return { kind: "missing" };
  if (
    !Number.isSafeInteger(object.size) ||
    object.size > MAX_JSON_BYTES ||
    object.size < 1
  ) {
    return { kind: "invalid" };
  }
  let text;
  try {
    text = await object.text();
  } catch {
    return { kind: "unverified" };
  }
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? { kind: "ok", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

const SOURCE_SHA = /^[0-9a-f]{64}$/i;
const ROLLUP_KEY = {
  gslive: /^gslive-tally\/(\d{4}-\d{2}-\d{2})\/rollup\.json$/,
  weblog: /^f402-weblog\/(\d{4}-\d{2}-\d{2})\/rollup\.json$/,
};

function archiveIdentity(id, pointer, archive, day) {
  if (
    !SOURCE_SHA.test(pointer.sha256 ?? "") ||
    pointer.sha256 !== archive.sourceSha256 ||
    pointer.deskDate !== day ||
    archive.kind !== (id === "gslive" ? "gslive-tally" : "f402-weblog")
  ) {
    return false;
  }
  if (id === "gslive") {
    return (
      archive.deskDate === day && archive.generatedAt === pointer.generatedAt
    );
  }
  return true;
}

function archiveWindowEndMs(id, pointer, archive) {
  const window = archive.window;
  if (!isRecord(window)) return null;
  if (id === "gslive") {
    const start = window.fromEpochSec;
    const end = window.toEpochSec;
    return Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      end >= start &&
      end > 0
      ? end * 1000
      : null;
  }
  const start = window.fromMs;
  const end = window.toMs;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end >= start &&
    end > 0 &&
    end === pointer.data_window_max_epoch_ms &&
    end === archive.data_window_max_epoch_ms
    ? end
    : null;
}

function safeCoverage(value) {
  const coverage = isRecord(value) ? value : {};
  return {
    wholeBookComplete: coverage.wholeBookComplete === true,
    scope:
      typeof coverage.scope === "string" &&
      /^[a-z0-9_-]{1,64}$/.test(coverage.scope)
        ? coverage.scope
        : "unknown",
    requestedAccounts: validCount(coverage.requestedAccounts),
    completedAccounts: validCount(coverage.completedAccounts),
    failedAccounts: validCount(coverage.failedAccounts),
    snapshotTicketRows: validCount(coverage.snapshotTicketRows),
    unidentifiedTicketRows: validCount(coverage.unidentifiedTicketRows),
    activityRows: validCount(coverage.activityRows),
  };
}

/** Check only known pointer keys and never log arbitrary object content. */
async function inspectTarget(bucket, target, nowMs) {
  const latest = await readObject(bucket, target.key);
  const baseline = {
    id: target.id,
    status: latest.kind,
    ageMinutes: null,
    sourceAt: null,
  };
  if (latest.kind !== "ok") return { ...baseline, stage: "latest" };

  const pointer = latest.value;
  let timestampBasis =
    target.id === "ticker"
      ? "data_window_max_epoch_ms"
      : target.id === "wagers"
        ? "capturedAt"
        : "archive.window";
  let sourceAtMs =
    target.id === "ticker"
      ? finiteTimestamp(pointer.data_window_max_epoch_ms)
      : target.id === "wagers"
        ? finiteTimestamp(pointer.capturedAt)
        : null;
  let detail = {};

  if (target.id === "pending") {
    const provenance = pointer.provenance;
    if (
      pointer.kind !== "f402-pending" ||
      provenance?.sourceKind !== "capture"
    ) {
      return {
        ...baseline,
        status: "invalid",
        stage: "source",
        reason: "invalid_pending_provenance",
      };
    }
    if (provenance.capturedAt == null) {
      return {
        ...baseline,
        status: "unverified",
        stage: "source",
        reason: "missing_capture_time",
      };
    }
    timestampBasis = "provenance.capturedAt";
    sourceAtMs = finiteTimestamp(provenance.capturedAt);
    if (
      sourceAtMs === null ||
      sourceAtMs > nowMs ||
      new Date(sourceAtMs).toISOString() !== provenance.capturedAt
    ) {
      return {
        ...baseline,
        status: "invalid",
        stage: "source",
        reason: "invalid_source_timestamp",
      };
    }
  }

  if (target.id === "gslive" || target.id === "weblog") {
    const match =
      typeof pointer.key === "string" &&
      pointer.key.match(ROLLUP_KEY[target.id]);
    if (!match)
      return {
        ...baseline,
        status: "invalid",
        stage: "latest",
        reason: "invalid_archive_key",
      };
    const archived = await readObject(bucket, pointer.key);
    if (archived.kind !== "ok") {
      return { ...baseline, status: archived.kind, stage: "archive" };
    }
    const archive = archived.value;
    if (!archiveIdentity(target.id, pointer, archive, match[1])) {
      return {
        ...baseline,
        status: "invalid",
        stage: "archive",
        reason: "provenance_mismatch",
      };
    }
    sourceAtMs = archiveWindowEndMs(target.id, pointer, archive);
    if (sourceAtMs === null) {
      return {
        ...baseline,
        status: "invalid",
        stage: "archive",
        reason: "invalid_source_window",
      };
    }

    if (target.id === "gslive") {
      const count = validCount(archive.rowCount);
      if (count === null) {
        return {
          ...baseline,
          status: "invalid",
          stage: "archive",
          reason: "invalid_row_count",
        };
      }
      detail = { rowCount: count, empty: count === 0 };
      timestampBasis = "archive.window.toEpochSec";
    } else {
      // Compare both pointer and archive coverage; neither can silently override the other.
      const coverage = safeCoverage(archive.coverage);
      if (
        !isRecord(pointer.coverage) ||
        !isRecord(archive.coverage) ||
        JSON.stringify(safeCoverage(pointer.coverage)) !==
          JSON.stringify(coverage)
      ) {
        return {
          ...baseline,
          status: "invalid",
          stage: "archive",
          reason: "coverage_mismatch",
        };
      }
      detail = {
        coverage,
        coverageStatus: coverage.wholeBookComplete ? "complete" : "partial",
      };
      timestampBasis = "archive.window.toMs";
    }
  }

  if (sourceAtMs === null || sourceAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return {
      ...baseline,
      status: "invalid",
      stage: "source",
      reason: "invalid_source_timestamp",
    };
  }
  const ageMinutes = Math.max(0, Math.floor((nowMs - sourceAtMs) / 60_000));
  let status = ageMinutes > target.maxAgeMinutes ? "stale" : "fresh";
  if (
    target.id === "pending" &&
    nowMs - sourceAtMs > target.maxAgeMinutes * 60_000
  )
    status = "stale";
  if (
    target.id === "wagers" &&
    isRecord(pointer.staleness) &&
    pointer.staleness.stale === true
  ) {
    status = "stale";
  }
  if (target.id === "gslive" && detail.empty && status === "fresh")
    status = "empty";
  if (
    target.id === "weblog" &&
    detail.coverageStatus === "partial" &&
    status === "fresh"
  )
    status = "partial";
  return {
    ...baseline,
    status,
    ageMinutes,
    sourceAt: new Date(sourceAtMs).toISOString(),
    timestampBasis,
    ...(target.id === "gslive" || target.id === "weblog"
      ? { archiveVerified: true }
      : {}),
    ...detail,
  };
}

/** Public for injected-R2 deterministic unit tests; no object values are returned. */
export async function inspectPrivateReports(bucket, nowMs = Date.now()) {
  const checks = await Promise.all(
    TARGETS.map((target) => inspectTarget(bucket, target, nowMs)),
  );
  const degraded = checks.filter(
    (x) => x.status !== "fresh" && x.status !== "partial",
  );
  const partial = checks.filter((x) => x.coverageStatus === "partial");
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
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const report = await inspectPrivateReports(env.REPORTS);
        // Logs contain only approved keys, timestamps and aggregates, never raw object content.
        console.log(JSON.stringify(report));
        if (report.degradedCount > 0) {
          console.error(
            JSON.stringify({
              event: "sportsdesk_r2_source_degraded",
              checkedAt: report.checkedAt,
              degraded: report.checks
                .filter((x) => x.status !== "fresh" && x.status !== "partial")
                .map(({ id, status, ageMinutes }) => ({
                  id,
                  status,
                  ageMinutes,
                })),
            }),
          );
        }
        if (report.partialCount > 0) {
          console.warn(
            JSON.stringify({
              event: "sportsdesk_r2_coverage_partial",
              checkedAt: report.checkedAt,
              streams: report.checks
                .filter((x) => x.coverageStatus === "partial")
                .map((x) => x.id),
            }),
          );
        }
      })(),
    );
  },
};
