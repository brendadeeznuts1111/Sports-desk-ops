#!/usr/bin/env bun
/**
 * Read-only execution plan from the CLI.
 *
 *   bun run execution:plan                  # operator table (paper-first)
 *   bun run execution:plan --json           # the same envelope as GET /api/execution/plan
 *   bun run execution:plan --limit 10
 *   bun run execution:plan --paper-run      # also append paper fills/quotes to the local ledger
 *
 * Planning reads public books only (Kalshi events/orderbook, Polymarket gamma/CLOB). It never
 * places an order: live placement lives in `lib/kalshi_live_execution.ts` and is reachable only
 * through POST /api/execution/run behind the full env + credentials + confirm gate.
 */
import { resolve } from "node:path";
import { buildExecutionPlan } from "../lib/execution_planner.ts";
import {
  appendExecutionLedgerRow,
  fillTakerFromDecision,
  makeMakerQuote,
  paperIntentId,
  type PaperFill,
  type PaperQuote,
} from "../lib/execution_paper.ts";

const ROOT = resolve(import.meta.dir, "..");

function usage(): string {
  return [
    "Usage: bun run execution:plan [--json] [--limit N] [--paper-run]",
    "",
    "Read-only planning against public venue books. Paper by default; no order endpoint is",
    "called and no credentials are used. --paper-run appends taker fills / maker quotes to",
    "Scratch/execution/ledger.jsonl.",
  ].join("\n");
}

interface CliArgs {
  readonly json: boolean;
  readonly limit: number;
  readonly paperRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  let json = false;
  let limit = 25;
  let paperRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--paper-run") {
      paperRun = true;
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
        console.error("execution:plan: --limit needs a positive number");
        return null;
      }
      limit = Math.min(200, Math.trunc(value));
      continue;
    }
    console.error(`execution:plan: unknown argument ${String(arg)}`);
    return null;
  }
  return { json, limit, paperRun };
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? "—" : value.toFixed(digits);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const now = new Date();
  const plan = await buildExecutionPlan({
    root: ROOT,
    now,
    limit: args.limit,
  });

  const paperFills: PaperFill[] = [];
  const paperQuotes: PaperQuote[] = [];
  if (args.paperRun) {
    for (const decision of plan.decisions) {
      if (decision.blocked) continue;
      const snapshot = {
        dailyPlannedUsd: plan.risk.dailyPlannedUsd,
        openIntents: plan.risk.openIntents,
        marketExposureUsd: plan.risk.marketExposureUsd,
      };
      const intentId = paperIntentId(decision, now);
      if (decision.style === "taker") {
        const fill = fillTakerFromDecision(decision, intentId, now);
        if (fill.status !== "rejected") paperFills.push(fill);
        appendExecutionLedgerRow(ROOT, {
          kind: "intent",
          intentId,
          atIso: now.toISOString(),
          mode: "paper",
          decision,
          fill,
          quote: null,
          riskSnapshot: snapshot,
        });
        continue;
      }
      if (decision.style === "maker") {
        const quote = makeMakerQuote(decision, intentId, now);
        if (quote !== null) paperQuotes.push(quote);
        appendExecutionLedgerRow(ROOT, {
          kind: "intent",
          intentId,
          atIso: now.toISOString(),
          mode: "paper",
          decision,
          fill: null,
          quote,
          riskSnapshot: snapshot,
        });
      }
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          success: true,
          schemaVersion: 1,
          generatedAt: plan.generatedAt,
          mode: plan.mode,
          killSwitch: plan.killSwitch,
          policy: plan.policy,
          venues: plan.venues,
          risk: plan.risk,
          decisions: plan.decisions.map(
            ({ bookLevels: _bookLevels, ...rest }) => rest,
          ),
          paper: {
            quotes: args.paperRun ? paperQuotes : plan.paper.quotes,
            fills: args.paperRun ? paperFills : plan.paper.fills,
            ledgerTail: plan.paper.ledgerTail,
          },
          blockedReasons: plan.blockedReasons,
          provenance: plan.provenance,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `execution:plan — mode ${plan.mode}${plan.killSwitch ? " (KILL SWITCH)" : ""}; ` +
      `${plan.decisions.length} decision(s); Kalshi live-ready ${plan.venues.kalshi.liveReady ? "yes" : `no (${plan.venues.kalshi.reason})`}`,
  );
  console.log(
    `risk: daily $${plan.risk.dailyPlannedUsd}/$${plan.risk.dailyCapUsd}, open intents ${plan.risk.openIntents}; ` +
      `paper fills ${plan.paper.fills.length}, quotes ${plan.paper.quotes.length}`,
  );
  console.log(
    `${"signal".padEnd(38)} ${"venue/style".padEnd(18)} ${"size".padEnd(8)} ${"limit".padEnd(6)} ${"edge".padEnd(9)} verdict`,
  );
  for (const decision of plan.decisions) {
    const verdict = decision.blocked
      ? `blocked:${decision.blockReason}`
      : decision.paper
        ? "paper"
        : "live-ready";
    console.log(
      [
        decision.signalId.slice(0, 38).padEnd(38),
        `${decision.venue ?? "—"}/${decision.style ?? "—"}`.padEnd(18),
        `$${decision.sizeUsd.toFixed(2)}`.padEnd(8),
        fmt(decision.limitPrice, 3).padEnd(6),
        (decision.edgeAfterSlippageBps === null
          ? "—"
          : `${decision.edgeAfterSlippageBps} bps`
        ).padEnd(9),
        verdict,
      ].join(" "),
    );
    if (decision.reasons.length > 0) {
      console.log(`  ↳ ${decision.reasons.join(" · ")}`);
    }
  }
  if (args.paperRun) {
    console.log(
      `paper-run: appended ${paperFills.length} fill(s), ${paperQuotes.length} quote(s) to Scratch/execution/ledger.jsonl`,
    );
  }
}

await main();
