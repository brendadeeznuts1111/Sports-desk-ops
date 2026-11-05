/**
 * @file lib/stale_line_cohort.ts
 * @description Stale-line / post-move bet cohort detection.
 *
 * Turns a normalized bet-log export into (a) seeded stale-line tickets, (b) same-event clusters of
 * other customers who hit the same market within a time window, and (c) per-customer scores.
 *
 * This is deliberately evidence-led: a ticket is a seed only when an operator note says the line
 * was stale, or when a ticket was graded and then cancelled afterwards. The tool never infers
 * "stale" from price alone — without a reference line series it cannot.
 */

import {
  buildGsLiveBetHistorySidecarUrl,
  resolveDeskDateYmd,
} from "./gslive_manager_deeplink_sidecar.ts";

export interface StaleTicketInput {
  readonly customer?: unknown;
  readonly agent?: unknown;
  readonly ticketId?: unknown;
  readonly eventId?: unknown;
  readonly market?: unknown;
  readonly period?: unknown;
  readonly side?: unknown;
  readonly priceAmerican?: unknown;
  readonly stakeUsd?: unknown;
  readonly placedAt?: unknown;
  readonly settledAt?: unknown;
  readonly canceledAt?: unknown;
  readonly status?: unknown;
  readonly staleNote?: unknown;
  readonly notedBy?: unknown;
  readonly ip?: unknown;
}

export interface StaleTicket {
  readonly customer: string;
  readonly agent: string;
  readonly ticketId: string;
  readonly eventId: string;
  readonly market: string;
  readonly period: string;
  readonly side: string;
  readonly priceAmerican: number | null;
  readonly stakeUsd: number;
  readonly placedAtMs: number;
  readonly settledAtMs: number | null;
  readonly canceledAtMs: number | null;
  readonly status: string;
  readonly staleNote: string;
  readonly notedBy: string;
  readonly ip: string;
}

export interface StaleCohortCluster {
  readonly eventId: string;
  readonly market: string;
  readonly period: string;
  readonly side: string;
  readonly seedTicketIds: readonly string[];
  readonly customerIds: readonly string[];
  readonly firstPlacedAtIso: string;
  readonly lastPlacedAtIso: string;
  readonly spreadSeconds: number;
  readonly tickets: readonly {
    readonly ticketId: string;
    readonly customer: string;
    readonly agent: string;
    readonly placedAtIso: string;
    readonly stakeUsd: number;
    readonly priceAmerican: number | null;
    readonly status: string;
    readonly isSeed: boolean;
    readonly staleNote: string;
  }[];
  readonly followUpUrl: string;
}

export interface StaleCustomerScore {
  readonly customer: string;
  readonly agent: string;
  readonly tickets: number;
  readonly seeds: number;
  readonly staleRatePct: number;
  readonly distinctSeedEvents: number;
  readonly clusteredTickets: number;
  readonly canceled: number;
  readonly gradedThenCanceled: number;
  readonly stakeFingerprint: readonly number[];
  readonly ip24: readonly string[];
}

export interface StaleCohortReport {
  readonly schemaVersion: 1;
  readonly windowMinutes: number;
  readonly totals: {
    readonly tickets: number;
    readonly seeds: number;
    readonly clusters: number;
    readonly customers: number;
  };
  readonly clusters: readonly StaleCohortCluster[];
  readonly customers: readonly StaleCustomerScore[];
  readonly warnings: readonly string[];
}

export class StaleCohortInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleCohortInputError";
  }
}

/* -------------------------------------------------------------------------- */
/* Export parsing (shared with the CLI)                                       */
/* -------------------------------------------------------------------------- */

const COLUMN_ALIASES: Readonly<Record<string, keyof StaleTicketInput>> = {
  customer: "customer",
  customerid: "customer",
  login: "customer",
  player: "customer",
  agent: "agent",
  agentid: "agent",
  ticket: "ticketId",
  ticketid: "ticketId",
  ticketnumber: "ticketId",
  event: "eventId",
  eventid: "eventId",
  rot: "eventId",
  rotation: "eventId",
  market: "market",
  markettype: "market",
  period: "period",
  side: "side",
  price: "priceAmerican",
  priceamerican: "priceAmerican",
  odds: "priceAmerican",
  stake: "stakeUsd",
  stakeusd: "stakeUsd",
  amount: "stakeUsd",
  wager: "stakeUsd",
  placedat: "placedAt",
  placed: "placedAt",
  placedtime: "placedAt",
  time: "placedAt",
  timestamp: "placedAt",
  settledat: "settledAt",
  settled: "settledAt",
  paidat: "settledAt",
  canceledat: "canceledAt",
  cancelledat: "canceledAt",
  canceled: "canceledAt",
  cancelled: "canceledAt",
  status: "status",
  stalenote: "staleNote",
  note: "staleNote",
  notes: "staleNote",
  reason: "staleNote",
  notedby: "notedBy",
  operator: "notedBy",
  ip: "ip",
};

