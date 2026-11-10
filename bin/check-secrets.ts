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

const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|ico|avif|woff2?|ttf|otf|eot|sqlite3?|db|dodbin|nshc|nshpkg|zst|gz|zip|tar|pdf|mp4|webm)$/i;

const UTF8_DECODER = new TextDecoder();
const SCAN_BATCH_SIZE = 64;

async function trackedFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const [out, err, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`check:secrets: git ls-files -z failed (${code}): ${err}`);
  }
  return out.split("\0").filter((path) => path !== "");
}

const candidates = (await trackedFiles()).filter(
  (path) =>
    !SKIP.some((pattern) => pattern.test(path)) && !BINARY_EXT.test(path),
);

const findings: { path: string; finding: SecretFinding }[] = [];
let scanned = 0;

for (let offset = 0; offset < candidates.length; offset += SCAN_BATCH_SIZE) {
  const slice = candidates.slice(offset, offset + SCAN_BATCH_SIZE);
  const batchResults = await Promise.all(
    slice.map(async (path) => {
      const bytes = await Bun.file(join(ROOT, path))
        .bytes()
        .catch(() => null);
      if (bytes === null || looksBinary(bytes)) return null;
      return { path, matches: scanText(UTF8_DECODER.decode(bytes)) };
    }),
  );
  for (const item of batchResults) {
    if (item === null) continue;
    scanned += 1;
    for (const finding of item.matches) {
      findings.push({ path: item.path, finding });
    }
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
