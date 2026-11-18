# Decision: is the live XML feed's `@line` a decimal line or an American price?

Status: **open wire-unit question; tri-state fail-closed behavior implemented** (2026-11-18). The
live feed has not been observed, so an `@line` whose unit cannot be deduced is carried explicitly as
UNKNOWN instead of being guessed, zeroed or scaled. A captured feed response settles this page.

## What is already true

- [`src/lib/xml_feed_spine_hydrator.ts`](../../src/lib/xml_feed_spine_hydrator.ts) classifies
  `@line` tri-state: a KNOWN decimal line is scaled by 100 (`-3.5` → `-350`); every UNKNOWN row
  keeps the legacy `0` line sentinel and is flagged. The decimal unit is an assumption that arrived
  with the first XML-ingest commit; no capture backs it.
- The canonical R2 snapshot (`sportsdeskXmlFeed`, served by `GET /api/xml-odds/soa`) carries
  `@lineHundredths` for known rows and `lineUnknown="1"` (no `lineHundredths`) for unknown rows,
  with a root `lineUnknownCount`; the dashboard formats the decimal hundredths
  ([`packages/nsh-desk/xml_odds_view.ts`](../../packages/nsh-desk/xml_odds_view.ts)
  `formatLineHundredths`).
- The original single-assumption code path multiplied a moneyline price: `@line="-110"` became
  `-11000`, which the table rendered as `-110.00`.

## Evidence found (2026-11-18, repo search; no live capture)

- **The desk's line unit is decimal hundredths.**
  - [`docs/OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md`](../OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md)
    §4: `LineHundredths = Math.round(effectiveLine * 100)`, e.g. `-7.5 -> -750`.
  - [`docs/cross-market-parlay-matching.md`](../cross-market-parlay-matching.md) §1: "All spreads
    and totals represented strictly as integer hundredths (`-3.25` → `-325`, `48.0` → `4800`)".
- **A price is not a line, and the two differ by shape.**
  - [`lib/watchlist_signal_engine.ts`](../../lib/watchlist_signal_engine.ts): "American odds are the
    trailing signed 3-5 digit token; a price is never a line", and "A spread line carries a decimal
    (`-1.5`); a moneyline price is a whole number (`-110`)".
  - [`lib/desk-parser.ts`](../../lib/desk-parser.ts) bounds American odds outside `[-99, +99]`;
    [`lib/f402_report_player_analysis.ts`](../../lib/f402_report_player_analysis.ts) records
    American odds as decimal-form `JUICE` (`"-110.0"`).
- **In-repo XML fixtures carry decimal `@line` for the KNOWN cases** (`-2.5`, `-3.5`, `3.5`,
  `-1.10`): [`tests/xml_feed_spine_hydrator.test.ts`](../../tests/xml_feed_spine_hydrator.test.ts),
  [`tests/xml_parse_sportsdesk_ops_cli.test.ts`](../../tests/xml_parse_sportsdesk_ops_cli.test.ts),
  [`tests/xml_odds_view.test.ts`](../../tests/xml_odds_view.test.ts),
  [`tests/bun_aspects_contract.test.ts`](../../tests/bun_aspects_contract.test.ts). The
  CLI/hydrator fixtures now carry `-110` deliberately, as the UNKNOWN case.
- **No captured feed exists.** `docs/evidence/captures/` holds Manager JSON/HAR captures only;
  [`docs/evidence/ledger.json`](../evidence/ledger.json) carries the `GET /api/xml-odds/soa` producer
  surface but no feed payload; the only live-feed reference is the `SPORTSDESK_XML_FEED_URL` env var
  in [`packages/sportsdesk-ops/src/bin/xml-parse.ts`](../../packages/sportsdesk-ops/src/bin/xml-parse.ts),
  and no sample URL or response body is committed.

## The constraint

The wire schema cannot be decided from the code that assumes it. Adding an `@lineKind` discriminator
would change a wire contract nobody has observed, so the schema stays unchanged and the ingest fails
closed on the values that cannot be a decimal line.

## Chosen behavior (implemented, provisional)

- `@line` is classified tri-state, with no guessed unit (`XML_FEED_LINE_UNIT = "decimal"` names the
  unit assumed only for a KNOWN line):
  - **KNOWN**: a decimal literal that is non-integer (fractional), or whose |value| < 20 — e.g.
    `3.5`, `-3.25`, `48.5`, `0`, `0.0`, `19`, `-3`. Stored as `Math.round(value * 100)`.
  - **UNKNOWN**: blank/absent `@line`; non-decimal text; non-finite; not representable as int32
    hundredths; or integer-valued with |value| >= 20 — e.g. `48`, `220`, `20.0`, `-20`, `-110`,
    `-110.0`, `+145`, `+145.0`, `N/A`. The line column keeps the legacy `0` sentinel, the row is
    marked in the dense `lineUnknownFlags` bitset, and the row is counted in
    `XmlOddsFeedColumnStore.malformedLineCount` (field name kept; it is the line-unknown count).
- The canonical snapshot carries the state explicitly: a KNOWN row publishes
  `lineHundredths="N"`; an UNKNOWN row omits `lineHundredths` and publishes `lineUnknown="1"`; the
  root publishes `lineUnknownCount="N"`.
- The publisher manifest records `line_unknown_count` and the CLI `--json` summary reports
  `line_unknown_count`; `--help` documents the snapshot line states.
- Nothing is silently reinterpreted: whole-number totals (`48`) and decimal-form prices (`-110.0`)
  are UNKNOWN, not zeroed and not scaled.
- The route (`GET /api/xml-odds/soa`), desk model, panel and table consume the flag end to end:
  unknown rows render `—` and `Line unavailable (unit unconfirmed)`, the table header reports
  `M lines unit-unconfirmed`, and the route cross-checks the root and manifest counts (a mismatch is
  HTTP 502). The route also caps the manifest/chunk bodies at 1 MiB / 32 MiB before parsing.
- The legacy `hydrateCompactXmlDocIntoArena` path was aligned to the same tri-state; no path scales a
  price-shaped `@line` to `-11000`.

## Residual exposure (open)

- The wire unit is still unverified. Any new consumer must treat `lineUnknown="1"` as "no line",
  never as `0.00`.
- An explicit `@lineKind="decimal"|"american"` discriminator remains the only way to store and
  render a price-shaped line as a value. Changing the wire schema still requires evidence.

## Acceptance criteria for closing

- A captured `feed` response stored under `docs/evidence/captures/` shows the `@line` values and
  their market context. Then either:
  - (a) confirm decimal-only, keep the tri-state guard, and remove this page's open question; or
  - (b) add an explicit `@lineKind="decimal"|"american"` discriminator, store and render the two
    separately, and drop the ambiguity heuristic.
- Until then the tests pin the tri-state: KNOWN decimals are stored; every UNKNOWN shape is marked
  (`lineUnknown="1"`, root/manifest/summary counts), keeps line `0`, and is never published as a
  scaled `-11000` or a fabricated `0.00` line.
