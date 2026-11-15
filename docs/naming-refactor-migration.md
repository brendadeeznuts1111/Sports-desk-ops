# Identifier / naming refactor — migration plan

Derived from raw artifacts, not from a naming table. Every claim below cites the
file it came from. Where an artifact contradicts the proposed grammar, the
contradiction is listed in §3 rather than resolved by assumption.

Executable companions:

| Artifact                           | What it is                                        |
| ---------------------------------- | ------------------------------------------------- |
| `lib/identifier_grammar.ts`        | the casing grammar as validators (contract layer) |
| `scripts/naming_fitness.ts`        | the five guarantees + casing, exit 0/1 (`--json`) |
| `tests/identifier_grammar.test.ts` | contract-layer tests; always green                |

Current gate state: **6/6 guarantees violated** — see §6.

## 1. Artifacts read

| Artifact                                           | What was extracted                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `lib/domain_venue_registry.ts`                     | 5 `VenueId`, 6 `OriginDomainId`, 8 `WriterLaneId`, labels, colours, tokens                               |
| `lib/domain-enums.ts`                              | uint8 wire ids for origin byte 56 and lane byte 57 (append-only)                                         |
| `design/domain-branded-types.ts`                   | `Brand` engine + 16 branded primitives (no venue brand)                                                  |
| `lib/f402_bet_ticker_delta.ts`                     | `F402_BET_TICKER_SENTINEL_CHANNELS = ["ALERT","BLOCKED","NON_SPORTS_DROP"]`                              |
| `lib/bet_flags.ts`                                 | ALERT as a _mirror_ channel; sentinel rows pinned to zero                                                |
| `migrations/001_operators.sql`, `002_sessions.sql` | no venue/origin/lane literals                                                                            |
| `reports/schema.snapshot.json:317`                 | `combo_legs.venue TEXT NOT NULL`, enum text `internal \| polymarket`, index `idx_combo_legs_combo_venue` |
| `dist/openapi.json`                                | `POST /api/v1/live-bets` body `channel`: `^[a-z0-9-]{1,32}$`                                             |
| `data/*.json` corpus                               | writer labels actually in use: `Internet` 166, `ALERT` 68, `GSLIVE` 35, `GSBUILDER` 30, `BLOCKED` 1      |

## 2. Inventory and dependency graph

```
raw writer label  (runtime: Internet, ALERT, GSLIVE, GSBUILDER, BLOCKED)
      │ resolveWriterLaneId()
      ▼
WriterLaneId ──────────────► provenanceLabel ──────► UI / payload label
      │  (8 ids, 1 token each)
      ▼
OriginDomainId (6) ──defaultTokenCode──► token provenance
      │
      ▼
VenueId (5) ──kind/settlement──► risk maths, arb, dashboards
      │
      ├─► combo_legs.venue (SQL TEXT, enum documented as 2 values)
      ├─► MCP writerResolution.venueId / label
      └─► API channel field (openapi, kebab-case pattern)

Row flags / sentinels: ALERT, BLOCKED, NON_SPORTS_DROP  (not lanes, not venues)
```

Text-search impact (upper bounds — see §3-C9 for why grep overstates):

| Identifier   | Hits | Files | Notes                                                  |
| ------------ | ---- | ----- | ------------------------------------------------------ |
| `"internal"` | 24   | 8     | venue id **and** prose                                 |
| `"alert"`    | 13   | 5     | lane id, sentinel, prose                               |
| `"unknown"`  | 116  | 54    | mostly unrelated fallbacks; type-aware search required |
| `"blocked"`  | 40   | 16    | row-flag uses dominate; not renameable wholesale       |
| `"gateway"`  | 5    | 2     | no raw writer label observed                           |

Proposed names **absent from raw artifacts**: `inet_mirror`, `desk`, `lakehouse`,
`unresolved`, and `gateway` (registry-only). Raw identifiers the grammar does
**not** cover: `NON_SPORTS_DROP` (no lane, origin or venue home), `ALERT` and
`BLOCKED` (both a row flag and a lane spelling), and the writer labels
`Internet`/`GSLIVE`/`GSBUILDER` (UPPER/TitleCase, not the lower_snake lane form).

## 3. Contradictions surfaced (not smoothed)

**C1 — `alert` is a sentinel, not a Kalshi lane.** `F402_BET_TICKER_SENTINEL_CHANNELS`
lists `ALERT`, and `bet_flags.ts` calls it a mirror of a real ticket; the ticker
corpus contains 68 `ALERT` rows. `WRITER_LANE_REGISTRY.alert` maps it to
`ORIGIN_EXCHANGE_KALSHI_REGULATED`. Artifact wins: `alert` → **inet_mirror on f402**.

