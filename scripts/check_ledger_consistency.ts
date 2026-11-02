#!/usr/bin/env bun
/**
 * Fail when docs/evidence/ledger.json disagrees with itself or with docs/openapi.json.
 *
 * The ledger is the SSOT the docs gate trusts, so a stale number inside it is load-bearing
 * prose. This reports; it never rewrites. Fix the row or the prose, then re-run.
 *
 *   bun run scripts/check_ledger_consistency.ts
 */

import { resolve } from "node:path";
import { auditLedger } from "../lib/ledger_consistency.ts";
import { loadManifestIndex } from "./apply_captures.ts";

const root = resolve(import.meta.dir, "..");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

const ledgerPath = resolve(root, "docs/evidence/ledger.json");
const specPath = resolve(root, "docs/openapi.json");

const ledger = await readJson(ledgerPath);
const spec = await readJson(specPath).catch(() => undefined);

// The capture store decides whether a `capture:` citation resolves; loadManifestIndex already
// recomputes every captureHash from the record, so a stale manifest cannot vouch for itself.
const manifest = await loadManifestIndex(
  resolve(root, "docs/evidence/captures"),
);
const issues = auditLedger(ledger, spec, {
  root,
  captureFiles: new Set(manifest.hashes.keys()),
});
if (issues.length === 0) {
  console.log("check:ledger-consistency: ok docs/evidence/ledger.json");
  process.exit(0);
}

console.error(
  `check:ledger-consistency: ${issues.length} issue(s) in docs/evidence/ledger.json`,
);
for (const issue of issues) console.error(`  [${issue.code}] ${issue.message}`);
process.exit(1);
