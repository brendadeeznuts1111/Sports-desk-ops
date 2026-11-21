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
import {
  R2PreconditionFailedError,
  R2S3Client,
  resolveSecretBackedEnv,
} from "../lib/r2_s3_client.ts";
import {
  buildWeblogRollup,
  type WebLogRollup,
  readBetsWindow,
  readWeblogRows,
  resolveWeblogRollupWindow,
  WeblogRollupCorpusError,
} from "../lib/f402_weblog.ts";
import { weblogPublishDataWindowLogLine } from "../lib/f402_weblog_publish_log.ts";

import {
  capturePendingAccountWeblog,
  type WeblogAccountCoverage,
} from "../lib/f402_weblog_capture.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";
import {
  F402_KEYCHAIN_NAMES,
  readSecretCanonicalThenLegacy,
} from "../lib/secrets.ts";
import { persistWebLogCapture } from "../lib/f402_weblog_fetch.ts";
import { defaultWeblogCapturePath } from "../lib/f402_weblog_bridge_inputs.ts";

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
    const allowActionLoginCount =
      lower === "login" &&
      path === "$.operations.actions" &&
      typeof entry === "number";
    if (
      !allowActionLoginCount &&
      (FORBIDDEN_WEBLOG_KEYS.has(lower) ||
        (lower === "logins" && typeof entry !== "number"))
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
  /** `superseded` means a newer manifest won and this publisher did not overwrite the pointer. */
  readonly pointerOutcome: "written" | "superseded";
}

/**
 * Sanitizes, stamps dual-clock lineage, verifies `stat.size === body.byteLength`,
 * and promotes `manifests/f402-weblog/latest` using strict `If-Match` /
 * `If-None-Match` ETag CAS with zero rebases on HTTP 412.
 */
/**
 * Promotes the public pointer under its own ETag.
 *
 * The manifest CAS is the commit point; the pointer has no cross-key transaction with it, so a
 * stale writer must not overwrite a newer pointer. On a 412 the writer re-reads the manifest:
 * while its own manifest is still current it retries the pointer once, and once a newer manifest
 * owns the key it returns `superseded` and leaves the pointer alone.
 */
