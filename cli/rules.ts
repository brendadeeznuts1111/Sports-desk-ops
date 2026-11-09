/**
 * @file rules.ts
 * @description Deterministic anomaly signatures over parsed tickets.
 *
 * Rules are pure `RuleTicket[] -> Anomaly[]` functions. Customer and agent identifiers are
 * read from the private `WeakMap` (`lib/ticket_internal.ts`) and only hashed references reach
 * `evidence`; the public ticket/safe view never carries them.
 */
import type { NormalizedTicketLeg } from "../lib/live_ticket_view.ts";
import {
  getTicketInternal,
  setTicketInternal,
} from "../lib/ticket_internal.ts";

export type Severity = "info" | "notice" | "warning";

export type RuleName =
  | "period_correlation"
  | "opposite_sides_same_customer"
  | "opposite_sides_across_customers"
  | "batch_replay"
  | "clone_bet"
  | "velocity_customer"
  | "velocity_market"
  | "period_order_anomaly"
  | "past_post";

export interface RuleTicket {
  readonly wagerNumber: string;
  readonly insertedAt: string | null;
  readonly stake: number | null;
  readonly toWin: number | null;
  readonly ticketWriter?: string;
  readonly legs: readonly NormalizedTicketLeg[];
}

export interface Anomaly {
  readonly rule: RuleName;
  readonly severity: Severity;
  readonly tickets: readonly RuleTicket[];
  readonly evidence: Readonly<
    Record<string, string | number | readonly string[]>
  >;
}

export interface RuleOptions {
  /** Normalized event name -> ISO start time. */
  readonly schedule?: ReadonlyMap<string, string> | undefined;
}

type Rule = (
  tickets: readonly RuleTicket[],
  options?: RuleOptions,
) => Anomaly[];

const PERIODS_OF_INTEREST = new Set([
  "1H",
  "2H",
  "1Q",
  "2Q",
  "3Q",
  "4Q",
  "1P",
  "2P",
  "3P",
]);

const PERIOD_RANK: Readonly<Record<string, number>> = {
  "1H": 1,
  "2H": 2,
  "1Q": 1,
  "2Q": 2,
  "3Q": 3,
  "4Q": 4,
  "1P": 1,
  "2P": 2,
  "3P": 3,
};

const VELOCITY_CUSTOMER_TIERS: ReadonlyArray<{
  count: number;
  minutes: number;
  severity: Severity;
}> = [
  { count: 10, minutes: 5, severity: "notice" },
  { count: 30, minutes: 30, severity: "warning" },
  { count: 100, minutes: 60, severity: "warning" },
];

const VELOCITY_MARKET_TIERS: ReadonlyArray<{
  count: number;
  seconds: number;
  severity: Severity;
}> = [
  { count: 5, seconds: 30, severity: "notice" },
  { count: 20, seconds: 300, severity: "warning" },
  { count: 100, seconds: 1800, severity: "warning" },
];

function timeOf(ticket: RuleTicket): number {
  if (ticket.insertedAt === null) return Number.NaN;
  return Date.parse(ticket.insertedAt);
}

function timed(
  tickets: readonly RuleTicket[],
): Array<RuleTicket & { at: number }> {
  return tickets
    .map((ticket) => {
      const copy = { ...ticket, at: timeOf(ticket) };
      const internal = getTicketInternal(ticket);
      if (internal !== undefined) setTicketInternal(copy, internal);
      return copy;
    })
    .filter((ticket) => Number.isFinite(ticket.at))
    .sort((a, b) => a.at - b.at);
}

function withinWindow(
  tickets: readonly RuleTicket[],
  windowMs: number,
): boolean {
  const times = tickets
    .map((ticket) => timeOf(ticket))
    .filter((value) => Number.isFinite(value));
  if (times.length < 2) return true;
  return Math.max(...times) - Math.min(...times) <= windowMs;
}

export function normalizeEventName(name: string): string {
  const parts = name.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return name.trim().toLowerCase();
  return parts
    .map((part) => part.trim().toLowerCase())
    .sort()
    .join(" vs ");
}

function customerOf(ticket: RuleTicket): string | undefined {
  const value = getTicketInternal(ticket)?.customer;
  return value === undefined || value === "" ? undefined : value;
}

