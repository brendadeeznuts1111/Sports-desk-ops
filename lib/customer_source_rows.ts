/**
 * @file lib/customer_source_rows.ts
 * @description Customer rows synthesized from live artifacts, for ids the book does not carry.
 *
 * Two fallbacks: a harvested 24h live profile (`reports/harvested-live-profiles.json`) and the
 * open wager capture (`data/live-wagers.json`). Only fields the artifact actually measured are
 * mapped. An absent aggregate stays absent — never 0 — and `provenance` names the artifact, so a
 * consumer can label "not measured" instead of rendering it as a real zero.
 */

import type { CustomerRow, TicketRow } from "./customer_profile.ts";

type JsonRow = Record<string, unknown>;

const asRow = (value: unknown): JsonRow | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRow)
    : null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const rowsOf = (value: unknown): readonly JsonRow[] =>
  Array.isArray(value)
    ? value.filter((row): row is JsonRow => asRow(row) !== null)
    : [];

/**
 * Rows of a live-wagers capture. The capture writes `{ LIST: [...] }`; a bare array and the older
 * `{ wagers: [...] }` shape are still accepted so a stale artifact does not read as "no rows".
 */
export function liveWagerRows(raw: unknown): readonly JsonRow[] {
  const direct = rowsOf(raw);
  if (direct.length > 0) return direct;
  const doc = asRow(raw);
  if (!doc) return [];
  for (const key of ["LIST", "wagers"]) {
    const rows = rowsOf(doc[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

/** The customer login on one live wager row; the capture trims nothing, so trailing spaces are normal. */
export function liveWagerCustomerId(row: JsonRow): string | null {
  return (
    (
      text(row.CustomerID) ??
      text(row.customerId) ??
      text(row.Login) ??
      text(row.login)
    )?.toUpperCase() ?? null
  );
}

/** A sample wager from a harvested profile: stake and net are measured, the win amount is not. */
function harvestedTicket(value: unknown): TicketRow | null {
  const wager = asRow(value);
  if (!wager) return null;
  const net = finite(wager.netUsd);
  const risk = finite(wager.stakeUsd);
  const league = text(wager.sport);
  const market = text(wager.market);
  const selection = text(wager.line);
  const placedAt = text(wager.time);
  // net > 0 settled a win, net < 0 a loss; net === 0 is a push and stays unlabelled rather than
  // being counted as a settled non-win.
  const result =
    net === null ? null : net > 0 ? "WIN" : net < 0 ? "LOSS" : null;
  return {
    ...(league === null ? {} : { league }),
    ...(market === null ? {} : { market }),
    ...(selection === null ? {} : { selection }),
    ...(risk === null ? {} : { risk_usd: risk }),
    ...(net === null ? {} : { net_usd: net }),
    ...(result === null ? {} : { result }),
    ...(placedAt === null ? {} : { placed_at: placedAt }),
  };
}

/** An open ticket from the live wagers capture; it is unsettled by definition, so it carries no result. */
function liveTicket(row: JsonRow): TicketRow {
  const risk = finite(row.AmountWagered) ?? finite(row.amountWagered);
  const toWin = finite(row.ToWinAmount) ?? finite(row.toWinAmount);
  const number = finite(row.WagerNumber) ?? finite(row.wagerNumber);
  const writer = text(row.TicketWriter) ?? text(row.ticketWriter);
  const placedAt = text(row.InsertDateTime) ?? text(row.insertedAt);
  const selection = text(row.ShortDesc) ?? text(row.shortDesc);
  return {
    ...(number === null ? {} : { wager_number: number }),
    ...(risk === null ? {} : { risk_usd: risk }),
    ...(toWin === null ? {} : { win_usd: toWin }),
    ...(selection === null ? {} : { selection }),
    ...(writer === null ? {} : { channel: writer }),
    ...(placedAt === null ? {} : { placed_at: placedAt }),
  };
}

/**
 * Map one harvested profile. `ltvUsd` is the DOD6 lifetime net, `dodClvBps` is null when CLV was
 * never measured, and the harvester publishes no lifetime volume — that field is left absent
 * rather than guessed from net.
 */
export function customerRowFromHarvestedProfile(
  value: unknown,
): CustomerRow | null {
  const profile = asRow(value);
  if (!profile) return null;
  const id = text(profile.id) ?? text(profile.canonicalId);
  if (id === null) return null;

  const agent = text(profile.agentId);
  const masterAgent = text(profile.masterAgent);
  const net = finite(profile.ltvUsd);
  const hold = finite(profile.holdPct);
  const clv = finite(profile.dodClvBps);
  const sharp = finite(profile.dodSharpScore);
  const sampleRows = rowsOf(profile.sampleWagers);
  const tickets: TicketRow[] = [];
  for (const sample of sampleRows) {
    const ticket = harvestedTicket(sample);
    if (ticket !== null) tickets.push(ticket);
  }

  return {
    customer_id: id.toUpperCase(),
    provenance: "harvested-live-profiles",
    status: "Active",
    ...(agent === null ? {} : { agent_id: agent }),
    ...(masterAgent === null ? {} : { master_agent: masterAgent }),
    ...(net === null ? {} : { lifetime_net_usd: net }),
    ...(hold === null ? {} : { hold_pct: hold }),
    ...(clv === null ? {} : { clv_bps: clv }),
    ...(sharp === null ? {} : { sharp_score: sharp }),
    recent_tickets: tickets,
  };
}

/**
 * Map the open wagers captured for one customer. The capture is a pending-ticket snapshot, so it
 * says nothing about lifetime volume or net: those fields are left absent.
 */
export function customerRowFromLiveWagers(
  customerId: string,
  rows: readonly JsonRow[],
): CustomerRow | null {
  const id = customerId.trim().toUpperCase();
  if (id === "") return null;
  const mine: JsonRow[] = [];
  for (const row of rows) {
    if (liveWagerCustomerId(row) === id) mine.push(row);
  }
  if (mine.length === 0) return null;

  let agent: string | null = null;
  const tickets: TicketRow[] = [];
  for (const row of mine) {
    agent ??= text(row.AgentID) ?? text(row.agentId) ?? text(row.AgentLogin);
    if (tickets.length < 10) tickets.push(liveTicket(row));
  }

  return {
    customer_id: id,
    provenance: "live-wagers",
    status: "Active",
    ...(agent === null ? {} : { agent_id: agent }),
    recent_tickets: tickets,
  };
}
