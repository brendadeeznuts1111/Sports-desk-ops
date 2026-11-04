#!/usr/bin/env bun
/**
 * Merge `data/scoreboard.json` nicknames + portal logo filenames into
 * `data/unified_team_registry.json` (idempotent).
 */
import { resolve } from "node:path";

import {
  defaultScoreboardSyncPaths,
  mergeScoreboardIntoRegistryFile,
} from "../lib/unified_team_registry_scoreboard.ts";

const REPO = resolve(import.meta.dir, "..");

const result = mergeScoreboardIntoRegistryFile(
  defaultScoreboardSyncPaths(REPO).registryPath,
  defaultScoreboardSyncPaths(REPO).scoreboardPath,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      ...result,
      registryPath: defaultScoreboardSyncPaths(REPO).registryPath,
    },
    null,
    2,
  ),
);
