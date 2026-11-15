#!/usr/bin/env bun
/**
 * @file scripts/verify_ci_gates.ts
 * @description Deterministic pre-install CI gate over the repository's package-manager,
 * credential and artifact invariants. Read-only: it never installs, writes or fetches.
 *
 * Usage:
 *   bun ./scripts/verify_ci_gates.ts
 *   bun ./scripts/verify_ci_gates.ts --json
 *
 * Exit codes: 0 every rule passed, 1 at least one rule failed, 2 usage error.
 *
 * The rules live in `scripts/bun_native_rules.ts` so the same checks can be imported by a
 * test or a CI step without spawning this CLI.
 */

import path from "node:path";
import { runAllRules, type RuleResult } from "./bun_native_rules.ts";

const root = path.resolve(import.meta.dir, "..");
const json = process.argv.includes("--json");

if (process.argv.slice(2).some((arg) => arg !== "--json")) {
  console.error("usage: bun ./scripts/verify_ci_gates.ts [--json]");
  process.exit(2);
}

const results: readonly RuleResult[] = runAllRules(root);
const failed = results.filter((rule) => !rule.ok);

if (json) {
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        checkedAt: new Date().toISOString(),
        root,
        rules: results,
      },
      null,
      2,
    ),
  );
} else {
  for (const rule of results) {
    const mark = rule.ok ? "✓" : "✗";
    console.log(`${mark} ${rule.id.padEnd(36)} ${rule.detail}`);
  }
  console.log("");
  if (failed.length === 0) {
    console.log(`verify_ci_gates: ok — ${results.length} rule(s) passed`);
  } else {
    console.error(
      `verify_ci_gates: ${failed.length}/${results.length} rule(s) failed`,
    );
  }
}

process.exit(failed.length === 0 ? 0 : 1);
