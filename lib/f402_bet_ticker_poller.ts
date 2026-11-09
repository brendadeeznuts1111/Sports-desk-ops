/**
 * @file f402_bet_ticker_poller.ts
 * @description One Bridge 3a poll: fail-closed drain → pure delta projection → WS delta + R2
 * snapshot → watermark advance. The state is in-memory and monotonic; a failed, regressed, or
 * unsettled drain returns the previous state untouched, so the last good snapshot and watermark
 * survive. Sink failures are reported but do not discard a poll that was processed (Bridge 1's
 * rule: WS is best-effort, R2 keeps the last good object on failure).
 */

import {
  buildF402TickerSnapshot,
  highestWagerNumber,
  projectF402TickerDeltaWithDiagnostics,
  type F402TickerBatchDiagnostics,
  type F402TickerDeltaEvent,
  type F402TickerSnapshot,
} from "./f402_bet_ticker_delta.ts";
import {
  drainF402BetTicker,
  type F402TickerDrainOptions,
} from "./f402_bet_ticker_drain.ts";
import type { F402TickerRow } from "./f402_ingest.ts";
import type {
  F402BetTickerSink,
  F402BetTickerSinkResult,
} from "./f402_bet_ticker_sink.ts";

export interface F402BetTickerPollState {
  /** Highest wager number fully processed by a completed drain. */
  readonly watermark: number;
  /** Rows of the last completed poll; the baseline for the next delta. */
  readonly previousRows: readonly F402TickerRow[];
}

export interface F402BetTickerPollOptions {
  readonly probe: F402TickerDrainOptions["probe"];
  readonly sink: F402BetTickerSink;
  readonly state: F402BetTickerPollState;
  /** ISO timestamp for the poll; defaults to the current time. */
  readonly now?: () => string;
  /**
   * Emit the first poll as a WS delta instead of silently establishing its watermark. Default
   * false: a cold start has no previous rows, so a delta would call the whole ticker "new".
   */
  readonly publishBaseline?: boolean;
  readonly pageLimit?: number;
  readonly maxPages?: number;
}

export type F402BetTickerPollOutcome =
  | {
      readonly status: "published";
      readonly event: F402TickerDeltaEvent;
      readonly snapshot: F402TickerSnapshot;
      readonly liveBets: F402BetTickerSinkResult;
      readonly r2: F402BetTickerSinkResult;
      readonly state: F402BetTickerPollState;
      readonly diagnostics?: F402TickerBatchDiagnostics;
    }
  | {
      readonly status: "baseline";
      readonly event: F402TickerDeltaEvent;
      readonly snapshot: F402TickerSnapshot;
      readonly r2: F402BetTickerSinkResult;
      readonly state: F402BetTickerPollState;
      readonly diagnostics?: F402TickerBatchDiagnostics;
    }
  | {
      readonly status: "noop";
      readonly reason: "no-new-rows";
      readonly state: F402BetTickerPollState;
    }
  | {
      readonly status: "regressed";
      readonly watermark: number;
      readonly pageMax: number;
      readonly state: F402BetTickerPollState;
    }
  | {
      readonly status: "unsettled";
      readonly pages: number;
      readonly state: F402BetTickerPollState;
    }
  | {
      readonly status: "error";
      readonly error: string;
      readonly state: F402BetTickerPollState;
    };

/** Default poll cadence once the loop is wired; the CLI passes it explicitly. */
export const F402_BET_TICKER_DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * Run one poll against the injected probe and sink. Returns an outcome instead of throwing: the
 * caller logs it and keeps the returned state, which is unchanged for a fail-closed result and
 * advanced only for a processed poll.
 */
export async function pollF402BetTickerOnce(
  options: F402BetTickerPollOptions,
): Promise<F402BetTickerPollOutcome> {
  const polledAt = (options.now ?? (() => new Date().toISOString()))();
  const drain = await drainF402BetTicker({
    probe: options.probe,
    watermark: options.state.watermark,
    ...(options.pageLimit === undefined
      ? {}
      : { pageLimit: options.pageLimit }),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
  });

  if (drain.status === "error") {
    return {
      status: "error",
      error: drain.error,
      state: options.state,
    };
  }
  if (drain.status === "regressed") {
    return {
      status: "regressed",
      watermark: drain.watermark,
      pageMax: drain.pageMax,
      state: options.state,
    };
  }
  if (drain.status === "unsettled") {
    return {
      status: "unsettled",
      pages: drain.pages,
      state: options.state,
    };
  }
  if (drain.status === "empty") {
    return {
      status: "noop",
      reason: "no-new-rows",
      state: { ...options.state, previousRows: [] },
    };
  }

  const rows = drain.rows;
  const coldStart =
    options.state.watermark === 0 && options.state.previousRows.length === 0;

  if (coldStart && options.publishBaseline !== true) {
    const { event, diagnostics } = projectF402TickerDeltaWithDiagnostics(
      [],
      rows,
      polledAt,
    );
    const snapshot = buildF402TickerSnapshot(event, rows.length);
    const r2 = await options.sink.publishR2(snapshot);
    return {
      status: "baseline",
      event,
      snapshot,
      r2,
      state: { watermark: drain.watermark, previousRows: rows },
      diagnostics,
    };
  }

  // "No row above the watermark" is an idempotent no-op: keep the last good snapshot, do not
  // publish a delta that claims progress.
  if (
    options.state.watermark > 0 &&
    highestWagerNumber(rows) <= options.state.watermark
  ) {
    return {
      status: "noop",
      reason: "no-new-rows",
      state: { ...options.state, previousRows: rows },
    };
  }

  const { event, diagnostics } = projectF402TickerDeltaWithDiagnostics(
    options.state.previousRows,
    rows,
    polledAt,
  );
  const snapshot = buildF402TickerSnapshot(event, rows.length);
  const liveBets = await options.sink.publishLiveBets(event);
  const r2 = await options.sink.publishR2(snapshot);
  return {
    status: "published",
    event,
    snapshot,
    liveBets,
    r2,
    state: { watermark: drain.watermark, previousRows: rows },
    diagnostics,
  };
}
