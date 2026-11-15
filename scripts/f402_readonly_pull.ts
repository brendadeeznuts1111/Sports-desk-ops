#!/usr/bin/env bun
/**
 * Read-only Fantasy402 puller.
 *
 *   bun run f402:pull census --agent-id BILLY666
 *   bun run f402:pull contract --agent-id BILLY666 --customer <id>
 *   bun run f402:pull transactions --agent-id BILLY666
 *   bun run f402:pull weblog --agent-id BILLY666 --from 2026-11-01 --to 2026-11-14
 *
 * This CLI never places a wager, writes a log, or opens a page module.
 * Sessions are minted only through the existing `session:login` / WebView path.
 * Default output is `/workspace/f402-pull` (gitignored). Summaries never
 * include raw IPs; passwords are stripped on ingest.
 *
 * Live login is not run by this script unless a session must be minted and
 * F402_LIVE_LOGIN=1 is already set. Do not pass passwords on the command line.
 */

import { parseArgs } from "node:util";

import {
  F402_PULL_DEFAULT_BASE_URL,
  F402_PULL_DEFAULT_INTERVAL_MS,
  F402_PULL_DEFAULT_OUT_DIR,
  F402PullClient,
  F402PullerError,
  createPaceClock,
  defaultTransactionStartDate,
  redactSecretsAndIps,
  resolvePullSession,
  runCensus,
  runContract,
  runTransactions,
  runWeblog,
  type F402PullPhase,
} from "../lib/f402_readonly_puller.ts";

const PHASES: readonly F402PullPhase[] = [
  "census",
  "contract",
  "transactions",
  "weblog",
];

function printUsage(): void {
  console.log(`Usage: bun run f402:pull <census|contract|transactions|weblog> [options]

Options:
  --out <dir>              Output directory (default: ${F402_PULL_DEFAULT_OUT_DIR})
  --agent-id <id>          Root agent (default: F402_AGENT_ID)
  --agent-owner <id>       agentOwner form field (default: --agent-id)
  --agent-type <M|A>       agentType for getListAgenstByAgent (default: from hierarchy)
  --customer <id>          Test customer for the contract phase (required there)
  --start <YYYY-MM-DD>     Transaction start; contract also sends start=""
  --from <YYYY-MM-DD>      Weblog range start (required for weblog)
  --to <YYYY-MM-DD>        Weblog range end (required for weblog)
  --mode <A|B|C|I>         getWebLog type (default: I)
  --base-url <url>         Portal origin (default: ${F402_PULL_DEFAULT_BASE_URL})
  --interval-ms <n>        Minimum delay between requests (default: ${F402_PULL_DEFAULT_INTERVAL_MS})
  --no-resume              Ignore completed ids/dates in the checkpoint
  --help

Session (existing path only; this CLI does not invent a login):
  Preferred: a cached session at ~/.cache/sportsdesk/f402-session.json
  (or F402_SESSION_FILE) with an Authorization Bearer header, less than 15
  minutes old. Mint with:
    F402_LIVE_LOGIN=1 bun run session:login --from-keychain
  or a WebView credential login. --from-profile copies cookies only and is
  not enough for these API reads. Do not pass a password here.
`);
}

function flagString(
  values: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function requirePhase(argv: string[]): F402PullPhase {
  const positional = argv.find((arg) => !arg.startsWith("-"));
  if (positional === undefined || positional === "help") {
    printUsage();
    process.exit(positional === undefined ? 2 : 0);
  }
  if (!(PHASES as readonly string[]).includes(positional)) {
    console.error(`unknown phase "${positional}"`);
    printUsage();
    process.exit(2);
  }
  return positional as F402PullPhase;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return 0;
  }
  const phase = requirePhase(argv);
  const rest = argv.filter((arg) => arg !== phase);
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      "agent-id": { type: "string" },
      "agent-owner": { type: "string" },
      "agent-type": { type: "string" },
      customer: { type: "string" },
      start: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      mode: { type: "string" },
      "base-url": { type: "string" },
      "interval-ms": { type: "string" },
      "no-resume": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printUsage();
    return 0;
  }

  const agentId =
    flagString(values, "agent-id") ?? Bun.env.F402_AGENT_ID?.trim() ?? "";
  if (agentId === "") {
    throw new F402PullerError(
      "config",
      phase,
      "missing --agent-id (or F402_AGENT_ID)",
    );
  }
  const outDir = flagString(values, "out") ?? F402_PULL_DEFAULT_OUT_DIR;
  const intervalMs = Number(
    flagString(values, "interval-ms") ?? F402_PULL_DEFAULT_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new F402PullerError("config", phase, "invalid --interval-ms");
  }

  const session = await resolvePullSession({});
  const client = new F402PullClient({
    session,
    baseUrl: flagString(values, "base-url") ?? F402_PULL_DEFAULT_BASE_URL,
    intervalMs,
    clock: createPaceClock(),
  });
  const ctx = {
    client,
    outDir,
    agentId,
    agentOwner: flagString(values, "agent-owner") ?? agentId,
    agentType: flagString(values, "agent-type") ?? "",
  };

  if (phase === "census") {
    const result = await runCensus(ctx);
    console.log(
      JSON.stringify(
        redactSecretsAndIps({
          phase,
          agentCount: result.agentCount,
          playerCount: result.playerCount,
          maxLevel: result.maxLevel,
          roots: result.roots,
          orphans: result.orphans,
          countsByLevel: result.countsByLevel,
          countsByType: result.countsByType,
          outDir,
        }),
      ),
    );
    return 0;
  }
  if (phase === "contract") {
    const customer = flagString(values, "customer");
    if (customer === undefined) {
      throw new F402PullerError("config", "contract", "missing --customer");
    }
    const result = await runContract(ctx, {
      customerId: customer,
      start: flagString(values, "start") ?? defaultTransactionStartDate(),
    });
    console.log(
      JSON.stringify(redactSecretsAndIps({ phase, ...result, outDir })),
    );
    return 0;
  }
  if (phase === "transactions") {
    const result = await runTransactions(ctx, {
      start: flagString(values, "start") ?? "",
      resume: values["no-resume"] !== true,
    });
    console.log(
      JSON.stringify(redactSecretsAndIps({ phase, ...result, outDir })),
    );
    return 0;
  }
  const from = flagString(values, "from");
  const to = flagString(values, "to");
  if (from === undefined || to === undefined) {
    throw new F402PullerError("config", "weblog", "missing --from or --to");
  }
  const modeRaw = (flagString(values, "mode") ?? "I").toUpperCase();
  if (
    modeRaw !== "A" &&
    modeRaw !== "B" &&
    modeRaw !== "C" &&
    modeRaw !== "I"
  ) {
    throw new F402PullerError("config", "weblog", "mode must be A, B, C, or I");
  }
  const result = await runWeblog(ctx, {
    from,
    to,
    mode: modeRaw,
    resume: values["no-resume"] !== true,
  });
  console.log(
    JSON.stringify(
      redactSecretsAndIps({
        phase,
        completed: result.completed,
        skipped: result.skipped,
        dates: result.dates,
        rowCounts: result.rowCounts,
        outDir,
      }),
    ),
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof F402PullerError) {
      console.error(error.message);
      process.exit(error.code === "config" ? 2 : 1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { main };
