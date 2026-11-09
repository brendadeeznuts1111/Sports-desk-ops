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
  readBetsWindow,
  readWeblogRows,
  resolveWeblogRollupWindow,
  WeblogRollupCorpusError,
} from "../lib/f402_weblog.ts";
import { weblogPublishDataWindowLogLine } from "../lib/f402_weblog_publish_log.ts";

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
  console.log(`Usage: bun run weblog:rollup [options]

Capture + rollup (live getWebLog):
  bun run weblog:rollup --fetch-mode B [--date YYYY-MM-DD] [--save-capture path]

Rollup only (existing JSONL corpus):
  bun run weblog:rollup --from out/f402/weblog/11-08-2026.jsonl

Options:
  --from           Comma-separated JSONL paths (required without --fetch-mode)
  --fetch-mode     A|B|C|I — fetch getWebLog, write JSONL, then roll up
  --save-capture   Capture path (default: out/f402/weblog/MM-DD-YYYY.jsonl)
  --date           Desk date YYYY-MM-DD for fetch (default: today UTC)
  --bets           Wagers JSONL for Mode 6 join (default: resolveF402BetsJsonlPath / F402_BETS_JSONL)
  --out            Local rollup JSON (default: scratch/weblog/rollup-<date>.json)
  --dry-run        Build rollup only; skip R2 publish
  --no-r2          Skip R2 publish
  --customer-id, --ip, --bearer-token  Passed through to getWebLog when fetching

${WEBLOG_BRIDGE_USAGE_HINT}`);
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
    const deskDate = new Date(toMs - 1).toISOString().slice(0, 10);
    const body = new TextEncoder().encode(
      `${JSON.stringify(rollup, null, 2)}\n`,
    );
    const dailyKey = `f402-weblog/${deskDate}/rollup.json`;
    const metadata = {
      pii: "none",
      "schema-version": "1",
      "desk-date": deskDate,
      "generated-at": new Date().toISOString(),
      sha256: rollup.sourceSha256,
      source: "f402-weblog",
    };
    await client.writeWithMetadata(dailyKey, body, {
      type: "application/json",
      metadata,
    });
    const stat = await client.stat(dailyKey);
    const pointer = {
      schemaVersion: 1,
      deskDate,
      key: dailyKey,
      sha256: rollup.sourceSha256,
      generatedAt: new Date().toISOString(),
    };
    await client.writeWithMetadata(
      "f402-weblog/latest.json",
      new TextEncoder().encode(`${JSON.stringify(pointer, null, 2)}\n`),
      {
        type: "application/json",
        metadata: { ...metadata, source: "f402-weblog-pointer" },
      },
    );
    console.error(
      `[weblog] published ${dailyKey} bytes=${stat.size} + latest.json`,
    );
    console.error(weblogPublishDataWindowLogLine(rollup.window.toMs));
    const publicStatus = await fetch(`${client.publicBase}/${dailyKey}`)
      .then((r) => r.status)
      .catch(() => -1);
    console.error(`[weblog] public ${publicStatus} ${dailyKey}`);
    const secrets = await resolveSecretBackedEnv().catch(
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
