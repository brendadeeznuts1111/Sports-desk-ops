#!/usr/bin/env bun
/**
 * Native Bun Lint Rule: no-unsafe-innerhtml
 * Enforces that `.innerHTML` is never assigned a non-literal expression or unescaped concatenation.
 *
 * Disallowed:
 *   element.innerHTML = variable
 *   element.innerHTML = `template ${variable}`
 *   element.innerHTML = a + b
 *
 * Allowed:
 *   element.innerHTML = "" (literal clearing)
 *   element.innerHTML = "constant static string"
 *   element.innerHTML = expr; // sanitized: <ticket-or-path> — <reason>
 */

import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: { verbose: { type: "boolean", default: false } },
  allowPositionals: true,
});
const ROOT = path.resolve(positionals[0] ?? path.join(import.meta.dir, ".."));
const isVerbose = values.verbose;

const IGNORE_SUBSTRINGS = [
  "/.git/",
  "/node_modules/",
  "/archive/",
  "/opencode/",
  "/vscode/",
  // The portal's own bundles, byte-pinned by SHA-256 in pinned/manifest.json: not ours to edit.
  "/verification/manager-boot-oracle/pinned/",
];

const INNER_HTML_ASSIGN_RE = /\.innerHTML\s*=\s*(.+?);?$/;
const SAFE_STATIC_LITERAL_RE = /^['"][^'"]*['"]$/;

function isTestFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return (
    norm.endsWith(".test.ts") ||
    norm.endsWith(".test.js") ||
    norm.includes("/tests/") ||
    norm.includes("/test/") ||
    norm.includes("/fixtures/")
  );
}

function auditFile(content: string, relPath: string): string[] {
  if (isTestFile(relPath)) {
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
    if (
      stripped.includes("// sanitized:") ||
      stripped.includes("/* sanitized:")
    ) {
      continue;
    }

    const match = stripped.match(INNER_HTML_ASSIGN_RE);
    if (match) {
      const rhs = match[1]!.trim().replace(/;$/, "");
      if (SAFE_STATIC_LITERAL_RE.test(rhs)) {
        continue;
      }
      violations.push(
        `Line ${idx + 1}: Unsafe innerHTML assignment with dynamic expression '${rhs}'. Use textContent or DOM creation.`,
      );
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs,html}");
  let scannedCount = 0;
  let totalViolations = 0;

  for await (const file of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    const norm = `/${file.replace(/\\/g, "/")}`;
    if (IGNORE_SUBSTRINGS.some((ig) => norm.includes(ig))) {
      continue;
    }

    scannedCount++;
    const fullPath = path.join(ROOT, file);
    const content = await Bun.file(fullPath).text();
    const violations = auditFile(content, file);

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
      `PASS: ${scannedCount} files scanned across ${ROOT}. Zero unsafe innerHTML assignments.`,
    );
    process.exit(0);
  } else {
    console.error(
      `FAILED: ${totalViolations} unsafe innerHTML violation(s) found across codebase.`,
    );
    process.exit(1);
  }
}

await main();
