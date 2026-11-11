#!/usr/bin/env bun
/**
 * Candidate overlay evaluation — golden pin check + policy replay (append-only audit).
 */

import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANDIDATE_EXIT_STORE_INVARIANT,
  createMatchEvaluationStore,
  evaluateCandidateOverlay,
  formatPolicyDriftWarnings,
  replayPolicyDelta,
  ValidTimeReplayError,
  type MatchEvaluationSinceAxis,
} from "../lib/candidate_match_evaluation.ts";
import {
  DEFAULT_MATCH_POLICY,
  hashPolicy,
  type MatchPolicy,
} from "../lib/candidate_ticket_enrich.ts";
import {
  hashCanonicalJsonBytes,
  serializeMatchEvaluationResult,
} from "../lib/match_evaluation_canonical.ts";

type GlobalOpts = { json: boolean };

function printRootHelp(): void {
  console.log(`Candidate overlay match evaluation

Commands:
  pin       Verify golden evaluation fixtures (byte pin vs evaluation_result_sha256)
  verify    Append-only store invariants (serializer drift)
  replay    Re-evaluate stored inputs under a new policy vs baseline append-only rows

Global:
  -h, --help
  --json    Machine-readable stdout

Examples:
  bun run candidate pin
  bun run candidate verify --db ./match_evaluations.sqlite
  bun run candidate replay --db ./match_evaluations.sqlite --baseline-policy-sha256 b856b401… --policy ./policy-v3.json --since 2026-10-01 --until 2026-10-31
  bun run candidate replay --since 2026-10-01 --since-axis valid_time --db ./match_evaluations.sqlite ...
`);
}

function printPinHelp(): void {
  console.log(`candidate pin

Options:
  --fixtures-dir <path>   Default: tests/fixtures

Exit: 0 all pins match · 2 drift
`);
}

function printVerifyHelp(): void {
  console.log(`candidate verify

Options:
  --db <path>   SQLite match_evaluations store (required)

Checks:
  Same (ticker, pending, policy) must never produce multiple evaluation_json_sha256 values.

Exit: 0 clean · 5 store invariant failure (serializer drift or valid_time fork)
`);
}

function printReplayHelp(): void {
  console.log(`candidate replay

Append-only semantics: baseline rows are the latest run_at per (ticker, pending) for baseline policy.

Time window (--since / --until):
  Default --since-axis run_at filters evaluation transaction time (when the matcher ran).
  --since-axis valid_time filters market event time from replay_input_json.validTime
  (denormalized to valid_time column). Refuses valid_time if any row lacks validTime —
  never falls back to run_at.

Options:
  --db <path>                      SQLite match_evaluations store (required)
  --policy <path>                  New MatchPolicy JSON { ms, mode } (required)
  --baseline-policy-sha256 <hex>   Baseline policy_sha256 (required)
  --since <iso>                    Lower bound (axis-dependent, see above)
  --until <iso>                    Upper bound (axis-dependent)
  --since-axis run_at|valid_time   Default: run_at
  --gate-policy-latency            Exit 3 when p90 or max-tail (5× max) exceeds policy

Exit:
  0  no policy flips
  2  policy state flips (expected when deploying a new policy — reviewer decides)
  3  policy latency gate (--gate-policy-latency)
  4  valid_time axis unsupported on store
  5  store invariant failure (serializer drift or valid_time fork) — bug, fix before deploy
`);
}

function parseGlobal(argv: string[]): { rest: string[]; opts: GlobalOpts } {
  const opts: GlobalOpts = { json: false };
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else rest.push(a);
  }
  return { rest, opts };
}

function loadPolicyFile(path: string): MatchPolicy {
  const raw = JSON.parse(readFileSync(path, "utf8")) as MatchPolicy;
  if (typeof raw.ms !== "number" || typeof raw.mode !== "string") {
    throw new Error(`Invalid policy file: ${path}`);
  }
  return raw;
}

function parseSinceAxis(value: string | undefined): MatchEvaluationSinceAxis {
  if (!value || value === "run_at") return "run_at";
  if (value === "valid_time") return "valid_time";
  throw new Error(`Invalid --since-axis: ${value} (use run_at or valid_time)`);
}

async function cmdPin(args: string[], opts: GlobalOpts): Promise<number> {
  let fixturesDir = resolve(import.meta.dir, "../tests/fixtures");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixtures-dir" && args[i + 1]) {
      fixturesDir = resolve(args[++i]!);
    } else if (args[i] === "-h" || args[i] === "--help") {
      printPinHelp();
      return 0;
    }
  }

  const goldenNames = [
    "candidate-match-evaluation-file1.golden.json",
    "candidate-match-evaluation-file2.golden.json",
  ];
  const failures: string[] = [];

  for (const name of goldenNames) {
    const jsonPath = resolve(fixturesDir, name);
    const shaPath = resolve(
      fixturesDir,
      name.replace(".golden.json", ".golden.sha256"),
    );
    const bytes = readFileSync(jsonPath, "utf8");
    const expected = readFileSync(shaPath, "utf8").trim();
    const actual = hashCanonicalJsonBytes(bytes);
    if (actual !== expected) {
      failures.push(`${name}: expected ${expected}, got ${actual}`);
    }
  }

  if (failures.length > 0) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, failures }, null, 2));
    } else {
      for (const f of failures) console.error(f);
    }
    return 2;
  }

  if (opts.json)
    console.log(JSON.stringify({ ok: true, checked: goldenNames }));
  else console.log(`pin ok (${goldenNames.length} golden evaluations)`);
  return 0;
}

