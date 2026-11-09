#!/usr/bin/env bun
/**
 * Native Bun Lint Rule: check-signal-honesty
 * Enforces Signal Honesty invariants (docs/architecture/signal-honesty.md):
 *
 * 1. Banned generic error throws:
 *    - throw new Error("failed")
 *    - throw new Error("error")
 *    - throw new Error("fail")
 *    - throw new Error("unknown")
 *    - throw new Error("unexpected error")
 *    - throw new Error("something went wrong")
 *    - Error messages must name the specific subsystem, file, URL, or cause.
 *
 * 2. Banned silent catches:
 *    - catch (e) { return []; } or catch { return []; }
 *    - catch (e) { return null; } or catch { return null; }
 *    - Catch blocks must log, re-throw, or annotate with `// signal-honesty: intentional-...`
 *
 * Allowlist:
 * - Test files (*.test.ts, *.test.js, tests/**, test/**, fixtures/**) are exempt.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { listSourceFiles } from "../lib/source_files.ts";

const { values, positionals } = parseArgs({
  options: { verbose: { type: "boolean", default: false } },
  allowPositionals: true,
});

const ROOT = path.resolve(positionals[0] ?? path.join(import.meta.dir, ".."));
const isVerbose = values.verbose;

const BANNED_GENERIC_THROW_RE =
  /\bthrow\s+new\s+(?:Error|TypeError|RangeError)\s*\(\s*["'`]\s*(?:failed|error|fail|unknown|unexpected error|something went wrong|request failed)\s*["'`]\s*\)/i;

const SILENT_CATCH_RETURN_EMPTY_RE =
  /\bcatch\s*(?:\([^)]*\))?\s*\{\s*return\s+(?:\[\]|\{\}|null|undefined)\s*;\s*\}/;

function isTestOrDoc(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return (
    norm.endsWith(".test.ts") ||
    norm.endsWith(".test.js") ||
    norm.includes("/tests/") ||
    norm.includes("/test/") ||
    norm.includes("/fixtures/") ||
    norm.includes("/docs/")
  );
}

export function auditSignalHonesty(content: string, relPath: string): string[] {
  if (isTestOrDoc(relPath)) {
    return [];
  }

  const violations: string[] = [];
  const lines = content.split("\n");

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const stripped = line.trim();

    if (stripped.startsWith("//") || stripped.startsWith("*")) {
      continue;
    }
    if (stripped.includes("// signal-honesty: intentional-")) {
      continue;
    }

    // 1. Check generic error throw
    const throwMatch = stripped.match(BANNED_GENERIC_THROW_RE);
    if (throwMatch) {
      violations.push(
        `Line ${idx + 1}: Generic error throw '${throwMatch[0]}'. State the subsystem, URL, or pass { cause } per docs/architecture/signal-honesty.md.`,
      );
    }

    // 2. Check inline silent catch
    const silentCatchMatch = stripped.match(SILENT_CATCH_RETURN_EMPTY_RE);
    if (silentCatchMatch) {
      violations.push(
        `Line ${idx + 1}: Silent catch '${silentCatchMatch[0]}'. Must log, re-throw with context, or annotate with '// signal-honesty: intentional-<reason>'.`,
      );
    }
  }

  return violations;
}

async function main(): Promise<void> {
  let scannedCount = 0;
  let totalViolations = 0;

  for (const file of await listSourceFiles(ROOT, ["ts", "tsx", "js", "mjs"])) {
    if (file.includes("/verification/manager-boot-oracle/pinned/")) continue;
    scannedCount++;
    const fullPath = path.join(ROOT, file);
    const content = await Bun.file(fullPath).text();
    const violations = auditSignalHonesty(content, file);

    if (violations.length > 0) {
      console.log(`FAIL: ${file}`);
      for (const err of violations) {
        console.log(`  - ${err}`);
      }
      totalViolations += violations.length;
    } else if (isVerbose) {
      console.log(`PASS: ${file}`);
    }
  }

  if (totalViolations === 0) {
    console.log(
      `PASS: ${scannedCount} files scanned across ${ROOT}. Zero signal honesty violations.`,
    );
    process.exit(0);
  } else {
    console.error(
      `FAILED: ${totalViolations} signal honesty violation(s) found across codebase.`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
