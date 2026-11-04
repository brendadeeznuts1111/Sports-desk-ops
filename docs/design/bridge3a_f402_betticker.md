# Bridge 3a — F402 BetTicker → WS + R2 summary (open)

Status: **open, first of the four 3x workstreams.** Design only; no implementation yet.

## Goal

Poll Fantasy402 `Manager/getBetTicker` read-only, normalize the ticker rows, and publish:

1. a WS delta on the existing gateway channel `f402-bet-ticker` (lowercase), and
2. a sanitized `f402-bet-ticker/latest.json` snapshot in `sportsdesk-ops-reports`.

This is the first of 3a–3d because it exercises the shared event/snapshot rules in
[`pii_sanitization.md`](./pii_sanitization.md) and [`stream_map.md`](./stream_map.md) without needing
settlement aggregation.

## Inputs and outputs

- Input: `lib/f402_ingest.ts` `probeF402BetTicker()` → `F402Probe` / `F402TickerRow[]`
  (`login`, `customerId`, `agentId`, `ticketWriter`, `wagerNumber`, `wagerType`, `shortDesc`,
  `insertedAt`, `vip`).
- WS event: a per-poll **delta** (new/gone/changed counts and bounded dimensions), not raw rows.
- R2 snapshot: `f402-bet-ticker/latest.json`, metadata `x-amz-meta-pii: none`, schema version,
  poll time, row counts, source hash.
- No exact insertedAt below hour; no login/customer/agent/ticket ids; `shortDesc` is free text and
  must be dropped or mapped to a bounded wager-type allowlist.

## Contract sketch

```ts
export interface F402TickerDeltaEvent {
  schemaVersion: 1;
  kind: "f402-bet-ticker";
  polledAt: string;
  deskDate: string;
  deskHour: number;
  newTickets: number;
  goneTickets: number;
  changedTickets: number;
  byWagerType: readonly {
    wagerType: string;
    ticketCount: number;
    legCount: number;
  }[];
  sourceSha256: string;
}

export function projectF402TickerDelta(
  previous: readonly F402TickerRow[],
  current: readonly F402TickerRow[],
  polledAt: string,
): F402TickerDeltaEvent;
```

The projection drops identity fields and is pure/testable; the poller only supplies rows and
publishes the result.

## Delivery

- Poller: reuse `probeF402BetTicker` with the existing F402 session/replay transport; no cookies in
  argv or logs.
- WS: `POST /api/v1/live-bets` with bearer, channel `f402-bet-ticker`.
- R2: `R2S3Client.fromEnvOrSecrets()` + `writeWithMetadata("f402-bet-ticker/latest.json", ..., {
metadata: { pii: "none", ... } })`; verify with `stat` and presigned GET.
- Failure semantics: a failed poll never replaces the last good R2 snapshot; WS publish failure is
  reported but does not discard the poll result.
- Tests: pure delta projection (new/gone/changed, no PII, no raw rows), gateway publish contract,
  R2 write with metadata, and a live smoke that deletes its test object.

## Open decisions

- Is `shortDesc` dropped entirely or reduced to a bounded `wagerType` label?
- Should the delta include per-market counts or only wager-type totals (k-anonymity)?
- Poll cadence and the corresponding R2 freshness budget.
