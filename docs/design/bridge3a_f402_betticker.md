# Bridge 3a — F402 BetTicker → WS + R2 summary (open)

Status: **open, first of the four 3x workstreams.** Design only; no implementation yet.

## Goal

Poll Fantasy402 `Manager/getBetTicker` read-only, normalize the ticker rows, and publish:

1. a WS delta on the gateway channel `f402-bet-ticker` (lowercase), and
2. a sanitized `f402-bet-ticker/latest.json` snapshot in `sportsdesk-ops-reports`.

This is the first of 3a–3d because it exercises the shared event/snapshot rules in
[`pii_sanitization.md`](./pii_sanitization.md) and [`stream_map.md`](./stream_map.md) without needing
settlement aggregation.

## Locked extraction and demux

Extract these bounded fields **before** dropping `ShortDesc`. The raw text is never published.

### ExtendedSignalChannelCode (11)

`Internet`, `ALERT`, `GSLIVE`, `GSBUILDER`, `LIVE_CWS`, `CSLEVEL2`, `PHONE`, `HOUSE_BOOK`, `GATEWAY`,
`BLOCKED`, `NON_SPORTS_DROP`

### WagerType (8)

`S`, `M`, `L`, `E`, `P`, `T`, `I`, `G`

`ShortDesc` is demux input only: parse the channel and wager type into the bounded codes, then drop
the raw string. Unknown channel/type maps to `other`/`unknown` (never emitted as free text).

## Inputs and outputs

- Input: `lib/f402_ingest.ts` `probeF402BetTicker()` → `F402Probe` / `F402TickerRow[]`
  (`login`, `customerId`, `agentId`, `ticketWriter`, `wagerNumber`, `wagerType`, `shortDesc`,
  `insertedAt`, `vip`).
- Internal dedupe: `${TicketNumber}-${WagerNumber}`; one risk/to-win amount per ticket before
  summing. Raw login/customer/agent/ticket ids are never output.
- WS event: per-poll delta with channel/wager-type counts plus alert-twin metrics.
- R2 snapshot: `f402-bet-ticker/latest.json`, `x-amz-meta-pii: none`, schema version, poll time,
  watermark, row/leg counts, source hash.
- Timestamps coarsen to `deskDate` and `deskHour`; no exact `insertedAt`.

**Runtime boundary — Bun service, Node Harness:** Bridge 3 executes entirely under Bun in
`sportsdesk-ops` (`:4020`). The Harness host is Node (`:3080`) and has no `Bun` global. Any
Harness-facing view of Bridge 3 (gates, freshness, census) must be a thin HTTP client against
`:4020`, not an import of Bun-only modules — the same class of failure `dsh-plugin/verify-runtime.mjs`
exists to catch. `Bun.secrets` access is confined to the service; the Host receives credentials only
via the service's HTTP surface.

## Locked accounting rules

### ALERT rows are not handle

- Every parsed `ALERT` row sets `canonicalVolumeCents = 0`; it never contributes to handle,
  risk, to-win, or settled volume.
- Count it separately as `alertTwinCount` and in the `CONFIRM`, `LATE`, and `ORPHAN` metrics.
  These are count axes, not money axes.
- An ALERT row and its non-ALERT twin must not both add money. The dedupe key
  `${TicketNumber}-${WagerNumber}` identifies the twin; the non-ALERT row owns the money.

### No parlay multiplication

- Deduplicate `riskCents` and `toWinCents` by `${TicketNumber}-${WagerNumber}` **before** any sum.
- `legCount` counts legs; `ticketCount` counts distinct deduped tickets; risk/to-win are counted
  once per ticket/group, never once per leg.
- `M.G<betGroupId>` (when present) is the group key for multi-leg grouping; it is internal and
  never published.

## Locked watermark and 100-row drain

- Maintain a fail-closed `wagerNumber` watermark: the highest wager number fully processed from a
  completed drain.
- If `LIST.length >= 100`, do **not** publish/advance the watermark yet. Drain immediately with
  another `getBetTicker` request, repeating until a response has fewer than 100 rows, then publish
  one delta and advance the watermark.
- If a poll returns no row above the watermark, publish no event (idempotent no-op) but keep the last
  good R2 snapshot.
- If the response goes backwards (a row or page below the watermark), fail closed: do not publish,
  do not replace R2, and surface a watermark-regression alert.
- A failed/incomplete drain leaves the previous watermark and R2 snapshot untouched.

## Contract sketch

```ts
export interface F402TickerDeltaEvent {
  schemaVersion: 1;
  kind: "f402-bet-ticker";
  polledAt: string;
  deskDate: string;
  deskHour: number;
  watermark: string;
  newTickets: number;
  goneTickets: number;
  changedTickets: number;
  alertTwinCount: number;
  confirmCount: number;
  lateCount: number;
  orphanCount: number;
  byChannel: readonly {
    channel: string;
    ticketCount: number;
    legCount: number;
    canonicalVolumeCents: number;
  }[];
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

The projection drops identity/free-text fields and is pure/testable; the poller only supplies rows
and publishes the result.

## Delivery

- Poller: reuse `probeF402BetTicker` with the existing F402 session/replay transport; no cookies in
  argv or logs.
- WS: `POST /api/v1/live-bets` with bearer, channel `f402-bet-ticker`.
- R2: `R2S3Client.fromEnvOrSecrets()` + `writeWithMetadata("f402-bet-ticker/latest.json", ..., {
metadata: { pii: "none", ... } })`; verify with `stat` and presigned GET.
- Failure semantics: a failed poll/drain never replaces the last good R2 snapshot; WS publish failure
  is reported but does not discard the poll result.
- Tests: pure delta projection (new/gone/changed, ALERT zero-volume, dedupe once, no PII, no raw
  rows), watermark/drain behavior, gateway publish contract, R2 write with metadata, and a live smoke
  that deletes its test object.

## Remaining open decisions

- Poll cadence and the corresponding R2 freshness budget (watermark handles same-page duplicates).
- Whether `alertTwinCount` should also expose a per-channel breakdown; the money rule is already
  locked to zero.
