#!/usr/bin/env bun
/**
 * @file scripts/health_check.ts
 * @description Structured `/health` (`schemaVersion: 1`) and `/status` CLI check for SportsDesk local services.
 */

import { runHealthCli } from "../lib/health_cli.ts";

if (import.meta.main) {
  process.exitCode = await runHealthCli(Bun.argv.slice(2));
}
