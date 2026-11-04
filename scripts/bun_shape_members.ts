#!/usr/bin/env bun
/**
 * @file scripts/bun_shape_members.ts
 * @description Snapshot the member surface of every non-volatile object/function
 * shape in `lib/bun_shapes.ts`, so a Bun upgrade that adds or removes a member is a
 * reviewed diff rather than a silent surface change.
 *
 *   bun scripts/bun_shape_members.ts --baseline tests/bun_shape_members.json
 *   bun scripts/bun_shape_members.ts --check tests/bun_shape_members.json
 *
 * Own names plus the prototype chain, minus function internals — the same walk
 * `bin/bun_types.ts` uses for declaration drift. Volatile shapes (environment and
 * argv containers) are excluded: their members depend on the caller.
 */

import { resolve } from "node:path";
import {
  BUN_SHAPES,
  BUN_SHAPE_PINS,
  VOLATILE_SHAPES,
  surfaceMembers,
} from "../lib/bun_shapes.ts";

const USAGE = `usage: bun scripts/bun_shape_members.ts [--baseline <file> | --check <file>]`;

function shapeMembers(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const shape of BUN_SHAPES) {
    if (shape.kind !== "value" || VOLATILE_SHAPES.has(shape.name)) continue;
    const value = (Bun as unknown as Record<string, unknown>)[shape.name];
    if (typeof value !== "object" && typeof value !== "function") continue;
    out[shape.name] = surfaceMembers(value);
  }
  return out;
}

const args = process.argv.slice(2);
const modeIndex = args.findIndex((a) => a === "--baseline" || a === "--check");
if (modeIndex < 0 || args[modeIndex + 1] === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const mode = args[modeIndex] as "--baseline" | "--check";
const file = resolve(args[modeIndex + 1] as string);
const current = shapeMembers();

if (mode === "--baseline") {
  await Bun.write(
    file,
    `${JSON.stringify(
      {
        note: "Bun shape member surface — regenerate with bun scripts/bun_shape_members.ts --baseline",
        bunVersion: BUN_SHAPE_PINS.bunVersion,
        bunCommit: BUN_SHAPE_PINS.bunCommit,
        shapes: current,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `wrote ${Object.keys(current).length} shape member sets to ${file}`,
  );
  process.exit(0);
}

const baseline = (await Bun.file(file).json()) as {
  bunVersion?: string;
  shapes: Record<string, string[]>;
};
let drift = 0;
for (const [name, members] of Object.entries(baseline.shapes)) {
  const now = current[name];
  if (now === undefined) {
    console.log(`MISSING ${name} — the shape no longer has a member surface`);
    drift++;
    continue;
  }
  const added = now.filter((m) => !members.includes(m));
  const removed = members.filter((m) => !now.includes(m));
  if (added.length === 0 && removed.length === 0) continue;
  drift++;
  console.log(`DIFF    ${name}`);
  if (added.length > 0) console.log(`  added:   ${added.join(", ")}`);
  if (removed.length > 0) console.log(`  removed: ${removed.join(", ")}`);
}
for (const name of Object.keys(current)) {
  if (baseline.shapes[name] === undefined) {
    console.log(`NEW     ${name} — not in the baseline`);
    drift++;
  }
}
console.log(
  `${drift} member-surface drift(s) against ${baseline.bunVersion ?? "unknown Bun"}`,
);
process.exit(drift === 0 ? 0 : 1);
