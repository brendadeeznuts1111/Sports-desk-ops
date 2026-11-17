#!/usr/bin/env bun
/**
 * Summarize syndicate steam bursts + deterministic rule hits on data/live-wagers.json.
 *
 *   bun run scripts/steam_ticker_report.ts
 *   bun run scripts/steam_ticker_report.ts -- --json --path data/live-wagers.json
 */
import { DETERMINISTIC_RULES, toRuleTicket } from "../cli/rules.ts";
import { normalizeTicket } from "../lib/live_ticket_view.ts";
import { toLiveWager, type LiveWager } from "../lib/live_wagers.ts";
import {
  evaluateWagersForBursts,
  type RawWagerInput,
} from "../lib/syndicate_burst_guard.ts";
import { portalWallClockIso } from "../lib/gslive_manager_deeplink_sidecar.ts";
import { resolve } from "node:path";

function parseArgs(argv: string[]) {
  let path = "data/live-wagers.json";
  let json = false;
  const windows = [120, 180, 300];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    if (a === "--path" && argv[i + 1]) path = argv[++i]!;
  }
  return { path: resolve(import.meta.dir, "..", path), json, windows };
}

function mapRow(row: Record<string, unknown>): RawWagerInput {
  const desc = String(row.ShortDesc ?? "").trim();
  const gameMatch = desc.match(/#(\d+)/);
  const isoRaw = String(row.InsertDateTime ?? "");
  const iso =
    portalWallClockIso(isoRaw) ??
    new Date(isoRaw.replace(" ", "T") + "-06:00").toISOString();
  const masterAgent = String(row.AgentLogin ?? "").trim();
  return {
    login: String(row.Login ?? row.CustomerID ?? "").trim(),
    agentId: String(row.AgentID ?? "").trim(),
    // exactOptionalPropertyTypes: an absent login is an omitted key, not `undefined`.
    ...(masterAgent === "" ? {} : { masterAgent }),
    amountWageredCents: Math.round(Number(row.AmountWagered ?? 0) * 100),
    toWinCents: Math.round(Number(row.ToWinAmount ?? 0) * 100),
    insertDateTimeIso: iso,
    wagerType: String(row.WagerType ?? ""),
    gameId: gameMatch ? gameMatch[1]! : "UNKNOWN",
    selection: desc,
    sport: "FOOTBALL",
    period: /1H|2H|Half/i.test(desc) ? "HALF" : "FULL",
    isAlert: /ALERT/i.test(String(row.TicketWriter ?? "")),
  };
}

function ruleHits(wagers: LiveWager[]): Record<string, number> {
  const tickets = wagers.map((w) => toRuleTicket(normalizeTicket(w)));
  const out: Record<string, number> = {};
  for (const [name, run] of Object.entries(DETERMINISTIC_RULES)) {
    try {
      out[name] = run(tickets).length;
    } catch {
      out[name] = 0;
    }
  }
  return out;
}

const { path, json, windows } = parseArgs(process.argv.slice(2));
const doc = (await Bun.file(path).json()) as {
  LIST: Record<string, unknown>[];
  observedAt?: string;
  source?: string;
};
const list = doc.LIST ?? [];
const rawInputs = list.map(mapRow);
const liveWagers = list.map((r) => toLiveWager(r as never));

const span = (() => {
  if (rawInputs.length === 0) return null;
  const times = rawInputs
    .map((w) => new Date(w.insertDateTimeIso).getTime())
    .sort((a, b) => a - b);
  return {
    first: rawInputs[0]!.insertDateTimeIso,
    last: rawInputs[rawInputs.length - 1]!.insertDateTimeIso,
    spanSeconds: Math.round((times.at(-1)! - times[0]!) / 1000),
  };
})();

const burstSweep = windows.map((w) => ({
  windowSeconds: w,
  bursts: evaluateWagersForBursts(rawInputs, { windowSeconds: w })
    .activeBurstsDetected,
}));

const rules = ruleHits(liveWagers);
const report = {
  path,
  observedAt: doc.observedAt ?? null,
  source: doc.source ?? null,
  rowCount: list.length,
  span,
  burstSweep,
  rules,
  ruleTotal: Object.values(rules).reduce((a, b) => a + b, 0),
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `steam_ticker_report  rows=${report.rowCount}  observed=${report.observedAt ?? "?"}`,
  );
  if (span) console.log(`  span ${span.spanSeconds}s`);
  for (const row of burstSweep) {
    console.log(`  bursts @ ${row.windowSeconds}s window: ${row.bursts}`);
  }
  console.log(`  rule hits: ${report.ruleTotal}`, report.rules);
}
