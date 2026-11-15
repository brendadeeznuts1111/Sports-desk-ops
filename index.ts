#!/usr/bin/env bun
/**
 * @file index.ts
 * @description SportsDesk Operations TypeScript root entrypoint.
 *
 * Delegates to cli/sportsdesk_cli.ts when executed directly or imported.
 */

import { main } from "./cli/sportsdesk_cli.ts";

export * from "./cli/sportsdesk_cli.ts";

if (import.meta.main) {
  main().catch((err) => {
    console.error("CLI Execution Error:", err);
    process.exit(1);
  });
}
