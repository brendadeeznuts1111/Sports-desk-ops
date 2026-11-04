# Manager Tools UI observations — 2026-11-03

Operator-supplied screenshots of the GS Manager Tools console, captured 2026-11-03 between
12:50:40 and 12:52:20 America/Chicago. **UI observation only.** No request, transport, headers,
auth mechanism or response body was captured, so this does not satisfy the GS wire-contract gap:
`POST /manager-tools/ajax.php` remains `blocked_contract` (see [../EVIDENCE.md](../EVIDENCE.md)
"GS live acquisition is blocked" and [capture-requests.md](./capture-requests.md) §P4).

Machine-readable record: [manager-ui-observations-2026-11-03.json](./manager-ui-observations-2026-11-03.json)
(sha256 and dimensions per image; normalized WebP copies, originals are not in the repo).

## What the images are

| #   | Screen                                     | File                                                                                                                 |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 01  | Manage Players — Agent tab (profile grid)  | [01-manage-players-agent-profiles.webp](./screenshots/manager-ui-2026-11-03/01-manage-players-agent-profiles.webp)   |
| 02  | Manage Players — Player tab (profile grid) | [02-manage-players-player-profiles.webp](./screenshots/manager-ui-2026-11-03/02-manage-players-player-profiles.webp) |
| 03  | Find Player search                         | [03-find-player.webp](./screenshots/manager-ui-2026-11-03/03-find-player.webp)                                       |
| 04  | Events → Last Bets (empty result)          | [04-events-last-bets-empty.webp](./screenshots/manager-ui-2026-11-03/04-events-last-bets-empty.webp)                 |
| 05  | Reports → Summary report (empty)           | [05-reports-summary-empty.webp](./screenshots/manager-ui-2026-11-03/05-reports-summary-empty.webp)                   |
| 06  | Reports → Bettor report (empty)            | [06-reports-bettor-empty.webp](./screenshots/manager-ui-2026-11-03/06-reports-bettor-empty.webp)                     |
| 07  | Reports → Open bet report (empty)          | [07-reports-open-bet-empty.webp](./screenshots/manager-ui-2026-11-03/07-reports-open-bet-empty.webp)                 |
| 08  | Reports → Player report (empty)            | [08-reports-player-empty.webp](./screenshots/manager-ui-2026-11-03/08-reports-player-empty.webp)                     |
| 09  | Reports → Event report (empty)             | [09-reports-event-empty.webp](./screenshots/manager-ui-2026-11-03/09-reports-event-empty.webp)                       |

## What is observed

**Manage Players.** Two profile tabs, `Agent` and `Player`, share one grid: `Name`, `Kind`,
`Delay (sec)`, `Event Limit`, `Min Straight`, `Max Straight`, `Min Odds`, `Max Odds`,
`Max Event Win`, `Min Parlay`, `Max Parlay`, `Max Same Game Parlay`, `Wager Cool-off (sec)`,
`Max Bet Win`, `Max Wager Type Max`, `Supplemental Time Window (sec)`, `Bets`,
`View profile players`. Actions: `Find Profile`, `Add new profile`, `Refresh`,
`Apply settings to multiple profiles`. The agent tab reports **190** total records; the player tab
reports **2,964**. A player-profile search by player id is present.

**Events → Last Bets.** Query form: date range (`11/03/2026`–`11/03/2026`), a **Grade time / Bet time**
date-filter choice, `Player`, `Agent`, `Event Id`, `Bet Id`, `Bet Group Id`, `Group Kind`,
`Group Name`, `Free Bet Id`, `State` = **All**, `Sport` = All sports, `Period`, `Min Wager`,
`Max Time Until Score`, `Market` = All Markets. Toolbar: `Group by`, `Auto-resize columns`,
`Select all`, `Bulk Actions (0)`, `Filters`, `Table settings`. Result: **"No data for current
selection."** Grid headers observed: `Bet Group`, `Id`, `Player`, `Player Id`, `Profile`, `Agent`,
`Ticket`, `If bet`, `Risk`, `To Win`, `Then bet`, `Premium`, `Result`, `Free bet`, `Sport/League`,
`Sport (SportId)`, `League (LeagueId)`, `Event Id`, `Event Details`.

**Reports.** Five pages: Summary, Event, Player, Open bet, Bettor. Each has a date range (summary
`10/23/2026`–`10/30/2026`; the others `10/27/2026`–`11/03/2026`), `Agent`/`Player` filter, `EventId`,
`Bot report`, `Report History`, `Search`, and `To Excel` / `To CSV`. Summary metrics observed:
`Profit`, `Bet`, `Hold %`, `To win`, `Wager Count` (plus `Player Count`, `Event Count`,
`Bettor Count` on their pages). Group grids include `Group`, `Profit`, `Bet`, `Hold %`,
`Wager Count`, `Leg Count`, `To Win`, `Avg Odds`, `Start`, and `Bot?`. All five grids are **empty**
for the selected filters.

**SPA hash routes.** The status bar shows `#/reports/users?t=1793731912416` and a truncated
`#/reports/summ…`. These are client-side routes, not transport URLs.

## What this establishes, and what it does not

Establishes: the console's control vocabulary and column labels (including the `State: All`
selector, which is consistent with `state: ""` meaning All); that both profile grids exist and their
row totals at that moment; that the Last Bets and report grids returned zero rows for those
selections at that time.

Does **not** establish: any HTTP method, URL, body, header, auth scheme or response shape. The
supplied `getBetReport` body uses `dateFilterBy: "logTime"`, which is **not** one of the visible
date-filter choices (`Grade time`, `Bet time`) — this is an open question, not evidence. An empty
grid is zero rows for that selection, not proof that no wagers exist.

## Handling

These screenshots contain customer and agent logins and ids. They are **internal evidence**: do not
stage them into `dist/`, publish them to R2, or transcribe the identifiers into docs. The
`docs:stage` step copies an explicit file list, so these images are not part of the published docs.