**C2 — `internal` is two venues.** `VENUE_REGISTRY.internal.originDomainIds` has
two entries (R2 lakehouse, desk host). The proposed invariant
`everyVenueHasOneKindAndOneOrigin` cannot hold while that is true. Split into
`desk` and `lakehouse`.

**C3 — `unknown → unresolved` does not fix the sentinel violation.** `unresolved`
is itself a state word, so a lane named `unresolved` still fails
`sentinelsAreNotWritableFeeds`. The lane should be **removed**, and unresolved
observations classified as a row status, not a feed. The proposed rename is
therefore insufficient as stated.

**C4 — the API `channel` field is kebab-case, not camelCase.** `dist/openapi.json`
declares `^[a-z0-9-]{1,32}$` for `POST /api/v1/live-bets`. Either the grammar's
"camelCase channel" rule applies to a different field than this one, or the
grammar is wrong for the only channel field in the published spec.

**C5 — `blocked` is both a lane id and a row flag.** Not covered by the given
rename set; `noLaneIdIsARowFlag` cannot pass while it exists.

**C6 — `inet`'s provenance label is `Internet`** (TitleCase), failing UPPER_SNAKE.

**C7 — the DB enum is narrower than the registry.** `combo_legs.venue` documents
`internal | polymarket`; the registry has five venues. Whichever is authoritative,
one is wrong today.

**C8 — `gateway` has no raw witness.** Registry-only, 5 hits in 2 files, absent
from the writer corpus. Conditional on the operator's answer.

**C9 — grep-based impact overstates.** `"unknown"` appears 116 times across 54
files, almost all of them unrelated fallbacks. Impact sets must be produced by a
type-aware reference search (`tsc --noEmit` + symbol graph), not by text.

## 4. Ordered rename sequence

Each step is independently landable and independently gated.

| #   | Rename                                                 | Depends on          | Gate that flips                                                         |
| --- | ------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------- |
| 0   | none — land contract layer + fitness script            | —                   | gate runs, 6 failures recorded                                          |
| 1   | `alert` → `inet_mirror` (venue `f402`)                 | —                   | `noLaneIdIsARowFlag`, `sentinelsAreNotWritableFeeds`, lineage assertion |
| 2   | `internal` → `desk` + `lakehouse`                      | —                   | `everyVenueHasOneKindAndOneOrigin`, `sentinelsAreNotWritableFeeds`      |
| 3   | `unknown` lane removed; `unresolved` as row status     | —                   | `laneIdMatchesProvenanceLabel`, `sentinelsAreNotWritableFeeds`          |
| 4   | `inet` label `Internet` → `INET`, or lane → `internet` | —                   | `laneIdMatchesProvenanceLabel`, casing                                  |
| 5   | `blocked` lane removed (sentinel only)                 | —                   | `noLaneIdIsARowFlag`                                                    |
| 6   | `gateway` kept or removed                              | **operator answer** | `everyOriginHasTokenMatchedLane` for Kalshi                             |
| 7   | DB enum + openapi channel documented to match          | 1–5                 | downstream compatibility check                                          |

If step 6 is unresolved, `everyOriginHasTokenMatchedLane` **remains failing for
`ORIGIN_EXCHANGE_KALSHI_REGULATED`** (and today also for
`ORIGIN_STORAGE_R2_LAKEHOUSE`). That is a known-failing invariant, not a blocker
for steps 1–5.

## 5. Boundary enforcement

Apply validators at write boundaries, not at call sites:

| Boundary                  | Validator                                                                         | Failure mode                                                   |
| ------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `combo_legs.venue` insert | `assertIdentifier("venue", v, "SEC_COMBO_VENUE_WRITE")` + `assertNotSentinel`     | rejects before the row exists (C7)                             |
| API request `channel`     | the published pattern, parsed at ingress — **not** camelCase until C4 is resolved | 400 with the rule name                                         |
| MCP payload serialization | `assertIdentifier` for venueId/originId/laneId                                    | refuses to emit a non-conforming id                            |
| JSONL ingestion           | `resolveWriterLaneId` → `assertIdentifier("lane", …)`                             | row lands with an unresolved classification, never a fake lane |
| Registry construction     | `assertNotSentinel` in `venueBase()`                                              | module load fails with `SEC_VENUE_ORIGIN_CONSISTENCY`          |

A schema registry manifest generated from `VENUE_REGISTRY` / `ORIGIN_DOMAIN_REGISTRY`
/ `WRITER_LANE_REGISTRY` is diffed in CI against the DB snapshot enum and the
openapi enum, so C7 and C4 become build failures rather than documentation drift.

## 6. Independent verification plan

**6.1 Gates that fail now and pass after**

`bun scripts/naming_fitness.ts` — current output, exit 1:

