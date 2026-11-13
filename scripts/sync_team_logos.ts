#!/usr/bin/env bun
/**
 * @file sync_team_logos.ts
 * @description Attribute the team-logo files referenced by live-bets `logoUrl`s to logo-less
 * teams in `data/unified_team_registry.json`.
 *
 * Defaults to CFB: college filenames are `<School> Mascot.png` and identify one team, while the
 * registry stores pro teams by city only, so a pro filename is ambiguous across leagues.
 *
 * Usage:
 *   bun run scripts/sync_team_logos.ts                 # apply
 *   bun run scripts/sync_team_logos.ts --dry-run       # report only
 *   bun run scripts/sync_team_logos.ts --leagues CFB,NBA
 *   bun run scripts/sync_team_logos.ts --live-bets data/live-bets.json --registry data/unified_team_registry.json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { League } from "../lib/watchlist_signal_engine.ts";
import {
  collectLogoFilesFromLiveBets,
  mergeLogoFilesIntoRegistryFile,
} from "../lib/unified_team_registry_scoreboard.ts";

const KNOWN_LEAGUES: readonly League[] = [
  "CFB",
  "EPL",
  "NBA",
  "NFL",
  "NHL",
  "UNKNOWN",
];

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

const argv = Bun.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const repoRoot = process.cwd();
const liveBetsPath = resolve(
  repoRoot,
  flagValue(argv, "--live-bets") ?? "data/live-bets.json",
);
const registryPath = resolve(
  repoRoot,
  flagValue(argv, "--registry") ?? "data/unified_team_registry.json",
);
const leagues = (flagValue(argv, "--leagues") ?? "CFB")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter((value): value is League => KNOWN_LEAGUES.includes(value as League));
if (leagues.length === 0) {
  console.error(
    "sync_team_logos: --leagues must name at least one of",
    KNOWN_LEAGUES.join(", "),
  );
  process.exit(2);
}

// A CFB-only run attributes college logos; a pro-inclusive run takes every file.
const collegeOnly = leagues.length === 1 && leagues[0] === "CFB";
const logoFiles = collectLogoFilesFromLiveBets(
  JSON.parse(readFileSync(liveBetsPath, "utf8")),
  { collegeOnly },
);
const result = mergeLogoFilesIntoRegistryFile(registryPath, logoFiles, {
  leagues,
  write: !dryRun,
});

// The registry's canonical layout is the formatter's output (inline short arrays), while
// JSON.stringify expands everything; format after every write so the diff stays minimal.
if (!dryRun && (result.updated > 0 || result.aliased > 0)) {
  const formatted = Bun.spawnSync(["bun", "fmt", registryPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (formatted.exitCode !== 0) {
    console.error("sync_team_logos: bun fmt failed on", registryPath);
    process.exit(1);
  }
}

console.log(
  JSON.stringify(
    {
      dryRun,
      liveBetsPath,
      registryPath,
      leagues,
      collegeOnly,
      logoFiles: logoFiles.length,
      updated: result.updated,
      aliased: result.aliased,
      total: result.total,
      matched: result.matched,
      unmatchedFiles: result.unmatchedFiles,
    },
    null,
    2,
  ),
);
