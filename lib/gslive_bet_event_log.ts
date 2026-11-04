/**
 * @file gslive_bet_event_log.ts
 * @description GSLive getBetLog/getEventLog parsing, wager-state validation, and the
 * placement/acceptance/score anomaly audit. Pure: no network, no keychain, no PII output.
 */

export type WagerState =
  "accepted" | "placed_only" | "rejected" | "manual_override";
export interface BetLogEntry {
  readonly logDetails: string;
  readonly logTimeMs: number;
  readonly manual: boolean;
  readonly adminUserName: string | null;
}
export interface EventTick {
  readonly id: string;
  readonly updateTimeMs: number;
  readonly m: readonly [number, number];
  readonly p: number;
  readonly t: number;
  readonly ht: boolean;
  readonly tu: number;
  readonly lsGuid: string;
}
export interface ParsedBetLog {
  readonly placedAtMs: number;
  readonly acceptedAtMs: number | null;
  readonly observedDelayMs: number | null;
  readonly placedOddsAmerican: number | null;
  readonly acceptedOddsAmerican: number | null;
  readonly oddsDeltaAmerican: number | null;
  readonly f402TicketNumber: string | null;
  readonly isManuallyEntered: boolean;
  readonly adminUserName: string | null;
  readonly inferredState: WagerState;
}
export type AnomalyFlag =
  | "WAGER_STATE_MISMATCH"
  | "SCORE_DURING_DELAY_WINDOW"
  | "SUB_15S_SCORE_SNIPE"
  | "POSSESSION_FLIP_DURING_DELAY"
  | "ACCEPTED_WHILE_BLOCKED"
  | "FEED_STALL_AT_PLACEMENT"
  | "ODDS_IMPROVEMENT_DURING_DELAY"
  | "MANUAL_ADMIN_INTERVENTION";

const num = (v: unknown): number | null => {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN;
  return Number.isFinite(n) ? n : null;
};

function parseEventResult(raw: unknown): EventTick | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const o = value as Record<string, unknown> | null;
  if (o === null || typeof o !== "object") return null;
  const m =
    Array.isArray(o.m) && o.m.length >= 2
      ? ([Number(o.m[0]), Number(o.m[1])] as const)
      : null;
  if (m === null) return null;
  return {
    id: "",
    updateTimeMs: 0,
    m,
    p: Number(o.p ?? 0),
    t: Number(o.t ?? 0),
    ht: o.ht === true,
    tu: Number(o.tu ?? 0),
    lsGuid: String(o.ls_guid ?? ""),
  };
}

export function parseBetLog(payload: unknown): ParsedBetLog {
  const rows = (
    Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { r?: unknown }).r)
        ? (payload as { r: unknown[] }).r
        : []
  ) as Record<string, unknown>[];
  let placedAtMs: number | null = null,
    acceptedAtMs: number | null = null;
  let placedOdds: number | null = null,
    acceptedOdds: number | null = null,
    ticket: string | null = null;
  let manual = false,
    admin: string | null = null,
    rejected = false;
  for (const row of rows) {
    const details = String(row.logDetails ?? "");
    const time = num(row.logTime);
    if (row.isManuallyEntered === "1" || row.isManuallyEntered === 1)
      manual = true;
    if (
      typeof row.adminUserName === "string" &&
      row.adminUserName.trim() !== ""
    )
      admin = row.adminUserName.trim();
    if (/reject|void|declin/i.test(details)) rejected = true;
    const placed = /Bet placed @ ([+-]?\d+)/i.exec(details);
    const accepted = /Ticket#\s*(\d+)\s+accepted @ ([+-]?\d+)/i.exec(details);
    if (placed !== null) {
      placedAtMs = time;
      placedOdds = Number(placed[1]);
    }
    if (accepted !== null) {
      acceptedAtMs = time;
      ticket = accepted[1] ?? null;
      acceptedOdds = Number(accepted[2]);
    }
  }
  if (placedAtMs === null) throw new Error("betLog has no 'Bet placed' entry");
  const inferredState: WagerState =
    manual || admin !== null
      ? "manual_override"
      : rejected
        ? "rejected"
        : acceptedAtMs !== null
          ? "accepted"
          : "placed_only";
  return {
    placedAtMs,
    acceptedAtMs,
    observedDelayMs: acceptedAtMs === null ? null : acceptedAtMs - placedAtMs,
    placedOddsAmerican: placedOdds,
    acceptedOddsAmerican: acceptedOdds,
    oddsDeltaAmerican:
      placedOdds !== null && acceptedOdds !== null
        ? acceptedOdds - placedOdds
        : null,
    f402TicketNumber: ticket,
    isManuallyEntered: manual,
    adminUserName: admin,
    inferredState,
  };
}

export function parseEventLog(payload: unknown): EventTick[] {
  const rows = (
    Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { r?: unknown }).r)
        ? (payload as { r: unknown[] }).r
        : []
  ) as Record<string, unknown>[];
  const ticks: EventTick[] = [];
  for (const row of rows) {
    const parsed = parseEventResult(row.eventResult);
    const updateTimeMs = num(row.updateTime);
    if (parsed === null || updateTimeMs === null) continue;
    ticks.push({ ...parsed, id: String(row.id ?? ""), updateTimeMs });
  }
  return ticks.sort((a, b) => a.updateTimeMs - b.updateTimeMs);
}