function agentOf(ticket: RuleTicket): string | undefined {
  const value = getTicketInternal(ticket)?.agent;
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The kind is hashed with the value: a customer and an agent sharing a login must not
 * produce the same reference. SHA-256 truncated to 12 hex chars stays stable across runs
 * without retaining the raw identity anywhere the evidence can reach.
 */
function ref(kind: "customer" | "agent", value: string | undefined): string {
  if (value === undefined) return `${kind}:?`;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${kind}:${value}`);
  return `${kind}:${hasher.digest("hex").slice(0, 12)}`;
}

/** The stable customer hash carried in anomaly evidence; used to join queue accounts. */
export function customerRefOf(value: string | undefined): string {
  return ref("customer", value);
}

function wagerNumbers(tickets: readonly RuleTicket[]): string[] {
  return tickets.map((ticket) => ticket.wagerNumber);
}

/** Same customer, same event, >=3 distinct periods within 60 minutes. */
export function periodCorrelation(tickets: readonly RuleTicket[]): Anomaly[] {
  const groups = new Map<
    string,
    {
      customer: string;
      event: string;
      periods: Set<string>;
      tickets: RuleTicket[];
    }
  >();
  for (const ticket of tickets) {
    const customer = customerOf(ticket);
    if (customer === undefined) continue;
    for (const leg of ticket.legs) {
      if (!PERIODS_OF_INTEREST.has(leg.period)) continue;
      const event = normalizeEventName(leg.eventName);
      const key = `${customer}\u0000${event}`;
      const group = groups.get(key) ?? {
        customer,
        event: leg.eventName,
        periods: new Set<string>(),
        tickets: [],
      };
      group.periods.add(leg.period);
      if (!group.tickets.includes(ticket)) group.tickets.push(ticket);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter(
      (group) =>
        group.periods.size >= 3 && withinWindow(group.tickets, 60 * 60_000),
    )
    .map((group) => ({
      rule: "period_correlation",
      severity: "warning",
      tickets: group.tickets,
      evidence: {
        customerRef: ref("customer", group.customer),
        event: group.event,
        periods: [...group.periods].sort(),
        periodCount: group.periods.size,
        wagerCount: group.tickets.length,
        windowMinutes: 60,
      },
    }));
}

/** Two or more wagers from one agent within 100 ms. */
export function batchReplay(tickets: readonly RuleTicket[]): Anomaly[] {
  const sorted = timed(tickets).filter(
    (ticket) => agentOf(ticket) !== undefined,
  );
  const groups: RuleTicket[][] = [];
  let current: Array<RuleTicket & { at: number }> = [];
  for (const ticket of sorted) {
    const previous = current[current.length - 1];
    if (
      previous !== undefined &&
      agentOf(previous) === agentOf(ticket) &&
      ticket.at - previous.at <= 100
    ) {
      current.push(ticket);
    } else {
      if (current.length >= 2) groups.push(current);
      current = [ticket];
    }
  }
  if (current.length >= 2) groups.push(current);
  return groups.map((group) => ({
    rule: "batch_replay",
    severity: "warning",
    tickets: group,
    evidence: {
      agentRef: ref("agent", agentOf(group[0]!)),
      count: group.length,
      windowMs: 100,
      spanMs: timeOf(group[group.length - 1]!) - timeOf(group[0]!),
      wagerNumbers: wagerNumbers(group),
    },
  }));
}

function ticketSignature(ticket: RuleTicket): string {
  return [
    ticket.stake ?? "?",
    ticket.toWin ?? "?",
    ticket.legs
      .map((leg) => `${leg.selection}@${leg.price ?? ""}`)
      .sort()
      .join("&"),
  ].join("|");
}

/** Same customer, identical stake/to-win/legs, within 60 seconds. */
export function cloneBet(tickets: readonly RuleTicket[]): Anomaly[] {
  const byCustomer = new Map<string, Map<string, RuleTicket[]>>();
  for (const ticket of tickets) {
    const customer = customerOf(ticket);
    if (customer === undefined) continue;
    const signatures = byCustomer.get(customer) ?? new Map();
    const signature = ticketSignature(ticket);
    const list = signatures.get(signature) ?? [];
    list.push(ticket);
    signatures.set(signature, list);
    byCustomer.set(customer, signatures);
  }
  const hits: Anomaly[] = [];
  for (const [customer, signatures] of byCustomer) {
    for (const [signature, list] of signatures) {
      if (list.length < 2 || !withinWindow(list, 60_000)) continue;
      const sorted = [...list].sort((a, b) => timeOf(a) - timeOf(b));
      hits.push({
        rule: "clone_bet",
        severity: sorted.length >= 3 ? "warning" : "notice",
        tickets: sorted,
        evidence: {
          customerRef: ref("customer", customer),
          cloneCount: sorted.length,
          signature,
          wagerNumbers: wagerNumbers(sorted),
          // Hash the actual agent, not the TicketWriter channel (ALERT/Internet/GSLIVE).
          agentRefs: sorted
            .map((ticket) => agentOf(ticket))
            .filter(
              (agent): agent is string =>
                typeof agent === "string" && agent !== "",
            )
            .map((agent) => ref("agent", agent)),
        },
      });
    }
  }
  return hits;
}

/** Customer burst tiers: 10/5m, 30/30m, 100/60m. */
export function velocityCustomer(tickets: readonly RuleTicket[]): Anomaly[] {
  const byCustomer = new Map<string, Array<RuleTicket & { at: number }>>();
  for (const ticket of timed(tickets)) {
    const customer = customerOf(ticket);
    if (customer === undefined) continue;
    const list = byCustomer.get(customer) ?? [];
    list.push(ticket);
    byCustomer.set(customer, list);
  }
  const hits: Anomaly[] = [];
  for (const [customer, list] of byCustomer) {
    for (const tier of VELOCITY_CUSTOMER_TIERS) {
      const windowMs = tier.minutes * 60_000;
      for (let index = 0; index < list.length; index++) {
        let end = index;
        while (
          end < list.length &&
          list[end]!.at - list[index]!.at <= windowMs
        ) {
          end++;
        }
        if (end - index >= tier.count) {
          const window = list.slice(index, end);
          hits.push({
            rule: "velocity_customer",
            severity: tier.severity,
            tickets: window,
            evidence: {
              customerRef: ref("customer", customer),
              count: window.length,
              windowMinutes: tier.minutes,
              firstAt: window[0]!.insertedAt ?? "",
              lastAt: window[window.length - 1]!.insertedAt ?? "",
            },
          });
          index = end - 1;
          break;
        }
      }
    }
  }
  return hits;
}

function marketKey(leg: NormalizedTicketLeg): string {
  return [
    normalizeEventName(leg.eventName),
    leg.market,
    leg.selection,
    leg.price ?? "",
  ].join("|");
}

/** Market burst tiers: 5/30s, 20/5m, 100/30m. */
export function velocityMarket(tickets: readonly RuleTicket[]): Anomaly[] {
  const byMarket = new Map<string, RuleTicket[]>();
  for (const ticket of tickets) {
    if (!Number.isFinite(timeOf(ticket))) continue;
    for (const leg of ticket.legs) {
      const key = marketKey(leg);
      const list = byMarket.get(key) ?? [];
      if (!list.includes(ticket)) list.push(ticket);
      byMarket.set(key, list);
    }
  }
  const hits: Anomaly[] = [];
  for (const [key, list] of byMarket) {
    const sorted = timed(list);
    for (const tier of VELOCITY_MARKET_TIERS) {
      const windowMs = tier.seconds * 1000;
      for (let index = 0; index < sorted.length; index++) {
        let end = index;
        while (
          end < sorted.length &&
          sorted[end]!.at - sorted[index]!.at <= windowMs
        ) {
          end++;
        }
        if (end - index >= tier.count) {
          const window = sorted.slice(index, end);
          const customers = new Set(
            window
              .map((ticket) => customerOf(ticket))
              .filter((value): value is string => value !== undefined),
          );
          hits.push({
            rule: "velocity_market",
            severity: tier.severity,
            tickets: window,
            evidence: {
              market: key.replace(/\|/g, " · "),
              count: window.length,
              windowSeconds: tier.seconds,
              distinctCustomers: customers.size,
            },
          });
          index = end - 1;
          break;
        }
      }
    }
  }
  return hits;
}

interface OppositePair {
  readonly key: string;
  readonly side: string;
  readonly event: string;
  readonly market: string;
}

function oppositePair(leg: NormalizedTicketLeg): OppositePair | null {
  const event = normalizeEventName(leg.eventName);
  const trimmedSelection = leg.selection.trim();
  const total = /^(Over|Under)\s+(.+)$/i.exec(trimmedSelection);
  if (total !== null) {
    return {
      key: `total|${event}|${leg.market}|${total[2]}`,
      side: total[1]!.toUpperCase(),
      event: leg.eventName,
      market: leg.market,
    };
  }
  const playerTotal = /^(.+?)\s+(Over|Under)\s+(.+)$/i.exec(trimmedSelection);
  if (playerTotal !== null) {
    const subject = playerTotal[1]!.trim().toLowerCase();
    return {
      key: `total|${event}|${leg.market}|${subject}|${playerTotal[3]!.trim()}`,
      side: playerTotal[2]!.toUpperCase(),
      event: leg.eventName,
      market: leg.market,
    };
  }
  if (leg.market === "" || trimmedSelection === "") return null;
  const side = /\d+\s*-\s*\d+$/.test(trimmedSelection)
    ? trimmedSelection.toLowerCase()
    : trimmedSelection
        .replace(/\s+[+-]?\d+(?:\.\d+)?$/, "")
        .trim()
        .toLowerCase();
  return {
    key: `side|${event}|${leg.market}`,
    side,
    event: leg.eventName,
    market: leg.market,
  };
}

function oppositeGroups(
  tickets: readonly RuleTicket[],
  sameCustomer: boolean,
): Array<{
  key: string;
  sides: Map<string, RuleTicket[]>;
  customer?: string | undefined;
  event: string;
  market: string;
}> {
  const groups = new Map<
    string,
    {
      key: string;
      sides: Map<string, RuleTicket[]>;
      customer?: string | undefined;
      event: string;
      market: string;
    }
  >();
  for (const ticket of tickets) {
    const customer = customerOf(ticket);
    if (sameCustomer && customer === undefined) continue;
    for (const leg of ticket.legs) {
      const pair = oppositePair(leg);
      if (pair === null) continue;
      const key = sameCustomer ? `${customer}\u0000${pair.key}` : pair.key;
      const group = groups.get(key) ?? {
        key,
        sides: new Map<string, RuleTicket[]>(),
        ...(sameCustomer ? { customer } : {}),
        event: pair.event,
        market: pair.market,
      };
      const side = group.sides.get(pair.side) ?? [];
      if (!side.includes(ticket)) side.push(ticket);
      group.sides.set(pair.side, side);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

/** Same customer on both sides of the same event/market within 60 minutes. */
export function oppositeSidesSameCustomer(
  tickets: readonly RuleTicket[],
): Anomaly[] {
  const hits: Anomaly[] = [];
  for (const group of oppositeGroups(tickets, true)) {
    if (group.sides.size < 2) continue;
    const all = [...new Set([...group.sides.values()].flat())];
    if (all.length < 2 || !withinWindow(all, 60 * 60_000)) continue;
    hits.push({
      rule: "opposite_sides_same_customer",
      severity: "notice",
      tickets: all,
      evidence: {
        customerRef: ref("customer", group.customer),
        event: group.event,
        market: group.market,
        sides: [...group.sides.keys()],
        wagerNumbers: wagerNumbers(all),
      },
    });
  }
  return hits;
}

/** Different customers on both sides of the same event/market within 5 minutes. */
export function oppositeSidesAcrossCustomers(
  tickets: readonly RuleTicket[],
): Anomaly[] {
  const hits: Anomaly[] = [];
  for (const group of oppositeGroups(tickets, false)) {
    if (group.sides.size < 2) continue;
    const all = [...new Set([...group.sides.values()].flat())];
    const customers = new Set(
      all
        .map((ticket) => customerOf(ticket))
        .filter((value): value is string => value !== undefined),
    );
    if (customers.size < 2 || !withinWindow(all, 5 * 60_000)) continue;
    hits.push({
      rule: "opposite_sides_across_customers",
      severity: "notice",
      tickets: all,
      evidence: {
        event: group.event,
        market: group.market,
        sides: [...group.sides.keys()],
        distinctCustomers: customers.size,
        wagerNumbers: wagerNumbers(all),
      },
    });
  }
  return hits;
}

/** Later-period ticket followed by an earlier period more than 10 minutes later. */
export function periodOrderAnomaly(tickets: readonly RuleTicket[]): Anomaly[] {
  const byCustomerEvent = new Map<
    string,
    Array<{ ticket: RuleTicket; rank: number; period: string; at: number }>
  >();
  for (const ticket of tickets) {
    const customer = customerOf(ticket);
    const at = timeOf(ticket);
    if (customer === undefined || !Number.isFinite(at)) continue;
    for (const leg of ticket.legs) {
      const rank = PERIOD_RANK[leg.period];
      if (rank === undefined) continue;
      const key = `${customer}\u0000${normalizeEventName(leg.eventName)}`;
      const list = byCustomerEvent.get(key) ?? [];
      list.push({ ticket, rank, period: leg.period, at });
      byCustomerEvent.set(key, list);
    }
  }
  const hits: Anomaly[] = [];
  for (const list of byCustomerEvent.values()) {
    list.sort((a, b) => a.at - b.at);
    let maxRank = 0;
    let maxAt = 0;
    let maxPeriod = "";
    for (const entry of list) {
      if (entry.rank < maxRank && entry.at - maxAt > 10 * 60_000) {
        hits.push({
          rule: "period_order_anomaly",
          severity: "notice",
          tickets: [entry.ticket],
          evidence: {
            customerRef: ref("customer", customerOf(entry.ticket)),
            event: entry.ticket.legs[0]?.eventName ?? "",
            period: entry.period,
            priorPeriod: maxPeriod,
            gapMinutes: Math.round((entry.at - maxAt) / 60_000),
          },
        });
      }
      if (entry.rank > maxRank) {
        maxRank = entry.rank;
        maxAt = entry.at;
        maxPeriod = entry.period;
      }
    }
  }
  return hits;
}

const PREGAME_PERIODS = new Set(["Game", "1H", "1P", "1Q"]);

/** Wager inserted after the scheduled start; no-op without `--event-schedule`. */
export function pastPost(
  tickets: readonly RuleTicket[],
  options?: RuleOptions,
): Anomaly[] {
  const schedule = options?.schedule;
  if (schedule === undefined || schedule.size === 0) return [];
  const hits: Anomaly[] = [];
  for (const ticket of tickets) {
    const at = timeOf(ticket);
    if (!Number.isFinite(at)) continue;
    for (const leg of ticket.legs) {
      if (!PREGAME_PERIODS.has(leg.period)) continue;
      const start = schedule.get(normalizeEventName(leg.eventName));
      if (start === undefined) continue;
      const startMs = Date.parse(start);
      if (!Number.isFinite(startMs) || at <= startMs) continue;
      hits.push({
        rule: "past_post",
        severity: "warning",
        tickets: [ticket],
        evidence: {
          event: leg.eventName,
          scheduledStart: start,
          insertedAt: ticket.insertedAt ?? "",
          wagerNumber: ticket.wagerNumber,
        },
      });
    }
  }
  return hits;
}

export const DETERMINISTIC_RULES: Readonly<Record<RuleName, Rule>> = {
  period_correlation: periodCorrelation,
  opposite_sides_same_customer: oppositeSidesSameCustomer,
  opposite_sides_across_customers: oppositeSidesAcrossCustomers,
  batch_replay: batchReplay,
  clone_bet: cloneBet,
  velocity_customer: velocityCustomer,
  velocity_market: velocityMarket,
  period_order_anomaly: periodOrderAnomaly,
  past_post: pastPost,
};

/** Copy the rule-relevant fields and carry the private identity onto the copy. */
export function toRuleTicket(
  ticket: {
    wagerNumber: string;
    insertedAt: string | null;
    stake: number | null;
    toWin: number | null;
    ticketWriter?: string;
    legs: readonly NormalizedTicketLeg[];
  },
  source?: object,
): RuleTicket {
  const copy: RuleTicket = {
    wagerNumber: ticket.wagerNumber,
    insertedAt: ticket.insertedAt,
    stake: ticket.stake,
    toWin: ticket.toWin,
    ...(ticket.ticketWriter === undefined
      ? {}
      : { ticketWriter: ticket.ticketWriter }),
    legs: ticket.legs,
  };
  const internal = getTicketInternal(source ?? ticket);
  if (internal !== undefined) setTicketInternal(copy, internal);
  return copy;
}
