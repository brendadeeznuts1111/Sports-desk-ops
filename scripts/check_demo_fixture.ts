#!/usr/bin/env bun
/**
 * @file scripts/check_demo_fixture.ts
 * @description Policy gate for the tracked demo fixture.
 *
 * The dashboard's demo surface is four synthetic customers. The invariant that keeps it honest is
 * not enforced at runtime — the rows are committed, so the reviewable diff is the first check. This
 * is the second: every id is SYNTH_*, only permitted keys appear, and the row count equals the
 * constant the copy interpolates.
 *
 * Permitted-keys-only rather than a forbidden list (#283): a denylist drifts, and fails open the
 * moment a row grows a field nobody thought to name. Adding a field to the demo must be a decision
 * made here, in code, next to the reason.
 */

import { readFileSync } from "node:fs";

import {
  DEMO_CUSTOMERS,
  DEMO_CUSTOMER_COUNT,
} from "../packages/ui/src/data/demo_customers.ts";

const FIXTURE = "packages/ui/src/data/demo-customers.json";

/** The only keys a demo row may carry. Anything else fails closed. */
const PERMITTED_KEYS: ReadonlySet<string> = new Set([
  "customer_id",
  "agent_id",
  "status",
  "wager_limit_usd",
  "delay_seconds",
  "clv_bps",
  "sharp_score",
  "hold_pct",
  "lifetime_volume_usd",
  "lifetime_net_usd",
]);

function fail(message: string): never {
  console.error(`check_demo_fixture: ${message}`);
  process.exit(1);
}

function main(): void {
  const rows = JSON.parse(readFileSync(FIXTURE, "utf8")) as Array<
    Record<string, unknown>
  >;
  const problems: string[] = [];

  if (rows.length !== DEMO_CUSTOMER_COUNT) {
    problems.push(
      `row count ${rows.length} != DEMO_CUSTOMER_COUNT ${DEMO_CUSTOMER_COUNT}`,
    );
  }
  if (DEMO_CUSTOMERS.length !== rows.length) {
    problems.push(
      `module exports ${DEMO_CUSTOMERS.length} rows but the fixture has ${rows.length}`,
    );
  }

  rows.forEach((row, index) => {
    const id = row["customer_id"];
    if (typeof id !== "string" || !id.startsWith("SYNTH_")) {
      problems.push(
        `row ${index}: customer_id ${JSON.stringify(id)} is not a SYNTH_* id`,
      );
    }
    for (const key of Object.keys(row)) {
      if (!PERMITTED_KEYS.has(key)) {
        problems.push(
          `row ${index} (${String(id)}): key "${key}" is not permitted`,
        );
      }
    }
  });

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    fail(`${problems.length} problem(s) in ${FIXTURE}`);
  }

  console.log(
    `check_demo_fixture: ok — ${rows.length} synthetic rows, permitted keys only, ` +
      `count matches DEMO_CUSTOMER_COUNT`,
  );
}

main();