function mapRecord(record: Record<string, unknown>): StaleTicketInput {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const target = COLUMN_ALIASES[key.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (target !== undefined && mapped[target] === undefined)
      mapped[target] = value;
  }
  return mapped as StaleTicketInput;
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). */
function parseCsv(source: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (header === undefined) return [];
  return rows
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells) =>
      Object.fromEntries(
        header.map((name, column) => [
          name.trim(),
          (cells[column] ?? "").trim(),
        ]),
      ),
    );
}

/** Parses a JSON array, JSONL stream, `{tickets: []}` document, or CSV export. */
export function parseStaleTicketInput(source: string): StaleTicketInput[] {
  const trimmed = source.trim();
  if (trimmed === "") throw new StaleCohortInputError("input is empty");

  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed))
      throw new StaleCohortInputError("JSON input must be an array");
    return parsed.map((entry) => mapRecord(entry as Record<string, unknown>));
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const container = parsed as { tickets?: unknown } | null;
      if (
        container !== null &&
        typeof container === "object" &&
        Array.isArray(container.tickets)
      ) {
        return container.tickets.map((entry) =>
          mapRecord(entry as Record<string, unknown>),
        );
      }
      return [mapRecord(parsed as Record<string, unknown>)];
    } catch {
      // Intentional hand-rolled JSONL loop: must throw on malformed line (caller treats that as
      // "input is not JSONL either"); `Bun.JSONL.parse()` would return the parsed prefix silently
      // and the caller would see a partial, wrong cohort. See
      // `docs/bun-upstream-reference.md` "When NOT to migrate to Bun.JSONL".
      return trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => mapRecord(JSON.parse(line) as Record<string, unknown>));
    }
  }
  return parseCsv(trimmed).map((record) => mapRecord(record));
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value === undefined || value === null
      ? ""
      : String(value).trim();
}

function toMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value)) {
      return numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

/** Normalizes one bet-log row. Throws with the row index when a required field is unusable. */
export function normalizeStaleTicket(
  raw: StaleTicketInput,
  index: number,
): StaleTicket {
  const customer = text(raw.customer);
  if (customer === "") {
    throw new StaleCohortInputError(`row ${index + 1}: customer is required`);
  }
  const placedAtMs = toMs(raw.placedAt);
  if (placedAtMs === null) {
    throw new StaleCohortInputError(
      `row ${index + 1} (${customer}): placedAt must be ISO-8601 or epoch`,
    );
  }
  return {
    customer: customer.toUpperCase(),
    agent: text(raw.agent).toUpperCase(),
    ticketId: text(raw.ticketId),
    eventId: text(raw.eventId),
    market: text(raw.market).toUpperCase(),
    period: text(raw.period).toUpperCase(),
    side: text(raw.side).toUpperCase(),
    priceAmerican: toNumber(raw.priceAmerican),
    stakeUsd: toNumber(raw.stakeUsd) ?? 0,
    placedAtMs,
    settledAtMs: toMs(raw.settledAt),
    canceledAtMs: toMs(raw.canceledAt),
    status: text(raw.status).toUpperCase(),
    staleNote: text(raw.staleNote),
    notedBy: text(raw.notedBy),
    ip: text(raw.ip),
  };
}

const STALE_NOTE_PATTERN =
  /stale|should have been down|line (?:was |should have been )?(?:moved|down|off)|off the board/i;
/** A ticket is a seed only with an explicit stale note or a graded-then-cancelled reversal. */
export function staleSeedReasons(ticket: StaleTicket): readonly string[] {
  const reasons: string[] = [];
  if (STALE_NOTE_PATTERN.test(ticket.staleNote))
    reasons.push("operator_stale_note");
  if (
    ticket.status === "CANCELLED" &&
    ticket.settledAtMs !== null &&
    ticket.canceledAtMs !== null &&
    ticket.canceledAtMs >= ticket.settledAtMs
  ) {
    reasons.push("graded_then_cancelled");
  }
  return reasons;
}

function ip24(ip: string): string {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip.trim());
  return match ? `${match[1]}.0/24` : "";
}

