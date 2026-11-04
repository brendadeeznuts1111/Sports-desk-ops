#!/usr/bin/env bun
/**
 * Data-driven schema extraction for graded wager rows.
 *
 * Reads a graded-wager HTML fixture and prints the sorted field names of the
 * resulting SoA, so the interface and lockstep tests can be regenerated from
 * real data instead of hand-maintained lists.
 *
 *   bun run scripts/extract_graded_wager_schema.ts tests/fixtures/f402-graded-wager-rows.html
 */
import { readFileSync } from "node:fs";

import { parseGradedWagerRowsSoA } from "../lib/f402_graded_wager_row.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: extract_graded_wager_schema <html-file>");
  process.exit(1);
}
const html = readFileSync(path, "utf8");
const soa = parseGradedWagerRowsSoA(html);
const fields = Object.keys(soa).sort();
console.log(JSON.stringify({ fieldCount: fields.length, fields }, null, 2));
