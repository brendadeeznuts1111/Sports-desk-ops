#!/usr/bin/env bun
/** WebLog + Mode 6 overlap bridge: full-corpus profile, gates, zero-PII rollup. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { R2S3Client } from "../lib/r2_s3_client.ts";
import {
  buildWeblogRollup,
  readBetsWindow,
  readWeblogRows,
} from "../lib/f402_weblog.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string" },
    bets: { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-r2": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: bun run weblog:rollup [--from a.jsonl[,b.jsonl]] [--bets f402-bets.jsonl] [--out path] [--dry-run] [--no-r2]",
  );
  process.exit(0);
}
const from = (
  values.from ??
  "out/f402/weblog/11-01-2026.jsonl,out/f402/weblog/11-02-2026.jsonl"
)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const betsPath =
  values.bets ?? Bun.env.F402_BETS_JSONL ?? "out13/f402-bets.jsonl";
const web = await readWeblogRows(from);
const fromMs = Math.min(...web.rows.map((r) => r.accessMs));
const toMs = Math.max(...web.rows.map((r) => r.accessMs)) + 1;
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
  `Scratch/weblog/rollup-${new Date(fromMs).toISOString().slice(0, 10)}.json`;
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
    await client.writeWithMetadata(
      "f402-weblog/latest.json",
      new TextEncoder().encode(`${JSON.stringify(rollup, null, 2)}\n`),
      {
        type: "application/json",
        metadata: {
          pii: "none",
          "schema-version": "1",
          "desk-date": new Date(fromMs).toISOString().slice(0, 10),
          "generated-at": new Date().toISOString(),
          sha256: rollup.sourceSha256,
          source: "f402-weblog",
        },
      },
    );
    const stat = await client.stat("f402-weblog/latest.json");
    console.error(
      `[weblog] published f402-weblog/latest.json bytes=${stat.size}`,
    );
  }
}
console.log(
  JSON.stringify(
    { out, gates: rollup.gates, join: rollup.join, flags: rollup.flags },
    null,
    2,
  ),
);