export interface BetTimelineAudit {
  readonly betId: string;
  readonly f402TicketNumber: string | null;
  readonly inferredState: WagerState;
  readonly stateMatchesExpected: boolean | null;
  readonly placedAtMs: number;
  readonly acceptedAtMs: number | null;
  readonly observedDelayMs: number | null;
  readonly placedOddsAmerican: number | null;
  readonly acceptedOddsAmerican: number | null;
  readonly oddsDeltaAmerican: number | null;
  readonly feedGapAtPlacementMs: number | null;
  readonly scoreAtPlace: readonly [number, number] | null;
  readonly nextScore: readonly [number, number] | null;
  readonly msFromPlaceToNextScore: number | null;
  readonly msFromAcceptToNextScore: number | null;
  readonly would12sDelayInterceptScore: boolean | null;
  readonly anomalies: readonly AnomalyFlag[];
}

export function validateAndAuditBetTimeline(input: {
  readonly betId: string;
  readonly expectedWagerState?: string;
  readonly betLog: unknown;
  readonly eventLog: unknown;
  readonly eventState?: string;
  readonly stallThresholdMs?: number;
}): BetTimelineAudit {
  const bet = parseBetLog(input.betLog);
  const ticks = parseEventLog(input.eventLog);
  const atPlace =
    ticks.filter((tick) => tick.updateTimeMs <= bet.placedAtMs).at(-1) ?? null;
  const afterPlace = ticks.filter((tick) => tick.updateTimeMs > bet.placedAtMs);
  const nextTick = afterPlace[0] ?? null;
  const nextScoreTick =
    afterPlace.find(
      (tick) =>
        atPlace === null ||
        tick.m[0] !== atPlace.m[0] ||
        tick.m[1] !== atPlace.m[1],
    ) ?? null;
  const feedGap =
    atPlace !== null && nextTick !== null
      ? nextTick.updateTimeMs - atPlace.updateTimeMs
      : null;
  const scoreAtPlace = atPlace?.m ?? null;
  const nextScore = nextScoreTick?.m ?? null;
  const msFromPlace =
    nextScoreTick === null ? null : nextScoreTick.updateTimeMs - bet.placedAtMs;
  const msFromAccept =
    nextScoreTick === null || bet.acceptedAtMs === null
      ? null
      : nextScoreTick.updateTimeMs - bet.acceptedAtMs;
  const would12s =
    nextScoreTick === null
      ? null
      : bet.placedAtMs + 12_000 >= nextScoreTick.updateTimeMs;
  const delayWindow = ticks.filter(
    (tick) =>
      tick.updateTimeMs > bet.placedAtMs &&
      bet.acceptedAtMs !== null &&
      tick.updateTimeMs <= bet.acceptedAtMs,
  );
  const scoreDuringDelay =
    scoreAtPlace !== null &&
    delayWindow.some(
      (tick) => tick.m[0] !== scoreAtPlace[0] || tick.m[1] !== scoreAtPlace[1],
    );
  const possessionFlip =
    delayWindow.length > 0 &&
    atPlace !== null &&
    delayWindow.some((tick) => tick.p !== atPlace.p);
  const anomalies: AnomalyFlag[] = [];
  const stateMatchesExpected =
    input.expectedWagerState === undefined
      ? null
      : bet.inferredState === input.expectedWagerState;
  if (stateMatchesExpected === false) anomalies.push("WAGER_STATE_MISMATCH");
  if (scoreDuringDelay) anomalies.push("SCORE_DURING_DELAY_WINDOW");
  if (msFromAccept !== null && msFromAccept < 15_000 && nextScoreTick !== null)
    anomalies.push("SUB_15S_SCORE_SNIPE");
  if (possessionFlip) anomalies.push("POSSESSION_FLIP_DURING_DELAY");
  if ((input.eventState ?? "").toLowerCase() === "blocked")
    anomalies.push("ACCEPTED_WHILE_BLOCKED");
  if (feedGap !== null && feedGap > (input.stallThresholdMs ?? 5_000))
    anomalies.push("FEED_STALL_AT_PLACEMENT");
  if (bet.oddsDeltaAmerican !== null && bet.oddsDeltaAmerican > 0)
    anomalies.push("ODDS_IMPROVEMENT_DURING_DELAY");
  if (bet.isManuallyEntered || bet.adminUserName !== null)
    anomalies.push("MANUAL_ADMIN_INTERVENTION");
  return {
    betId: input.betId,
    f402TicketNumber: bet.f402TicketNumber,
    inferredState: bet.inferredState,
    stateMatchesExpected,
    placedAtMs: bet.placedAtMs,
    acceptedAtMs: bet.acceptedAtMs,
    observedDelayMs: bet.observedDelayMs,
    placedOddsAmerican: bet.placedOddsAmerican,
    acceptedOddsAmerican: bet.acceptedOddsAmerican,
    oddsDeltaAmerican: bet.oddsDeltaAmerican,
    feedGapAtPlacementMs: feedGap,
    scoreAtPlace,
    nextScore,
    msFromPlaceToNextScore: msFromPlace,
    msFromAcceptToNextScore: msFromAccept,
    would12sDelayInterceptScore: would12s,
    anomalies,
  };
}
