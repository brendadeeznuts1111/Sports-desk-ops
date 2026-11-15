#!/usr/bin/env bun
/** WebLog + Mode 6 overlap bridge: full-corpus profile, gates, zero-PII rollup. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { resolveF402BetsJsonlPath } from "../lib/f402_bets_corpus_path.ts";
import {
  resolveWeblogCorpusPaths,
  WEBLOG_BRIDGE_USAGE_HINT,
} from "../lib/f402_weblog_bridge_inputs.ts";
import { R2S3Client, resolveSecretBackedEnv } from "../lib/r2_s3_client.ts";
import {
  buildWeblogRollup,
  type WebLogRollup,
  readBetsWindow,
  readWeblogRows,
  resolveWeblogRollupWindow,
  WeblogRollupCorpusError,
} from "../lib/f402_weblog.ts";
import { weblogPublishDataWindowLogLine } from "../lib/f402_weblog_publish_log.ts";

const MAX_WEBLOG_PUBLISH_BYTES = 256 * 1024;
const WEBLOG_MANIFEST_KEY = "manifests/f402-weblog/latest";
const WEBLOG_LATEST_KEY = "f402-weblog/latest.json";

const FORBIDDEN_WEBLOG_KEYS = new Set([
  "ipaddress",
  "ip",
  "remoteaddr",
  "userid",
  "customerid",
  "customer",
  "agentid",
  "agent",
  "agentlogin",
  "login",
  "loginid",
  "ticketnumber",
  "wagernumber",
  "betgroupid",
  "ticketid",
  "ticketwriter",
  "betdetails",
  "raw",
  "shortdesc",
  "description",
  "bettime",
  "bet_time",
  "scheduled",
  "accepted",
  "insertdatetime",
  "insertedat",
  "accessdatetime",
  "payloadsha256",
  "password",
  "namefirst",
  "partneruserid",
  "playerid",
]);

const IPV4_PATTERN =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
const IPV6_COMPRESSED_PATTERN =
  /(?:^|[\s[("'])((?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{0,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5}|::ffff:(?:\d{1,3}\.){3}\d{1,3}|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)(?=$|[\s\],"/%'])/i;
const IPV6_FULL_PATTERN = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;

function hasRawIpLiteral(text: string): boolean {
  return (
    IPV4_PATTERN.test(text) ||
    IPV6_COMPRESSED_PATTERN.test(text) ||
    IPV6_FULL_PATTERN.test(text)
  );
}

function assertCleanWeblogValue(
  value: unknown,
  path: string,
  visited: Set<object>,
): void {
  if (typeof value === "string") {
    if (hasRawIpLiteral(value)) {
      throw new Error(
        `F402 weblog pre-publish sanitization failed: raw IP literal at ${path}`,
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertCleanWeblogValue(value[i], `${path}[${i}]`, visited);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const lower = key.toLowerCase();
    if (
      FORBIDDEN_WEBLOG_KEYS.has(lower) ||
      (lower === "logins" && typeof entry !== "number")
    ) {
      throw new Error(
        `F402 weblog pre-publish sanitization failed: forbidden key "${key}" at ${childPath}`,
      );
    }
    if (hasRawIpLiteral(key)) {
      throw new Error(
        `F402 weblog pre-publish sanitization failed: raw IP key "${key}" at ${childPath}`,
      );
    }
    assertCleanWeblogValue(entry, childPath, visited);
  }
}

/**
 * Enforces `docs/design/pii_sanitization.md` pre-publish invariants:
 * zero forbidden PII/customer/agent/IP keys, zero raw IPv4/IPv6 strings,
 * and serialized payload bounded to <= 256 KiB.
 */
