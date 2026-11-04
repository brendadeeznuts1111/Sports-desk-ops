#!/usr/bin/env bun
/** Bridge 3b CLI: fixture/live pending rows → sanitized rollup → R2 (fixtures never hit the WS channel). */
import { parseArgs } from "node:util";
import { buildF402PendingRollup } from "../lib/f402_pending_rollup.ts";
import { createF402PendingSink } from "../lib/f402_pending_sink.ts";
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", default: "tests/f402-pending-wager-sample.json" },
    "source-kind": { type: "string", default: "fixture" },
    live: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "no-r2": { type: "boolean", default: false },
    "no-ws": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: bun run bridge3b:rollup [--from path] [--source-kind fixture|capture] [--live] [--dry-run] [--no-r2] [--no-ws]",
  );
  process.exit(0);
}
const rollup = await buildF402PendingRollup(values.from as string, {
  sourceKind: values["source-kind"] as string,
  live: values.live,
});
const gates = rollup.gates.map((g) => `GATE-0${g.gate}:${g.status}`).join(" ");
console.error(
  `[bridge3b] rows=${rollup.rowCount} tickets=${rollup.ticketCount} cells=${rollup.cells.length} suppressed=${rollup.suppressed.cellCount} deskDate=${rollup.deskDate} provenance=${rollup.provenance.sourceKind} ${gates}`,
);
if (values["dry-run"]) {
  console.log(JSON.stringify(rollup, null, 2));
  process.exit(0);
}
if (values["no-r2"] && values["no-ws"]) process.exit(0);
const sink = createF402PendingSink({
  liveBets: !values["no-ws"],
  r2: !values["no-r2"],
});
const ws = await sink.publishLiveBets(rollup);
const r2 = await sink.publishR2(rollup);
const publicStatus =
  r2.url === undefined
    ? null
    : await fetch(r2.url)
        .then((r) => r.status)
        .catch(() => -1);
console.log(
  JSON.stringify(
    {
      deskDate: rollup.deskDate,
      provenance: rollup.provenance,
      ws,
      r2,
      publicStatus,
    },
    null,
    2,
  ),
);
