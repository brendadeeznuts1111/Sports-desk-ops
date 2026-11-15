/**
 * @file packages/backend/src/r2_pipeline.ts
 * @description Live Cloudflare R2 public pipeline monitor, pointer-rollup dereferencer, and `:4020` daemon probe.
 */

import type {
  BetTickerBridge3aSnapshot,
  Daemon4020Status,
  R2PipelineApiResponse,
  R2SinkDetail,
  R2SinkRollupMetric,
  R2SinkState,
} from "@sportsdesk-ops/contracts";

export const DEFAULT_R2_PUBLIC_BASE =
  "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";
export const DEFAULT_DAEMON_4020_ORIGIN = "http://127.0.0.1:4020";
export const R2_DATA_STALE_SECONDS = 86_400;

export interface R2TargetSpec {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly slaSeconds: number;
  readonly remediationCommand: string;
}

export const R2_PIPELINE_TARGETS: readonly R2TargetSpec[] = [
  {
    id: "f402-bet-ticker",
    key: "f402-bet-ticker/latest.json",
    label: "f402 bet ticker",
    description: "Bridge 3a channel/wager-type ticker rollup & watermark",
    slaSeconds: 3600,
    remediationCommand: "bun run positions:cron --once",
  },
  {
    id: "gslive-tally",
    key: "gslive-tally/latest.json",
    label: "gslive tally",
    description: "Bridge 3c open-bets & CLV settlement pointer rollup",
    slaSeconds: 3600,
    remediationCommand: "bun run tally:bridge3c",
  },
  {
    id: "f402-weblog",
    key: "f402-weblog/latest.json",
    label: "f402 weblog",
    description: "Weblog access & device template corpus pointer rollup",
    slaSeconds: 5400,
    remediationCommand: "bun run weblog:cron",
  },
  {
    id: "wagers-by-state",
    key: "wagers-by-state/latest.json",
    label: "wagers-by-state",
    description: "88-hour win/lose/push & grade-lag histogram",
    slaSeconds: 3600,
    remediationCommand: "bun run wagers:publish-snapshot",
  },
] as const;

export type R2Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function defaultFetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, {
    ...init,
    method: init?.method ?? "GET",
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUsdFromCents(cents: number): string {
  const usd = cents / 100;
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(usd) >= 100 ? 0 : 2,
  });
}

