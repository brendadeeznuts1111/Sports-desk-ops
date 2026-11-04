---
name: polymarket-profile
description: >-
  Profile a Polymarket address with the repo's Bun CLI (`dx profile`): PnL, win rate, open
  positions, category mix, activity summary and strategy pattern from public APIs, no key.
---

# Polymarket address profile (SportsDesk adaptation)

Adapted from the public `runesleo/polymarket-toolkit` skill. The upstream skill used `curl`/`node`
and `lb-api`, which is now retired; this version uses the repo's Bun CLI and the v2 APIs.

## Trigger

A user gives a 0x address, a Polymarket profile URL, or a username and wants trading analysis.

## Command

```bash
./bin/dx profile 0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612
./bin/dx profile <username>            # resolved via v2 leaderboard cursor
./bin/dx profile 0x… --json            # full structured profile
./bin/dx profile 0x… --max-activity-pages 40 --timeout-ms 15000
```

Implementation: `lib/polymarket_profile.ts` + `scripts/polymarket_profile_cli.ts`.
Do not shell out to curl; do not add npm packages.

## APIs (public, no auth)

| Endpoint                                                                        | Purpose                                               |
| :------------------------------------------------------------------------------ | :---------------------------------------------------- |
| `data-api.polymarket.com/v2/positions?user=<0x>&limit=500&cursor=`              | current positions (v1 `/positions` retired: HTTP 410) |
| `data-api.polymarket.com/activity?user=<0x>&limit=500&end=<last timestamp>`     | activity, cursor by timestamp                         |
| `data-api.polymarket.com/v2/leaderboard?user=<0x>&time_period=all\|month\|week` | PnL snapshot (single user; not `day`)                 |
| `data-api.polymarket.com/v2/leaderboard?limit=500&cursor=`                      | username → wallet (lb-api is retired)                 |
| `gamma-api.polymarket.com/events?slug=<eventSlug>`                              | category/tags                                         |

## Rules that matter

1. **Username resolution** uses v2 leaderboard cursor pagination (`pagination.next_cursor`), max 3
   pages. If not found, ask for the 0x address; the account is likely unranked.
2. **Activity pagination uses `end=<last timestamp>`**, not offsets. Do not dedupe: repeated
   `transactionHash` rows can be separate fills.
3. **Activity `slug` is empty in v2.** Use `slug || eventSlug || conditionId` as the market key.
4. **Win rate** = won / (won + lost), where `redeemable == true` and `currentValue > 0` means won;
   `redeemable == true` and `currentValue == 0` means lost. Never use `cashPnl > 0` as the win test.
   If won+lost < 3, estimate from REDEEM vs TRADE activity and label it.
5. **PnL**: `lb-api` is retired (HTTP 410). Use
   `data-api/v2/leaderboard?user=<0x>&time_period=all|month|week` (omit `time_period` and it
   behaves like `day`). The number is **pre-fee**; `pnlAudit` replays activity for a fee-aware
   cashflow PnL and withholds it when pagination truncates. Unranked wallets return `data: null` —
   report "no PnL figure", never zero.
6. **Categories**: Gamma `category` first, then tag labels, then title keywords. Old markets may
   return `[]`; fall back to title inference.
7. **Pattern classification** (SPLIT arbitrage, market maker, whale/concentrated, diversified,
   small trader, mixed) is internal; explain the result with the trader's numbers, not thresholds.
8. Rate limits are undocumented: keep concurrency ≤ 4 and sleep 500 ms between activity pages.

## Output

Text summary by default (PnL, win rate, open positions, category mix, activity, top wins/losses) or
`--json` for the full `AddressProfile`. All money is USD; addresses are lowercased.

## Evidence limits

- `cashPnl` is approximate for partially sold positions.
- Win rate from positions can be skewed for accounts whose settled positions were cleaned up; the
  activity fallback is labelled.
- Gamma may omit categories for settled markets; keyword inference is a heuristic.
