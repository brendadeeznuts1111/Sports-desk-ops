#!/usr/bin/env bun
/** Bridge 3b CLI: fixture/live pending rows → sanitized rollup → R2 (fixtures never hit the WS channel). */
import { parseArgs } from "node:util";
import { buildF402PendingRollup } from "../lib/f402_pending_rollup.ts";
import {
  defaultPendingDate,
  fetchAndPersistPending,
  f402TokenExpiresAtMs,
  fetchAndPersistReportPending,
  renewF402BearerToken,
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
    customers: { type: "string" },
    "customers-file": { type: "string" },
    "allow-partial": { type: "boolean", default: false },
    "allow-legacy-manager": { type: "boolean", default: false },
    "max-concurrency": { type: "string" },
    "max-retries": { type: "string" },
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
    "Usage: bun run bridge3b:rollup [--from path] [--from-file path] [--source-kind fixture|capture] [--bearer-token token] [--date YYYY-MM-DD] [--save-capture path] [--customers id,id | --customers-file path] [--allow-partial] [--allow-legacy-manager] [--max-concurrency 1-16] [--max-retries n] [--live] [--dry-run] [--no-r2] [--no-ws]",
  );
  process.exit(0);
}
const threeC =
  values["three-c-rollup"] === undefined
    ? null
    : (JSON.parse(
        await Bun.file(values["three-c-rollup"] as string).text(),
      ) as { kind?: string; totals?: { openExposureCents?: number } });
if (
  threeC !== null &&
  (threeC.kind !== "gslive-tally" ||
    typeof threeC.totals?.openExposureCents !== "number")
) {
  throw new Error(
    "--three-c-rollup must be a gslive-tally rollup with totals.openExposureCents",
  );
}
function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  flag: string,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(
      `bridge3b: ${flag} must be an integer ${min}..${max} (got ${JSON.stringify(raw)})`,
    );
    process.exit(2);
  }
  return value;
}

/** Explicit customer list for the verified Report/Pending bearer path (no enumeration). */
async function resolveCustomerIds(): Promise<string[] | null> {
  const split = (text: string): string[] =>
    text
      .split(/[,\n\r]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  const cli = (values.customers ?? "").trim();
  if (cli !== "") return split(cli);
  const file =
    (values["customers-file"] ?? "").trim() ||
    (Bun.env.F402_PENDING_CUSTOMERS_FILE ?? "").trim();
  if (file !== "") {
    const text = await Bun.file(file).text();
    const ids = split(text);
    if (ids.length === 0) {
      throw new Error(`--customers-file ${file} contains no customer ids`);
    }
    return ids;
  }
  const envList = (Bun.env.F402_PENDING_CUSTOMERS ?? "").trim();
  return envList === "" ? null : split(envList);
}

const customerIds = await resolveCustomerIds();
const fetchRequested =
  values["bearer-token"] !== undefined ||
  (Bun.env.F402_BEARER_TOKEN ?? "").trim() !== "" ||
  (Bun.env.F402_TOKEN_FILE ?? "").trim() !== "";
let fromPath = (values["from-file"] ?? values.from) as string;
let sourceKindOverride = values["source-kind"] as string | undefined;
if (
  fetchRequested &&
  customerIds === null &&
  values["allow-legacy-manager"] !== true
) {
  console.error(
    "bridge3b: a bearer fetch needs an explicit customer list — Report/Pending is customer-scoped, and Manager/getPending is dead (500 for every captured shape).",
  );
  console.error(
    "  pass --customers id,id / --customers-file <path>, or set F402_PENDING_CUSTOMERS.",
  );
  console.error(
    "  --allow-legacy-manager keeps the old Manager/getPending request for historical reproduction only.",
  );
  process.exit(2);
}

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
      `Scratch/f402-pending/capture-${date}.json`);
  if (customerIds !== null) {
    const maxConcurrency = boundedInt(
      values["max-concurrency"] as string | undefined,
      6,
      1,
      16,
      "--max-concurrency",
    );
    const maxRetries = boundedInt(
      values["max-retries"] as string | undefined,
      2,
      0,
      6,
      "--max-retries",
    );
    const expiresAtMs = f402TokenExpiresAtMs(token);
    const fetched = await fetchAndPersistReportPending({
      token,
      customerIds,
      capturePath,
      onCustomerFailure: values["allow-partial"] ? "skip" : "throw",
      maxConcurrency,
      concurrency: maxConcurrency,
      maxRetries,
      expiresAtMs,
      refreshToken: async (current) => {
        const renewed = await renewF402BearerToken({ token: current });
        console.error(
          `[bridge3b] bearer refreshed (expires ${renewed.expiresAtIso ?? "unknown"})`,
        );
        return { token: renewed.token, expiresAtMs: renewed.expiresAtMs };
      },
    });
    console.error(
      `[bridge3b] Report/Pending: ${fetched.rows.length} legs across ${fetched.okCount}/${customerIds.length} customer(s) for ${date} (concurrency=${String(values["max-concurrency"] ?? "6")}) -> ${capturePath}`,
    );
    if (fetched.failedCount > 0) {
      console.error(
        `[bridge3b] WARNING: ${fetched.failedCount} customer request(s) failed (--allow-partial); the rollup is incomplete`,
      );
    }
  } else {
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
  }
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
