#!/usr/bin/env bun
/**
 * Inspect one live bet ticket, or list every ticket with its leg count, from the latest
 * getBetTicker capture.
 *
 *   bun run ticket 767125863
 *   bun run ticket b767125863 --json
 *   bun run ticket --list
 *   bun run ticket --list --file tests/fixtures/live-wagers-list-sample.json --json
 *
 * Customer logins, agent logins and customer ids stay out of every view: the ticket number,
 * writer, amounts and legs are enough to identify the wager on the desk.
 */

import { parseArgs } from "node:util";

import { wagerTypeLabel } from "../lib/game_admin.ts";
import { normalizeTicket } from "../lib/live_ticket_view.ts";
import { readWagerListArtifact, type LiveWager } from "../lib/live_wagers.ts";

const DEFAULT_FILE = "data/live-wagers.json";

const HELP = `ticket — inspect live bet tickets from the latest getBetTicker capture

Usage: bun run ticket <wagerNumber> [--file <artifact>] [--json]
       bun run ticket --list [--file <artifact>] [--json]

  --file <path>  Capture artifact (default: ${DEFAULT_FILE})
  --list         Every ticket with its leg count (safe fields only)
  --normalized   Canonical public ticket shape; requires --json
  --json         Machine-readable safe view (no customer/agent identifiers)
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

/** The only shape either view emits; identifiers from the wire are deliberately absent. */
function safeWagerView(wager: LiveWager) {
  return {
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
}

function sourceLine(provenance: {
  readonly source: string;
  readonly observedAt: string | null;
}): string {
  return `Source: ${provenance.source}${
    provenance.observedAt === null ? "" : ` · observed ${provenance.observedAt}`
  }`;
}

let values: {
  readonly file?: string;
  readonly json?: boolean;
  readonly list?: boolean;
  readonly normalized?: boolean;
  readonly help?: boolean;
};
let positionals: string[];
try {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: "string", default: DEFAULT_FILE },
      json: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      normalized: { type: "boolean", default: false },
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
if (values.normalized === true && values.json !== true) {
  usage("--normalized requires --json");
}

const listing = values.list === true;
let target: number | null = null;
if (listing) {
  if (positionals.length !== 0) usage("--list takes no wager number");
} else {
  if (positionals.length !== 1) usage("expected exactly one wager number");
  const rawWager = positionals[0]!.trim();
  const parsed = Number(rawWager.replace(/^b/i, ""));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    usage(`invalid wager number ${JSON.stringify(rawWager)}`);
  }
  target = parsed;
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
const meta = {
  file,
  source: artifact.provenance.source,
  capturedAt: artifact.provenance.observedAt,
};

if (listing) {
  if (values.json === true) {
    if (values.normalized === true) {
      const tickets = artifact.wagers.map((wager) =>
        normalizeTicket(wager, meta),
      );
      const legs = tickets.reduce(
        (total, ticket) => total + ticket.legs.length,
        0,
      );
      console.log(
        JSON.stringify(
          {
            tickets,
            totals: { tickets: tickets.length, legs },
            provenance: artifact.provenance,
          },
          null,
          2,
        ),
      );
    } else {
      const tickets = artifact.wagers.map(safeWagerView);
      const legs = tickets.reduce(
        (total, ticket) => total + ticket.legs.length,
        0,
      );
      console.log(
        JSON.stringify(
          {
            tickets,
            totals: { tickets: tickets.length, legs },
            provenance: artifact.provenance,
          },
          null,
          2,
        ),
      );
    }
    process.exit(0);
  }

  const tickets = artifact.wagers.map(safeWagerView);
  const legs = tickets.reduce((total, ticket) => total + ticket.legs.length, 0);
  const table = Bun.inspect.table(
    tickets.map((ticket) => ({
      ticket: ticket.wagerNumber,
      writer: ticket.writer,
      type: ticket.wagerType,
      live: ticket.live,
      legs: ticket.legs.length,
      stake: ticket.amountWagered,
      toWin: ticket.toWinAmount,
    })),
    { colors: false },
  );
  const average = tickets.length === 0 ? 0 : legs / tickets.length;
  console.log(
    [
      table.trimEnd(),
      `${tickets.length} tickets · ${legs} legs · avg ${average.toFixed(2)} legs/ticket`,
      sourceLine(artifact.provenance),
    ].join("\n"),
  );
  process.exit(0);
}

if (target === null) fail("internal: missing wager number");
const wager = artifact.wagers.find(
  (candidate) => candidate.wagerNumber === target,
);
if (wager === undefined) {
  fail(`wager ${target} not found in ${file}`);
}

const view = safeWagerView(wager);

if (values.json === true) {
  console.log(
    JSON.stringify(
      values.normalized === true
        ? normalizeTicket(wager, meta)
        : { wager: view, provenance: artifact.provenance },
      null,
      2,
    ),
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
  sourceLine(artifact.provenance),
];
console.log(lines.join("\n"));
