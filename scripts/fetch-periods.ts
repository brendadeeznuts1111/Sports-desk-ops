/** Inspect the period-taxonomy response from plive ajax.php.
 *
 *  Reads stdin (or a file) containing the JSON, extracts `periods[id]`,
 *  maps `periodNames[id]` → label, and prints a compact table:
 *    id | label | type | h1 | h2 | segments
 *
 *  Usage:
 *    bun run scripts/fetch-periods.ts < scratch/periods.json
 *    bun run scripts/fetch-periods.ts scratch/periods.json
 */

import { readFileSync } from "node:fs";

const input = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : await Bun.stdin.text();
const j = JSON.parse(input);
const periods: Record<
  string,
  { m: string; h1: string; h2: string; ht: string; [k: string]: unknown }
> = j.periods ?? j ?? {};
const periodNames: Record<string, string> = j.periodNames ?? {};
const abbreviations: Record<string, string> = j.abbreviations ?? {};

type Row = [string, string, string, string, string, string];
const rows: Row[] = [];

for (const [id, p] of Object.entries(periods)) {
  const segments: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const v = p[`s${i}` as const] as string | undefined;
    if (v && !segments.includes(v)) segments.push(v);
  }
  rows.push([
    id,
    periodNames[id] ?? abbreviations[id] ?? "",
    p.m ?? "",
    p.h1 ?? "",
    p.h2 ?? "",
    segments.join(", ") ?? "",
  ]);
}

rows.sort((a, b) => Number(a[0]) - Number(b[0]));

const w = rows.reduce((m, r) => Math.max(m, r[0].length), 2);
const labelW = rows.reduce((m, r) => Math.max(m, r[1].length), 5);
const typeW = rows.reduce((m, r) => Math.max(m, r[2].length), 4);

console.log(`periods: ${rows.length}`);
console.log(
  "id".padEnd(w),
  "label".padEnd(labelW),
  "type".padEnd(typeW),
  "h1".padEnd(12),
  "h2".padEnd(12),
  "segments",
);
console.log("-".repeat(w + labelW + typeW + 30));
for (const [id, label, type, h1, h2, segs] of rows) {
  console.log(
    id.padEnd(w),
    label.padEnd(labelW),
    type.padEnd(typeW),
    h1.padEnd(12),
    h2.padEnd(12),
    segs,
  );
}
