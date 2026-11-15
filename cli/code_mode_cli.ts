#!/usr/bin/env bun
/**
 * @file cli/code_mode_cli.ts
 * @description Code Mode CLI for executing JavaScript/TypeScript tool-orchestration scripts.
 *
 * Usage:
 *   bun run code-mode -e "const blotter = await tools.get_active_bet_blotter({ limit: 10 }); return blotter.length;"
 *   bun run code-mode:profile -e "return (await tools.query_profiles({ field: 'clv', limit: 3 })).rows.length"
 *   bun run code-mode script.ts [--json]
 *   bun run code-mode --types
 *   bun run code-mode --list-tools
 */

import { parseArgs } from "node:util";
import { createSportsdeskCodeModeRunner } from "../lib/code_mode.ts";
import { createProfileQueryHostRunner } from "../lib/profile_code_mode_host.ts";
import {
  executeProfileCodeMode,
  type ProfileCodeModeRealm,
} from "../lib/code_mode_profile.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    eval: { type: "string", short: "e" },
    file: { type: "string", short: "f" },
    realm: { type: "string" },
    types: { type: "boolean", short: "t" },
    "list-tools": { type: "boolean", short: "l" },
    json: { type: "boolean", short: "j" },
    timeout: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`sportsdesk code-mode — Programmatic Tool Orchestration Engine

Usage:
  bun run code-mode -e "<code>" [options]        # desk MCP spine (--realm host default)
  bun run code-mode:profile -e "<code>"          # profile cells (--realm guest default)
  bun run code-mode <script.ts> [options]
  bun run code-mode --types
  bun run code-mode --list-tools

Realm defaults (intentional split):
  code-mode         → host  = full desk tool spine (operator CLI; not hardened)
  code-mode:profile → guest = production profile QuickJS cells

  code-mode:profile still accepts --realm profile-host (gated env) or --realm host (desk spine);
  defaults are not exclusions — they pick the usual path for each script.

Options:
  -e, --eval <code>      Execute inline JavaScript/TypeScript snippet
  -f, --file <path>      Path to script file to execute
      --realm <host|guest|profile-host>
                         host (default on code-mode) = desk MCP spine
                         guest (default on code-mode:profile / library) = QuickJS profile bridge
                         profile-host = dev/parity profile on insecure host; SPORTSDESK_PROFILE_CODE_MODE_HOST=1
  -t, --types            Output ambient TypeScript (.d.ts) declarations for LLM prompt injection
  -l, --list-tools       List all registered tools and signatures
  -j, --json             Output structured JSON execution result with full telemetry
      --timeout <ms>     Maximum script timeout in milliseconds (default: 30000)
  -h, --help             Show this help screen
`);
  process.exit(0);
}

const realmRaw = values.realm ?? "host";
if (
  realmRaw !== "host" &&
  realmRaw !== "guest" &&
  realmRaw !== "profile-host"
) {
  console.error(
    `Error: invalid --realm '${realmRaw}' (use host, guest, or profile-host).`,
  );
  process.exit(1);
}
type CliRealm = ProfileCodeModeRealm | "profile-host" | "host";
const realm = realmRaw as CliRealm;

let runner = null as ReturnType<typeof createSportsdeskCodeModeRunner> | null;
if (realm === "guest") {
  runner = null;
} else if (realm === "profile-host") {
  try {
    runner = createProfileQueryHostRunner();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message);
    process.exit(1);
  }
} else {
  runner = createSportsdeskCodeModeRunner();
}

if (values.types) {
  if (!runner) {
    console.error("Error: --types requires --realm host or profile-host.");
    process.exit(1);
  }
  console.log(runner.generateTypeDeclarations());
  process.exit(0);
}

if (values["list-tools"]) {
  if (realm === "guest") {
    console.log("Registered Code Mode Tools (guest profile bridge):\n");
    for (const name of [
      "query_profiles",
      "get_profile",
      "get_profile_summary",
    ]) {
      console.log(`  • tools.${name}`);
    }
    process.exit(0);
  }
  console.log("Registered Code Mode Tools:\n");
  for (const tool of runner!.listTools()) {
    console.log(`  • tools.${tool.name.padEnd(35)} - ${tool.description}`);
  }
  process.exit(0);
}

let codeToRun: string | null = null;

if (values.eval) {
  codeToRun = values.eval;
} else if (values.file) {
  const file = Bun.file(values.file);
  if (!(await file.exists())) {
    console.error(`Error: File '${values.file}' not found.`);
    process.exit(1);
  }
  codeToRun = await file.text();
} else if (positionals.length > 0) {
  const candidatePath = positionals[0];
  if (candidatePath) {
    const file = Bun.file(candidatePath);
    if (await file.exists()) {
      codeToRun = await file.text();
    } else {
      codeToRun = candidatePath;
    }
  }
}

if (!codeToRun) {
  console.error(
    "Error: No code or script file provided. Use -e '<code>' or pass a script path.",
  );
  process.exit(1);
}

const timeoutMs = values.timeout ? Number(values.timeout) : 30_000;

if (realm === "guest") {
  try {
    const result = await executeProfileCodeMode(codeToRun, "guest", {
      timeoutMs,
    });
    if (values.json) {
      console.log(JSON.stringify({ success: true, result }, null, 2));
    } else {
      console.log("Result:");
      if (typeof result === "object" && result !== null) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(String(result));
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Execution Error: ${message}`);
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exit(1);
  }
  process.exit(0);
}

const execution = await runner!.execute(codeToRun, { timeoutMs });

if (values.json) {
  console.log(JSON.stringify(execution, null, 2));
} else {
  if (execution.logs.length > 0) {
    console.log("Script Logs:");
    for (const log of execution.logs) {
      console.log(`  ${log}`);
    }
    console.log("");
  }

  if (execution.success) {
    console.log("Result:");
    if (typeof execution.result === "object" && execution.result !== null) {
      console.log(JSON.stringify(execution.result, null, 2));
    } else {
      console.log(String(execution.result));
    }

    const {
      durationMs,
      totalToolCalls,
      rawToolBytes,
      outputBytes,
      tokenSavingsRatio,
    } = execution.telemetry;

    console.log("\nTelemetry:");
    console.log(`  Execution Time   : ${durationMs.toFixed(2)}ms`);
    console.log(`  Tool Calls       : ${totalToolCalls}`);
    console.log(`  Raw Tool Bytes   : ${rawToolBytes.toLocaleString()} B`);
    console.log(`  Output Bytes     : ${outputBytes.toLocaleString()} B`);
    console.log(`  Token Efficiency : ${tokenSavingsRatio}x reduction`);
  } else {
    console.error(`Execution Error: ${execution.error?.message}`);
    if (execution.error?.stack) {
      console.error(execution.error.stack);
    }
    process.exit(1);
  }
}
