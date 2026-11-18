#!/usr/bin/env bun
/**
 * @file scripts/verify_ci_gates.ts
 * @description Deterministic pre-install CI gate over the repository's package-manager,
 * credential and artifact invariants. Read-only: it never installs, writes or fetches.
 *
 * Usage:
 *   bun ./scripts/verify_ci_gates.ts
 *   bun ./scripts/verify_ci_gates.ts --json
 *   bun ./scripts/verify_ci_gates.ts --audit-bun-failclosed [--json]
 *
 * Exit codes: 0 every rule passed, 1 at least one rule failed, 2 usage error.
 *
 * The rules live in `scripts/bun_native_rules.ts` so the same checks can be imported by a
 * test or a CI step without spawning this CLI. `--audit-bun-failclosed` is opt-in JSON
 * telemetry: it spawns the TypeScript-aware fail-closed Bun surface audit, reports its
 * summary, and fails the gate when the audit exits non-zero. The default path stays fast
 * and does not require the audit's TypeScript program.
 */

import path from "node:path";
import { runAllRules, type RuleResult } from "./bun_native_rules.ts";

const root = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const auditBunFailclosed = args.includes("--audit-bun-failclosed");
const allowedArgs = new Set(["--json", "--audit-bun-failclosed"]);

if (args.some((arg) => !allowedArgs.has(arg))) {
  console.error(
    "usage: bun ./scripts/verify_ci_gates.ts [--json] [--audit-bun-failclosed]",
  );
  process.exit(2);
}

interface AuditReport {
  readonly scannedFiles?: number;
  readonly elapsedMs?: number;
  readonly errorCount?: number;
  readonly warnCount?: number;
  readonly findings?: readonly unknown[];
}

interface AuditTelemetryResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly telemetry: AuditReport | null;
}

function runBunFailclosedAudit(): AuditTelemetryResult {
  try {
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "scripts/audit_bun_failclosed_edges.ts",
        "--json",
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString().trim();
    const report = JSON.parse(stdout) as AuditReport;
    const errors = report.errorCount ?? 0;
    const warns = report.warnCount ?? 0;
    const scanned = report.scannedFiles ?? 0;
    const ok = proc.exitCode === 0 && errors === 0;
    return {
      ok,
      detail: `scanned ${scanned} files; ${errors} error(s), ${warns} warning(s)${
        ok
          ? ""
          : ` — exit ${String(proc.exitCode)}${stderr === "" ? "" : `: ${stderr}`}`
      }`,
      telemetry: report,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      telemetry: null,
    };
  }
}

const results: readonly RuleResult[] = runAllRules(root);
const audit = auditBunFailclosed ? runBunFailclosedAudit() : null;
const failed = results.filter((rule) => !rule.ok);
const ok = failed.length === 0 && (audit?.ok ?? true);

if (json) {
  console.log(
    JSON.stringify(
      {
        ok,
        checkedAt: new Date().toISOString(),
        root,
        rules: results,
        ...(audit === null
          ? {}
          : {
              telemetry: {
                bunFailClosed: audit.telemetry,
                detail: audit.detail,
                ok: audit.ok,
              },
            }),
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
  if (audit !== null) {
    const mark = audit.ok ? "✓" : "✗";
    console.log(`${mark} ${"bun-failclosed".padEnd(36)} ${audit.detail}`);
  }
  console.log("");
  if (ok) {
    console.log(
      `verify_ci_gates: ok — ${results.length} rule(s) passed${
        audit === null ? "" : " + bun-failclosed"
      }`,
    );
  } else {
    console.error(
      `verify_ci_gates: ${failed.length}/${results.length} rule(s) failed${
        audit !== null && !audit.ok ? " + bun-failclosed" : ""
      }`,
    );
  }
}

process.exit(ok ? 0 : 1);
