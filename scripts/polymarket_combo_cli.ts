#!/usr/bin/env bun
/**
 * @file scripts/polymarket_combo_cli.ts
 * @description `dx combo` — CFB combo leg discovery, product-of-legs pricing and wallet combo lookups.
 *
 * Usage:
 *   ./bin/dx combo legs --limit 5
 *   ./bin/dx combo price --prices 0.38,0.80 --stake 10 --quoted 0.32
 *   ./bin/dx combo price --legs "cfb-nd-navy-2026-10-31=Notre Dame,cfb-uga-fsu-2026-10-31=Georgia"
 *   ./bin/dx combo wallet 0x26cf...
 */

import {
  buildComboUniquenessReport,
  buildGameIndex,
  checkComboSubset,
  comboIdLines,
  linesToText,
  loadCfbGames,
  seedWalletsFromLeaderboard,
  walletLines,
  type ComboGate,
  type ComboSubsetCheck,
  type ComboUniquenessOptions,
} from "../lib/combo_uniqueness.ts";
import { runComboBacktest } from "../lib/combo_backtest.ts";
import {
  CFB_SERIES_ID,
  fetchCfbComboEvents,
  priceCombo,
  resolveLegSpecs,
  summarizeComboWallet,
  type ComboEvent,
  type ComboPrice,
} from "../lib/polymarket_combo.ts";

const HELP = `Polymarket CFB combo helper

Usage:
  bun run scripts/polymarket_combo_cli.ts legs [--limit 10] [--include-started] [--json]
  bun run scripts/polymarket_combo_cli.ts price --prices 0.38,0.80 [--stake 10] [--quoted 0.32]
  bun run scripts/polymarket_combo_cli.ts price --legs "<marketSlug>=<Outcome>,..." [--limit 10]
  bun run scripts/polymarket_combo_cli.ts wallet <0x> [--limit 100] [--max-pages 5] [--json]
  bun run scripts/polymarket_combo_cli.ts uniqueness [--strict-full-game|--all-legs-cfb] [--json]
  bun run scripts/polymarket_combo_cli.ts verify-subset [--all-legs-cfb] [--against <gate>] [--chain]
  bun run scripts/polymarket_combo_cli.ts verify-subset --wallet-file <path> [--strict-exit]
  bun run scripts/polymarket_combo_cli.ts backtest [--days 30] [--wallets 0x..] [--all-venues] [--json]

Notes:
  • CFB markets come from Gamma series ${CFB_SERIES_ID}; legs are moneyline/spreads/totals.
  • Fair price is the product of leg probabilities (independent legs, raw prices include vig).
  • Combo discovery is user-anchored: /v2/positions/combos and /v2/activity/combos require a wallet.
  • uniqueness seeds wallets from the PnL leaderboard (add --seed-trades for CFB trades) and
    caches combo responses under scratch/cfb-combo-cache (CACHE_TTL_HOURS=24 by default,
    --cache-ttl-hours overrides, --fresh bypasses).
  • uniqueness flags: --open-only (active games only), --since YYYY-MM-DD, --max-game-pages N,
    --strict-full-game (STRICT_FULL_GAME=1), --all-legs-cfb, --cache-dir, --cache-ttl-hours,
    --seed-trades, --max-seed-markets, --wallet-file, --no-leaderboard, --no-audit,
    --emit-ids <path>, --dump-wallets <path>.
  • the game index is active+closed by default (settled games still hold unique combos) and
    paginates the whole series 12756; --open-only restores the old narrow view.
  • three gates, each a pure filter after attribution:
      permissive    = any combo touching a CFB game
      all-legs-cfb  = every leg is CFB and every leg's market_sport_type is
                      moneyline|spreads|totals (cross-game allowed)
      full-game     = all-legs-cfb AND single game
    A stricter gate is always a subset of a looser one. --json returns the active
    gate, mode-relative exclusions, includedCrossGame and a kept/dropReason audit.
  • verify-subset runs the reference and treatment reports in one process.
    Default reference = permissive, treatment = full-game (or all-legs-cfb).
      --against all-legs-cfb   assert full-game ⊆ all-legs-cfb
      --chain                  assert both edges: full-game ⊆ all-legs-cfb ⊆ permissive
    Exit 1 = leak. Exit 2 only with --strict-exit when an edge is vacuous
    (empty treatment); otherwise a vacuous edge warns and exits 0, so a
    structurally-zero gate does not fail unattended runs.
  • backtest computes realized PnL from SPLIT cost vs REDEEM/MERGE/SELL payout; open combos are
    excluded from realized totals, and --all-venues skips CFB game attribution.
  • Public APIs only; no key.`;

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

