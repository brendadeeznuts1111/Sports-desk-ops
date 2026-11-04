#!/usr/bin/env bun
/**
 * @file gslive_tally_bridge3c.ts
 * @description Bridge 3c CLI: stream a GSLive bet-report capture, fold the deduped tally, run
 * GATE-01..06 + GATE-08, and publish `gslive-tally/<desk-date>/rollup.json` plus the
 * `gslive-tally/latest.json` pointer to R2. No raw row, identifier or free text is written.
 *
 * Usage:
 *   bun run bridge3c:rollup --from Scratch/betReport-all.json --dry-run
 *   bun run bridge3c:rollup --from Scratch/betReport-all.json
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { buildGsliveTallyRollup } from "../lib/gslive_tally_rollup.ts";
import { publishGsliveTallyRollup } from "../lib/gslive_tally_sink.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", default: "Scratch/betReport-all.json" },
    "desk-date": { type: "string" },
    "chunk-bytes": { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-r2": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    "Usage: bun run bridge3c:rollup [--from <betReport-all.json>] [--out path] [--desk-date YYYY-MM-DD] [--chunk-bytes n] [--dry-run] [--no-r2]",
  );
  process.exit(0);
}

const chunkBytes = (() => {
  const raw = values["chunk-bytes"];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("--chunk-bytes must be a positive integer");
  return parsed;
})();

const rollup = await buildGsliveTallyRollup(values.from as string, {
  ...(values["desk-date"] === undefined
    ? {}
    : { deskDate: values["desk-date"] as string }),
  ...(chunkBytes === undefined ? {} : { chunkBytes }),
});
const gateSummary = rollup.gates
  .map((gate) => `GATE-0${gate.gate}:${gate.status}`)
  .join(" ");
console.error(
  `[bridge3c] rows=${rollup.rowCount} groups=${rollup.distinctBetGroupCount} cells=${rollup.cells.length} ` +
    `suppressed=${rollup.suppressed.cellCount} bytes=${new TextEncoder().encode(JSON.stringify(rollup)).byteLength} ` +
    `deskDate=${rollup.deskDate} ${gateSummary}`,
);

if (values.out !== undefined) {
  const out = values.out as string;
  mkdirSync(dirname(out), { recursive: true });
  const temp = `${out}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(rollup, null, 2)}\n`);
  renameSync(temp, out);
  console.error(`[bridge3c] wrote ${out}`);
}
if (values["dry-run"]) {
  console.log(JSON.stringify(rollup, null, 2));
  process.exit(0);
}
if (values["no-r2"]) process.exit(0);

const result = await publishGsliveTallyRollup(rollup);
const publicStatus = await fetch(result.publicUrl)
  .then((r) => r.status)
  .catch(() => -1);
console.log(JSON.stringify({ ...result, publicStatus, gateSummary }, null, 2));