export function assertSanitizedF402Weblog(
  payload: unknown,
  body?: Uint8Array,
): Uint8Array {
  assertCleanWeblogValue(payload, "$", new Set());
  const bytes =
    body ?? new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`);
  if (bytes.byteLength > MAX_WEBLOG_PUBLISH_BYTES) {
    throw new Error(
      `F402 weblog pre-publish sanitization failed: payload ${bytes.byteLength} bytes exceeds ${MAX_WEBLOG_PUBLISH_BYTES}`,
    );
  }
  return bytes;
}

export interface WeblogR2PublishClient {
  readonly publicBase: string;
  writeWithMetadata(
    key: string,
    data: Uint8Array | string,
    options?: {
      readonly type?: string;
      readonly metadata?: Readonly<Record<string, string>>;
      readonly ifMatch?: string;
      readonly ifNoneMatch?: string;
      readonly fetchImpl?: typeof fetch;
    },
  ): Promise<number>;
  stat(key: string): Promise<{ readonly size: number }>;
  headEtag(
    key: string,
    options?: { readonly fetchImpl?: typeof fetch },
  ): Promise<string | null>;
}

export interface PublishWeblogRollupResult {
  readonly deskDate: string;
  readonly dailyKey: string;
  readonly manifestKey: string;
  readonly latestKey: string;
  readonly bytes: number;
  readonly dataWindowMaxEpochMs: number;
  readonly r2PublishedAtEpochMs: number;
  readonly manifestIfMatch: string | null;
  readonly manifestIfNoneMatch: string | null;
}

/**
 * Sanitizes, stamps dual-clock lineage, verifies `stat.size === body.byteLength`,
 * and promotes `manifests/f402-weblog/latest` using strict `If-Match` /
 * `If-None-Match` ETag CAS with zero rebases on HTTP 412.
 */
export async function publishF402WeblogRollup(options: {
  readonly client: WeblogR2PublishClient;
  readonly rollup: WebLogRollup;
  readonly nowMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<PublishWeblogRollupResult> {
  const { client, rollup, fetchImpl } = options;
  const dataWindowMaxEpochMs = rollup.window.toMs;
  const r2PublishedAtEpochMs = options.nowMs ?? Date.now();
  const deskDate = new Date(dataWindowMaxEpochMs - 1)
    .toISOString()
    .slice(0, 10);
  const dailyKey = `f402-weblog/${deskDate}/rollup.json`;
  const publishedAtIso = new Date(r2PublishedAtEpochMs).toISOString();
  const stampedRollup = {
    ...rollup,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: r2PublishedAtEpochMs,
  };
  const body = assertSanitizedF402Weblog(stampedRollup);
  const metadata = {
    pii: "none",
    "schema-version": "1",
    "desk-date": deskDate,
    "generated-at": publishedAtIso,
    "data-window-max-epoch-ms": String(dataWindowMaxEpochMs),
    "r2-published-at-epoch-ms": String(r2PublishedAtEpochMs),
    sha256: rollup.sourceSha256,
    source: "f402-weblog",
  };
  await client.writeWithMetadata(dailyKey, body, {
    type: "application/json",
    metadata,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const stat = await client.stat(dailyKey);
  if (stat.size !== body.byteLength) {
    throw new Error(
      `R2 upload size mismatch for ${dailyKey}: stat.size=${stat.size} !== body.byteLength=${body.byteLength}`,
    );
  }

  const expectedEtag = await client.headEtag(
    WEBLOG_MANIFEST_KEY,
    fetchImpl === undefined ? {} : { fetchImpl },
  );
  const manifestPayload = {
    schemaVersion: 1,
    kind: "f402-weblog-manifest",
    deskDate,
    key: dailyKey,
    sha256: rollup.sourceSha256,
    bytes: body.byteLength,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: r2PublishedAtEpochMs,
    generatedAt: publishedAtIso,
  };
  const manifestBody = assertSanitizedF402Weblog(manifestPayload);
  // Zero rebases on HTTP 412: R2PreconditionFailedError propagates cleanly.
  await client.writeWithMetadata(WEBLOG_MANIFEST_KEY, manifestBody, {
    type: "application/json",
    metadata: { ...metadata, source: "f402-weblog-manifest" },
    ...(expectedEtag === null
      ? { ifNoneMatch: "*" }
      : { ifMatch: expectedEtag }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const pointerPayload = {
    schemaVersion: 1,
    deskDate,
    key: dailyKey,
    sha256: rollup.sourceSha256,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: r2PublishedAtEpochMs,
    generatedAt: publishedAtIso,
  };
  const pointerBody = assertSanitizedF402Weblog(pointerPayload);
  await client.writeWithMetadata(WEBLOG_LATEST_KEY, pointerBody, {
    type: "application/json",
    metadata: { ...metadata, source: "f402-weblog-pointer" },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  return {
    deskDate,
    dailyKey,
    manifestKey: WEBLOG_MANIFEST_KEY,
    latestKey: WEBLOG_LATEST_KEY,
    bytes: body.byteLength,
    dataWindowMaxEpochMs,
    r2PublishedAtEpochMs,
    manifestIfMatch: expectedEtag,
    manifestIfNoneMatch: expectedEtag === null ? "*" : null,
  };
}

export function formatWeblogBridgeHelp(): string {
  return `Usage: bun run --filter sportsdesk-ops weblog:rollup [options]

Capture + rollup (live getWebLog):
  bun run --filter sportsdesk-ops weblog:rollup --fetch-mode A [--date YYYY-MM-DD] [--save-capture path]

Rollup only (existing JSONL corpus):
  bun run --filter sportsdesk-ops weblog:rollup --from out/f402/weblog/11-08-2026.jsonl

Options:
  --from           Comma-separated JSONL paths (required without --fetch-mode)
  --fetch-mode     A|C — fetch getWebLog activity weblog, write JSONL, then roll up
  --save-capture   Capture path (default: out/f402/weblog/MM-DD-YYYY.jsonl)
  --date           Desk date YYYY-MM-DD for fetch (default: today UTC)
  --bets           Wagers JSONL for Mode 6 join (default: resolveF402BetsJsonlPath / F402_BETS_JSONL)
  --out            Local rollup JSON (default: scratch/weblog/rollup-<date>.json)
  --dry-run        Build rollup only; skip R2 publish
  --no-r2          Skip R2 publish
  --customer-id, --ip, --bearer-token  Passed through to getWebLog when fetching

${WEBLOG_BRIDGE_USAGE_HINT}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      from: { type: "string" },
      bets: { type: "string" },
      out: { type: "string" },
      "fetch-mode": { type: "string" },
      date: { type: "string" },
      "customer-id": { type: "string" },
      ip: { type: "string" },
      "save-capture": { type: "string" },
      "bearer-token": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-r2": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(formatWeblogBridgeHelp());
    process.exit(0);
  }
  const corpus = await resolveWeblogCorpusPaths(values, {
    log: (line) => console.error(line),
  });
  if (!corpus.ok) {
    console.error(corpus.message);
    process.exit(corpus.exitCode);
  }

  const from = [...corpus.paths];
  let betsPath: string;
  try {
    betsPath = resolveF402BetsJsonlPath(
      values.bets !== undefined ? { cliValue: values.bets } : {},
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const web = await readWeblogRows(from);
  let fromMs: number;
  let toMs: number;
  try {
    ({ fromMs, toMs } = resolveWeblogRollupWindow(web));
  } catch (error) {
    console.error(
      error instanceof WeblogRollupCorpusError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    );
    process.exit(1);
  }
  const bets = await readBetsWindow(betsPath, fromMs, toMs);
  const rollup = buildWeblogRollup(web, bets, fromMs, toMs);
  const failed = rollup.gates.filter((g) => g.status === "fail");
  console.error(
    `[weblog] rows=${rollup.rows.parsed}/${rollup.rows.total} malformed=${rollup.rows.malformed} wagers=${rollup.join.totalWindowWagers} matched=${rollup.join.matched} ${rollup.gates.map((g) => `${g.gate}:${g.status}`).join(" ")}`,
  );
  if (values["dry-run"]) {
    console.log(JSON.stringify(rollup, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  }
  const out =
    (values.out as string | undefined) ??
    `scratch/weblog/rollup-${new Date(fromMs).toISOString().slice(0, 10)}.json`;
  mkdirSync(dirname(out), { recursive: true });
  const temp = `${out}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(rollup, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, out);
  if (failed.length > 0) {
    console.error(`[weblog] gate failure; wrote ${out} but not publishing`);
    process.exit(1);
  }
  if (values["no-r2"] !== true) {
    const client = await R2S3Client.fromEnvOrSecrets();
    if (client === null) {
      console.error("[weblog] R2 unavailable; local artifact only");
    } else {
      const published = await publishF402WeblogRollup({ client, rollup });
      console.error(
        `[weblog] published ${published.dailyKey} bytes=${published.bytes} + ${published.manifestKey} + ${published.latestKey}`,
      );
      console.error(weblogPublishDataWindowLogLine(rollup.window.toMs));
      const publicStatus = await fetch(
        `${client.publicBase}/${published.dailyKey}`,
      )
        .then((r) => r.status)
        .catch(() => -1);
      console.error(`[weblog] public ${publicStatus} ${published.dailyKey}`);
      const secrets = await resolveSecretBackedEnv().catch(
        // signal-honesty: intentional-optional-ws-broadcast-secrets
        () => ({}) as Record<string, string>,
      );
      const token = (
        Bun.env.BLOB_API_TOKEN ??
        secrets.BLOB_API_TOKEN ??
        ""
      ).trim();
      if (token !== "") {
        const gateway = (
          Bun.env.BLOB_GATEWAY_URL ??
          `http://127.0.0.1:${Bun.env.BLOB_PORT ?? "4021"}`
        ).replace(/\/+$/, "");
        const wsStatus = await fetch(`${gateway}/api/v1/live-bets`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ channel: "f402-weblog", event: rollup }),
          signal: AbortSignal.timeout(5_000),
        })
          .then((r) => r.status)
          .catch(() => -1);
        console.error(`[weblog] ws f402-weblog status=${wsStatus}`);
      } else {
        console.error("[weblog] ws skipped: no BLOB_API_TOKEN");
      }
    }
  }

  console.log(
    JSON.stringify(
      { out, gates: rollup.gates, join: rollup.join, flags: rollup.flags },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
