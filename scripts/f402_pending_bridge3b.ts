#!/usr/bin/env bun
/** Bridge 3b CLI: fixture/live pending rows → sanitized rollup → R2 (fixtures never hit the WS channel). */
import { parseArgs } from "node:util";
import { buildF402PendingRollup } from "../lib/f402_pending_rollup.ts";
import {
  defaultPendingDate,
  fetchAndPersistPending,
  resolveF402BearerToken,
} from "../lib/f402_pending_fetch.ts";
import { createF402PendingSink } from "../lib/f402_pending_sink.ts";
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: {
      type: "string",
      default:
        Bun.env.F402_PENDING_CAPTURE_PATH ??
        "tests/f402-pending-wager-sample.json",
    },
    "from-file": { type: "string" },
    "source-kind": { type: "string" },
    "bearer-token": { type: "string" },
    date: { type: "string" },
    "agent-id": { type: "string" },
    "agent-owner": { type: "string" },
    "save-capture": { type: "string" },
    live: { type: "boolean", default: false },
    "three-c-rollup": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-r2": { type: "boolean", default: false },
    "no-ws": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: bun run bridge3b:rollup [--from path] [--from-file path] [--source-kind fixture|capture] [--bearer-token token] [--date YYYY-MM-DD] [--save-capture path] [--live] [--dry-run] [--no-r2] [--no-ws]",
  );
  process.exit(0);
}
const threeC =
  values["three-c-rollup"] === undefined
    ? null
    : ((await Bun.file(values["three-c-rollup"] as string).json()) as {
        kind?: string;
        totals?: { openExposureCents?: number };
      });
if (
  threeC !== null &&
  (threeC.kind !== "gslive-tally" ||
    typeof threeC.totals?.openExposureCents !== "number")
) {
  throw new Error(
    "--three-c-rollup must be a gslive-tally rollup with totals.openExposureCents",
  );
}
const fetchRequested =
  values["bearer-token"] !== undefined ||
  (Bun.env.F402_BEARER_TOKEN ?? "").trim() !== "" ||
  (Bun.env.F402_TOKEN_FILE ?? "").trim() !== "";
let fromPath = (values["from-file"] ?? values.from) as string;
let sourceKindOverride = values["source-kind"] as string | undefined;
if (fetchRequested) {
  const token = resolveF402BearerToken({
    cliToken: values["bearer-token"] as string | undefined,
  });
  const date = defaultPendingDate(
    new Date(),
    values.date as string | undefined,
  );
  const capturePath =
    (values["save-capture"] as string | undefined) ??
    ((Bun.env.F402_PENDING_CAPTURE_PATH ?? "").trim() ||
      `scratch/f402-pending/capture-${date}.json`);
  const fetched = await fetchAndPersistPending({
    token,
    date,
    ...(values["agent-id"] === undefined
      ? {}
      : { agentId: values["agent-id"] as string }),
    ...(values["agent-owner"] === undefined
      ? {}
      : { agentOwner: values["agent-owner"] as string }),
    capturePath,
  });
  console.error(
    `[bridge3b] fetched ${fetched.legs.length} pending legs for ${date} -> ${capturePath}`,
  );
  fromPath = capturePath;
  sourceKindOverride = "capture";
}
const sourceKind =
  sourceKindOverride ??
  (fromPath === "tests/f402-pending-wager-sample.json" ? "fixture" : "capture");
if (sourceKind === "fixture" && values["dry-run"] !== true) {
  console.error(
    "bridge3b: refusing to publish fixture data to R2/WS; pass a captured --from-file or --source-kind capture",
  );
  process.exit(2);
}
const rollup = await buildF402PendingRollup(fromPath, {
  sourceKind,
  live: values.live,
  ...(threeC === null
    ? {}
    : {
        gate8: {
          openExposureCents: threeC.totals?.openExposureCents as number,
        },
      }),
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
