#!/usr/bin/env bun
/**
 * @file scripts/customer_wager_review.ts
 * @description One-command wager review for a customer login: pending exposure, settled record,
 * behavioural findings and the limits of what the local artifacts can prove.
 *
 *   bun run wagers:review TTN97
 *   bun run wagers:review TTN97 --json
 *   bun run wagers:review TTN97 --root tests/fixtures/customer-wager-review
 *
 * The review reads the pending capture, the ticker capture, the graded-wager exports, the newest
 * users report, the agent roster and the suspected-bot ledger — each reported independently, so a
 * missing source is MISSING and never an empty observation. Nothing is fetched from the live
 * manager API.
 *
 * Exit codes: 0 reviewed, 2 usage, 3 the login is in no wager source.
 */

import { resolve } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import { loadCustomerWagerArtifacts } from "../lib/customer_wager_artifacts.ts";
import { clipDisplay, wrapDisplay } from "../lib/terminal_format.ts";
import {
  buildCustomerWagerReview,
  type CustomerWagerReview,
  type ReviewSource,
} from "../lib/customer_wager_review.ts";

const HELP = `
customer wager review — one login, reconciled across the local artifacts

Usage:
  bun run wagers:review <customerId> [options]
  bun run customer:wagers <customerId> [options]

Options:
  --root <dir>    Checkout root the default artifact paths are relative to
                  (default: this repository)
  --json          Machine-readable review (always carries cards/expectation/peers/platform)
  --deep          Text view: add peers, platform context and the reconstructed card detail
  --limit <n>     Rows per table in the text view (1-50, default 8)
  -h, --help      This text

What it reads (each independently, MISSING is reported as MISSING):
  data/live-bets.json                                  Pending capture
  data/live-wagers.json                                Tickertape capture
  Scratch/graded/graded-today.json                     graded wagers
  Scratch/graded/graded-oct-window.json                graded wagers, older window
  Scratch/gslive-reports-*/users-report-*.json         newest users report
  Scratch/raw-f402-list-agents.json                    agent roster
  Scratch/f402-suspected-bots-raw-ledger-bundle.json   ledger tenure
  enriched_customers_full.json                         customer book (presence only)

Examples:
  bun run wagers:review TTN97
  bun run wagers:review player_TTN97 --json
  bun run wagers:review TTN97 --root /path/to/fixtures

Exit codes: 0 reviewed, 2 usage, 3 not present in any wager source.
`.trim();

const VALUE_FLAGS = ["--root", "--limit"] as const;
const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: VALUE_FLAGS });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const customerId = parsed.positionals[0]?.trim() ?? "";
if (customerId === "") {
  console.error(HELP);
  process.exit(2);
}

const root = flagValue(parsed, "--root", resolve(import.meta.dir, ".."));
const json = hasFlag(parsed, "--json");
const deep = hasFlag(parsed, "--deep");
const limitArg = Number(flagValue(parsed, "--limit", "8"));
const limit = Number.isFinite(limitArg)
  ? Math.min(50, Math.max(1, Math.floor(limitArg)))
  : 8;

const loaded = await loadCustomerWagerArtifacts({ customerId, root });
const review = buildCustomerWagerReview(loaded);

if (!review.found) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          success: false,
          schemaVersion: 1,
          command: "customer-wager-review",
          customerId: review.customerId,
          found: false,
          generatedAt: review.generatedAt,
          error: {
            code: "unknown_customer",
            message: `"${review.customerId}" is in none of the wager sources under ${root}.`,
          },
          sources: review.sources,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(
      `${review.customerId}: not present in any wager source under ${root}.`,
    );
    for (const source of review.sources) {
      console.error(
        `  ${sourceMark(source)} ${source.label} — ${sourceState(source)}`,
      );
    }
    console.error(
      "Nothing was invented from absence: every source above is reported as it was found.",
    );
  }
  process.exit(3);
}

if (json) {
  console.log(
    JSON.stringify(
      { success: true, command: "customer-wager-review", ...review },
      null,
      2,
    ),
  );
  process.exit(0);
}

// The text renderer runs after its helpers are initialized (see the end of the file).

