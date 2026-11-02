#!/usr/bin/env bun
/**
 * @file extract_contests.ts
 * @description Extracts the portal's Contest (futures) list from pasted sports-nav markup.
 *
 * Why an extractor instead of a hand-written file: every entry's identity is a numeric
 * `contestNum` read out of an HTML-escaped `data-param`. Retyping ~100 of those by hand
 * invites a wrong primary key, so the markup is parsed instead.
 *
 * Input: any HTML containing `<div data-group="FOOTBALL">` blocks with
 * `<a data-action="get-games-prop" data-param="…">` anchors — i.e. a saved copy of the
 * manager page's sports nav (the `data-sport="contest"` dropdown).
 *
 * Usage:
 *   bun run contests:extract --html scratch/manager-nav.html
 *   bun run contests:extract --html scratch/manager-nav.html --out data/contests.json
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  extractContests,
  summarizeContests,
  type ContestFile,
} from "../lib/contests.ts";

interface Args {
  /** File to read; empty when the markup is piped in. */
  html: string;
  out: string;
  /** True when the markup should come from stdin rather than a file. */
  stdin: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { html: "", out: "data/contests.json", stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--html") {
      if (value === undefined) throw new Error("--html needs a path");
      args.html = value;
      i++;
    } else if (flag === "--stdin") {
      args.stdin = true;
    } else if (flag === "--out") {
      if (value === undefined) throw new Error("--out needs a path");
      args.out = value;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      console.log(
        [
          "Usage: bun run contests:extract (--html <file> | --stdin) [--out <path>]",
          "",
          "  --html <path>  saved markup containing the sports nav (contest dropdown)",
          "  --stdin        read the markup from stdin (copy the nav, then pipe pbpaste)",
          "  --out <path>   output (default data/contests.json)",
          "",
          "Examples:",
          "  bun run contests:extract --html scratch/manager-nav.html",
          "  pbpaste | bun run contests:extract",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${String(flag)}`);
    }
  }
  if (args.html === "" && !args.stdin) {
    // No file and no flag: assume the markup was piped in, which is the clipboard workflow.
    args.stdin = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  let markup: string;
  let sourceLabel: string;

  if (args.stdin) {
    const piped = await new Response(Bun.stdin.stream()).text();
    if (piped.trim() === "") {
      throw new Error("stdin was empty; pipe the markup or pass --html <file>");
    }
    markup = piped;
    sourceLabel = "stdin";
  } else {
    const file = Bun.file(resolve(process.cwd(), args.html));
    if (!(await file.exists())) throw new Error(`not found: ${args.html}`);
    markup = await file.text();
    sourceLabel = args.html;
  }

  const entries = extractContests(markup);
  if (entries.length === 0) {
    throw new Error(
      "no contests found; pass markup containing data-group blocks with get-games-prop anchors",
    );
  }

  const contestFile: ContestFile = {
    schemaVersion: 1,
    source: `markup:${sourceLabel}`,
    extractedAt: new Date().toISOString(),
    entries,
  };

  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, `${JSON.stringify(contestFile, null, 2)}\n`);

  const summary = summarizeContests(contestFile);
  console.log(`[contests:extract] ${sourceLabel} -> ${args.out}`);
  console.log(`[contests:extract] ${summary.total} contest(s)`);
  console.log(
    `[contests:extract] groups: ${Object.entries(summary.byGroup)
      .map(([group, count]) => `${group} ${count}`)
      .join(", ")}`,
  );
  if (summary.partial > 0) {
    console.log(
      `[contests:extract] ${summary.partial} entr(ies) have fewer than three type segments`,
    );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(
      `contests:extract: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