async function cmdVerify(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      printVerifyHelp();
      return 0;
    }
    if (a === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
  }
  if (!dbPath) {
    console.error("verify requires --db");
    printVerifyHelp();
    return 1;
  }

  const db = openSportsdeskSqlite(dbPath);
  const store = createMatchEvaluationStore(db);
  const report = store.runStoreInvariants();

  if (!report.ok) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            serializerDrift: report.serializerDrift,
            validTimeFork: report.validTimeFork,
          },
          null,
          2,
        ),
      );
    } else {
      if (report.serializerDrift.length > 0) {
        console.error(
          `serializer drift: ${report.serializerDrift.length} (ticker, pending, policy) group(s)`,
        );
        for (const row of report.serializerDrift) {
          console.error(
            `  ${row.ticker_sha256.slice(0, 12)}… distinct_outputs=${row.distinct_outputs}`,
          );
        }
      }
      if (report.validTimeFork.length > 0) {
        console.error(
          `valid_time fork: ${report.validTimeFork.length} (ticker, pending) group(s)`,
        );
        for (const row of report.validTimeFork) {
          console.error(
            `  ${row.ticker_sha256.slice(0, 12)}… distinct_valid_times=${row.distinct_valid_times}`,
          );
        }
      }
    }
    return CANDIDATE_EXIT_STORE_INVARIANT;
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        serializerDrift: [],
        validTimeFork: [],
      }),
    );
  } else console.log("verify ok (store invariants clean)");
  return 0;
}

async function cmdReplay(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  let policyPath: string | undefined;
  let baselineSha: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let sinceAxis: MatchEvaluationSinceAxis = "run_at";
  let gatePolicyLatency = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      printReplayHelp();
      return 0;
    }
    if (a === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
    else if (a === "--policy" && args[i + 1]) policyPath = resolve(args[++i]!);
    else if (a === "--baseline-policy-sha256" && args[i + 1]) {
      baselineSha = args[++i]!;
    } else if (a === "--since" && args[i + 1]) since = args[++i]!;
    else if (a === "--until" && args[i + 1]) until = args[++i]!;
    else if (a === "--since-axis" && args[i + 1]) {
      try {
        sinceAxis = parseSinceAxis(args[++i]);
      } catch (e) {
        console.error(String(e));
        return 1;
      }
    } else if (a === "--gate-policy-latency") gatePolicyLatency = true;
  }

  if (!dbPath || !policyPath || !baselineSha) {
    console.error("replay requires --db, --policy, --baseline-policy-sha256");
    printReplayHelp();
    return 1;
  }

  const newPolicy = loadPolicyFile(policyPath);
  const db = openSportsdeskSqlite(dbPath);
  const store = createMatchEvaluationStore(db);

  const invariants = store.runStoreInvariants();
  if (!invariants.ok) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            aborted: true,
            serializerDrift: invariants.serializerDrift,
            validTimeFork: invariants.validTimeFork,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(
        "replay aborted: store invariant failure — run candidate verify (exit 5)",
      );
    }
    return CANDIDATE_EXIT_STORE_INVARIANT;
  }

  let delta;
  try {
    delta = replayPolicyDelta(store, baselineSha, newPolicy, {
      sinceAxis,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    });
  } catch (e) {
    if (e instanceof ValidTimeReplayError) {
      console.error(e.message);
      return 4;
    }
    throw e;
  }

  for (const line of formatPolicyDriftWarnings(delta.latency, newPolicy.ms)) {
    console.warn(line);
  }

  const hasFlips = delta.newlyAccepted > 0 || delta.newlyRejected > 0;
  let exitCode = 0;
  if (hasFlips) exitCode = 2;
  else if (gatePolicyLatency && delta.latency.driftAny) exitCode = 3;

  if (opts.json) {
    console.log(JSON.stringify({ exitCode, ...delta }, null, 2));
  } else {
    console.log(`since-axis ${delta.sinceAxis}`);
    console.log(`baseline ${delta.baselinePolicySha256.slice(0, 12)}…`);
    console.log(`new      ${delta.newPolicySha256.slice(0, 12)}…`);
    console.log(
      `newly accepted: ${delta.newlyAccepted}, newly rejected: ${delta.newlyRejected}, unchanged: ${delta.unchanged}`,
    );
    console.log(
      `latency batch ${delta.latency.batchWindow} n=${delta.latency.sampleCount} | abs p90=${delta.latency.absP90Ms} p99=${delta.latency.absP99Ms} max=${delta.latency.absMaxMs} (policy max ${newPolicy.ms}ms)`,
    );
    console.log(
      `latency signed p50=${delta.latency.signedP50Ms}ms p90=${delta.latency.signedP90Ms}ms`,
    );
    if (delta.flipped.length > 0) {
      console.log("flips:");
      for (const f of delta.flipped) {
        console.log(
          `  ${f.tickerSha256.slice(0, 12)}… ${f.baselineState} → ${f.newState}`,
        );
      }
    }
  }
  return exitCode;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { rest, opts } = parseGlobal(argv);
  const [cmd, ...args] = rest;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printRootHelp();
    return 0;
  }

  switch (cmd) {
    case "pin":
      return cmdPin(args, opts);
    case "verify":
      return cmdVerify(args, opts);
    case "replay":
      return cmdReplay(args, opts);
    default:
      console.error(`Unknown command: ${cmd}`);
      printRootHelp();
      return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}

export {
  evaluateCandidateOverlay,
  hashPolicy,
  DEFAULT_MATCH_POLICY,
  serializeMatchEvaluationResult,
};
