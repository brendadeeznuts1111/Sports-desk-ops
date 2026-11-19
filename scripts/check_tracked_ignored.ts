#!/usr/bin/env bun
/**
 * @file scripts/check_tracked_ignored.ts
 * @description Fail when a tracked file matches the repository's own `.gitignore`.
 *
 *   bun run check:tracked-ignored                # exit 1 on any non-allowlisted hit
 *   bun run check:tracked-ignored --json         # machine-readable result
 *   bun run check:tracked-ignored --root <dir>   # check another checkout (tests)
 *
 * A tracked file under an ignored path was force-added, or the ignore rule arrived after the file.
 * Either way the tree ships something it declared it would not — a generated report, a scratch
 * benchmark, a captured report with real data — and the rule stops protecting anyone. Fix by
 * untracking (`git rm --cached`) or negating the pattern (`!path`), never by widening the allowlist
 * without a reason.
 *
 * Git's answer is authoritative: `git ls-files -i -c --exclude-standard`.
 */
import {
  TRACKED_IGNORED_ALLOWLIST,
  parseTrackedIgnored,
  unexpectedTrackedIgnored,
} from "../lib/tracked_ignored.ts";

const argv = Bun.argv.slice(2);
const rootIndex = argv.indexOf("--root");
const ROOT =
  rootIndex === -1 ? `${import.meta.dir}/..` : (argv[rootIndex + 1] ?? ".");
const JSON_MODE = argv.includes("--json");

const listed = Bun.spawnSync(
  ["git", "ls-files", "-z", "-i", "-c", "--exclude-standard"],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
if (listed.exitCode !== 0) {
  console.error(
    `check:tracked-ignored: git ls-files failed: ${listed.stderr.toString().trim()}`,
  );
  process.exit(2);
}

const all = parseTrackedIgnored(listed.stdout.toString());
const unexpected = unexpectedTrackedIgnored(all);

if (JSON_MODE) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: unexpected.length === 0,
        trackedIgnored: all,
        unexpected,
        allowlist: TRACKED_IGNORED_ALLOWLIST,
      },
      null,
      2,
    )}\n`,
  );
} else if (unexpected.length === 0) {
  console.log(
    `check:tracked-ignored: ok — ${all.length} tracked file(s) match .gitignore, 0 unexpected`,
  );
} else {
  for (const file of unexpected) {
    console.error(`  ${file}`);
  }
  console.error(
    `\ncheck:tracked-ignored: ${unexpected.length} tracked file(s) match .gitignore.`,
  );
  console.error(
    "  Untrack them (`git rm --cached <path>`) or negate the pattern (`!<path>`). A file that must",
  );
  console.error(
    "  stay needs a negation, and an allowlist entry needs a stated reason.",
  );
}

process.exit(unexpected.length === 0 ? 0 : 1);
