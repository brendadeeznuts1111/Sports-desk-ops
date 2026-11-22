#!/usr/bin/env bun
/**
 * @file publish_wagers_snapshot.ts
 * @description Publish a sanitized Bridge 1 snapshot (`wagers-by-state/latest.json`) from the
 * existing live or offline GSLive summary. Keep the time of the upstream read separate
 * from the bet-time window. Only aggregate fields are published.
 *
 * Usage:
 *   bun run wagers:publish-snapshot --from scratch/gslive-wagers-by-state.summary.json --dry-run
 *   bun run wagers:publish-snapshot --from scratch/gslive-wagers-by-state.summary.json
 */

import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";

import { sha256Hex, stableJson } from "../lib/f402_bet_ticker_delta.ts";
import { R2S3Client } from "../lib/r2_s3_client.ts";

const KEY = "wagers-by-state/latest.json";
const FORBIDDEN =
  /^(login|customerid|customer|agent|agentid|agentlogin|ticket|ticketnumber|wagernumber|betgroupid|ipaddress|ip|userid|playername|team1|team2)$/i;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function walkKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => walkKeys(v, path));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    path ? `${path}.${k}` : k,
    ...walkKeys(v, path ? `${path}.${k}` : k),
  ]);
}
const CHICAGO_YMD_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function chicagoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp ${iso}`);
  const parts = CHICAGO_YMD_FORMAT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: {
      type: "string",
      default: "scratch/gslive-wagers-by-state.summary.json",
    },
    "dry-run": { type: "boolean", default: false },
  },
});

const summaryPath = values.from as string;
const raw = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<
  string,
  unknown
>;
const source = (raw.source ?? {}) as Record<string, unknown>;
const window = (raw.window ?? {}) as Record<string, unknown>;
const observedEnd = text(window.observedEnd) || null;
const isLive = source.kind === "live-ajax.php";
// Offline exports only establish when activity was observed. Preserve their historical clock.
const capturedAt = isLive ? text(source.capturedAt) : observedEnd;
const capturedMs = Date.parse(capturedAt ?? "");
const nowMs = Date.now();
if (
  !capturedAt ||
  !Number.isFinite(capturedMs) ||
  (isLive && capturedMs > nowMs)
) {
  throw new Error(
    isLive
      ? "invalid live source.capturedAt"
      : "invalid summary.window.observedEnd",
  );
}
// A successful read of an old request window cannot establish current coverage.
const requestEndSec = int(source.toEpochSec);
if (
  isLive &&
  (requestEndSec === null ||
    !Number.isSafeInteger(requestEndSec) ||
    requestEndSec <= 0)
) {
  throw new Error("invalid live source.toEpochSec");
}
const coverageMs =
  isLive && requestEndSec !== null
    ? Math.min(capturedMs, requestEndSec * 1000)
    : capturedMs;
const ageMinutes = Math.max(0, Math.round((nowMs - coverageMs) / 60_000));
const generatedAt = new Date(nowMs).toISOString();
const deskDate = chicagoDate(observedEnd ?? capturedAt);
const rangeStart = text(window.observedStart) || null;

const sourcePath = text(source.path);
const sourceKind = sourcePath.endsWith(".json")
  ? "bet-report-json"
  : text(source.kind) || "offline-csv";
const payload = {
  schemaVersion: 2,
  kind: "gslive-wagers",
  sourceKind,
  capturedAt,
  generatedAt,
  deskDate,
  window: {
    observedStart: rangeStart,
    observedEnd,
    ...(isLive && {
      fromEpochSec: int(source.fromEpochSec),
      toEpochSec: requestEndSec,
    }),
    spanHours: int(window.spanHours),
    snapshotLagMinutes: int(window.snapshotLagMinutes),
  },
  staleness: {
    timestampBasis: !isLive
      ? "window.observedEnd"
      : coverageMs < capturedMs
        ? "source.toEpochSec"
        : "source.capturedAt",
    ageMinutesAtPublish: ageMinutes,
    stale: ageMinutes > 1_440,
    staleAfterMinutes: 1_440,
  },
  source: {
    kind: text(source.kind) || "offline-csv",
    mtime: text(source.mtime) || null,
  },
  moneyScope: raw.moneyScope ?? null,
  identity: raw.identity ?? null,
  totals: raw.totals ?? null,
  states: raw.states ?? null,
  quality: raw.quality ?? null,
  notes: Array.isArray(raw.notes) ? raw.notes : [],
} as const;

const artifactSha = sha256Hex(stableJson(payload));
const artifact = { ...payload, sourceSha256: artifactSha };
const body = `${JSON.stringify(artifact, null, 2)}\n`;

const keyPaths = walkKeys(artifact);
const forbidden = keyPaths.filter((p) =>
  FORBIDDEN.test(p.split(".").at(-1) ?? ""),
);
if (forbidden.length > 0)
  throw new Error(`forbidden keys: ${forbidden.join(", ")}`);
if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(body))
  throw new Error("IP literal in artifact");
if (new TextEncoder().encode(body).byteLength > 256 * 1024)
  throw new Error("artifact exceeds 256 KiB");

const summary = {
  key: KEY,
  bytes: new TextEncoder().encode(body).byteLength,
  deskDate,
  generatedAt,
  capturedAt,
  ageMinutes,
  stale: ageMinutes > 1_440,
  sourceKind: payload.sourceKind,
  sha256: artifactSha,
  summaryMtime: statSync(summaryPath).mtime.toISOString(),
};
if (values["dry-run"]) {
  console.log(JSON.stringify({ ...summary, payload: artifact }, null, 2));
  process.exit(0);
}

const client = await R2S3Client.fromEnvOrSecrets();
if (client === null) throw new Error("R2 credentials unavailable");
await client.writeWithMetadata(KEY, new TextEncoder().encode(body), {
  type: "application/json",
  metadata: {
    pii: "none",
    "schema-version": "2",
    "desk-date": deskDate,
    "generated-at": generatedAt,
    sha256: artifactSha,
    source: `gslive-wagers-${sourceKind}`,
  },
});
const stat = await client.stat(KEY);
const publicUrl = `${client.publicBase}/${KEY}`;
let publicStatus = 0;
try {
  publicStatus = (await fetch(publicUrl)).status;
} catch {
  publicStatus = -1;
}
console.log(
  JSON.stringify(
    { ...summary, statSize: stat.size, publicStatus, publicUrl },
    null,
    2,
  ),
);
