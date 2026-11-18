/**
 * @file lib/customer_source_rows.ts
 * @description Customer rows synthesized from live artifacts, for ids the book does not carry.
 *
 * Two fallbacks: a harvested 24h live profile (`reports/harvested-live-profiles.json`) and the
 * open wager capture (`data/live-wagers.json`). Only fields the artifact actually measured are
 * mapped. An absent aggregate stays absent — never 0 — and `provenance` names the artifact, so a
 * consumer can label "not measured" instead of rendering it as a real zero.
 */

import type {
  CustomerRow,
  PositionRow,
  TicketRow,
} from "./customer_profile.ts";
import { ticketWriterDisposition } from "./live_writer_policy.ts";
import { positionIdentity } from "./position_identity.ts";
import { extractRotationFromText } from "./rotation_normalizer.ts";
import { usdFromWireCents } from "./wire_money.ts";

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
    ...(risk === null ? {} : { risk_usd: usdFromWireCents(risk) }),
    ...(toWin === null ? {} : { win_usd: usdFromWireCents(toWin) }),
    ...(selection === null ? {} : { selection }),
    ...(writer === null ? {} : { channel: writer }),
    ...(placedAt === null ? {} : { placed_at: placedAt }),
  };
}

function sportOfDescription(description: string | null): string | null {
  if (description === null) return null;
  if (/basketball/i.test(description)) return "Basketball";
  if (/hockey/i.test(description)) return "Hockey";
  if (/soccer/i.test(description)) return "Soccer";
  if (/football/i.test(description)) return "Football";
  return null;
}

/** One harvested open position. The harvester stores USD already; do not divide again. */
function harvestedPosition(value: unknown): PositionRow | null {
  const position = asRow(value);
  if (!position) return null;
  const ticket = text(position.ticketNumber);
  const number = text(position.wagerNumber);
  const sport = text(position.sport);
  const market = text(position.wagerType);
  const selection = text(position.description);
  const risk = finite(position.riskUsd);
  const toWin = finite(position.toWinUsd);
  const placedAt = text(position.placedAtIso);
  const writer = text(position.writer);
  const source = text(position.source);
  return {
    ...(ticket === null ? {} : { ticket_number: ticket }),
    ...(number === null ? {} : { wager_number: number }),
    ...(sport === null ? {} : { sport }),
    ...(market === null ? {} : { market }),
    ...(selection === null ? {} : { selection }),
    ...(risk === null ? {} : { risk_usd: risk }),
    ...(toWin === null ? {} : { to_win_usd: toWin }),
    ...(placedAt === null ? {} : { placed_at: placedAt }),
    ...(writer === null ? {} : { writer }),
    status: "open",
    ...(source === null ? {} : { source }),
  };
}

