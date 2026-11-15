# GSLive `getBetReport` field contract — observed from the manager client bundle

Status: **observed**, not a vendor schema. The enums below were read from the deployed Manager Tools
client bundle and cross-checked against captured corpus rows. The bundle hash is pinned; bundle
contents drift between deployments, so refresh the citation before trusting a re-extracted value.

## Provenance

- Endpoint: `POST https://plive.sportswidgets.pro/manager-tools/ajax.php`
- Request action: `getBetReport`; response rows at `r.bets[*]`
- Client asset: `https://plive.sportswidgets.pro/manager-tools/assets/index-C5e7IMSe.js`
- Asset sha256: `df91bc6692b5d8c28531dfb6ac48b1c1042bbcb118d25995146ef82150e98a91`
- Fetched: 2026-11-08. Older/newer builds use different asset hashes; an earlier observed bundle
  (`index-Ce7M5e.js`) is no longer served.

This is a _shape_ contract for the fraud pipeline's `getBetReport` variant. It does not cover
other manager report actions that reuse the same field names with different row shapes.

## Enums

Top-level lifecycle `state` (the `BET_STATE_*` constants in the client):

| Value | Meaning             |
| ----- | ------------------- |
| `-1`  | rejected            |
| `0`   | processing          |
| `1`   | pending             |
| `2`   | complete            |
| `3`   | ECO (early cashout) |

Per-leg `isWin`:

| Value | Meaning |
| ----- | ------- |
| `1`   | win     |
| `0`   | lose    |
| `-1`  | push    |
| `-2`  | cancel  |

Half-win and half-lose are **not** encoded in `isWin`; the client derives them from the settlement
amounts (comparing result amount with to-win, or with stake). Any rule that needs half outcomes
must use amounts, not this code.

## Two differently-scoped "state" fields

1. Top-level `state` — the numeric lifecycle above.
2. `supplementalConfirmation` — a JSON string on each row containing the bet-acceptance
   confirmation: `{"state": "ACCEPTED" | "PENDING" | "REJECTED", "windowEndTime": <epoch-ms>}`.
   This is acceptance metadata, not settlement and not lifecycle; a rejected confirmation is a
   cancellation path. Rules must name which "state" they mean.

## Ticket-level fields and currency

`betGroupResult`, `betGroupToWin`, `bet`, `betGroupFinalOdds`, `betGroupPremiumAwarded` and
`exchangeRate` are ticket-level values repeated verbatim on every leg row of a `betGroupId`.
Financial aggregates must dedupe by `betGroupId` first.

The raw values are in settlement currency. The client converts for display by
`exchangeRate / displayExchangeRate` (applied to stake, to-win, result, premium, and the ticket
result). The fraud pipeline reads the raw ticket result (dollars) and converts to integer cents; it
does not apply the display conversion.

`valuesRetrieved` is added by the client normalizer; it is not present on raw wire rows.

## Adjacent services that are not the source

- `assets/vendor/lp-data-service/dist/lib/lp-data-service.iife.js` (sha256
  `63c2bd06f209cfcc7a34e0e471e8d3b1902412e0dd2c151704300d690dcdb862`, fetched 2026-11-08) is a
  real-time event/odds subscription service, not a wager-read client. It subscribes to
  event/league/sport/lineset data and to partner, free-bet and promo-profile entities
  (`featuredBet`, `freeBet`, `userFreeBet`, `groupProfile`, `activeCircle`, `fixedParlay`,
  `partnerPreferences`, …). It does **not** contain `betGroupResult`, `betGroupToWin`,
  `betGroupId`, `supplementalConfirmation`, `windowEndTime`, `isWin` or `getBetReport`.
- Trap: its `groupId` is a promo/group-profile cache key, not the wager `betGroupId`. Wager rows
  and their enums live in the manager application bundle and the `ajax.php` `getBetReport`
  response documented above; the vendor data service must not be cited for wager grouping or
  settlement semantics.

## Enforced at ingest

`schema/wagers_field_contract.json` is the machine-readable form of this note: it cites this
capture set by sha256 and owns only the semantic axes (origin, consumer obligation, lifecycle,
liveness). Wire shape stays owned by the captures — the registry never restates `type`/`nullable`.

`lib/wagers_wire_contract.ts` turns that registry into a runtime check over the raw rows the live
wagers loader reads (before projection). Sentinel-noise rows (`TicketWriter` `ALERT`/`BLOCKED`) are
skipped and counted in `skipped_rows`, so the exclusion is visible rather than silent. The host attaches the result
to the feed:

```sh
curl -s http://127.0.0.1:4023/api/wagers | jq '.wire_contract'
```

A registry must cite exactly one capture for all of its fields; a mixed set is rejected rather than
partially checked (the checker would otherwise silently verify only the first field's capture). Cited
capture paths resolve relative to the registry's grandparent, and the reported `registry` is a
basename or `schema/<file>` — never an absolute host path.

It reports `ok`, `rows` (checked), `skipped_rows`, `fields_checked`, the capture id/sha it resolved, and one violation bucket
per `(field, kind)` where kind is `type` or `nullable`. Enum differences are deliberately **not**
violations: `enum_source` is `observed` (see `scripts/capture/schema.ts:191`), so an unobserved code
is a sample boundary, not a contract break. A missing registry or capture yields `ok: false` with an
`error`, never a silent pass.

## Limits

- No external settlement truth is implied: these are shape semantics, not outcome correctness.
  A same-book settlement ledger is still required to verify settlement.
- The client's display result includes premium adjustment and exchange conversion; do not compare
  a displayed number to the raw field without accounting for both.
- This note covers the `getBetReport` variant only; other manager report actions may share field
  names with different shapes and state vocabularies.