async function promoteWeblogPointer(options: {
  readonly client: WeblogR2PublishClient;
  readonly body: Uint8Array;
  readonly metadata: Readonly<Record<string, string>>;
  readonly ourManifestEtag: string | null;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<"written" | "superseded"> {
  const fetchOptions =
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };
  for (let attempt = 0; attempt < 2; attempt++) {
    const pointerEtag = await options.client.headEtag(
      WEBLOG_LATEST_KEY,
      fetchOptions,
    );
    try {
      await options.client.writeWithMetadata(WEBLOG_LATEST_KEY, options.body, {
        type: "application/json",
        metadata: options.metadata,
        ...(pointerEtag === null
          ? { ifNoneMatch: "*" }
          : { ifMatch: pointerEtag }),
        ...fetchOptions,
      });
      return "written";
    } catch (error) {
      if (!(error instanceof R2PreconditionFailedError)) throw error;
      const currentManifest = await options.client.headEtag(
        WEBLOG_MANIFEST_KEY,
        fetchOptions,
      );
      if (
        options.ourManifestEtag === null ||
        currentManifest !== options.ourManifestEtag
      ) {
        return "superseded";
      }
      // Our manifest is still current; retry once against the pointer's new ETag.
    }
  }
  return "superseded";
}

export async function publishF402WeblogRollup(options: {
  readonly client: WeblogR2PublishClient;
  readonly rollup: WebLogRollup;
  readonly nowMs?: number;
  readonly onStage?: (
    stage: "sanitize" | "daily-upload" | "daily-stat" | "manifest" | "pointer",
  ) => void;
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
  options.onStage?.("sanitize");
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
  options.onStage?.("daily-upload");
  await client.writeWithMetadata(dailyKey, body, {
    type: "application/json",
    metadata,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  options.onStage?.("daily-stat");
  const stat = await client.stat(dailyKey);
  if (stat.size !== body.byteLength) {
    throw new Error(
      `R2 upload size mismatch for ${dailyKey}: stat.size=${stat.size} !== body.byteLength=${body.byteLength}`,
    );
  }

  options.onStage?.("manifest");
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
    ...(rollup.coverage === undefined ? {} : { coverage: rollup.coverage }),
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
  const ourManifestEtag = await client.headEtag(
    WEBLOG_MANIFEST_KEY,
    fetchImpl === undefined ? {} : { fetchImpl },
  );

  const pointerPayload = {
    schemaVersion: 1,
    deskDate,
    key: dailyKey,
    sha256: rollup.sourceSha256,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: r2PublishedAtEpochMs,
    generatedAt: publishedAtIso,
    ...(rollup.coverage === undefined ? {} : { coverage: rollup.coverage }),
  };
  const pointerBody = assertSanitizedF402Weblog(pointerPayload);
  options.onStage?.("pointer");
  const pointerOutcome = await promoteWeblogPointer({
    client,
    body: pointerBody,
    metadata: { ...metadata, source: "f402-weblog-pointer" },
    ourManifestEtag,
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
    pointerOutcome,
  };
}

export function formatWeblogBridgeHelp(): string {
  return `Usage: bun run --filter sportsdesk-ops weblog:rollup [options]

Capture + rollup (live getWebLog):
  bun run --filter sportsdesk-ops weblog:rollup --fetch-mode A [--date YYYY-MM-DD] [--save-capture path]

Scheduled account-scoped capture + rollup:
  bun run --filter sportsdesk-ops weblog:rollup --capture-pending

Rollup only (existing JSONL corpus):
  bun run --filter sportsdesk-ops weblog:rollup --from out/f402/weblog/11-08-2026.jsonl

Options:
  --capture-pending Capture Mode A for accounts in a recent live pending snapshot (scheduled mode)
  --pending-snapshot Snapshot path (default: data/live-bets.json; maximum age 1 hour)
  --from           Comma-separated JSONL paths (offline/manual rollup)
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
      "capture-pending": { type: "boolean", default: false },
      "pending-snapshot": { type: "string" },
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
  let coverage: WeblogAccountCoverage | undefined;
  let capturedPath: string | undefined;
  if (values["capture-pending"]) {
    if (
      values.from ||
      values["fetch-mode"] ||
      values.date ||
      values["customer-id"] ||
      values.ip
    )
      throw new Error(
        "--capture-pending cannot be combined with --from, --fetch-mode, --date, --customer-id or --ip",
      );
    const agentId =
      Bun.env.F402_AGENT_ID?.trim() ||
      (await readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.agentId));
    if (!agentId) throw new Error("weblog capture requires F402_AGENT_ID");
    const snapshotFile = Bun.file(
      values["pending-snapshot"] ?? "data/live-bets.json",
    );
    if (snapshotFile.size > 8 * 1024 * 1024)
      throw new Error("weblog pending snapshot exceeds 8 MiB");
    const snapshot: unknown = await snapshotFile.json();
    const transport = await createF402ReplayTransport();
    try {
      const capture = await capturePendingAccountWeblog({
        snapshot,
        agentId,
        fetchActivity: (body) =>
          transport.fetch(
            "https://fantasy402.com/cloud/api/Manager/getWebLog",
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/x-www-form-urlencoded; charset=UTF-8",
                accept: "application/json, text/plain, */*",
                "x-requested-with": "XMLHttpRequest",
              },
              body,
              signal: AbortSignal.timeout(10_000),
            },
          ),
      });
      coverage = capture.coverage;
      capturedPath =
        values["save-capture"] ??
        defaultWeblogCapturePath(new Date().toISOString().slice(0, 10));
      persistWebLogCapture(capturedPath, capture.rows);
      console.error(
        `[weblog] coverage=${coverage.completedAccounts}/${coverage.eligibleAccounts} pending accounts, active=${coverage.accountsWithActivity}, empty=${coverage.emptyAccounts}, unidentifiedTickets=${coverage.unidentifiedTicketRows}/${coverage.snapshotTicketRows}, wholeBookComplete=false`,
      );
    } finally {
      await transport.close();
    }
  }
  const corpus =
    capturedPath === undefined
      ? await resolveWeblogCorpusPaths(values, {
          log: (line) => console.error(line),
        })
      : { ok: true as const, paths: [capturedPath] };
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
  const rollup = {
    ...buildWeblogRollup(web, bets, fromMs, toMs),
    ...(coverage === undefined ? {} : { coverage }),
  };
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
      let stage = "initialize";
      let published: Awaited<ReturnType<typeof publishF402WeblogRollup>>;
      try {
        published = await publishF402WeblogRollup({
          client,
          rollup,
          onStage: (value) => {
            stage = value;
          },
        });
      } catch (error) {
        console.error(
          `[weblog] R2 publish failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      console.error(
        `[weblog] published ${published.dailyKey} bytes=${published.bytes} + ${published.manifestKey} + ${published.latestKey} pointer=${published.pointerOutcome}`,
      );
      if (published.pointerOutcome === "superseded") {
        console.error(
          "[weblog] pointer left to the newer manifest; this run did not overwrite it",
        );
      }
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
