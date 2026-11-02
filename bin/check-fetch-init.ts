#!/usr/bin/env bun
/**
 * Repository RequestInit source gate, executed by Bun.
 * Enforces RequestInit & fetch invariants across source files:
 * 1. No lowercase HTTP method literals in fetch/Request options (method: "post", etc.)
 * 2. No BufferSource bodies without an explicit Content-Type in request init
 * 3. No plain-object literals passed directly to body (WebIDL coerces to [object Object])
 * 4. No URL-embedded credentials (http(s)://user:pass@host) in production code/config
 *
 * Allowlist:
 * - Test files (*.test.ts, *.test.js, test/**, tests/**) are exempt.
 * - Proxy documentation and fixtures (bun-fetch-proxy) are exempt for example strings.
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
];

const FETCH_CALL_RE = /\bfetch\s*\(/g;
const METHOD_LOWERCASE_RE =
  /\bmethod\s*:\s*["'](delete|get|head|options|post|put|patch)["']/;
const URL_CREDENTIALS_RE = /https?:\/\/[^"'\s/:]+:[^"'\s/@]+@[^"'\s/]+/;
const OBJECT_BODY_PROPERTY_RE =
  /(?<!let\s)(?<!const\s)(?<!var\s)(?<!interface\s)(?<!type\s)\bbody\s*:\s*\{[^}]*\}/;
const BUFFER_BODY_RE =
  /\bbody\s*:\s*(?:new\s+(?:Uint8Array|ArrayBuffer|DataView)|Buffer\.from)/;

function isTestOrDoc(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return (
    norm.endsWith(".test.ts") ||
    norm.endsWith(".test.js") ||
    norm.includes("/tests/") ||
    norm.includes("/test/") ||
    norm.includes("/fixtures/") ||
    norm.includes("bun-fetch-proxy") ||
    norm.includes("/docs/")
  );
}

interface AuditResult {
  readonly violations: string[];
  readonly fetchCount: number;
}

function auditContent(content: string, relPath: string): AuditResult {
  const fetchMatches = content.match(FETCH_CALL_RE) || [];
  const fetchCount = fetchMatches.length;

  if (isTestOrDoc(relPath)) {
    return { violations: [], fetchCount };
  }

  const violations: string[] = [];
  const lines = content.split("\n");
  // `body: {...}` is only a request body where requests are built; elsewhere it is any object
  // key, e.g. a `parseArgs` option spec `body: { type: "string" }`.
  const buildsRequests =
    fetchCount > 0 || /\bnew\s+Request\s*\(|\bRequestInit\b/.test(content);

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) {
      continue;
    }

    // 1. Lowercase method literal in request options
    const methodMatch = line.match(METHOD_LOWERCASE_RE);
    if (methodMatch) {
      violations.push(
        `Line ${idx + 1}: Lowercase HTTP method '${methodMatch[1]}' in request options. Use explicit uppercase.`,
      );
    }

    // 2. URL credentials in production code
    const credMatch = line.match(URL_CREDENTIALS_RE);
    if (credMatch) {
      violations.push(
        `Line ${idx + 1}: URL-embedded credentials found ('${credMatch[0]}'). Use explicit Authorization headers.`,
      );
    }

    // 3. BufferSource without Content-Type
    if (BUFFER_BODY_RE.test(line)) {
      const start = Math.max(0, idx - 4);
      const end = Math.min(lines.length, idx + 4);
      const block = lines
        .slice(start, end)
        .filter(
          (candidate) =>
            !candidate.trim().startsWith("//") &&
            !candidate.trim().startsWith("*"),
        )
        .join("\n")
        .toLowerCase();
      if (!block.includes("content-type")) {
        violations.push(
          `Line ${idx + 1}: BufferSource body without explicit Content-Type in request init.`,
        );
      }
    }

    // 4. Plain object body in fetch init
    if (buildsRequests && OBJECT_BODY_PROPERTY_RE.test(line)) {
      if (
        !stripped.endsWith(";") &&
        !line.toLowerCase().includes("json.stringify") &&
        !line.includes("type ") &&
        !line.includes("let ")
      ) {
        violations.push(
          `Line ${idx + 1}: Plain object literal passed to body (WebIDL coerces to [object Object]).`,
        );
      }
    }
  }

  return { violations, fetchCount };
}

async function main(): Promise<void> {
  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs}");
  let scannedCount = 0;
  let totalFetchCalls = 0;
  let filesWithFetch = 0;
  let totalViolations = 0;

  for await (const file of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    const norm = `/${file.replace(/\\/g, "/")}`;
    if (IGNORE_SUBSTRINGS.some((ig) => norm.includes(ig))) {
      continue;
    }

    scannedCount++;
    const fullPath = path.join(ROOT, file);
    const content = await Bun.file(fullPath).text();
    const { violations, fetchCount } = auditContent(content, file);

    totalFetchCalls += fetchCount;
    if (fetchCount > 0) {
      filesWithFetch++;
      if (isVerbose) {
        console.log(
          `INFO: ${file} contains ${fetchCount} fetch() call site(s)`,
        );
      }
    }

    if (violations.length > 0) {
      console.log(`FAIL: ${file}`);
      for (const err of violations) {
        console.log(`  - ${err}`);
      }
      totalViolations += violations.length;
    }
  }

  if (totalViolations === 0) {
    console.log(
      `PASS: ${scannedCount} files scanned across ${ROOT}. Inspected ${totalFetchCalls} fetch() call site(s) across ${filesWithFetch} files. Zero RequestInit violations found.`,
    );
    process.exitCode = 0;
  } else {
    console.error(
      `FAILED: ${totalViolations} RequestInit violation(s) across codebase (${totalFetchCalls} fetch calls inspected).`,
    );
    process.exitCode = 1;
  }
}

await main();
