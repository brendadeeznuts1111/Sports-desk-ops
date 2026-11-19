#!/usr/bin/env bun
/**
 * @file scripts/check_home_paths.ts
 * @description Fail when a tracked file hardcodes an operator home directory.
 *
 *   bun run check:home-paths                # exit 1 on any non-allowlisted hit
 *   bun run check:home-paths --json         # machine-readable result
 *   bun run check:home-paths --root <dir>   # scan another checkout (tests)
 *
 * A path that names this machine's home leaks the operator's account name and cannot resolve on
 * another checkout. Use `$HOME`/`~`, a repo-relative path, or `homedir()` at runtime. The allowlist
 * in `lib/home_paths.ts` names each file that keeps one, with the reason.
 *
 * The scan covers tracked files plus untracked files that are not gitignored, so a file that is
 * about to be committed is caught locally — the tracked-only listing let a scratch line reach a
 * commit once. CI sees the same set, because nothing is untracked there.
 */
import { readFileSync } from "node:fs";

import { HOME_PATH_ALLOWLIST, scanHomePaths } from "../lib/home_paths.ts";

const argv = Bun.argv.slice(2);
const ROOT = (() => {
  const index = argv.indexOf("--root");
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined ? `${import.meta.dir}/..` : value;
})();
const JSON_MODE = argv.includes("--json");

const listed = Bun.spawnSync(
  ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (listed.exitCode !== 0) {
  console.error(
    `check:home-paths: git ls-files failed: ${listed.stderr.toString().trim()}`,
  );
  process.exit(2);
}

const files = listed.stdout
  .toString()
  .split("\0")
  .filter((file) => file.length > 0);

const result = scanHomePaths(files, (file) => {
  // Skip empty and very large files, and anything that is not UTF-8 text; binary assets cannot
  // hold a home path, and reading a 2 MB+ generated artifact for this check is not worth it.
  try {
    const bytes = readFileSync(`${ROOT}/${file}`);
    if (bytes.length === 0 || bytes.length > 2_000_000) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
});

if (JSON_MODE) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.violations.length === 0 && result.foreign.length === 0,
        violations: result.violations,
        foreign: result.foreign,
        allowed: result.allowed,
        scannedFiles: result.scannedFiles,
        allowlist: HOME_PATH_ALLOWLIST,
      },
      null,
      2,
    )}\n`,
  );
} else if (result.scannedFiles === 0) {
  console.error(
    "check:home-paths: scanned no files — the tracked-file listing or the reader is broken",
  );
  process.exit(2);
} else if (result.violations.length === 0 && result.foreign.length === 0) {
  console.log(
    `check:home-paths: ok — ${result.scannedFiles} file(s) scanned (tracked + untracked), ${result.allowed.length} allowlisted hit(s)`,
  );
} else {
  for (const hit of result.violations) {
    console.error(`  ${hit.file}:${hit.line}: ${hit.match}`);
  }
  for (const hit of result.foreign) {
    console.error(
      `  ${hit.file}:${hit.line}: /Users/${hit.match} — another account's home, not a placeholder`,
    );
  }
  console.error(
    `\ncheck:home-paths: ${result.violations.length + result.foreign.length} home path(s) in ${new Set([...result.violations, ...result.foreign].map((h) => h.file)).size} file(s).`,
  );
  console.error(
    "  Use $HOME/~, a repo-relative path, or homedir() at runtime; for a fixture, use a synthetic",
  );
  console.error(
    "  account name (see HOME_PATH_PLACEHOLDER_USERS in lib/home_paths.ts) rather than a real person.",
  );
  console.error("  If the path is a recorded fact");
  console.error(
    "  or generated output, add it to HOME_PATH_ALLOWLIST in lib/home_paths.ts.",
  );
}

process.exit(
  result.violations.length === 0 && result.foreign.length === 0 ? 0 : 1,
);
