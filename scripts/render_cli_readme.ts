#!/usr/bin/env bun
/**
 * @file scripts/render_cli_readme.ts
 * @description Write or check the generated `bun x` catalog in `cli/README.md`.
 *
 *   bun run cli:readme          # rewrite the marker-delimited table
 *   bun run cli:readme:check    # fail when the committed table is stale
 *
 * The rows derive from root `package.json` `bin`/`scripts` plus each target's header comment;
 * `lib/cli_catalog.ts` owns the derivation so the verifier and tests share it.
 */

import { resolve } from "node:path";
import {
  CLI_README_BEGIN,
  CLI_README_END,
  renderCliReadmeCatalog,
} from "../lib/cli_catalog.ts";

const HELP = `
render_cli_readme — generated bun x catalog for cli/README.md

Usage:
  bun run cli:readme          rewrite the table
  bun run cli:readme:check    fail if it is stale
  -h, --help                  this text

Markers: ${CLI_README_BEGIN} … ${CLI_README_END}
`.trim();

const args = Bun.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const root = resolve(import.meta.dir, "..");
const readmePath = resolve(root, "cli/README.md");
const current = await Bun.file(readmePath).text();
const next = await renderCliReadmeCatalog(root, current);
const write = args.includes("--write");

if (next === current) {
  console.log("cli/README.md catalog fresh");
  process.exit(0);
}
if (write) {
  await Bun.write(readmePath, next);
  console.log("cli/README.md catalog written");
  process.exit(0);
}
console.error(
  "cli/README.md catalog is stale; run `bun run cli:readme` and commit the result",
);
process.exit(1);