/** Shared `uniqueness` / `verify-subset` options. `gate` is the only per-run difference. */
function comboUniquenessOptions(
  args: readonly string[],
  gate: ComboGate,
): ComboUniquenessOptions {
  const env = Bun.env;
  const envFlag = (key: string): boolean => env[key] === "1";
  const walletFile = flag(args, ["--wallet-file"], env.WALLET_FILE ?? "");
  return {
    gate,
    fresh: args.includes("--fresh") || envFlag("FRESH"),
    leaderboard: !args.includes("--no-leaderboard") && env.LEADERBOARD !== "0",
    seedTrades: args.includes("--seed-trades") || envFlag("SEED_TRADES"),
    ...(walletFile !== "" ? { walletFile } : {}),
    limitGames: Number(flag(args, ["--limit-games"], "0")),
    includeClosedGames:
      !args.includes("--open-only") && env.INCLUDE_CLOSED_GAMES !== "0",
    ...(flag(args, ["--since"], "") === ""
      ? {}
      : { since: flag(args, ["--since"], "") }),
    maxGamePages: Number(flag(args, ["--max-game-pages"], "30")),
    concurrency: Number(flag(args, ["--concurrency"], env.CONCURRENCY ?? "6")),
    leaderboardLimit: Number(
      flag(args, ["--leaderboard-limit"], env.LEADERBOARD_LIMIT ?? "100"),
    ),
    maxSeedMarkets: Number(
      flag(args, ["--max-seed-markets"], env.MAX_SEED_MARKETS ?? "60"),
    ),
    maxComboPages: Number(flag(args, ["--max-combo-pages"], "3")),
    cacheDir: flag(
      args,
      ["--cache-dir"],
      env.CACHE_DIR ?? "scratch/cfb-combo-cache",
    ),
    cacheTtlHours: Number(
      flag(args, ["--cache-ttl-hours"], env.CACHE_TTL_HOURS ?? "24"),
    ),
    includeAudit: !args.includes("--no-audit"),
  };
}

const cents = (price: number): string => `${(price * 100).toFixed(1)}¢`;
const usd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function printLegs(events: readonly ComboEvent[], maxLegs = 12): void {
  const withLegs = events.filter((event) => event.legs.length > 0);
  if (withLegs.length === 0) {
    console.log(
      "No active CFB events with priced legs (in-progress games show 0/1 prices).",
    );
    return;
  }
  for (const event of withLegs) {
    console.log(`\n🏈 ${event.title} (${event.slug})`);
    for (const leg of event.legs.slice(0, maxLegs)) {
      const line = leg.line === null ? "" : ` ${leg.line}`;
      console.log(
        `   ${leg.marketType.padEnd(10)}${line.padEnd(6)} ${leg.outcome.padEnd(22)} @ ${cents(leg.price).padStart(7)}   [${leg.marketSlug}=${leg.outcome}]`,
      );
    }
    if (event.legs.length > maxLegs) {
      console.log(
        `   … +${event.legs.length - maxLegs} more legs (use --json for all)`,
      );
    }
  }
  const skipped = events.length - withLegs.length;
  if (skipped > 0)
    console.log(`\n(${skipped} event(s) had no priced legs and were skipped)`);
}

