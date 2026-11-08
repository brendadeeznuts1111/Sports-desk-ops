#!/usr/bin/env bun
/**
 * Fail when a tracked file carries a live credential.
 *
 *   bun run check:secrets
 *
 * Scans `git ls-files` — what a commit would publish — for a JWT, a Bearer token, a Cloudflare
 * clearance/bot-management cookie or a private key. Values are never printed, only their shape and
 * length, so the check itself cannot be the leak.
 *
 * Why it exists: a HAR named `.redacted.` in docs/evidence/captures carried 311-character
 * `cf_clearance` and 199-character `__cf_bm` values, and no gate looked at cookie headers.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  looksBinary,
  scanText,
  type SecretFinding,
} from "../lib/secret_scan.ts";

// `URL.pathname` percent-encodes the checkout path (`my%20repo`), so it is not a filesystem path:
// on a checkout with a space this scanner would find no files and pass. `fileURLToPath` decodes it.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Paths whose contents are vendored, generated, or deliberately scratch. */
const SKIP = [
  /^node_modules\//,
  /^dist\//,
  /^Scratch\//,
  /^\.worktrees\//,
  /^\.git\//,
];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  })
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

const findings: { path: string; finding: SecretFinding }[] = [];
let scanned = 0;

for (const path of trackedFiles()) {
  if (SKIP.some((pattern) => pattern.test(path))) continue;
  const bytes = await Bun.file(join(ROOT, path))
    .bytes()
    .catch(() => null);
  if (bytes === null || looksBinary(bytes)) continue;
  scanned += 1;
  for (const finding of scanText(new TextDecoder().decode(bytes))) {
    findings.push({ path, finding });
  }
}

if (findings.length === 0) {
  console.log(
    `check:secrets: ok — ${scanned} tracked file(s), no credential shapes`,
  );
  process.exit(0);
}

console.error(
  `check:secrets: ${findings.length} credential shape(s) in tracked files`,
);
for (const { path, finding } of findings) {
  console.error(
    `  ${path}:${finding.line} [${finding.kind}] ${finding.masked}`,
  );
}
console.error(
  "\nRedact the value (keep the header/cookie name and a placeholder), rotate the credential if it " +
    "was ever live, and remember that a removal does not purge git history.",
);
process.exit(1);
