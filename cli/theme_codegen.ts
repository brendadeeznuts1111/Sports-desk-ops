#!/usr/bin/env bun
/**
 * Dual-token theme codegen: write the profile `.env` and the static TypeScript LUT in one step.
 *
 *   bun run theme:codegen --profile crimson-dry --out-dir scratch/generated
 *   bun run cli/theme_codegen.ts codegen --profile incident-red --out-dir /tmp/themes
 *   bun run cli/theme_codegen.ts codegen --profile default --db scratch/theme-tokens.sqlite
 *
 * Built-in profiles (`default`, `crimson-dry`, `incident-red`) are seeded into a fresh database,
 * so the first run needs no input file. Exit codes: 0 written, 2 unknown command or profile,
 * 1 unexpected failure.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runCodegenSubcommand } from "../lib/token_automation.ts";

const USAGE = `usage: bun cli/theme_codegen.ts codegen [--profile <name>] [--out-dir <dir>] [--db <path>]

Defaults: --profile default, --out-dir ./generated, --db scratch/theme-tokens.sqlite
Built-in profiles: ${"default, crimson-dry, incident-red"}`;

/** Repository root, so a relative default database path does not depend on the caller's cwd. */
const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_DB = "scratch/theme-tokens.sqlite";

type Parsed = { db: string; args: string[] };

/** Pull `--db` out of the argument list; everything else stays for the codegen subcommand. */
function parseDb(argv: readonly string[]): Parsed {
  let db = DEFAULT_DB;
  const args: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--db") {
      const value = argv[++index];
      if (value === undefined || value === "")
        throw new Error("--db needs a path");
      db = value;
    } else if (arg.startsWith("--db=")) {
      const value = arg.slice("--db=".length);
      if (value === "") throw new Error("--db needs a path");
      db = value;
    } else {
      args.push(arg);
    }
  }
  return { db: resolve(ROOT, db), args };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "codegen") {
    console.error(
      argv.length === 0 ? USAGE : `unknown command "${argv[0]}"\n${USAGE}`,
    );
    return 2;
  }

  let parsed: Parsed;
  try {
    parsed = parseDb(argv.slice(1));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  // SQLite creates the database file but not its directory.
  mkdirSync(dirname(parsed.db), { recursive: true });
  return await runCodegenSubcommand(parsed.db, parsed.args);
}

if (import.meta.main) process.exit(await main());
