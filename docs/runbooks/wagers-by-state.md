# Wagers by state — operator runbook

Sort GSLive wagers by state, day, event, player, or agent over a date range,
from the retained CSV export or the live Manager Tools API. All column
positions, group dimensions and ordering, output layout, and the live request
shape come from `config/wagers.json` (validated by `lib/wagers_config.ts`
with zod). Change the config, not the code, when the export schema or report
layout changes.

## Commands

```bash
# CSV export (data covers 10/18–10/24/2026; stops at the last export)
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026 --state=cancel
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026 --nlegs=2
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026 --wager-number 1069664168
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026 --group-by=day
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026 --group-by=event --format=csv
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026 --group-by=player --format=json

# Live API (any range incl. 10/25→11/03/2026; needs GSID — production is read-only)
echo 'GSID=...' > .env   # .env is gitignored; never paste tokens into chat or commits
./bin/dx wagers-by-state-live -- --from=10/25/2026 --to=11/03/2026
./bin/dx wagers-by-state-live -- --from=10/25/2026 --to=11/03/2026 --state=cancel --nlegs=2
./bin/dx wagers-by-state-live -- --from=10/25/2026 --to=11/03/2026 --group-by=day
```

Bun swallows `--flag=value` args, so both scripts are always invoked with `--`
after the script path (`bun run … -- --from=…`); `./bin/dx` adds it for you.

## Filters and formats

| Flag               | Meaning                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--state=X`        | One state: `pending win lose push cashout "half win" "half lose" cancel "cancel after confirmation"`                                                                                   |
| `--nlegs=N`        | Only wagers in N-leg parlay groups (legs = rows sharing a Bet Group)                                                                                                                   |
| `--wager-number N` | One Ticket/wager number                                                                                                                                                                |
| `--format=F`       | `table` (default), `json`, `csv`, `summary` (one-line `GroupSummary` per group), `inspect` (full pretty-printed objects), `columns` (typed-array series), or `grid` (native box table) |
| `--out=PATH`       | Also write the stdout document to PATH                                                                                                                                                 |
| `--csv=PATH`       | CSV source override (CSV script only)                                                                                                                                                  |
| `--group-by=G`     | Dimension: `state` (default), `day`, `event`, `player`, `agent`                                                                                                                        |
| `--top=N`          | Show only the first N groups (after sorting)                                                                                                                                           |

`--format=json|csv` prints a pure machine-readable document on stdout;
titles, warnings, and provenance go to stderr, so
`./bin/dx wagers-by-state -- … --format=json 2>/dev/null | jq .total` works.
`--out=PATH` writes the same stdout document to a file. Every run reports
`Computed in …ms` (measured with `Bun.nanoseconds`) alongside provenance.

## Groups and money columns

`Count` = rows in that group. `Legs` = parlay legs (rows sharing a Bet
Group, counted over the full window before filters). `Risk` / `To Win` /
`Result` come straight from the export. `pending` always shows `$0.00`
result — ungraded, not zero. Day labels are local calendar days (matching
the window filter and the export's Bet Time columns, not UTC). Event groups
sort by risk desc, days ascending, states in config order, unknown last.

## Config contract (`config/wagers.json`, version 6)

- `columns` — CSV column indices (Ticket, Bet Group, State, Risk, To Win, Result, Bet Time, Player, Agent, Event)
- `states` — name → `{ label, sortOrder }`; unknown states sort last
- `groups` — dimension → `{ label, field, sort }` (`config-order`, `risk-desc`, `count-desc`, `key-asc`)
- `output.columns` — table/CSV column keys, labels, alignment, minimum widths
- `output.formats` / `default.format` / `default.groupBy` — allowed and default `--format` / `--group-by`
- `filters` — CLI flag, value type, and target field per filter
- `live` — `getBetReport` URL, action, `dateFilterBy`, day-boundary times, `retry` (`attempts`, `baseMs`)
- `dateFormats.betTime` — Bet Time regex; `default.days` / `default.csvPath`

Shared pipeline in `lib/wagers_report.ts`
(parse → group sizes → filters → group buckets → config-strategy sort → render:
hand-rolled `table`, `Bun.inspect.table` `grid` (colors gated by
`Bun.enableANSIColors`), `json`/`csv`/`columns` documents,
or `GroupSummary` `summary`/`inspect` views);
shared network guard in `lib/manager_fetch.ts`
(GSID cookie, `redirect: "manual"`, HTML-login trap, `Bun.sleep` exponential
backoff on 429/5xx only — auth failures never retry, atomic write,
`Bun.hash` change detection for stable mtimes, `Bun.semver` floor gate).
Column widths use `Bun.stringWidth`, so ANSI colors and wide emoji align.
`GroupSummary` customizes printing via `[Bun.inspect.custom](depth, options)` —
the same symbol as Node's `util.inspect.custom`, so `console.log`,
`Bun.inspect`, and `util.inspect` all print the one-line form (bold when
`options.colors` is true); `toJSON` keeps machine output clean.

## Verify

```bash
bun test tests/wagers_report.test.ts tests/manager_fetch.test.ts tests/fetch_config.test.ts
bun --check lib/wagers_report.ts lib/wagers_config.ts lib/manager_fetch.ts scripts/wagers_by_state_last14.ts scripts/wagers_by_state_live.ts
./bin/dx wagers-by-state -- --from=10/18/2026 --to=10/24/2026 --state=cancel
```
