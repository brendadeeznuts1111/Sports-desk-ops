#!/usr/bin/env bun
/**
 * Read-only Fantasy402 puller.
 *
 *   bun run f402:pull census --agent-id <agent-id>
 *   bun run f402:pull contract --agent-id <agent-id> --customer <id>
 *   bun run f402:pull transactions --agent-id <agent-id>
 *   bun run f402:pull weblog --agent-id <agent-id> --from 2026-11-01 --to 2026-11-14
 *   bun run f402:pull wagers --agent-id <agent-id> --from 2026-11-01 --to 2026-11-14
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

import { f402FetchSessions } from "../lib/f402_fetch_sessions.ts";
import {
  applyF402NetOptions,
  assertBunNetworkEnv,
  F402_NET_ARG_OPTIONS,
  F402_NET_USAGE,
  F402NetOptionsError,
  f402NetReport,
  resolveF402NetOptions,
} from "../lib/f402_net_options.ts";

import {
  F402_PULL_BASE_URL_ENV,
  F402_PULL_DEFAULT_BASE_URL,
  F402_PULL_DEFAULT_INTERVAL_MS,
  F402_PULL_DEFAULT_OUT_DIR,
  F402PullClient,
  F402PullerError,
  createPaceClock,
  defaultTransactionStartDate,
  redactSecretsAndIps,
  resolveF402PortalOrigin,
  resolvePullBaseUrl,
  resolvePullSession,
  runCensus,
  runContract,
  runTransactions,
  runWagers,
  runWeblog,
  type F402PullPhase,
} from "../lib/f402_readonly_puller.ts";
import {
  applySinceToRange,
  parseConcurrency,
  parseIdList,
  parseIsoDate,
  parseRateAndInterval,
  planPull,
  resolveResume,
} from "../lib/f402_pull_plan.ts";

const PHASES: readonly F402PullPhase[] = [
  "census",
  "contract",
  "transactions",
  "weblog",
  "wagers",
];

function printUsage(): void {
  console.log(`Usage: bun run f402:pull <census|contract|transactions|weblog|wagers> [options]

Options:
  --out <dir>              Output directory (default: ${F402_PULL_DEFAULT_OUT_DIR})
  --agent-id <id>          Root agent (default: F402_AGENT_ID)
  --agent-owner <id>       agentOwner form field (default: --agent-id)
  --agent-type <M|A>       agentType for getListAgenstByAgent (default: from hierarchy)
  --agents <id,id>         Limit to these agents (plus --recurse-downline to walk GENERAL)
  --recurse-downline       Extra getListAgenstByAgent calls for each downline agent
  --accounts <id,id>       Limit per-customer reads (transactions, figure-date)
  --customer <id>          Test customer for the contract phase (required there)
  --start <YYYY-MM-DD>     Transaction start; contract also sends start=""
  --from <YYYY-MM-DD>      Weblog / wagers range start (required for those phases)
  --to <YYYY-MM-DD>        Weblog / wagers range end (required for those phases)
  --since <YYYY-MM-DD>     Incremental start; later of --since and --from wins
  --mode <A|B|C|I>         getWebLog type (default: I)
  --skip-figure-date       Wagers: skip per-customer getWagersByFigureDate
  --base-url <url>         https portal origin, http only for loopback (default: ${F402_PULL_BASE_URL_ENV} or ${F402_PULL_DEFAULT_BASE_URL});
                           the host must be allowlisted (see --host)
  --interval-ms <n>        Minimum delay between requests (default: ${F402_PULL_DEFAULT_INTERVAL_MS})
  --rate <n>               Requests per second (default 1); do not also pass a conflicting --interval-ms
  --concurrency <n>        Max in-flight per-customer jobs (default 1, checkpoint-safe)
  --resume                 Resume from the checkpoint (default)
  --no-resume              Ignore completed ids/dates in the checkpoint
  --dry-run                Print the planned allowlisted calls only; no session, no writes
  --help

${F402_NET_USAGE}

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

function printNetReport(net: ReturnType<typeof resolveF402NetOptions>): void {
  console.error(JSON.stringify(f402NetReport(net)));
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
      rate: { type: "string" },
      concurrency: { type: "string" },
      agents: { type: "string" },
      accounts: { type: "string" },
      since: { type: "string" },
      resume: { type: "boolean", default: false },
      "no-resume": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "recurse-downline": { type: "boolean", default: false },
      "skip-figure-date": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      ...F402_NET_ARG_OPTIONS,
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
  const rate = parseRateAndInterval(
    flagString(values, "rate"),
    flagString(values, "interval-ms"),
  );
  const intervalMs = rate.intervalMs;
  const concurrency = parseConcurrency(flagString(values, "concurrency"));
  const resume = resolveResume(
    values.resume === true,
    values["no-resume"] === true,
  );
  const agentsRaw = flagString(values, "agents");
  const accountsRaw = flagString(values, "accounts");
  const agents =
    agentsRaw === undefined ? [] : parseIdList(agentsRaw, "--agents");
  const accounts =
    accountsRaw === undefined ? [] : parseIdList(accountsRaw, "--accounts");
  const sinceRaw = flagString(values, "since");
  const since =
    sinceRaw === undefined ? null : parseIsoDate(sinceRaw, "--since");
  const pullOptions = {
    resume,
    dryRun: values["dry-run"] === true,
    intervalMs,
    ratePerSec: rate.ratePerSec,
    concurrency,
    since,
    agents,
    accounts,
    recurseDownline: values["recurse-downline"] === true,
  };
  const net = resolveF402NetOptions(values);
  const baseUrl = resolveF402PortalOrigin(
    resolvePullBaseUrl(flagString(values, "base-url")),
    net.host,
  );

  if (pullOptions.dryRun) {
    const from = flagString(values, "from");
    const to = flagString(values, "to");
    const start = flagString(values, "start");
    const customer = flagString(values, "customer");
    const mode = flagString(values, "mode");
    const plan = planPull({
      phase,
      outDir,
      agentId,
      agentOwner: flagString(values, "agent-owner") ?? agentId,
      agentType: flagString(values, "agent-type") ?? "",
      options: pullOptions,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(start === undefined ? {} : { start }),
      ...(customer === undefined ? {} : { customer }),
      ...(mode === undefined ? {} : { mode }),
      includeFigureDate: values["skip-figure-date"] !== true,
    });
    console.log(JSON.stringify(redactSecretsAndIps(plan)));
    return 0;
  }

  assertBunNetworkEnv(net);
  applyF402NetOptions(net, f402FetchSessions);
  if (net.verbose) process.once("exit", () => printNetReport(net));

  const session = await resolvePullSession({});
  const client = new F402PullClient({
    session,
    baseUrl,
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
    const result = await runCensus(ctx, {
      recurseDownline: pullOptions.recurseDownline,
      ...(agents.length === 0 ? {} : { agents }),
      ...(accounts.length === 0 ? {} : { accounts }),
    });
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
      start: flagString(values, "start") ?? pullOptions.since ?? "",
      resume,
      concurrency,
      ...(accounts.length === 0 ? {} : { accounts }),
    });
    console.log(
      JSON.stringify(redactSecretsAndIps({ phase, ...result, outDir })),
    );
    return 0;
  }
  const range = applySinceToRange(
    flagString(values, "from"),
    flagString(values, "to"),
    since,
    phase,
  );
  const from = range.from;
  const to = range.to;
  if (phase === "wagers") {
    const result = await runWagers(ctx, {
      from,
      to,
      resume,
      includeFigureDate: values["skip-figure-date"] !== true,
      concurrency,
      ...(accounts.length === 0 ? {} : { accounts }),
    });
    console.log(
      JSON.stringify(redactSecretsAndIps({ phase, ...result, outDir })),
    );
    return 0;
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
    resume,
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
    if (error instanceof F402NetOptionsError) {
      console.error(`f402-pull ${error.message}`);
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { main };