function parseDataWindowEndMs(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const win = value.window;
  if (isRecord(win)) {
    if (typeof win.toMs === "number" && Number.isFinite(win.toMs)) {
      return win.toMs;
    }
    if (typeof win.observedEnd === "string" && win.observedEnd.trim() !== "") {
      const ms = Date.parse(win.observedEnd);
      if (Number.isFinite(ms)) return ms;
    }
    if (typeof win.toEpochSec === "number" && Number.isFinite(win.toEpochSec)) {
      return win.toEpochSec * 1000;
    }
    if (typeof win.to === "number" && Number.isFinite(win.to)) {
      return win.to < 1e12 ? win.to * 1000 : win.to;
    }
  }
  const ts = value.generatedAt ?? value.capturedAt;
  if (typeof ts === "string" && ts.trim() !== "") {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function extractPointerRollupKey(body: unknown): {
  readonly key: string | null;
  readonly sha256: string | null;
} {
  if (!isRecord(body)) return { key: null, sha256: null };
  const rawKey =
    typeof body.rollupKey === "string"
      ? body.rollupKey
      : typeof body.key === "string"
        ? body.key
        : null;
  const sha =
    typeof body.sha256 === "string"
      ? body.sha256
      : typeof body.sourceSha256 === "string"
        ? body.sourceSha256
        : null;
  const trimmedKey =
    rawKey && rawKey.trim() !== "" ? rawKey.trim().replace(/^\/+/, "") : null;
  return { key: trimmedKey, sha256: sha };
}

function extractMetricsForSink(
  id: string,
  latestBody: unknown,
  rollupBody: unknown,
): readonly R2SinkRollupMetric[] {
  const source = isRecord(rollupBody) ? rollupBody : latestBody;
  if (!isRecord(source)) return [];

  const metrics: R2SinkRollupMetric[] = [];
  if (id === "f402-bet-ticker") {
    const tickets = Number(source.ticketCount ?? source.rowCount ?? 0);
    const legs = Number(source.legCount ?? 0);
    const twins = Number(source.alertTwinCount ?? 0);
    const orphans = Number(source.orphanCount ?? 0);
    const watermark =
      typeof source.watermark === "string" ? source.watermark : "—";
    const deskSlice =
      typeof source.deskDate === "string"
        ? `${source.deskDate}${source.deskHour !== undefined ? ` h${String(source.deskHour).padStart(2, "0")}` : ""}`
        : "—";
    metrics.push(
      {
        label: "Tickets / Legs",
        value: `${tickets.toLocaleString()} / ${legs.toLocaleString()}`,
      },
      {
        label: "ALERT Twins",
        value: `${twins.toLocaleString()} (Orphans: ${orphans.toLocaleString()})`,
      },
      { label: "Watermark", value: watermark },
      { label: "Desk Slice", value: deskSlice },
    );
    if (Array.isArray(source.byChannel)) {
      const channelSummary = source.byChannel
        .filter((row): row is Record<string, unknown> => isRecord(row))
        .map(
          (row) =>
            `${String(row.channel ?? "other")}:${Number(row.ticketCount ?? 0)} (${formatUsdFromCents(Number(row.canonicalVolumeCents ?? 0))})`,
        )
        .join(" · ");
      if (channelSummary) {
        metrics.push({ label: "Channels", value: channelSummary });
      }
    }
    return metrics;
  }

  if (id === "gslive-tally") {
    const totals = isRecord(source.totals) ? source.totals : {};
    const tickets = Number(
      totals.ticketCount ?? source.distinctTicketCount ?? source.rowCount ?? 0,
    );
    const legs = Number(totals.legCount ?? 0);
    const riskCents = Number(totals.riskCents ?? 0);
    const netCents = Number(totals.settledNetCents ?? 0);
    const win = isRecord(source.window) ? source.window : {};
    const fromIso =
      typeof win.fromEpochSec === "number"
        ? new Date(win.fromEpochSec * 1000).toISOString().slice(0, 16) + "Z"
        : "—";
    const toIso =
      typeof win.toEpochSec === "number"
        ? new Date(win.toEpochSec * 1000).toISOString().slice(0, 16) + "Z"
        : "—";
    const gates = isRecord(source.gates) ? source.gates : {};
    const gateEntries = Object.entries(gates)
      .filter(([, v]) => typeof v === "boolean")
      .map(([k, v]) => `${k}:${v ? "OK" : "FAIL"}`)
      .join(" ");
    metrics.push(
      { label: "Desk Date", value: String(source.deskDate ?? "—") },
      {
        label: "Tickets / Legs",
        value: `${tickets.toLocaleString()} / ${legs.toLocaleString()}`,
      },
      {
        label: "Risk / Settled Net",
        value: `${formatUsdFromCents(riskCents)} / ${formatUsdFromCents(netCents)}`,
      },
      { label: "Window", value: `${fromIso} → ${toIso}` },
    );
    if (gateEntries) {
      metrics.push({ label: "Gates", value: gateEntries });
    }
    return metrics;
  }

  if (id === "f402-weblog") {
    const rows = isRecord(source.rows) ? source.rows : {};
    const ops = isRecord(source.operations) ? source.operations : {};
    const total = Number(rows.total ?? 0);
    const templates = Number(rows.distinctTemplates ?? 0);
    const devClasses = isRecord(ops.deviceClasses)
      ? Object.entries(ops.deviceClasses)
          .slice(0, 3)
          .map(([k, v]) => `${k}:${Number(v).toLocaleString()}`)
          .join(", ")
      : "—";
    const ipClasses = isRecord(source.ipClasses)
      ? Object.entries(source.ipClasses)
          .slice(0, 3)
          .map(([k, v]) => `${k}:${Number(v).toLocaleString()}`)
          .join(", ")
      : "—";
    metrics.push(
      { label: "Total Log Rows", value: total.toLocaleString() },
      { label: "Distinct Templates", value: templates.toLocaleString() },
      { label: "Device Classes", value: devClasses },
      { label: "IP Classes", value: ipClasses },
    );
    return metrics;
  }

  if (id === "wagers-by-state") {
    const totals = isRecord(source.totals) ? source.totals : {};
    const win = isRecord(source.window) ? source.window : {};
    const wagers = Number(totals.wagers ?? 0);
    const legs = Number(totals.legs ?? 0);
    const span =
      typeof win.spanHours === "number" ? `${win.spanHours.toFixed(1)}h` : "—";
    const statesSummary = Array.isArray(source.states)
      ? source.states
          .filter((s): s is Record<string, unknown> => isRecord(s))
          .map(
            (s) =>
              `${String(s.state ?? "?")}:${Number(s.wagers ?? 0).toLocaleString()}`,
          )
          .join(" · ")
      : "—";
    metrics.push(
      {
        label: "Wagers / Legs",
        value: `${wagers.toLocaleString()} / ${legs.toLocaleString()}`,
      },
      { label: "Span Window", value: span },
      { label: "States", value: statesSummary },
      { label: "Desk Date", value: String(source.deskDate ?? "—") },
    );
    return metrics;
  }

  return metrics;
}

export function buildBridge3aSnapshotFromBody(
  publicUrl: string,
  state: R2SinkState,
  lastModified: string | null,
  ageSeconds: number | null,
  body: unknown,
  error?: string,
): BetTickerBridge3aSnapshot {
  if (!isRecord(body)) {
    return {
      available: false,
      publicUrl,
      state,
      lastModified,
      ageSeconds,
      generatedAt: null,
      deskDate: null,
      deskHour: null,
      watermark: null,
      rowCount: 0,
      ticketCount: 0,
      legCount: 0,
      alertTwinCount: 0,
      orphanCount: 0,
      byChannel: {},
      byWagerType: {},
      error,
    };
  }

  const byChannel: Record<
    string,
    { tickets: number; legs: number; volumeCents: number }
  > = {};
  if (Array.isArray(body.byChannel)) {
    for (const item of body.byChannel) {
      if (!isRecord(item)) continue;
      const key = String(item.channel ?? "other");
      byChannel[key] = {
        tickets: Number(item.ticketCount ?? 0),
        legs: Number(item.legCount ?? 0),
        volumeCents: Number(item.canonicalVolumeCents ?? 0),
      };
    }
  } else if (isRecord(body.byChannel)) {
    for (const [key, item] of Object.entries(body.byChannel)) {
      if (!isRecord(item)) continue;
      byChannel[key] = {
        tickets: Number(item.tickets ?? item.ticketCount ?? 0),
        legs: Number(item.legs ?? item.legCount ?? 0),
        volumeCents: Number(item.volumeCents ?? item.canonicalVolumeCents ?? 0),
      };
    }
  }

  const byWagerType: Record<
    string,
    { tickets: number; legs: number; wageredCents: number }
  > = {};
  if (Array.isArray(body.byWagerType)) {
    for (const item of body.byWagerType) {
      if (!isRecord(item)) continue;
      const key = String(item.wagerType ?? "unknown");
      byWagerType[key] = {
        tickets: Number(item.ticketCount ?? 0),
        legs: Number(item.legCount ?? 0),
        wageredCents: Number(item.wageredCents ?? 0),
      };
    }
  } else if (isRecord(body.byWagerType)) {
    for (const [key, item] of Object.entries(body.byWagerType)) {
      if (!isRecord(item)) continue;
      byWagerType[key] = {
        tickets: Number(item.tickets ?? item.ticketCount ?? 0),
        legs: Number(item.legs ?? item.legCount ?? 0),
        wageredCents: Number(item.wageredCents ?? 0),
      };
    }
  }

  return {
    available: true,
    publicUrl,
    state,
    lastModified,
    ageSeconds,
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : null,
    deskDate: typeof body.deskDate === "string" ? body.deskDate : null,
    deskHour:
      typeof body.deskHour === "number" && Number.isFinite(body.deskHour)
        ? body.deskHour
        : null,
    watermark:
      typeof body.watermark === "string" || typeof body.watermark === "number"
        ? String(body.watermark)
        : null,
    rowCount: Number(body.rowCount ?? 0),
    ticketCount: Number(body.ticketCount ?? body.rowCount ?? 0),
    legCount: Number(body.legCount ?? 0),
    alertTwinCount: Number(body.alertTwinCount ?? 0),
    orphanCount: Number(body.orphanCount ?? 0),
    byChannel,
    byWagerType,
    error,
  };
}

interface Daemon4020HealthSummary {
  readonly operationalStatus?: "ok" | "degraded" | "down";
  readonly reasonSummary?: string;
}

async function readDaemon4020HealthSummary(
  res: Response,
): Promise<Daemon4020HealthSummary> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType !== "" && !contentType.toLowerCase().includes("json")) {
    return {};
  }
  try {
    const body = (await res.json()) as {
      operationalStatus?: unknown;
      degradedReasons?: unknown;
    } | null;
    if (!body || typeof body !== "object") return {};
    const op =
      body.operationalStatus === "ok" ||
      body.operationalStatus === "degraded" ||
      body.operationalStatus === "down"
        ? body.operationalStatus
        : undefined;
    const reasons = Array.isArray(body.degradedReasons)
      ? body.degradedReasons
          .map((item) =>
            item && typeof item === "object" && "message" in item
              ? String((item as { message: unknown }).message)
              : "",
          )
          .filter((msg) => msg.length > 0)
      : [];
    const reasonSummary =
      reasons.length > 0 ? reasons.slice(0, 2).join("; ") : undefined;
    return {
      ...(op !== undefined ? { operationalStatus: op } : {}),
      ...(reasonSummary !== undefined ? { reasonSummary } : {}),
    };
  } catch {
    return {};
  }
}

