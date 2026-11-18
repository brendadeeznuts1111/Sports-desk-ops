#!/usr/bin/env bun
/**
 * @file scripts/customer_lookup.ts
 * @description Index the customer records we already have and look them up.
 *
 *   bun run customers index
 *   bun run customers list --source artifact
 *   bun run customers find RF2003
 *   bun run customers search FAKE
 *   bun run customers find RF2003 --env      # print F402_CUSTOMER_ID=... for a probe
 *
 * Sources are demo cohorts, not live portal data. `--env` prints the export line, but a demo id is
 * rejected by the live report endpoints; only a `capture` source would be live, and none exist yet.
 */

import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  type CustomerRecord,
  type CustomerSource,
  countBySource,
  ensureCustomerSchema,
  findCustomer,
  listCustomers,
  openCustomerIndex,
  searchCustomers,
  upsertCustomers,
} from "../lib/customer_index.ts";
import {
  liveWagerCustomerId,
  liveWagerRows,
} from "../lib/customer_source_rows.ts";
import { createDod6V54LifetimeReader } from "../lib/dod6_v54_lifetime_reader.ts";

const HELP = `
customers — index and look up customer records

Usage:
  bun run customers index            Load known sources into the index
  bun run customers list             List indexed customers
  bun run customers find <id>        Exact lookup
  bun run customers search <text>    Substring match on id, agent or name

Options:
  --db <path>        SQLite file (default: scratch/customers.sqlite)
  --source <name>    artifact | demo-book | fixture | capture
  --limit <n>        Max rows (default 20)
  --json             Machine-readable output
  --env              Print F402_CUSTOMER_ID=<id> for the first match
  -h, --help         This text

Examples:
  bun run customers index
  bun run customers list --source artifact --limit 5
  bun run customers find BGD101 --env
  bun run customers search BIGDAD

Sources are demo cohorts (artifact/demo-book) or synthetic fixtures. None are live portal ids; the
report endpoints answer "Invalid CustomerID" for them. A capture source appears only when a capture
keeps a real id.
`.trim();

const VALUE_FLAGS = ["--db", "--source", "--limit"] as const;
const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: VALUE_FLAGS });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const command = parsed.positionals[0] ?? "list";
const dbPath = flagValue(parsed, "--db", "scratch/customers.sqlite");
const sourceArg = flagValue(parsed, "--source", "");
const limit = Number(flagValue(parsed, "--limit", "20")) || 20;
const json = hasFlag(parsed, "--json");
const asEnv = hasFlag(parsed, "--env");
const now = new Date().toISOString();