function printPrice(price: ComboPrice): void {
  console.log(
    `Legs: ${price.legPrices.map(cents).join(" × ")} = ${cents(price.fairPrice)} fair`,
  );
  console.log(
    `Stake ${usd(price.stakeUsd)} → ${usd(price.payoutUsd)} if all legs win (${price.payoutMultiple.toFixed(2)}x)`,
  );
  if (
    price.quotedPrice !== null &&
    price.quotedPayoutUsd !== null &&
    price.makerMarginPct !== null
  ) {
    console.log(
      `Quoted ${cents(price.quotedPrice)} → ${usd(price.quotedPayoutUsd)} | maker margin ${price.makerMarginPct.toFixed(1)}% over fair`,
    );
  }
}

export async function runPolymarketCombo(
  argv: readonly string[],
): Promise<void> {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help") || args.length === 0) {
    console.log(HELP);
    return;
  }
  const sub = args[0]!;
  const json = args.includes("--json");
  const limit = Number(flag(args, ["--limit"], "5"));

  if (sub === "legs") {
    const legsLimit = Number(flag(args, ["--limit"], "10"));
    const maxLegs = Number(flag(args, ["--max-legs"], "12"));
    const events = await fetchCfbComboEvents({
      limit: Number.isFinite(legsLimit) ? legsLimit : 10,
      pregameOnly: !args.includes("--include-started"),
    });
    if (json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    printLegs(events, Number.isFinite(maxLegs) ? maxLegs : 12);
    return;
  }

  if (sub === "price") {
    const stake = Number(flag(args, ["--stake"], "10"));
    const quotedRaw = flag(args, ["--quoted"], "");
    const quoted = quotedRaw === "" ? null : Number(quotedRaw);
    const pricesRaw = flag(args, ["--prices"], "");
    let legPrices: number[] = [];
    if (pricesRaw !== "") {
      legPrices = pricesRaw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((price) => Number.isFinite(price));
    } else {
      const specsRaw = flag(args, ["--legs"], "");
      if (specsRaw === "") {
        console.error(
          'price: provide --prices 0.38,0.80 or --legs "<slug>=<Outcome>,..."',
        );
        process.exitCode = 1;
        return;
      }
      const events = await fetchCfbComboEvents({
        limit: Number(flag(args, ["--limit"], "10")),
      });
      const resolved = resolveLegSpecs(
        specsRaw
          .split(",")
          .map((spec) => spec.trim())
          .filter((spec) => spec !== ""),
        events,
      );
      if (resolved.missing.length > 0) {
        console.error(
          `price: could not resolve: ${resolved.missing.join(" | ")}`,
        );
        process.exitCode = 1;
        return;
      }
      legPrices = resolved.legs.map((leg) => leg.price);
    }
    const price = priceCombo(legPrices, {
      stakeUsd: Number.isFinite(stake) ? stake : 10,
      quotedPrice: quoted !== null && Number.isFinite(quoted) ? quoted : null,
    });
    if (json) {
      console.log(JSON.stringify(price, null, 2));
      return;
    }
    printPrice(price);
    return;
  }

  if (sub === "uniqueness" || sub === "verify-subset") {
    const gate: ComboGate =
      args.includes("--all-legs-cfb") || Bun.env.ALL_LEGS_CFB === "1"
        ? "all-legs-cfb"
        : args.includes("--strict-full-game") ||
            Bun.env.STRICT_FULL_GAME === "1"
          ? "full-game"
          : "permissive";

    if (sub === "verify-subset") {
      const strictExit = args.includes("--strict-exit");
      const chain = args.includes("--chain");
      const treatmentGate: ComboGate = args.includes("--all-legs-cfb")
        ? "all-legs-cfb"
        : "full-game";
      const referenceArg = flag(
        args,
        ["--against"],
        "permissive",
      ).toLowerCase();
      const referenceGate: ComboGate =
        referenceArg === "all-legs-cfb" || referenceArg === "cfb"
          ? "all-legs-cfb"
          : referenceArg === "full-game"
            ? "full-game"
            : "permissive";

      if (!chain && referenceGate === treatmentGate) {
        console.error(
          `verify-subset: treatment and reference are both "${treatmentGate}"; nothing to prove`,
        );
        process.exitCode = 1;
        return;
      }

      const checks: ComboSubsetCheck[] = [];
      if (chain) {
        // full-game ⊆ all-legs-cfb ⊆ permissive, asserted edge by edge.
        const permissive = await buildComboUniquenessReport(
          comboUniquenessOptions(args, "permissive"),
        );
        const cfbOnly = await buildComboUniquenessReport(
          comboUniquenessOptions(args, "all-legs-cfb"),
        );
        const fullGame = await buildComboUniquenessReport(
          comboUniquenessOptions(args, "full-game"),
        );
        checks.push(checkComboSubset(permissive, cfbOnly));
        checks.push(checkComboSubset(cfbOnly, fullGame));
      } else {
        const reference = await buildComboUniquenessReport(
          comboUniquenessOptions(args, referenceGate),
        );
        const treatment = await buildComboUniquenessReport(
          comboUniquenessOptions(args, treatmentGate),
        );
        checks.push(checkComboSubset(reference, treatment));
      }

      const leaks = checks.reduce((sum, check) => sum + check.leaks.length, 0);
      const vacuous = checks.some((check) => check.vacuous);
      if (json) {
        console.log(
          JSON.stringify(
            { chain, checks, leaks, vacuous, strictExit },
            null,
            2,
          ),
        );
      } else {
        for (const check of checks) {
          console.log(
            `subset ${check.treatmentGate} ⊆ ${check.referenceGate} — reference ${check.reference}, treatment ${check.treatment}, leaks ${check.leaks.length}`,
          );
          if (check.vacuous) {
            console.log(
              `WARNING: ${check.treatmentGate} set empty — this edge is VACUOUS`,
            );
          }
          for (const leak of check.leaks.slice(0, 20))
            console.log(`  LEAK ${leak}`);
        }
        if (vacuous && strictExit)
          console.log("--strict-exit: failing on vacuous edge");
      }
      if (leaks > 0) process.exitCode = 1;
      else if (vacuous && strictExit) process.exitCode = 2;
      return;
    }

    const report = await buildComboUniquenessReport(
      comboUniquenessOptions(args, gate),
    );
    const emitPath = flag(args, ["--emit-ids"], "");
    const dumpPath = flag(args, ["--dump-wallets"], "");
    if (emitPath !== "") {
      await Bun.write(emitPath, linesToText(comboIdLines(report)));
    }
    if (dumpPath !== "") {
      await Bun.write(dumpPath, linesToText(walletLines(report)));
    }
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const gateLabel =
      report.gate === "permissive"
        ? ""
        : report.gate === "full-game"
          ? " (strict full-game)"
          : " (all legs CFB)";
    console.log(
      `CFB combo uniqueness${gateLabel} — games ${report.games.length}, wallets scanned ${report.walletsScanned}`,
    );
    console.log(
      `   index               : ${report.index.games} games · ${report.index.activeOnly ? "open-only" : "active+closed"}${report.index.since === null ? "" : ` · since ${report.index.since}`}`,
    );
    for (const game of report.games.filter((entry) => entry.uniqueCombos > 0)) {
      console.log(`\n🏈 ${game.title} (${game.gameSlug})`);
      console.log(
        `   combos ${game.uniqueCombos} | wallets ${game.uniqueWallets} | fully within game ${game.fullyWithinGame}`,
      );
      for (const sample of game.samples) {
        console.log(
          `   • ${sample.comboId.slice(0, 16)}… by ${sample.wallet.slice(0, 10)}… (${sample.legs} legs, ${sample.games} game${sample.games > 1 ? "s" : ""})`,
        );
      }
    }
    console.log("\nGlobal");
    console.log(`   games with activity : ${report.global.gamesWithActivity}`);
    console.log(`   distinct combos     : ${report.global.distinctCombos}`);
    console.log(`   distinct wallets    : ${report.global.distinctWallets}`);
    console.log(`   sum per-game combos : ${report.global.sumPerGameCombos}`);
    console.log(
      `   permissive combos   : ${report.permissiveCombos} (before the gate)`,
    );
    console.log(
      `   duplicates collapsed: ${report.duplicatesCollapsed} (comboId or leg-set)`,
    );
    console.log(
      `   dedupe by id / leg-set: ${report.duplicatesCollapsedById} / ${report.duplicatesCollapsedByLegSet}`,
    );
    console.log(
      `   legs without side   : ${report.diagnostics.legsWithoutSide}`,
    );
    if (report.diagnostics.legsWithoutSide > 0) {
      console.log(
        "   note                : unsided legs cannot match a sided source; cross-indexer dedupe is inert for them",
      );
    }
    if (report.gate !== "permissive") {
      const e = report.exclusions;
      const crossGame =
        report.gate === "full-game"
          ? `cross-game ${e.CROSS_GAME}`
          : "cross-game included";
      console.log(
        `   gate drops          : unresolved legs ${e.UNRESOLVED_LEGS} | ${crossGame} | ineligible type ${e.INELIGIBLE_LEG_TYPE}`,
      );
      console.log(`   included cross-game : ${report.includedCrossGame}`);
      if (e.UNRESOLVED_LEGS > 0) {
        console.log(
          "   note                : count is a FLOOR (unresolved legs are dropped)",
        );
      }
    }
    const unresolved = report.diagnostics.unresolved;
    if (
      unresolved.combos > 0 ||
      report.diagnostics.combosWithoutAttribution > 0
    ) {
      console.log(
        `   unresolved legs     : ${unresolved.combos} partial, ${report.diagnostics.combosWithoutAttribution} fully unresolved, ` +
          `${unresolved.legs} legs, ${unresolved.distinctLegKeys} distinct (${unresolved.oneOffLegKeys} one-off / ${unresolved.systemicLegKeys} systemic)`,
      );
      console.log(
        `   CFB touch rate      : ${report.diagnostics.cfbTouchRatePct}% of observed combos (non-CFB combos count against it)`,
      );
      console.log(
        `   combo-of-combo keys : ${report.diagnostics.suspectedComboOfComboLegKeys} (zero-padded, 404 on CLOB)`,
      );
      for (const entry of unresolved.top.slice(0, 3)) {
        console.log(
          `     • ${entry.legKey.slice(0, 46)} in ${entry.combos} combo${entry.combos === 1 ? "" : "s"}`,
        );
      }
    }
    console.log(
      `   cache               : ${report.cache.hits} hit / ${report.cache.misses} miss (ttl ${report.cache.ttlHours}h)`,
    );
    return;
  }

  if (sub === "backtest") {
    const env = Bun.env;
    const days = Number(flag(args, ["--days"], "30"));
    const cfbOnly = !args.includes("--all-venues");
    const walletArg = flag(args, ["--wallets"], "");
    let wallets = walletArg
      .split(",")
      .map((wallet) => wallet.trim().toLowerCase())
      .filter((wallet) => /^0x[0-9a-f]{40}$/.test(wallet));
    const walletFile = flag(args, ["--wallet-file"], env.WALLET_FILE ?? "");
    if (wallets.length === 0 && walletFile !== "") {
      try {
        wallets = (await Bun.file(walletFile).text())
          .split(/\s+/)
          .map((wallet) => wallet.trim().toLowerCase())
          .filter((wallet) => /^0x[0-9a-f]{40}$/.test(wallet));
      } catch {
        console.error(`backtest: cannot read ${walletFile}`);
        process.exitCode = 1;
        return;
      }
    }
    if (wallets.length === 0) {
      const seeded = await seedWalletsFromLeaderboard({
        leaderboardLimit: Number(flag(args, ["--leaderboard-limit"], "25")),
      });
      wallets = [...seeded];
    }
    if (wallets.length === 0) {
      console.error(
        "backtest: no wallets (pass --wallets/--wallet-file or seed the leaderboard)",
      );
      process.exitCode = 1;
      return;
    }

    let gameIndex: ReadonlyMap<string, string> | undefined;
    let gameBySlug: ReadonlyMap<string, string> | undefined;
    if (cfbOnly) {
      const games = await loadCfbGames({
        limitGames: Number(flag(args, ["--limit-games"], "50")),
      });
      const index = buildGameIndex(games);
      gameIndex = index.byConditionId;
      gameBySlug = index.byMarketSlug;
    }
    const report = await runComboBacktest({
      wallets,
      days: Number.isFinite(days) ? days : 30,
      cfbOnly,
      ...(gameIndex === undefined ? {} : { gameIndex }),
      ...(gameBySlug === undefined ? {} : { gameBySlug }),
      maxPages: Number(flag(args, ["--max-combo-pages"], "5")),
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const roi = (value: number | null): string =>
      value === null ? "n/a" : `${value.toFixed(1)}%`;
    console.log(
      `Combo backtest ${report.fromIso.slice(0, 10)}..${report.toIso.slice(0, 10)} | wallets ${report.wallets} | ${report.cfbOnly ? "CFB only" : "all venues"}`,
    );
    console.log(
      `  combos ${report.totals.combos} (settled ${report.totals.settled}, open ${report.totals.open}) | cost ${usd(report.totals.costUsd)} | payout ${usd(report.totals.payoutUsd)} | pnl ${usd(report.totals.pnlUsd)} | ROI ${roi(report.totals.roiPct)} | win ${roi(report.totals.winRatePct)}`,
    );
    console.log(
      `  avg legs ${report.totals.avgLegs} | cross-game ${roi(report.totals.crossGamePct)}`,
    );
    if (report.byDay.length > 0) {
      console.log("\n  Day         combos    cost     payout      pnl     ROI");
      for (const day of report.byDay.slice(-14)) {
        console.log(
          `  ${day.date}  ${String(day.combos).padStart(5)}  ${usd(day.costUsd).padStart(9)}  ${usd(day.payoutUsd).padStart(9)}  ${usd(day.pnlUsd).padStart(8)}  ${roi(day.roiPct).padStart(8)}`,
        );
      }
    }
    if (report.byGame.length > 0) {
      console.log("\n  Top games by PnL");
      for (const game of report.byGame.slice(0, 10)) {
        console.log(
          `  ${game.game.padEnd(34)} combos ${String(game.combos).padStart(3)}  cost ${usd(game.costUsd).padStart(9)}  pnl ${usd(game.pnlUsd).padStart(9)}`,
        );
      }
    }
    return;
  }

  if (sub === "wallet") {
    const wallet = args.find((arg, index) => index > 0 && !arg.startsWith("-"));
    if (wallet === undefined || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      console.error("wallet: provide a 0x wallet address");
      process.exitCode = 1;
      return;
    }
    const maxPages = Number(flag(args, ["--max-pages"], "5"));
    const summary = await summarizeComboWallet(wallet, {
      limit: Number.isFinite(limit) ? limit : 100,
      maxPages: Number.isFinite(maxPages) ? maxPages : 5,
    });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`Combo wallet ${summary.wallet}`);
    console.log(
      `  open ${summary.openPositions}  |  open cost ${usd(summary.openCostUsd)}  |  pages ${summary.pages}${summary.truncated ? " (truncated)" : ""}`,
    );
    for (const [type, bucket] of Object.entries(
      summary.activityByType,
    ).sort()) {
      console.log(
        `  ${type.padEnd(10)} ${String(bucket.count).padStart(4)}  ${usd(bucket.amountUsd)}`,
      );
    }
    console.log("");
    for (const position of summary.positions.slice(0, 10)) {
      console.log(
        `  • ${position.outcome} · ${position.status} — cost ${usd(position.entryCostUsd)} @ ${cents(position.entryAvgPrice)} | legs ${position.legsResolved}/${position.legsTotal}`,
      );
      for (const leg of position.legs) {
        console.log(
          `      ${leg.marketSlug || leg.conditionId.slice(0, 12)} ${leg.outcome} ${leg.status}${leg.currentPrice === null ? "" : ` @ ${cents(leg.currentPrice)}`}`,
        );
      }
    }
    return;
  }

  console.error(`combo: unknown subcommand "${sub}"\n`);
  console.log(HELP);
  process.exitCode = 1;
}

if (import.meta.main) {
  runPolymarketCombo(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `combo: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