export async function probeDaemon4020Status(
  options: {
    readonly origin?: string | undefined;
    readonly fetchImpl?: R2Fetcher | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): Promise<Daemon4020Status> {
  const origin = (options.origin ?? DEFAULT_DAEMON_4020_ORIGIN).replace(
    /\/+$/,
    "",
  );
  const url = `${origin}/health`;
  const nowDate = (options.now ?? (() => new Date()))();
  const checkedAt = nowDate.toISOString();
  const startedAt = performance.now();
  const fetcher: R2Fetcher =
    options.fetchImpl ?? ((u, init) => defaultFetchWithTimeout(u, init, 1500));

  try {
    const res = await fetcher(url, { method: "GET" });
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    const health = await readDaemon4020HealthSummary(res);

    if (res.ok) {
      const degraded =
        health.operationalStatus === "degraded" ||
        health.operationalStatus === "down";
      return {
        online: true,
        state: degraded ? "degraded" : "online",
        ...(health.operationalStatus !== undefined
          ? { operationalStatus: health.operationalStatus }
          : {}),
        url,
        status: res.status,
        latencyMs,
        checkedAt,
        reason: degraded ? health.reasonSummary : undefined,
      };
    }

    // SportsDesk /health returns HTTP 503 when the daemon process is up & answering
    // routes locally, but both upstream auth sessions (f402 + gslive) are down.
    if (res.status === 503) {
      const reason = health.reasonSummary
        ? `HTTP 503 — ${health.reasonSummary}`
        : "HTTP 503";
      return {
        online: true,
        state: "degraded",
        operationalStatus: health.operationalStatus ?? "down",
        url,
        status: res.status,
        latencyMs,
        checkedAt,
        reason,
      };
    }

    return {
      online: false,
      state: "offline",
      url,
      status: res.status,
      latencyMs,
      checkedAt,
      reason: `HTTP ${res.status}`,
    };
  } catch (err) {
    // signal-honesty: intentional-daemon-offline-probe-report
    return {
      online: false,
      state: "offline",
      url,
      status: null,
      latencyMs: null,
      checkedAt,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface R2PipelineServiceOptions {
  readonly publicBase?: string | undefined;
  readonly daemon4020Origin?: string | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly fetchImpl?: R2Fetcher | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createR2PipelineService(
  options: R2PipelineServiceOptions = {},
) {
  const bucketPublicBase = (
    options.publicBase ?? DEFAULT_R2_PUBLIC_BASE
  ).replace(/\/+$/, "");
  const cacheTtlMs = options.cacheTtlMs ?? 15_000;
  const getNow = options.now ?? (() => new Date());
  const fetcher: R2Fetcher =
    options.fetchImpl ?? ((u, init) => defaultFetchWithTimeout(u, init, 5000));

  let cachedResponse: R2PipelineApiResponse | null = null;
  let cachedBridge3a: BetTickerBridge3aSnapshot | null = null;
  let cachedAtMs = 0;

  async function probeSingleSink(
    target: R2TargetSpec,
    nowMs: number,
  ): Promise<{
    readonly sink: R2SinkDetail;
    readonly rawLatestBody: unknown;
  }> {
    const publicUrl = `${bucketPublicBase}/${target.key}`;
    let status = 0;
    let lastModified: string | null = null;
    let contentLength: number | null = null;
    let latestBody: unknown = null;
    let networkError: string | null = null;

    try {
      const res = await fetcher(publicUrl, { method: "GET" });
      status = res.status;
      lastModified = res.headers.get("last-modified");
      const clHeader = res.headers.get("content-length");
      if (clHeader !== null && clHeader.trim() !== "") {
        const parsedLen = Number(clHeader);
        if (Number.isFinite(parsedLen)) contentLength = parsedLen;
      }
      if (res.ok) {
        try {
          latestBody = (await res.json()) as unknown;
        } catch (err) {
          // signal-honesty: intentional-r2-invalid-json-classified-as-error
          networkError = `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } catch (err) {
      // signal-honesty: intentional-r2-network-failure-classified-as-error
      networkError = err instanceof Error ? err.message : String(err);
    }

    const lastModifiedMs = lastModified ? Date.parse(lastModified) : Number.NaN;
    const validLm = Number.isFinite(lastModifiedMs);
    const ageSeconds = validLm
      ? Math.max(0, Math.round((nowMs - lastModifiedMs) / 1000))
      : null;

    let state: R2SinkState = "error";
    let reason: string | null = networkError;
    if (networkError !== null) {
      state = "error";
    } else if (status === 404) {
      state = "missing";
      reason = "HTTP 404 Not Found";
    } else if (status < 200 || status >= 300) {
      state = "error";
      reason = `HTTP ${status}`;
    } else if (ageSeconds === null) {
      state = "error";
      reason = "Missing Last-Modified header";
    } else if (ageSeconds > target.slaSeconds) {
      state = "stale";
      reason = `Published ${Math.round(ageSeconds / 3600)}h ago (SLA ${Math.round(target.slaSeconds / 60)}m)`;
    } else {
      state = "fresh";
      reason = "Within publish SLA";
    }

    const pointer = extractPointerRollupKey(latestBody);
    const resolvedRollupKey =
      pointer.key && pointer.key !== target.key ? pointer.key : null;
    const resolvedRollupUrl = resolvedRollupKey
      ? `${bucketPublicBase}/${resolvedRollupKey}`
      : null;

    let rollupBody: unknown = null;
    if (resolvedRollupUrl) {
      try {
        const r2 = await fetcher(resolvedRollupUrl, { method: "GET" });
        if (r2.ok) {
          rollupBody = (await r2.json()) as unknown;
        }
      } catch {
        // signal-honesty: intentional-r2-rollup-deref-optional-fallback
      }
    }

    const dataWindowToMs =
      parseDataWindowEndMs(rollupBody) ?? parseDataWindowEndMs(latestBody);
    const dataAgeSeconds =
      dataWindowToMs !== null && Number.isFinite(dataWindowToMs)
        ? Math.max(0, Math.round((nowMs - dataWindowToMs) / 1000))
        : null;
    const dataStale =
      dataAgeSeconds !== null && dataAgeSeconds > R2_DATA_STALE_SECONDS;

    const metrics = extractMetricsForSink(target.id, latestBody, rollupBody);

    return {
      sink: {
        id: target.id,
        key: target.key,
        label: target.label,
        description: target.description,
        publicUrl,
        resolvedRollupKey,
        resolvedRollupUrl,
        slaSeconds: target.slaSeconds,
        state,
        stale: state !== "fresh",
        lastModified,
        ageSeconds,
        dataAgeSeconds,
        dataStale,
        contentLength,
        sha256: pointer.sha256,
        reason,
        remediationCommand: target.remediationCommand,
        metrics,
      },
      rawLatestBody: latestBody,
    };
  }

  async function probeAll(
    opts: { readonly refresh?: boolean | undefined } = {},
  ): Promise<R2PipelineApiResponse> {
    const nowDate = getNow();
    const nowMs = nowDate.getTime();
    if (
      !opts.refresh &&
      cachedResponse !== null &&
      nowMs - cachedAtMs < cacheTtlMs
    ) {
      return cachedResponse;
    }

    const [sinkResults, daemon4020] = await Promise.all([
      Promise.all(R2_PIPELINE_TARGETS.map((t) => probeSingleSink(t, nowMs))),
      probeDaemon4020Status({
        origin: options.daemon4020Origin,
        fetchImpl: options.fetchImpl,
        now: getNow,
      }),
    ]);

    const sinks = sinkResults.map((r) => r.sink);
    const freshCount = sinks.filter((s) => s.state === "fresh").length;
    const staleKeys = sinks.filter((s) => s.stale).map((s) => s.key);
    const dataStaleKeys = sinks.filter((s) => s.dataStale).map((s) => s.key);
    const hasErrorOrMissing = sinks.some(
      (s) => s.state === "error" || s.state === "missing",
    );
    const overallStatus: R2PipelineApiResponse["overallStatus"] =
      freshCount === sinks.length
        ? "fresh"
        : hasErrorOrMissing && freshCount === 0
          ? "degraded"
          : "stale";

    const betTickerResult = sinkResults.find(
      (r) => r.sink.id === "f402-bet-ticker",
    );
    if (betTickerResult) {
      cachedBridge3a = buildBridge3aSnapshotFromBody(
        betTickerResult.sink.publicUrl,
        betTickerResult.sink.state,
        betTickerResult.sink.lastModified,
        betTickerResult.sink.ageSeconds,
        betTickerResult.rawLatestBody,
        betTickerResult.sink.state === "error" ||
          betTickerResult.sink.state === "missing"
          ? (betTickerResult.sink.reason ?? undefined)
          : undefined,
      );
    }

    const response: R2PipelineApiResponse = {
      schemaVersion: 1,
      bucketPublicBase,
      observedAt: nowDate.toISOString(),
      overallStatus,
      freshCount,
      totalCount: sinks.length,
      staleKeys,
      dataStaleKeys,
      sinks,
      daemon4020,
    };

    cachedResponse = response;
    cachedAtMs = nowMs;
    return response;
  }

  async function getLatestBetTickerBridge3a(
    opts: { readonly refresh?: boolean | undefined } = {},
  ): Promise<BetTickerBridge3aSnapshot> {
    if (opts.refresh || cachedBridge3a === null) {
      await probeAll(opts);
    }
    return (
      cachedBridge3a ?? {
        available: false,
        publicUrl: `${bucketPublicBase}/f402-bet-ticker/latest.json`,
        state: "error",
        lastModified: null,
        ageSeconds: null,
        generatedAt: null,
        deskDate: null,
        deskHour: null,
        watermark: null,
        rowCount: 0,
        ticketCount: 0,
        legCount: 0,
        alertTwinCount: 0,
        orphanCount: 0,
        byChannel: {},
        byWagerType: {},
        error: "Bridge 3a R2 snapshot not yet probed",
      }
    );
  }

  return {
    probeAll,
    getLatestBetTickerBridge3a,
    probeDaemon: () =>
      probeDaemon4020Status({
        origin: options.daemon4020Origin,
        fetchImpl: options.fetchImpl,
        now: getNow,
      }),
    clearCache: () => {
      cachedResponse = null;
      cachedBridge3a = null;
      cachedAtMs = 0;
    },
  };
}