const db = openCustomerIndex(`sqlite://${dbPath}`);
try {
  await ensureCustomerSchema(db);

  if (command === "index") {
    const records: CustomerRecord[] = [];

    const artifact = Bun.file("docs/backtest-4wk-cfb-nba.json");
    if (await artifact.exists()) {
      const report = (await artifact.json()) as {
        customerLeaderboard?: Array<Record<string, unknown>>;
      };
      for (const row of report.customerLeaderboard ?? []) {
        const id = row["customerId"];
        if (typeof id !== "string" || id === "") continue;
        const agent = row["agentId"];
        const name = row["name"] ?? row["customerName"];
        records.push({
          id,
          source: "artifact",
          agent: typeof agent === "string" ? agent : "",
          name: typeof name === "string" ? name : "",
          updatedAt: now,
        });
      }
    }

    for (const [path, source] of [
      ["enriched_customers_full.json", "demo-book"],
      ["tests/fixtures/backtest/enriched_customers_full.json", "fixture"],
    ] as const) {
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const rows = (await file.json()) as Array<Record<string, unknown>>;
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = row["customer_id"] ?? row["customerId"];
        if (typeof id !== "string" || id === "") continue;
        const agent = row["agent_id"] ?? row["agentId"];
        const name = row["name"] ?? row["customer_name"];
        records.push({
          id,
          source,
          agent: typeof agent === "string" ? agent : "",
          name: typeof name === "string" ? name : "",
          updatedAt: now,
        });
      }
    }

    // Open wagers capture: the capture writes { LIST }, and the helper also reads a bare array.
    const liveWagersFile = Bun.file("data/live-wagers.json");
    if (await liveWagersFile.exists()) {
      try {
        for (const row of liveWagerRows(await liveWagersFile.json())) {
          const id = liveWagerCustomerId(row);
          if (id === null) continue;
          const agent = String(
            row["AgentID"] ?? row["AgentLogin"] ?? "",
          ).trim();
          const desc = String(row["ShortDesc"] ?? "").trim();
          records.push({
            id,
            source: "live",
            agent,
            name: desc === "" ? "" : `Wager: ${desc}`,
            updatedAt: now,
          });
        }
      } catch {
        // signal honesty: an unreadable capture indexes no live rows
      }
    }

    // Live harvested profiles
    const liveProfilesFile = Bun.file("reports/harvested-live-profiles.json");
    if (await liveProfilesFile.exists()) {
      try {
        const payload = (await liveProfilesFile.json()) as {
          profiles?: Array<Record<string, unknown>>;
        };
        for (const row of payload.profiles ?? []) {
          const id = String(row["id"] ?? "").trim();
          if (!id) continue;
          const agent = String(row["agentId"] ?? "").trim();
          const score = row["score"];
          const tier = row["tier"];
          records.push({
            id,
            source: "live",
            agent,
            name: score !== undefined ? `Live Score: ${score} (${tier})` : "",
            updatedAt: now,
          });
        }
      } catch {
        // signal honesty: unreadable harvested profiles index no live rows
      }
    }

    const written = await upsertCustomers(db, records);
    const counts = await countBySource(db);
    console.error(
      `customers: indexed ${written} record(s) into ${dbPath}: ${counts
        .map((row) => `${row.source}=${row.count}`)
        .join(" ")}`,
    );
  } else if (command === "list") {
    const source = sourceArg === "" ? undefined : (sourceArg as CustomerSource);
    const rows = await listCustomers(db, {
      limit,
      ...(source === undefined ? {} : { source }),
    });
    render(rows, json, asEnv);
  } else if (command === "find" || command === "search") {
    const needle = parsed.positionals[1] ?? "";
    if (needle === "") {
      console.error(`customers: ${command} needs a value.`);
      console.error("  bun run customers find BGD101");
      process.exit(2);
    }
    const rows =
      command === "find"
        ? await findCustomer(db, needle)
        : await searchCustomers(db, needle, limit);

    let displayRows = rows;
    if (rows.length === 0 && command === "find") {
      const reader = await createDod6V54LifetimeReader(
        "data/sportsdesk_unified_baseline_v54.dodbin",
      );
      const dodMatch = reader?.lookup(needle);
      if (dodMatch) {
        const net = dodMatch.lifetimeNetUsd;
        const netStr =
          net === null
            ? "N/A"
            : `${net < 0 ? "-" : ""}$${Math.abs(net).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        // A null CLV and a zero-leg spine row are unmeasured, never "+0 bps" or a failed gate.
        const clv = dodMatch.clvBps;
        const clvStr = clv === null ? "n/a" : `${clv >= 0 ? "+" : ""}${clv}bps`;
        const gate =
          dodMatch.clvLegs === 0
            ? "n/a (no measured legs)"
            : dodMatch.sharpCandidateGatePassed
              ? "PASS"
              : "FAIL";
        displayRows = [
          {
            id: needle.toUpperCase(),
            source: "dod6-spine",
            agent: `CLV:${clvStr}`,
            name: `Lifetime Net:${netStr} (${dodMatch.clvLegs} legs, SharpGate:${gate})`,
            updatedAt: new Date().toISOString(),
          },
        ];
      }
    }

    render(displayRows, json, asEnv);
  } else {
    console.error(
      `customers: unknown command "${command}" (index|list|find|search).`,
    );
    console.error("  bun run customers index");
    process.exit(2);
  }
} finally {
  await db.close();
}

function render(
  rows: readonly CustomerRecord[],
  asJson: boolean,
  env: boolean,
): void {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.error("customers: no match. Run `bun run customers index` first.");
    return;
  }
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(12)} ${row.source.padEnd(10)} ${row.agent.padEnd(14)} ${row.name}`.trimEnd(),
    );
  }
  if (env) console.log(`F402_CUSTOMER_ID=${rows[0]!.id}`);
}