/** Groups same-event tickets around seeds; requires a shared event id to cluster. */
export function buildStaleCohortReport(
  rows: readonly StaleTicketInput[],
  options?: { readonly windowMinutes?: number; readonly tickEpochMs?: number },
): StaleCohortReport {
  const windowMinutes = Math.max(1, options?.windowMinutes ?? 10);
  const windowMs = windowMinutes * 60_000;
  const tickEpochMs = options?.tickEpochMs ?? Date.now();
  const tickets = rows.map((row, index) => normalizeStaleTicket(row, index));

  const seedReasons = new Map<string, readonly string[]>();
  for (const ticket of tickets) {
    const reasons = staleSeedReasons(ticket);
    if (reasons.length > 0)
      seedReasons.set(
        ticket.ticketId || `${ticket.customer}@${ticket.placedAtMs}`,
        reasons,
      );
  }
  const isSeed = (ticket: StaleTicket): boolean =>
    seedReasons.has(
      ticket.ticketId || `${ticket.customer}@${ticket.placedAtMs}`,
    );

  const warnings: string[] = [];
  const missingEvent = tickets.filter((ticket) => ticket.eventId === "").length;
  if (missingEvent > 0) {
    warnings.push(
      `${missingEvent} ticket(s) have no eventId and cannot be clustered; add the event/rotation column.`,
    );
  }

  const groups = new Map<string, StaleTicket[]>();
  for (const ticket of tickets) {
    if (ticket.eventId === "") continue;
    const key = [
      ticket.eventId,
      ticket.market,
      ticket.period,
      ticket.side,
    ].join("|");
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [ticket]);
    else bucket.push(ticket);
  }

  const clusters: StaleCohortCluster[] = [];
  const clusteredIds = new Set<string>();
  const idOf = (ticket: StaleTicket): string =>
    ticket.ticketId || `${ticket.customer}@${ticket.placedAtMs}`;

  for (const group of groups.values()) {
    const groupSeeds = group.filter(isSeed);
    if (groupSeeds.length === 0) continue;
    const members = group.filter((ticket) =>
      groupSeeds.some(
        (seed) => Math.abs(ticket.placedAtMs - seed.placedAtMs) <= windowMs,
      ),
    );
    if (members.length === 0) continue;
    members.sort((a, b) => a.placedAtMs - b.placedAtMs);
    const first = members[0]!;
    const last = members[members.length - 1]!;
    const seedIds = groupSeeds.map(idOf);
    clusters.push({
      eventId: first.eventId,
      market: first.market,
      period: first.period,
      side: first.side,
      seedTicketIds: seedIds,
      customerIds: [...new Set(members.map((ticket) => ticket.customer))],
      firstPlacedAtIso: new Date(first.placedAtMs).toISOString(),
      lastPlacedAtIso: new Date(last.placedAtMs).toISOString(),
      spreadSeconds: Math.round((last.placedAtMs - first.placedAtMs) / 1000),
      tickets: members.map((ticket) => ({
        ticketId: idOf(ticket),
        customer: ticket.customer,
        agent: ticket.agent,
        placedAtIso: new Date(ticket.placedAtMs).toISOString(),
        stakeUsd: ticket.stakeUsd,
        priceAmerican: ticket.priceAmerican,
        status: ticket.status,
        isSeed: isSeed(ticket),
        staleNote: ticket.staleNote,
      })),
      followUpUrl: buildGsLiveBetHistorySidecarUrl({
        dateYmd: resolveDeskDateYmd(new Date(first.placedAtMs)),
        dateFilterBy: "betTime",
        eventId: first.eventId,
        tickEpochMs,
      }),
    });
    for (const member of members) clusteredIds.add(idOf(member));
  }

  const byCustomer = new Map<string, StaleTicket[]>();
  for (const ticket of tickets) {
    const bucket = byCustomer.get(ticket.customer);
    if (bucket === undefined) byCustomer.set(ticket.customer, [ticket]);
    else bucket.push(ticket);
  }

  const customers: StaleCustomerScore[] = [...byCustomer.entries()]
    .map(([customer, own]) => {
      const seeds = own.filter(isSeed);
      const canceled = own.filter((ticket) => ticket.status === "CANCELLED");
      return {
        customer,
        agent: own[0]?.agent ?? "",
        tickets: own.length,
        seeds: seeds.length,
        staleRatePct: Math.round((seeds.length / own.length) * 1000) / 10,
        distinctSeedEvents: new Set(
          seeds.map((ticket) => ticket.eventId).filter((id) => id !== ""),
        ).size,
        clusteredTickets: own.filter((ticket) => clusteredIds.has(idOf(ticket)))
          .length,
        canceled: canceled.length,
        gradedThenCanceled: canceled.filter((ticket) =>
          staleSeedReasons(ticket).includes("graded_then_cancelled"),
        ).length,
        stakeFingerprint: [
          ...new Set(own.map((ticket) => ticket.stakeUsd)),
        ].sort((a, b) => a - b),
        ip24: [
          ...new Set(
            own
              .map((ticket) => ip24(ticket.ip))
              .filter((value) => value !== ""),
          ),
        ],
      };
    })
    .sort(
      (a, b) =>
        b.seeds - a.seeds ||
        b.clusteredTickets - a.clusteredTickets ||
        a.customer.localeCompare(b.customer),
    );

  return {
    schemaVersion: 1,
    windowMinutes,
    totals: {
      tickets: tickets.length,
      seeds: seedReasons.size,
      clusters: clusters.length,
      customers: customers.length,
    },
    clusters: clusters.sort((a, b) =>
      a.firstPlacedAtIso.localeCompare(b.firstPlacedAtIso),
    ),
    customers,
    warnings,
  };
}
