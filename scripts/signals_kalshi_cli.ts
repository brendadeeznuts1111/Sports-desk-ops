#!/usr/bin/env bun
/**
 * Print the watchlist signals and their Kalshi join, read-only.
 *
 *   bun run signals:kalshi             # operator table
 *   bun run signals:kalshi --json      # the same body the API route serves
 *   bun run signals:kalshi --limit 10  # cap the number of joined signals
 *
 * This is the only file in the feature that makes live Kalshi requests on demand; the API route
 * does it per request too, but everything is a public GET. No order, portfolio or auth endpoint is
 * reachable from `lib/kalshi_client.ts`, and no credentials are read.
 */
import { resolve } from "node:path";
import { KalshiClient } from "../lib/kalshi_client.ts";
import {
  joinConfigFromEnv,
  joinWatchlistSignals,
} from "../lib/kalshi_signal_join.ts";
import {
  deriveWatchlistSignals,
  loadWatchlistSignalInputs,
} from "../lib/watchlist_signal_engine.ts";

const ROOT = resolve(import.meta.dir, "..");

function usage(): string {
  return [
    "Usage: bun run signals:kalshi [--json] [--limit N]",
    "",
    "Read-only: joins watchlist signals to public Kalshi markets and prints verdicts.",
    "No keys, no orders, no portfolio endpoints. A degraded Kalshi response is printed as",
    "degraded with the reason — never as a price.",
  ].join("\n");
}

interface CliArgs {
  readonly json: boolean;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  let json = false;
  let limit = 25;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      index += 1;
      if (!Number.isFinite(value) || value <= 0) {
        console.error("signals:kalshi: --limit needs a positive number");
        return null;
      }
      limit = Math.min(200, Math.trunc(value));
      continue;
    }
    console.error(`signals:kalshi: unknown argument ${String(arg)}`);
    return null;
  }
  return { json, limit };
}

function formatPrice(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

function formatCents(value: number | null): string {
  return value === null ? "—" : `${value}c`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const now = new Date();
  const config = joinConfigFromEnv();
  const client = new KalshiClient();
  const inputs = await loadWatchlistSignalInputs(ROOT);
  const signals = deriveWatchlistSignals(inputs, { now });
  const joined = await joinWatchlistSignals(signals.slice(0, args.limit), {
    client,
    config,
  });
  const telemetry = client.telemetry();
  const body = {
    success: true,
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    config,
    kalshi: telemetry,
    signals: joined,
  };
  if (args.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(
    `signals:kalshi — ${joined.length}/${signals.length} signal(s); Kalshi ${
      telemetry.ok ? "ok" : "DEGRADED"
    } (${telemetry.requests} request(s), ${telemetry.cacheHits} cache hit(s))`,
  );
  for (const error of telemetry.errors) {
    console.log(`  ! ${error.scope}: ${error.reason}`);
  }
  console.log(
    `${"signal".padEnd(34)} ${"verdict".padEnd(14)} ${"market".padEnd(42)} ${"side".padEnd(4)} ${"exec".padEnd(6)} ${"edge".padEnd(8)} liquidity`,
  );
  for (const signal of joined) {
    const join = signal.kalshi;
    const liquidity = join.liquidity;
    const line = [
      signal.id.slice(0, 34).padEnd(34),
      join.verdict.padEnd(14),
      (join.marketTicker ?? "—").slice(0, 42).padEnd(42),
      (join.side ?? "—").padEnd(4),
      formatPrice(join.executablePrice).padEnd(6),
      (join.edgeBps === null ? "—" : `${join.edgeBps} bps`).padEnd(8),
      liquidity === null
        ? "—"
        : `${liquidity.verdict} top=${liquidity.topSize} spread=${formatCents(
            liquidity.spreadCents,
          )} depth=${liquidity.depthContracts}`,
    ].join(" ");
    console.log(line);
    if (join.reason !== null) console.log(`  ↳ ${join.reason}`);
  }
}

await main();
