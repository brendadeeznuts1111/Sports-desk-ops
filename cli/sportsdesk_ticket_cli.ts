#!/usr/bin/env bun
/**
 * Inspect one live bet ticket from the latest getBetTicker capture.
 *
 *   bun run ticket 767125863
 *   bun run ticket b767125863 --json
 *   bun run ticket 767125863 --file tests/fixtures/live-wagers-list-sample.json
 *
 * Customer logins, agent logins and customer ids stay out of both views: the ticket number,
 * writer, amounts and legs are enough to identify the wager on the desk.
 */

import { parseArgs } from "node:util";

import { wagerTypeLabel } from "../lib/game_admin.ts";
import { readWagerListArtifact } from "../lib/live_wagers.ts";

const DEFAULT_FILE = "data/live-wagers.json";

const HELP = `ticket — inspect one live bet ticket from the latest getBetTicker capture

Usage: bun run ticket <wagerNumber> [--file <artifact>] [--json]

  --file <path>  Capture artifact (default: ${DEFAULT_FILE})
  --json         Machine-readable, safe view (no customer/agent identifiers)
  -h, --help     This text

The number may carry the portal's b prefix (b767125863).`;

function usage(message: string): never {
  console.error(`ticket: ${message}`);
  console.error(HELP);
  process.exit(2);
}

function fail(message: string): never {
  console.error(`ticket: ${message}`);
  process.exit(1);
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

let values: {
  readonly file?: string;
  readonly json?: boolean;
  readonly help?: boolean;
};
let positionals: string[];
try {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: "string", default: DEFAULT_FILE },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

if (values.help === true) {
  console.log(HELP);
  process.exit(0);
}
if (positionals.length !== 1) {
  usage("expected exactly one wager number");
}

const rawWager = positionals[0]!.trim();
const wagerNumber = Number(rawWager.replace(/^b/i, ""));
if (!Number.isSafeInteger(wagerNumber) || wagerNumber <= 0) {
  usage(`invalid wager number ${JSON.stringify(rawWager)}`);
}

const file = values.file ?? DEFAULT_FILE;
const handle = Bun.file(file);
if (!(await handle.exists())) {
  fail(`${file} not found; run bun run capture:bet-ticker or pass --file`);
}

let payload: unknown;
try {
  payload = await handle.json();
} catch (error) {
  fail(
    `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const artifact = readWagerListArtifact(payload);
const wager = artifact.wagers.find(
  (candidate) => candidate.wagerNumber === wagerNumber,
);
if (wager === undefined) {
  fail(`wager ${wagerNumber} not found in ${file}`);
}

const view = {
  wagerNumber: wager.wagerNumber,
  ticketWriter: wager.ticketWriter.trim(),
  writer: wager.writer,
  wagerType: wager.wagerType,
  wagerTypeLabel: wagerTypeLabel(wager.wagerType),
  live: wager.live,
  vip: wager.vip,
  amountWagered: wager.amountWagered,
  toWinAmount: wager.toWinAmount,
  volumeAmount: wager.volumeAmount,
  volumeDiffers: wager.volumeDiffers,
  insertedAt: wager.insertedAt,
  descCode: wager.descCode,
  legs: wager.legs.map((leg) => ({
    sport: leg.sport,
    game: leg.game,
    period: leg.period,
    market: leg.market,
    pick: leg.pick,
    live: leg.live,
    gameNumber: leg.gameNumber,
    compact: leg.compact,
    raw: leg.raw,
  })),
};

if (values.json === true) {
  console.log(
    JSON.stringify({ wager: view, provenance: artifact.provenance }, null, 2),
  );
  process.exit(0);
}

const lines = [
  `Ticket ${wager.wagerNumber} · ${view.ticketWriter || view.writer.toUpperCase()} · ${view.wagerTypeLabel} (${view.wagerType}) · ${view.live ? "live" : "pregame"}${view.vip ? " · VIP" : ""}`,
  `Stake ${money.format(view.amountWagered)} · To win ${money.format(view.toWinAmount)}${view.volumeDiffers ? ` · Volume ${money.format(view.volumeAmount)}` : ""}`,
  view.legs.length === 0 ? "Legs: —" : "Legs:",
  ...view.legs.map((leg, index) => {
    const parts = [leg.sport, leg.game, leg.period, leg.market, leg.pick]
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return `  ${index + 1}. ${parts.join(" · ")}${leg.live ? " · LIVE" : ""}`;
  }),
  `Source: ${artifact.provenance.source}${artifact.provenance.observedAt === null ? "" : ` · observed ${artifact.provenance.observedAt}`}`,
];
console.log(lines.join("\n"));
