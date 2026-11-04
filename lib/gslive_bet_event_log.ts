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
  | "MANUAL_ADMIN_INTERVENTION"
  | "FROZEN_CLOCK_SCORING_OR_PLAY"
  | "EXTENDED_FEED_OUTAGE";

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
  readonly maxFeedGapMs: number | null;
  readonly frozenClockScoreChanges: number;
  readonly anomalies: readonly AnomalyFlag[];
}

export interface EventTimelineAudit {
  readonly maxFeedGapMs: number | null;
  readonly frozenClockScoreChanges: number;
  readonly frozenClockSpanMs: number | null;
  readonly anomalies: readonly AnomalyFlag[];
}
/** Frozen-clock / long-outage audit over parsed ticks (state unblocked gates the frozen flag). */
export function auditEventTimeline(
  payload: unknown,
  eventState = "unblocked",
  outageThresholdMs = 60_000,
): EventTimelineAudit {
  const ticks = parseEventLog(payload);
  let maxFeedGapMs: number | null = null;
  for (let i = 1; i < ticks.length; i += 1) {
    const gap =
      (ticks[i]?.updateTimeMs ?? 0) - (ticks[i - 1]?.updateTimeMs ?? 0);
    if (maxFeedGapMs === null || gap > maxFeedGapMs) maxFeedGapMs = gap;
  }
  let best = { changes: 0, span: 0 };
  let runStart: number | null = null,
    runClock: number | null = null,
    runChanges = 0,
    prevM: readonly [number, number] | null = null;
  for (const tick of ticks) {
    if (runClock === null || tick.t !== runClock) {
      if (runStart !== null && runChanges > best.changes)
        best = {
          changes: runChanges,
          span: prevM === null ? 0 : tick.updateTimeMs - runStart,
        };
      runStart = tick.updateTimeMs;
      runClock = tick.t;
      runChanges = 0;
      prevM = tick.m;
      continue;
    }
    if (prevM !== null && (tick.m[0] !== prevM[0] || tick.m[1] !== prevM[1])) {
      runChanges += 1;
      best = {
        changes: runChanges,
        span: runStart === null ? 0 : tick.updateTimeMs - runStart,
      };
    }
    prevM = tick.m;
  }
  let longPossessionFlip = false;
  for (let i = 1; i < ticks.length; i += 1) {
    const a = ticks[i - 1],
      b = ticks[i];
    if (
      a !== undefined &&
      b !== undefined &&
      a.p !== b.p &&
      b.updateTimeMs - a.updateTimeMs > 15_000
    )
      longPossessionFlip = true;
  }
  const anomalies: AnomalyFlag[] = [];
  if (
    eventState.toLowerCase() === "unblocked" &&
    (best.changes > 0 || longPossessionFlip)
  )
    anomalies.push("FROZEN_CLOCK_SCORING_OR_PLAY");
  if (maxFeedGapMs !== null && maxFeedGapMs > outageThresholdMs)
    anomalies.push("EXTENDED_FEED_OUTAGE");
  return {
    maxFeedGapMs,
    frozenClockScoreChanges: best.changes,
    frozenClockSpanMs: best.changes > 0 ? best.span : null,
    anomalies,
  };
}
/** Parse GS Manager timestamps: epoch seconds/ms or "YYYY-MM-DD HH:mm:ss(.SSS)" in desk time. */
export function parseGsliveTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value;
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < 1e12 ? n * 1000 : n;
  }
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(
      text,
    );
  if (m === null) return null;
  const wallUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number((m[7] ?? "0").padEnd(3, "0")),
  );
  const offsetPart =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date(wallUtc))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-6";
  const om = /GMT([+-])(\d{1,2})/.exec(offsetPart);
  const offsetMinutes =
    om === null ? -360 : (om[1] === "-" ? -1 : 1) * Number(om[2]) * 60;
  return wallUtc - offsetMinutes * 60_000;
}
export interface BetLogAuditTarget {
  readonly betId: string;
  readonly eventId: string;
  readonly logTime: string;
  readonly reasons: readonly string[];
  readonly placementSnapshotM: readonly [number, number] | null;
}
export type PrescreenReason =
  | "ODDS_DRIFT"
  | "DELAY_MISMATCH"
  | "ADMIN_USER"
  | "MANUAL_LOG"
  | "SUSPECTED_BOT"
  | "REVERSED_CREDIT"
  | "PLACEMENT_SNAPSHOT_MISMATCH";
/** Stage 1: pre-screen 69-field getBetReport rows before spending a getBetLog call. */
export function extractBetLogAuditTargets(
  rows: readonly Record<string, unknown>[],
  eventLogs?: ReadonlyMap<string, unknown>,
): BetLogAuditTarget[] {
  const targets: BetLogAuditTarget[] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    if (String(row.fVal ?? "") !== String(row.fVal_new ?? ""))
      reasons.push("ODDS_DRIFT");
    const acceptMs = parseGsliveTimestampMs(row.acceptTime);
    const logMs = parseGsliveTimestampMs(row.logTime);
    const delaySec = Number(row.delay);
    if (
      acceptMs !== null &&
      logMs !== null &&
      Number.isFinite(delaySec) &&
      Math.abs(acceptMs - logMs - delaySec * 1000) > 1500
    ) {
      reasons.push("DELAY_MISMATCH");
    }
    if (row.adminUser !== null && row.adminUser !== undefined)
      reasons.push("ADMIN_USER");
    if (String(row.manualLogExists ?? "0") !== "0") reasons.push("MANUAL_LOG");
    if (String(row.isSuspectedBot ?? "0") !== "0")
      reasons.push("SUSPECTED_BOT");
    if (row.reversedCredit !== null && row.reversedCredit !== undefined)
      reasons.push("REVERSED_CREDIT");
    let snapshot: readonly [number, number] | null = null;
    try {
      const parsed = JSON.parse(String(row.eventResult ?? "")) as {
        m?: unknown;
      };
      if (Array.isArray(parsed.m) && parsed.m.length >= 2)
        snapshot = [Number(parsed.m[0]), Number(parsed.m[1])];
    } catch {
      /* non-JSON marker */
    }
    const eventId = String(row.eID ?? "");
    const eventLog = eventLogs?.get(eventId);
    if (snapshot !== null && eventLog !== undefined) {
      const logValue = Number(row.logTime);
      const logEpochMs = Number.isFinite(logValue) ? logValue * 1000 : NaN;
      const ticks = parseEventLog(eventLog).filter(
        (tick) => tick.updateTimeMs <= logEpochMs,
      );
      const atPlace = ticks.at(-1)?.m ?? null;
      if (
        atPlace !== null &&
        (atPlace[0] !== snapshot[0] || atPlace[1] !== snapshot[1])
      )
        reasons.push("PLACEMENT_SNAPSHOT_MISMATCH");
    }
    if (reasons.length > 0)
      targets.push({
        betId: String(row.id ?? ""),
        eventId,
        logTime: String(row.logTime ?? ""),
        reasons,
        placementSnapshotM: snapshot,
      });
  }
  return targets;
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
  const timelineAudit = auditEventTimeline(
    input.eventLog,
    input.eventState ?? "unblocked",
    input.stallThresholdMs ?? 5_000,
  );
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
    maxFeedGapMs: timelineAudit.maxFeedGapMs,
    frozenClockScoreChanges: timelineAudit.frozenClockScoreChanges,
    anomalies,
  };
}
