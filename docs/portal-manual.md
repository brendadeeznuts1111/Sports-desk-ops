# Portal user manual — digested reference

Our own structured digest of the vendor manual, kept in the repo so the surfaces it documents can
be checked against the code. The manual itself is third-party documentation and is **not** copied
here; only short UI labels (`Game Admin`, `Position`, `Vig Setup`) and paraphrased behaviour appear.

| Field           | Value                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Source          | `https://fantasy402.com/doc/FAQ.pdf` (linked from manager.html → F.A.Q. → User Manual)                                                  |
| Version         | 1.0.280                                                                                                                                 |
| Format          | PDF, 226,538 bytes, 6 pages, 13 questions, text layer (no OCR needed)                                                                   |
| SHA-256         | `e6a325bd14d904c5a300e9900ab961059caacc99e1931eb8e6ae9e60410b7aaa`                                                                      |
| First retrieved | 2026-11-01                                                                                                                              |
| Re-verified     | 2026-11-01 — `bun run manual:fetch` returned the same 226,538 bytes and SHA-256, so the digest below still describes the current manual |
| Raw text        | `scratch/portal-manual/manual-<sha8>.txt` — gitignored, regenerate with `bun run manual:fetch`                                          |

If `bun run manual:fetch` reports a different SHA-256, the vendor updated the manual: re-read this
digest against the new text before trusting the "status" column below.

## What the manual does and does not cover

It is an operator FAQ. It documents **workflows and permission gates**, not field dictionaries —
nothing about `Level`, `SeqNumber`, `WagerType` codes or report columns. The wire shapes in this
repo come from captures (`docs/evidence/captures/`), not from the manual.

## Documented behaviour → repo surface

| Q   | Documented behaviour                                                                                                                                                          | Repo surface                                                                                                            | Status                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Deposits: search the account, click the balance, or use the Transactions tab / Cashier for bulk                                                                               | —                                                                                                                       | gap (no cashier tooling)                                                        |
| 2   | Deposit, withdrawal, credit/debit adjustment, promotional credit/debit — the adjustments move the daily figure, promotional ones only the balance                             | —                                                                                                                       | gap                                                                             |
| 3   | Wager deletion lives on the **Pending** report or a player's Wagers section; the control is a column toggle (Settings) and may be limited to **before game time**             | `lib/f402_pending_delete_batch.ts`, `scripts/capture/batch_pending_delete_session.ts`, `preGame` in `lib/game_admin.ts` | tooling exists; not exposed in the UI                                           |
| 4   | **Game Admin** shows exposure per game; a dropdown switches Admin ↔ **Position** (Straight / Parlay / Teaser); clicking a figure lists the wagers; `F` toggles **Full Board** | `lib/game_admin.ts`, `GET /api/game-admin`                                                                              | Position view implemented; Full Board toggle is a gap                           |
| 5   | Moving your own lines happens on Game Admin by clicking the line                                                                                                              | —                                                                                                                       | gap (mutation; production is read-only)                                         |
| 6   | Analysis red flags: a customer taking 1+ points / 10+ cents better than the market, props-only accounts, oddball markets                                                      | —                                                                                                                       | gap (needs the closing line at bet time, which `Report/Pending` does not carry) |
| 7   | IP Tracker: Web Access Log per account and timeframe; a globe reveals approximate location; IPs are not street-accurate                                                       | `lib/bet_ticker_ip_tracker_bridge.ts` (modes `A`/`B`/`C`/`I`)                                                           | partially implemented                                                           |
| 8   | Multi-account detection: IP Tracker → **Account IP Match**, or Web Access Log → Users by IP                                                                                   | `lib/bet_ticker_ip_tracker_bridge.ts` (per-office and cross-office matchers)                                            | partially implemented                                                           |
| 9   | Vig changes: profile → **Vig Setup** per sport/league/period for Spread, Moneyline, Total, Team Total, plus a Vig Discount that combines with the line                        | —                                                                                                                       | gap                                                                             |
| 10  | Max wager per sport: profile → **Max Wager**, Call Center vs Internet; the system uses an "always lowest" rule, so a sport limit cannot exceed the general limit              | —                                                                                                                       | gap                                                                             |
| 11  | Removing a market: profile → **Allow/Deny**, toggles for Parlay, Spread, Moneyline, Total, Team Total                                                                         | —                                                                                                                       | gap                                                                             |
| 12  | Changing a sub-agent password: search the agent, or use Agent Admin and click the password                                                                                    | —                                                                                                                       | deliberate non-goal (this repo never handles portal passwords)                  |
| 13  | Transactions on a sub-agent account work like a player's account                                                                                                              | —                                                                                                                       | gap                                                                             |

## Rules this digest puts into force

1. **No delete control without a pre-game verdict.** `preGame` is computed from `gameDateTime`
   against the request clock, and is a fact about the fixture — not a claim that the operator has
   the portal permission described in Q3.
2. **No "line edge" score.** Q6's threshold needs the market price at bet time. `AdjSpread` /
   `OrigSpread` measure the accepted line against the original line, which is a different quantity.
3. **Position labels come from the wager type**, matching Q4's vocabulary: `S` → Straight,
   `P` → Parlay, `T` → Teaser; unknown codes stay `Other` rather than being guessed.
4. **Profile mutations stay out.** Q5, Q9, Q10, Q11 and Q12 are all writes into the portal. This
   repo is read-only against production unless a task is explicitly a deploy.

## Reproducing

```sh
bun run manual:fetch            # download + extract into scratch/portal-manual/
bun run manual:fetch --raw      # ...and print the text
```

The extractor (`scripts/fetch_user_manual.ts`) handles object streams, Identity-H subset fonts with
`/ToUnicode` CMaps, and simple WinAnsi fonts. A PDF without a text layer (scanned) would extract
nothing; this one is text-native.