function sourceState(source: ReviewSource): string {
  if (!source.exists) {
    return source.note ?? "MISSING";
  }
  const rows =
    source.records === null ? "rows unreadable" : `${source.records} row(s)`;
  const age =
    source.ageMinutes === null
      ? "mtime unknown"
      : `${Math.round(source.ageMinutes)} min old`;
  return `${rows}, ${age}`;
}

function sourceMark(source: ReviewSource): string {
  if (!source.exists) return "✗";
  return source.found ? "✓" : "·";
}

function line(char = "─", width = 78): string {
  return char.repeat(width);
}

function printReview(
  r: CustomerWagerReview,
  rowLimit: number,
  deep: boolean,
): void {
  const identity = r.identity;
  console.log(`\n${r.customerId} — wager review  (${r.generatedAt})`);
  console.log(line("═"));
  console.log(
    `  agent ${identity.agent ?? "—"}` +
      `  ·  userId ${identity.userIds.join(", ") || "—"}` +
      `  ·  group ${identity.groups.join(", ") || "—"}`,
  );
  console.log(
    `  suspected bot ${identity.suspectedBot === null ? "not measured" : identity.suspectedBot ? "yes" : "no"}` +
      `  ·  credit account ${identity.creditAccount === null ? "not measured" : identity.creditAccount ? "yes" : "no"}` +
      `  ·  free-play wagers ${identity.freePlayWagers}` +
      `  ·  writers ${identity.writers.join(", ") || "—"}`,
  );

  console.log(`\nsources`);
  for (const source of r.sources) {
    const matched =
      source.found || source.matchedRows > 0
        ? `  -> ${source.matchedRows} row(s) this customer`
        : "";
    console.log(
      `  ${sourceMark(source)} ${source.id.padEnd(12)} ${sourceState(source)}${matched}`,
    );
    console.log(`    ${source.path || "(no path)"}`);
  }

  console.log(`\nopen exposure  (${r.pending.rows} ticket(s))`);
  if (r.pending.rows === 0) {
    console.log("  none in the pending capture");
  } else {
    console.log(
      `  ${usd(r.pending.riskUsd)} at risk  ->  ${usd(r.pending.toWinUsd)} to win` +
        (r.pending.impliedProbabilitySum === null
          ? ""
          : `  ·  combined implied ${(r.pending.impliedProbabilitySum * 100).toFixed(2)}%`),
    );
    console.log(
      `  capture ${usd(r.pending.capture.riskUsd)} risk / ${usd(r.pending.capture.toWinUsd)} to win` +
        ` across ${r.pending.capture.customers} customer(s)` +
        (r.pending.share.riskPct === null
          ? ""
          : `  ->  ${r.pending.share.riskPct.toFixed(2)}% of risk, ${r.pending.share.toWinPct?.toFixed(2) ?? "—"}% of to-win`),
    );
    console.log(
      `  placedAt           selection                         price     stake        to win    implied`,
    );
    for (const wager of r.pending.wagers.slice(0, rowLimit)) {
      console.log(
        `  ${wager.placedAt.padEnd(18)} ${truncate(wager.selection, 32).padEnd(32)} ` +
          `${formatPrice(wager.priceAmerican).padStart(6)} ${usd(wager.riskUsd).padStart(11)} ` +
          `${usd(wager.toWinUsd).padStart(12)}   ` +
          `${wager.impliedProbability === null ? "—" : `${(wager.impliedProbability * 100).toFixed(1)}%`}`,
      );
    }
    if (r.pending.wagers.length > rowLimit) {
      console.log(`  … ${r.pending.wagers.length - rowLimit} more`);
    }
    if (r.pending.singleMarket !== null) {
      const market = r.pending.singleMarket;
      console.log(
        `\n  one market: ${market.sport} / ${market.subSport} / ${market.period}`,
      );
      for (const outcome of market.outcomes) {
        console.log(
          `    if ${truncate(outcome.selection, 28).padEnd(28)} wins -> ${usd(outcome.netUsd).padStart(12)}` +
            `  (${outcome.tickets} ticket(s), ${usd(outcome.returnUsd)} returned)`,
        );
      }
      console.log(
        `    best ${usd(market.bestNetUsd)} · worst ${usd(market.worstNetUsd)} · ${market.note}`,
      );
    }
  }

  const s = r.settled;
  console.log(
    `\nsettled  (${s.rows} wager(s) / ${s.tickets} ticket(s), ` +
      `${s.firstPlacedAt ?? "—"} → ${s.lastPlacedAt ?? "—"})`,
  );
  if (s.rows === 0) {
    console.log("  no graded rows in the exports");
  } else {
    console.log(
      `  staked ${usd(s.riskUsd)}` +
        (s.freePlayRiskUsd > 0
          ? ` (incl. ${usd(s.freePlayRiskUsd)} free play)`
          : "") +
        `  ·  profit ${usd(s.profitUsd)}  ·  lost ${usd(s.lostUsd)}` +
        `  ·  net ${usd(s.netUsd)}` +
        (s.roiPct === null ? "" : ` (${s.roiPct.toFixed(1)}%)`),
    );
    if (s.freePlayRiskUsd > 0) {
      console.log(
        `  cash-only: ${usd(s.cashRiskUsd)} staked, net ${usd(s.cashNetUsd)}` +
          (s.cashRoiPct === null ? "" : ` (${s.cashRoiPct.toFixed(1)}%)`),
      );
    }
    console.log(
      `  W-L ${s.wins}-${s.losses}` +
        (s.other > 0 ? ` (+${s.other} other)` : "") +
        (s.winRatePct === null ? "" : `  ·  ${s.winRatePct.toFixed(1)}%`) +
        `  ·  book-implied expectation ${r.expectation.expectedWins.toFixed(2)} wins` +
        ` (delta ${r.expectation.delta >= 0 ? "+" : ""}${r.expectation.delta.toFixed(2)})`,
    );
    const concentration = s.concentration;
    console.log(
      `  concentration: ${concentration.activeDays} active day(s)` +
        (concentration.topDay === null
          ? ""
          : `  ·  top day ${concentration.topDay.date} ${usd(concentration.topDay.riskUsd)}` +
            ` (${concentration.topDay.sharePct?.toFixed(1) ?? "—"}% of ` +
            `${usd(concentration.denominatorUsd)} settled handle)`) +
        (concentration.topTicket === null
          ? ""
          : `  ·  top ticket ${concentration.topTicket.ticket} ` +
            `${usd(concentration.topTicket.riskUsd)} ` +
            `(${concentration.topTicket.sharePct?.toFixed(1) ?? "—"}% of the same denominator)`),
    );
    console.log(
      `\n  structure        wagers      staked           net      W-L`,
    );
    for (const bucket of s.byStructure) {
      console.log(
        `  ${bucket.label.padEnd(14)} ${String(bucket.wagers).padStart(5)} ` +
          `${usd(bucket.riskUsd).padStart(12)} ${usd(bucket.netUsd).padStart(13)} ` +
          `${String(bucket.wins)}-${bucket.losses}`,
      );
    }
    const tickets = [...s.byTicket]
      .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))
      .slice(0, rowLimit);
    if (tickets.length > 0) {
      console.log(
        `\n  ticket            placedAt            wagers  picks        risk           net`,
      );
      for (const ticket of tickets) {
        console.log(
          `  ${ticket.ticket.padEnd(17)} ${ticket.placedAt.padEnd(19)} ` +
            `${String(ticket.wagers).padStart(6)}  ${ticket.picks.join("/").padEnd(9)} ` +
            `${usd(ticket.riskUsd).padStart(11)} ${usd(ticket.netUsd).padStart(13)}` +
            (ticket.freePlayWagers > 0 ? "  free play" : ""),
        );
      }
    }
  }

  for (const card of r.cards) {
    console.log(
      `\ncard ${card.ticket} — ${card.legs.length} selections, ${card.slots} slots ` +
        `(${card.bookedSlots} booked, ${card.omittedSlots} omitted)`,
    );
    if (card.reason !== null) {
      console.log(`  not reconstructed: ${wrap(card.reason, 70, "  ")}`);
      continue;
    }
    console.log(`  selection                     price  implied  outcome`);
    for (const leg of card.legs) {
      console.log(
        `  ${truncate(leg.selection, 28).padEnd(28)} ${formatPrice(leg.priceAmerican).padStart(7)}  ` +
          `${leg.impliedProbability === null ? "—" : `${(leg.impliedProbability * 100).toFixed(1)}%`}`.padStart(
            7,
          ) +
          `  ${leg.outcome ?? "—"}`,
      );
    }
    console.log(
      `  layer        slots  booked      staked           net     W-L`,
    );
    for (const layer of card.layers) {
      console.log(
        `  ${`${layer.picks}-leg`.padEnd(10)} ${String(layer.slots).padStart(6)} ` +
          `${String(layer.booked).padStart(7)} ${usd(layer.stakedUsd).padStart(11)} ` +
          `${usd(layer.netUsd).padStart(13)} ${`${layer.wins}-${layer.losses}`.padStart(6)}`,
      );
    }
    if (card.coverage !== null) {
      console.log(
        `  coverage: all-winner ${card.coverage.allWinnerBooked}/${card.coverage.allWinnerSlots} ` +
          `booked (${card.coverage.allWinnerBookingRatePct ?? "—"}%) · has-loser ` +
          `${card.coverage.hasLoserBooked}/${card.coverage.hasLoserSlots} ` +
          `(${card.coverage.hasLoserBookingRatePct ?? "—"}%)`,
      );
    }
    if (card.counterfactualNetUsd !== null) {
      console.log(
        `  full-card counterfactual: ${usd(card.counterfactualNetUsd)} ` +
          "(omitted slots at the median stake for their size; not observed)",
      );
    }
    if (card.probability !== null) {
      console.log(
        `  book prices: P(all ${card.legs.length}) ${card.probability.allLegsPct?.toFixed(2) ?? "—"}%` +
          (card.probability.atLeastRealizedPct === null
            ? ""
            : ` · P(>= ${card.probability.realizedWinners} winners) ` +
              `${card.probability.atLeastRealizedPct.toFixed(2)}%`),
      );
    }
  }

  if (deep) {
    console.log(`\npeers`);
    if (r.peers === null) {
      console.log("  no ledger-tenure population in the bundle");
    } else {
      console.log(
        `  ledger-tenure population: ${r.peers.population.toLocaleString("en-US")} accounts`,
      );
      const rows: Array<[string, string, number | null, string, string]> = [
        [
          "wager rows",
          String(r.peers.tickets.value),
          r.peers.tickets.percentile,
          String(r.peers.tickets.median),
          String(r.peers.tickets.p90),
        ],
        [
          "handle",
          usd(r.peers.handleUsd.value),
          r.peers.handleUsd.percentile,
          usd(r.peers.handleUsd.median),
          usd(r.peers.handleUsd.p90),
        ],
        [
          "net",
          usd(r.peers.netUsd.value),
          r.peers.netUsd.percentile,
          usd(r.peers.netUsd.median),
          usd(r.peers.netUsd.p90),
        ],
      ];
      console.log(`  metric       value       pct    median          p90`);
      for (const [label, value, pct, med, p90] of rows) {
        console.log(
          `  ${label.padEnd(12)} ${value.padStart(10)}  ${pct === null ? "—" : `p${pct.toFixed(1)}`}`.padEnd(
            26,
          ) + `${med.padStart(10)} ${p90.padStart(12)}`,
        );
      }
      console.log(`  ${r.peers.note}`);
    }

    console.log(`\nplatform`);
    if (r.platform === null) {
      console.log("  no graded activity days, so no platform window");
    } else {
      console.log(
        `  ${r.platform.days.join(", ")}: ${r.platform.rows.toLocaleString("en-US")} wagers · ` +
          `${r.platform.customers} customers · ${r.platform.multiLegSharePct ?? "—"}% multi-leg · ` +
          `median stake ${r.platform.medianStakeUsd === null ? "—" : usd(r.platform.medianStakeUsd)} · ` +
          `p90 ${r.platform.p90StakeUsd === null ? "—" : usd(r.platform.p90StakeUsd)}`,
      );
      if (r.platform.largestMultiLegTicket !== null) {
        const biggest = r.platform.largestMultiLegTicket;
        console.log(
          `  largest multi-leg ticket: ${biggest.customerId} ${biggest.ticket} ` +
            `(${biggest.wagers} wagers, max ${biggest.picks} legs, ${usd(biggest.riskUsd)})`,
        );
      }
      console.log(`  ${r.platform.note}`);
    }

    console.log(`\ncard norms`);
    const norms = r.cardNorms;
    if (norms.candidateTickets === 0) {
      console.log("  no candidate cards in the graded corpus");
    } else {
      const reasons = Object.entries(norms.refusalReasons)
        .filter(([key]) => key !== "solved")
        .map(([key, count]) => `${key} ${count}`)
        .join(", ");
      console.log(
        `  candidates ${norms.candidateTickets} · solved ${norms.solved} · refused ${norms.refused}` +
          ` · unparseable ${norms.unparseable}` +
          (reasons === "" ? "" : ` (${reasons})`),
      );
      console.log(
        `  pooled booking ${norms.minBookingPct ?? "—"}–${norms.maxBookingPct ?? "—"}%` +
          ` · median ${norms.medianBookingPct ?? "—"}% (n=${norms.solved})`,
      );
      const band = norms.comparable;
      console.log(
        `  >=${band.minWagers}-wager band ${band.minPct ?? "—"}–${band.maxPct ?? "—"}%` +
          ` · median ${band.medianPct ?? "—"}% (n=${band.n})` +
          (norms.truncated ? " · TRUNCATED at the group cap" : ""),
      );
      for (const card of r.cards) {
        if (card.reason !== null || card.bookedSlots < band.minWagers) continue;
        const rate = Math.round((card.bookedSlots / card.slots) * 10000) / 100;
        const lower = band.bookingRatesPct.filter(
          (value) => value < rate,
        ).length;
        console.log(
          `  this card ${card.ticket} books ${rate}% — ` +
            `${lower + 1}${lower === 0 ? "st (lowest)" : lower === 1 ? "nd lowest" : lower === 2 ? "rd lowest" : "th lowest"}` +
            ` of ${band.n} in the band`,
        );
      }
      console.log(`  ${norms.note}`);
    }
  }

  console.log(`\nfindings  (${r.findings.length})`);
  if (r.findings.length === 0) {
    console.log("  none of the review rules fired");
  }
  for (const finding of r.findings) {
    console.log(`\n  [${finding.severity}] ${finding.title}`);
    console.log(`  ${wrap(finding.detail, 74, "  ")}`);
    console.log(`  evidence: ${compactEvidence(finding.evidence)}`);
  }

  console.log(`\nlimits`);
  for (const limitation of r.limitations) {
    console.log(`  - ${wrap(limitation, 74, "    ")}`);
  }
  if (r.ledger !== null) {
    console.log(
      `\nledger cross-check: ${r.ledger.matchesSettled ? "agrees with the parsed exports" : "DISAGREES — reconcile"}` +
        ` (${r.ledger.totalTickets ?? "—"} tickets, ${usd(r.ledger.wageredUsd ?? 0)} wagered, ` +
        `${usd(r.ledger.netUsd ?? 0)} net)`,
    );
  }
  console.log("");
}

const usd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function formatPrice(american: number | null): string {
  if (american === null) return "—";
  return american > 0 ? `+${american}` : String(american);
}

/** Columns, not UTF-16 units, so a selection with emoji still fits its slot. */
function truncate(value: string, width: number): string {
  return clipDisplay(value, width);
}

/**
 * Wrap prose to the report's column budget, continuing under `indent`.
 *
 * `Bun.wrapAnsi` preserves ANSI state and hard-breaks a token longer than the width; the previous
 * hand-rolled loop counted `length` and left an over-wide URL on one line.
 */
function wrap(value: string, width: number, indent: string): string {
  return wrapDisplay(value, width, {
    hard: true,
    wordWrap: true,
    trim: true,
  }).join(`\n${indent}`);
}

function compactEvidence(evidence: Readonly<Record<string, unknown>>): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key}=${formatEvidenceValue(value)}`)
    .join(" · ");
}

function formatEvidenceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.length > 6 ? `${value.slice(0, 6).join(", ")}, …` : value.join(", ")}]`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

printReview(review, limit, deep);