```
FAIL noLaneIdIsARowFlag            alert, blocked
FAIL everyVenueHasOneKindAndOneOrigin   internal: 2 origins
FAIL laneIdMatchesProvenanceLabel  inet -> "Internet", unknown -> "UNRESOLVED"
FAIL sentinelsAreNotWritableFeeds  venue internal; lanes blocked, unknown
FAIL everyOriginHasTokenMatchedLane ORIGIN_EXCHANGE_KALSHI_REGULATED,
                                   ORIGIN_STORAGE_R2_LAKEHOUSE
FAIL identifiersMatchTheirCasingRule    provenanceLabel "Internet" (lane inet)
```

CI wiring: run as a required step in the release gate (not `bun test`, which must
stay green). Exit 0 is the completion condition of steps 1–5.

**6.2 Lineage assertion for the alert/inet_mirror edge**

```
for every row in data/*.json with TicketWriter == "ALERT":
    resolveVenueIdForWriter("ALERT") must equal "f402"
    and the row's venue must equal the venue of its non-ALERT twin
```

This is the assertion that C1 currently fails: `alert` resolves to `kalshi`.

**6.3 Property counterexamples**

Each gate reports its counterexample set as data (`--json`), so a regression is a
diff of the counterexample set, not a red dot: the empty set is the target.

**6.4 Downstream compatibility**

| Consumer                                            | Check                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `combo_legs.venue` readers (`combo_venue_store.ts`) | after step 2, every stored value is in `VENUE_REGISTRY` and the DB enum description matches                                |
| MCP `writerResolution` payload                      | venueId label/colour unchanged for `f402`, `gslive_partner118`, `polymarket`; `kalshi` keeps its values but loses its lane |
| Dashboards filtered on venue                        | replay one payload per venue and diff labels before/after                                                                  |
| Line desk provenance                                | ALERT rows keep their twin-collapse behaviour (venue f402)                                                                 |

## 7. Open questions

1. **Gateway** — real F402 lane, or a deployment detail that should not be a lane?
2. **Channel casing** — is the openapi `channel` the field the grammar means (C4)?
3. **DB enum authority** — registry or `schema.snapshot.json` (C7)?

## 8. Status after implementation

Steps 1–5 of §4 landed. Measured on the working tree:

```
bun scripts/naming_fitness.ts   ->  all guarantees hold (exit 0)
```

| Decision                                | Result                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 sentinels are not lanes              | lanes are `internet, gslive, gsbuilder, cslevel2, gateway, inet_mirror`; sentinels `alert, blocked, non_sports_drop, unknown`                                  |
| D2 `alert` → `inet_mirror` (venue f402) | `resolveWriterChannel("ALERT") === "inet_mirror"`; `resolveVenueIdForWriter("ALERT") === "f402"`                                                               |
| D3 label vs signal code                 | `WriterLaneEntry.signalChannelCode` added; frame schema keys the wire map off it, so frozen bytes are untouched                                                |
| D4 `inet` → `internet`                  | label `INTERNET`, signal code `Internet` (display unchanged)                                                                                                   |
| D5 `internal` → `desk` + `lakehouse`    | six venues, each with exactly one origin; neither internal venue has a settlement field                                                                        |
| D6 channel casing                       | `channelSlug` kind added with the published kebab pattern; camelCase retained for payload keys                                                                 |
| D7 DB enum from the registry            | `COMBO_LEGS_SCHEMA.venue.description` derives `Object.keys(VENUE_REGISTRY)`; `ComboVenue = VenueId`; writes assert, reads normalize legacy `internal` → `desk` |
| T2 token-match scoping                  | `everyOriginHasTokenMatchedLane` checks only origins with derived writer lanes; Kalshi claims none (trades via its own API)                                    |
| T1 gateway                              | **still conditional**: lane kept with wire byte 6 and no raw witness; removal is a one-commit follow-up                                                        |

Wire ids: lanes keep 1–6, sentinels keep 0/7 and take append-only byte 8 for `non_sports_drop`. Byte 1 aliases lane `inet_mirror` and sentinel `alert`; the decoder prefers the lane and the sentinel is derived from the row label.

Not done, and named here rather than implied:

- `reports/schema.snapshot.json` still contains the stale enum text until the snapshot is regenerated (`bun run schema:gate`); the schema registry now derives the description, so regeneration closes it.
- The production `combo_legs` table needs the attribution audit before any CHECK constraint: rows stored as `internal` cannot be distinguished from `desk` vs `lakehouse` by value alone. Reads currently normalize to `desk` and surface unmapped values as `SEC_COMBO_VENUE_READ`.
- `get_channel_provenance` with a sentinel writer now raises (the tool resolves lanes); the error names `SEC_WRITER_LANE_NOT_A_FEED`. If operators need sentinel lookups there, it should return the sentinel block the way `decode_nsh_frame` does.