/** One open position from a live-wagers capture row. `AmountWagered`/`ToWinAmount` are wire cents. */
function livePosition(row: JsonRow): PositionRow | null {
  if (
    ticketWriterDisposition(row.TicketWriter ?? row.ticketWriter) !== "book"
  ) {
    return null;
  }
  const risk = finite(row.AmountWagered) ?? finite(row.amountWagered);
  const toWin = finite(row.ToWinAmount) ?? finite(row.toWinAmount);
  const number = finite(row.WagerNumber) ?? finite(row.wagerNumber);
  const writer = text(row.TicketWriter) ?? text(row.ticketWriter);
  const placedAt = text(row.InsertDateTime) ?? text(row.insertedAt);
  const selection = text(row.ShortDesc) ?? text(row.shortDesc);
  const sport = sportOfDescription(selection);
  const market = text(row.WagerType) ?? text(row.wagerType);
  const vip = (text(row.VIP) ?? text(row.vip)) === "1";
  const rotation =
    selection === null
      ? null
      : (extractRotationFromText(selection)?.canonicalRotationKey ?? null);
  const legs =
    selection === null
      ? null
      : Math.max(1, (selection.match(/#\d+/g) ?? []).length);
  return {
    ...(number === null ? {} : { wager_number: String(number) }),
    ...(sport === null ? {} : { sport }),
    ...(market === null ? {} : { market }),
    ...(selection === null ? {} : { selection }),
    ...(risk === null ? {} : { risk_usd: usdFromWireCents(risk) }),
    ...(toWin === null ? {} : { to_win_usd: usdFromWireCents(toWin) }),
    ...(writer === null ? {} : { writer }),
    ...(vip ? { vip } : {}),
    ...(rotation === null ? {} : { rotation }),
    ...(legs === null ? {} : { legs }),
    ...(placedAt === null ? {} : { placed_at: placedAt }),
    status: "open",
    source: "live-wagers",
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
  const positionRows = rowsOf(profile.positions);
  const tickets: TicketRow[] = [];
  for (const sample of sampleRows) {
    const ticket = harvestedTicket(sample);
    if (ticket !== null) tickets.push(ticket);
  }
  const positions: PositionRow[] = [];
  for (const value of positionRows) {
    const position = harvestedPosition(value);
    if (position !== null) positions.push(position);
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
    ...(positions.length === 0 ? {} : { open_positions: positions }),
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
    if (
      liveWagerCustomerId(row) === id &&
      ticketWriterDisposition(row.TicketWriter ?? row.ticketWriter) === "book"
    ) {
      mine.push(row);
    }
  }
  if (mine.length === 0) return null;

  let agent: string | null = null;
  const tickets: TicketRow[] = [];
  for (const row of mine) {
    agent ??= text(row.AgentID) ?? text(row.agentId) ?? text(row.AgentLogin);
    if (tickets.length < 10) tickets.push(liveTicket(row));
  }
  const positions = mine
    .map(livePosition)
    .filter((position): position is PositionRow => position !== null);

  return {
    customer_id: id,
    provenance: "live-wagers",
    status: "Active",
    ...(agent === null ? {} : { agent_id: agent }),
    recent_tickets: tickets,
    ...(positions.length === 0 ? {} : { open_positions: positions }),
  };
}

/**
 * Rows of the pending-ticket capture (`data/live-bets.json`). The capture writes `games`; a bare
 * array and `{ rows }` are accepted so a stale artifact does not read as "no pending wagers".
 */
export function liveBetsRows(raw: unknown): readonly JsonRow[] {
  const direct = rowsOf(raw);
  if (direct.length > 0) return direct;
  const doc = asRow(raw);
  if (!doc) return [];
  for (const key of ["games", "rows"]) {
    const rows = rowsOf(doc[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

function liveBetCustomerId(row: JsonRow): string | null {
  return (
    (
      text(row.customerID) ??
      text(row.customerId) ??
      text(row.Login)
    )?.toUpperCase() ?? null
  );
}

/** One pending wager as a position. `wagered`/`toWin` are wire cents. */
function liveBetPosition(row: JsonRow): PositionRow {
  const risk = finite(row.wagered) ?? finite(row.riskUsd);
  const toWin = finite(row.toWin) ?? finite(row.toWinAmount);
  const ticket = text(row.ticketNumber) ?? text(row.ticket_number);
  const number = text(row.wagerNumber) ?? text(row.wager_number);
  const sport = text(row.sport);
  const market = text(row.wagerType) ?? text(row.subSport);
  const selection = text(row.description) ?? text(row.chosenTeam);
  const placedAt = text(row.acceptedAt);
  const picks = finite(row.picks);
  return {
    ...(ticket === null ? {} : { ticket_number: ticket }),
    ...(number === null ? {} : { wager_number: number }),
    ...(sport === null ? {} : { sport }),
    ...(market === null ? {} : { market }),
    ...(selection === null ? {} : { selection }),
    ...(risk === null ? {} : { risk_usd: usdFromWireCents(risk) }),
    ...(toWin === null ? {} : { to_win_usd: usdFromWireCents(toWin) }),
    ...(picks === null ? {} : { legs: Math.max(1, picks) }),
    ...(placedAt === null ? {} : { placed_at: placedAt }),
    status: "open",
    source: "live-bets",
  };
}

/** Map the pending capture for one customer. The capture is a pending snapshot, so no lifetime. */
export function customerRowFromLiveBets(
  customerId: string,
  rows: readonly JsonRow[],
): CustomerRow | null {
  const id = customerId.trim().toUpperCase();
  if (id === "") return null;
  const mine = rows.filter((row) => liveBetCustomerId(row) === id);
  if (mine.length === 0) return null;
  let agent: string | null = null;
  const tickets: TicketRow[] = [];
  for (const row of mine) {
    const agentObj = asRow(row.agent);
    agent ??=
      text(agentObj?.id) ??
      text(agentObj?.key) ??
      text(row.agent) ??
      text(row.AgentID);
    if (tickets.length < 10) {
      const position = liveBetPosition(row);
      tickets.push({
        ...(position.wager_number === undefined
          ? {}
          : { wager_number: position.wager_number }),
        ...(position.sport === undefined ? {} : { league: position.sport }),
        ...(position.market === undefined ? {} : { market: position.market }),
        ...(position.selection === undefined
          ? {}
          : { selection: position.selection }),
        ...(position.risk_usd === undefined
          ? {}
          : { risk_usd: position.risk_usd }),
        ...(position.to_win_usd === undefined
          ? {}
          : { win_usd: position.to_win_usd }),
        ...(position.placed_at === undefined
          ? {}
          : { placed_at: position.placed_at }),
      });
    }
  }
  return {
    customer_id: id,
    provenance: "live-bets",
    status: "Active",
    ...(agent === null ? {} : { agent_id: agent }),
    recent_tickets: tickets,
    open_positions: mine.map(liveBetPosition),
  };
}

/**
 * Every customer that appears in either live capture, with their open positions unioned across
 * the two snapshots. This is the book-independent customer set: a ranked harvest is not required
 * for a wager to reach a profile.
 */
export function customerRowsFromLiveCaptures(
  wagersRaw: unknown,
  betsRaw: unknown,
): CustomerRow[] {
  const byId = new Map<string, CustomerRow>();
  const wagerRows = liveWagerRows(wagersRaw);
  const wagerIds = new Set<string>();
  for (const row of wagerRows) {
    const id = liveWagerCustomerId(row);
    if (id !== null) wagerIds.add(id);
  }
  for (const id of wagerIds) {
    const row = customerRowFromLiveWagers(id, wagerRows);
    if (row !== null) byId.set(id, row);
  }

  const betRows = liveBetsRows(betsRaw);
  const betIds = new Set<string>();
  for (const row of betRows) {
    const id = liveBetCustomerId(row);
    if (id !== null) betIds.add(id);
  }
  for (const id of betIds) {
    const pending = customerRowFromLiveBets(id, betRows);
    if (pending === null) continue;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, pending);
      continue;
    }
    const positions = [...(existing.open_positions ?? [])];
    const seen = new Set(
      positions
        .map((position) => positionIdentity(position).key)
        .filter((key): key is string => key !== null),
    );
    for (const position of pending.open_positions ?? []) {
      const key = positionIdentity(position).key;
      if (key !== null && seen.has(key)) continue;
      if (key !== null) seen.add(key);
      positions.push(position);
    }
    const recentTickets =
      (pending.recent_tickets?.length ?? 0) > 0
        ? pending.recent_tickets
        : existing.recent_tickets;
    byId.set(id, {
      ...existing,
      ...(existing.agent_id === undefined && pending.agent_id !== undefined
        ? { agent_id: pending.agent_id }
        : {}),
      ...(recentTickets === undefined ? {} : { recent_tickets: recentTickets }),
      ...(positions.length === 0 ? {} : { open_positions: positions }),
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.customer_id.localeCompare(b.customer_id),
  );
}
