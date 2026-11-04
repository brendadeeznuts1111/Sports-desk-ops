#!/usr/bin/env bun
/**
 * @file scripts/customer_bridge_cli.ts
 * @description `dx bridge` — cross-domain value between the SportsDesk customer book and
 *              Polymarket wallets.
 *
 * Usage:
 *   ./bin/dx bridge coverage [--book enriched_customers_full.json] [--json]
 *   ./bin/dx bridge value [--live] [--top 15] [--customer BGD101] [--json]
 *   ./bin/dx bridge match [--db scratch/cross-domain.sqlite] [--seed] [--customer BGD101] [--json]
 *
 * Read-only. Live mode uses public Polymarket APIs only; no key and no customer PII leaves
 * the machine except the `0x` proxy wallet that is already public on-chain.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAttributionRegistry,
  buildCustomerPolyBridge,
  loadCustomerBook,
  matchCustomerLegsAcrossVenues,
  observePolymarketWallet,
  seedCrossDomainScenario,
  type AttributionRegistry,
  type CustomerBookRow,
  type CustomerPolyBridgeReport,
  type PolyObservation,
} from "../lib/customer_poly_bridge.ts";
import { createComboObservationsLegsStore } from "../lib/combo_observations_legs_store.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

const HELP = `Cross-domain value bridge — SportsDesk customers ↔ Polymarket wallets

Usage:
  bun run scripts/customer_bridge_cli.ts coverage [--book <path>] [--json]
  bun run scripts/customer_bridge_cli.ts value [--live] [--top 15] [--customer <id>] [--json]
  bun run scripts/customer_bridge_cli.ts match [--db <path>] [--seed] [--customer <id>] [--json]

Subcommands:
  coverage   Link yield, attribution types, and quarantined placeholder wallets.
  value      Customer desk P/L joined to Polymarket P/L (observational; not causal).
  match      Leg-level cross-domain matching over combo_observations_legs + attributions.

Flags:
  --book <path>        Customer book JSON (default: enriched_customers_full.json)
  --customer <id>      Restrict to one customerId (repeatable value/match filter)
  --top <n>            Rows to print in text mode (default: 15)
  --live               Fetch Polymarket profiles (public APIs; slower)
  --fresh              Ignore the observation cache (live mode only)
  --cache-dir <path>   Observation cache (default: scratch/poly-bridge-cache)
  --cache-ttl-hours    Cache TTL in hours (env BRIDGE_TTL_HOURS, default 24)
  --concurrency <n>    Parallel wallet fetches in live mode (default 4)
  --db <path>          SQLite observation store (default: scratch/cross-domain.sqlite)
  --seed               Seed the store when it is empty (also the default)
  --reset              Clear the store, then seed it (destructive, explicit)
  --max-delta <n>      Max line delta in hundredths for matching (default: 100)
  --json               Machine-readable output

Notes:
  • PnL basis: fee-aware cashflow when activity pagination completes, else the official
    (pre-fee) leaderboard number. The basis is reported per row as NET or GROSS.
  • customerDeskPnlUsd = -lifetime_net_usd (the book stores the desk's net).
  • polyAdvantageUsd is observational. It is a lead for leg-level review, not proof of a hedge.
  • Wallets that are not 42-char hex are quarantined and never queried.`;

function flag(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

function flagAll(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length)
      out.push(args[index + 1]!);
  }
  return out;
}

const usd = (value: number | null): string => {
  if (value === null) return "n/a";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
};

const pct = (value: number | null): string =>
  value === null ? "n/a" : `${value.toFixed(1)}%`;

function rule(label: string): void {
  console.log(
    `\n──────────────────────────────────────────────────────────────────────────────`,
  );
  console.log(`  ${label}`);
  console.log(
    `──────────────────────────────────────────────────────────────────────────────`,
  );
}

// ============================================================================
// Observation cache (live mode)
// ============================================================================

interface BridgeCacheFile {
  readonly schemaVersion: 1;
  readonly fetchedAtIso: string;
  readonly observation: PolyObservation;
}

function ttlMs(): number {
  const hours = Number(Bun.env.BRIDGE_TTL_HOURS ?? "24");
  return Math.max(0, Number.isFinite(hours) ? hours : 24) * 3_600_000;
}

async function readCache(
  path: string,
  fresh: boolean,
): Promise<PolyObservation | null> {
  if (fresh) return null;
  try {
    const parsed = (await Bun.file(path).json()) as Partial<BridgeCacheFile>;
    if (parsed.schemaVersion !== 1 || parsed.observation === undefined)
      return null;
    const fetchedAt = Date.parse(parsed.fetchedAtIso ?? "");
    if (!Number.isFinite(fetchedAt)) return null;
    const ttl = ttlMs();
    if (ttl === 0 || Date.now() - fetchedAt > ttl) return null;
    return parsed.observation;
  } catch {
    return null;
  }
}

async function fetchObservations(
  wallets: readonly string[],
  options: {
    readonly cacheDir: string;
    readonly fresh: boolean;
    readonly concurrency: number;
  },
): Promise<{
  observations: Map<string, PolyObservation>;
  hits: number;
  misses: number;
  failures: string[];
}> {
  const observations = new Map<string, PolyObservation>();
  const failures: string[] = [];
  let hits = 0;
  let misses = 0;
  await mkdir(options.cacheDir, { recursive: true });

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(options.concurrency, wallets.length || 1) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const wallet = wallets[index];
        if (wallet === undefined) return;
        const cachePath = join(options.cacheDir, `${wallet}.json`);
        const cached = await readCache(cachePath, options.fresh);
        if (cached !== null) {
          hits += 1;
          observations.set(wallet, cached);
          continue;
        }
        misses += 1;
        try {
          const observation = await observePolymarketWallet(wallet, {
            maxActivityPages: 6,
            sleepMs: 250,
          });
          if (observation === null) {
            failures.push(`${wallet} (resolver returned null)`);
            continue;
          }
          observations.set(wallet, observation);
          const payload: BridgeCacheFile = {
            schemaVersion: 1,
            fetchedAtIso: new Date().toISOString(),
            observation,
          };
          await writeFile(cachePath, `${JSON.stringify(payload)}\n`, "utf8");
        } catch (error) {
          failures.push(`${wallet} (${(error as Error).message})`);
        }
      }
    },
  );
  await Promise.all(workers);
  return { observations, hits, misses, failures };
}

// ============================================================================
// Subcommands
// ============================================================================

function printCoverage(
  report: CustomerPolyBridgeReport,
  registry: AttributionRegistry,
  book: readonly CustomerBookRow[],
): void {
  console.log(
    "══════════════════════════════════════════════════════════════════════════════",
  );
  console.log(
    "  🕸️  CROSS-DOMAIN COVERAGE — SportsDesk customers ↔ Polymarket wallets",
  );
  console.log(
    "══════════════════════════════════════════════════════════════════════════════",
  );
  console.log(`  customers in book    : ${report.coverage.customersInBook}`);
  console.log(
    `  customers with wallet: ${report.coverage.linkedCustomers} (${pct(report.coverage.linkYieldPct)} of book)`,
  );
  console.log(`  distinct wallets     : ${report.coverage.wallets}`);
  console.log(
    `  multi-wallet customers: ${report.coverage.multiWalletCustomers}`,
  );
  console.log(
    `  wallets shared by >1 customer: ${report.coverage.sharedWallets}`,
  );
  console.log(`  quarantined wallets  : ${report.coverage.invalidWallets}`);

  rule("Attribution types");
  for (const [type, count] of Object.entries(
    report.coverage.attributionTypes,
  ).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(30)} ${String(count).padStart(3)}`);
  }

  if (report.quarantined.length > 0) {
    rule("Quarantined (never queried)");
    for (const item of report.quarantined) {
      console.log(
        `  ${item.customerId.padEnd(12)} ${item.wallet.padEnd(44)} ${item.reason}`,
      );
    }
  }

  const unlinked = book.filter(
    (row) => !registry.byCustomer.has(row.customerId),
  );
  console.log(
    `\n  Book rows without any wallet attribution: ${unlinked.length}`,
  );
  const topUnlinked = [...unlinked]
    .sort(
      (a, b) => Math.abs(b.lifetimeVolumeUsd) - Math.abs(a.lifetimeVolumeUsd),
    )
    .slice(0, 5);
  for (const row of topUnlinked) {
    console.log(
      `    • ${row.customerId.padEnd(12)} vol ${usd(row.lifetimeVolumeUsd).padStart(14)}  net ${usd(row.lifetimeNetUsd).padStart(14)}`,
    );
  }
  console.log(
    "══════════════════════════════════════════════════════════════════════════════",
  );
}

function printValue(report: CustomerPolyBridgeReport, top: number): void {
  console.log(
    "══════════════════════════════════════════════════════════════════════════════",
  );
  console.log(`  💰 CROSS-DOMAIN VALUE — evidence: ${report.evidence}`);
  console.log(
    "══════════════════════════════════════════════════════════════════════════════",
  );
  console.log(`  linked rows          : ${report.customers.length}`);
  console.log(
    `  observed on Polymarket: ${report.value.customersWithPoly} (${report.value.customersWithPnl} with PnL)`,
  );
  console.log(`  desk volume          : ${usd(report.value.deskVolumeUsd)}`);
  console.log(
    `  customer desk P/L    : ${usd(report.value.customerDeskPnlUsd)} (desk hold ${pct(report.value.deskHoldPct)})`,
  );
  console.log(
    `  poly P/L (gross)     : ${usd(report.value.polyGrossPnlUsd)}  [pre-fee, unique wallets]`,
  );
  console.log(
    `  poly P/L (net)       : ${usd(report.value.polyNetPnlUsd)}  [${pct(report.value.netCoveragePct)} of wallets replayed to completion]`,
  );
  console.log(
    `  poly P/L (row basis) : ${usd(report.value.polyPnlUsd)}  [NET where complete, GROSS otherwise]`,
  );
  console.log(
    `  fee residual         : ${usd(report.value.polyFeeResidualUsd)} (lower bound on taker fees)`,
  );
  console.log(
    `  poly advantage (signed): ${usd(report.value.polyAdvantageUsd)}`,
  );
  console.log(
    `  review priority (positive, confidence-weighted): ${usd(report.value.priorityUsd)}`,
  );
  console.log(
    `  shared-wallet rows   : ${report.value.sharedWalletRows} (excluded from advantage totals)`,
  );

  rule("Verdict counts (customer perspective)");
  console.log(`  both up        : ${report.value.bothUp}`);
  console.log(
    `  poly only up   : ${report.value.polyOnlyUp}   ← customer wins on Polymarket, loses at the desk`,
  );
  console.log(`  desk only up   : ${report.value.deskOnlyUp}`);
  console.log(`  both down      : ${report.value.bothDown}`);
  console.log(`  flat           : ${report.value.flat}`);

  rule(
    `Top ${Math.min(top, report.customers.length)} by confidence-weighted poly advantage`,
  );
  console.log(
    "  customer     agent      desk P/L      poly P/L  basis  kind       verdict        priority",
  );
  for (const row of report.customers.slice(0, top)) {
    console.log(
      `  ${row.customerId.padEnd(12)} ${row.agentId.slice(0, 10).padEnd(10)} ` +
        `${usd(row.customerDeskPnlUsd).padStart(12)} ${usd(row.polyBasisPnlUsd).padStart(13)}  ` +
        `${(row.pnlBasis ?? "-").padEnd(5)} ${(row.valueKind ?? "-").padEnd(10)} ` +
        `${(row.verdict ?? "-").padEnd(14)} ${usd(row.priorityUsd).padStart(11)}`,
    );
  }
  console.log(
    "══════════════════════════════════════════════════════════════════════════════",
  );
}

// ============================================================================
// Main
// ============================================================================

export async function runCustomerBridge(
  args: readonly string[],
): Promise<void> {
  const [sub = "coverage", ...rest] = args;
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return;
  }
  const json = rest.includes("--json");
  const bookPath = flag(rest, ["--book"], "enriched_customers_full.json");

  if (sub === "match") {
    const dbPath = flag(rest, ["--db"], "scratch/cross-domain.sqlite");
    await mkdir(dbPath.slice(0, dbPath.lastIndexOf("/")) || ".", {
      recursive: true,
    });
    const db = openSportsdeskSqlite(dbPath);
    const store = createComboObservationsLegsStore(db);
    const registry = buildAttributionRegistry();
    if (rest.includes("--reset")) {
      db.run("DELETE FROM combo_observations_legs");
      db.run("DELETE FROM wallet_customer_attributions");
    }
    // countLegs() is a bigint under `safeIntegers: true`; never compare it to a number literal.
    const legCount = Number(store.countLegs());
    const empty = legCount === 0;
    if (empty) seedCrossDomainScenario(store, registry);
    else if (rest.includes("--seed") && !json) {
      console.error(
        `match: ${dbPath} already holds ${legCount} leg rows; re-run with --reset to rebuild`,
      );
    }
    const seeded = empty;

    const customerFilters = flagAll(rest, "--customer").map((value) =>
      value.trim().toUpperCase(),
    );
    const report = matchCustomerLegsAcrossVenues(db, {
      databasePath: dbPath,
      ...(customerFilters[0] === undefined
        ? {}
        : { customerId: customerFilters[0] }),
      maxLineDeltaHundredths: Number(flag(rest, ["--max-delta"], "100")),
      limit: Number(flag(rest, ["--limit"], "500")),
    });
    db.close();

    if (json) {
      console.log(JSON.stringify({ seeded, ...report }, null, 2));
      return;
    }
    console.log(
      "══════════════════════════════════════════════════════════════════════════════",
    );
    console.log(
      `  🔗 CROSS-DOMAIN LEG MATCHING — ${report.database}${seeded ? " (seeded)" : ""}`,
    );
    console.log(
      "══════════════════════════════════════════════════════════════════════════════",
    );
    console.log(`  matched legs   : ${report.matchedLegs}`);
    console.log(`  mirror picks   : ${report.mirrorLegs}`);
    console.log(
      `  opposite picks : ${report.oppositeLegs}   ← hedge shape, not proof`,
    );
    console.log(`  same line      : ${report.sameLineLegs}`);
    console.log(
      `  layoff-risk legs (PM line better): ${report.layoffRiskLegs}`,
    );
    rule("Per customer");
    for (const customer of report.customers) {
      console.log(
        `  ${customer.customerId.padEnd(12)} ${customer.agentId.slice(0, 10).padEnd(10)} ` +
          `matches ${String(customer.matches).padStart(3)} | mirror ${String(customer.mirror).padStart(3)} ` +
          `| opposite ${String(customer.opposite).padStart(3)} | layoff ${String(customer.layoffRiskLegs).padStart(3)} ` +
          `| avg Δ ${customer.avgDeltaHundredths ?? "n/a"}`,
      );
    }
    console.log(
      "══════════════════════════════════════════════════════════════════════════════",
    );
    return;
  }

  const book = await loadCustomerBook(bookPath);
  if (book.length === 0) {
    console.error(`bridge: no customers loaded from ${bookPath}`);
    process.exitCode = 1;
    return;
  }
  const registry = buildAttributionRegistry();

  if (sub === "coverage") {
    const report = buildCustomerPolyBridge({ customers: book, registry });
    if (json) {
      console.log(
        JSON.stringify(
          { coverage: report.coverage, quarantined: report.quarantined },
          null,
          2,
        ),
      );
      return;
    }
    printCoverage(report, registry, book);
    return;
  }

  if (sub !== "value") {
    console.error(
      `bridge: unknown subcommand "${sub}". Try: coverage | value | match`,
    );
    process.exitCode = 1;
    return;
  }

  const customerFilters = new Set(
    flagAll(rest, "--customer").map((value) => value.trim().toUpperCase()),
  );
  const links = registry.links.filter(
    (link) =>
      customerFilters.size === 0 || customerFilters.has(link.customerId),
  );
  const wallets = [...new Set(links.map((link) => link.wallet))];
  const live = rest.includes("--live");

  let observations = new Map<string, PolyObservation>();
  if (live) {
    const result = await fetchObservations(wallets, {
      cacheDir: flag(rest, ["--cache-dir"], "scratch/poly-bridge-cache"),
      fresh: rest.includes("--fresh"),
      concurrency: Math.max(1, Number(flag(rest, ["--concurrency"], "4"))),
    });
    observations = result.observations;
    if (!json) {
      console.error(
        `live: ${observations.size} wallets observed (${result.hits} cache hit / ${result.misses} miss)` +
          (result.failures.length > 0
            ? `, ${result.failures.length} failed`
            : ""),
      );
      for (const failure of result.failures) console.error(`  ! ${failure}`);
    }
  }

  const report = buildCustomerPolyBridge({
    customers: book.filter(
      (row) =>
        customerFilters.size === 0 || customerFilters.has(row.customerId),
    ),
    registry,
    observations,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printValue(report, Math.max(1, Number(flag(rest, ["--top"], "15"))));
}

if (import.meta.main) {
  runCustomerBridge(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
