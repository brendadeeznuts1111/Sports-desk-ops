# GS Manager CLI — contract status (blocked, capture required)

> **Status: `blocked_contract`.** There is **no verified GS HTTP contract** in this release — no
> verified endpoint URL, method, content type, authentication scheme, pagination rule or response
> schema for any of the six report kinds. Candidate URLs have since been observed in a browser
> network log (§2.2), but a URL is not a contract. Nothing in this document is an HTTP endpoint.
> Do not build a live adapter from it; build the capture first.

The GS Buckeye 2 / Partner 118 deliverable is a **job-orchestration CLI**, not an API client. Its
own documentation states the rule plainly:

> "Live acquisition is intentionally blocked: no GS endpoint/authentication/response contract is
> verified. Mock results are explicitly synthetic and contain no customer data."
> — `zip:README.md:3`

> "UI routes are not HTTP endpoints. No endpoint URL, method, auth scheme, Summary action,
> pagination, or upstream response schema is fabricated here." — `zip:contracts/contract-map.md:14`

Surface id: **`surface.gs-manager-cli`** (`docs/evidence/ledger.json`, tier D). Evidence package:
`scratch/docs-audit/gs-manager-cli/` (extracted from `gs-manager-cli.zip`). This file replaces the
earlier fabricated "GS steam ingestion" path that appeared in the pre-release spec; that path is
contradicted by the extract and has been removed rather than rewritten.

## 1. Six report kinds — all `blocked_contract`

The CLI exposes six report kinds. They are **report IDs in a local CLI**, and the browser routes are
SPA navigation locations. The `upstream` block for every kind is `status: blocked_contract` with
`url: null`, `method: null`, `contentType: null`, `responseSchema: null`, `authentication: null`.

| Report kind (CLI) | UI route (not an endpoint)            | Request evidence                             | Contract status                                                      |
| ----------------- | ------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `summary`         | `/manager-tools/#/reports/summary`    | SPA query parameters + visible controls only | `blocked_contract` — transport unknown                               |
| `event`           | `/manager-tools/#/reports/events`     | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `player`          | `/manager-tools/#/reports/users`      | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `open-bet`        | `/manager-tools/#/reports/open-bets`  | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `bettor`          | `/manager-tools/#/reports/bettor`     | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `last-bets`       | `/manager-tools/#/events/bet-history` | User-supplied `getBetReport` body            | `blocked_contract` — action observed; transport and response unknown |

Citations for the table: `zip:contracts/report-surfaces.md:9-16`; the `blocked_contract` upstream
blocks are at `zip:templates/endpoint-registry.json:17-24` (summary), `:73-80` (event), `:129-136`
(player), `:188-195` (open-bet), `:250-257` (bettor), `:281-292` (last-bets). `last-bets` is the only
kind with an observed `action` (`getBetReport`, `:285`); its `url`, `method`, `contentType`,
`responseSchema` and `authentication` are still `null` (`:282-291`).

> "Only Last Bets has an observed action (`getBetReport`); no transport URL, method, response shape,
> or auth mechanism has been established for any report."
> — `zip:templates/contract-verification.md:3`

One qualification, added 2026-11-02: the public client bundle (§2.8) shows the console building a
`GET /manager-tools/reports/?kind=…` request for every kind, with `kind` set to the report id. That is
**source observation of the client**, not a captured exchange, so it does not lift any row out of
`blocked_contract` — but it does name the endpoint a capture should target.

## 2. The only observed artifact: one `getBetReport` request payload

This is a **user-supplied request body**, not a capture. It establishes the field names and observed
scalar types of one Last Bets request. It establishes **no transport** — no URL, no method, no
content type, no auth, no response (`zip:templates/endpoint-registry.json:281-292`).

Source: `zip:contracts/get-bet-report.observed.json:1-22`; typed reading in
`zip:contracts/gs-manager.ts:5-27`.

| #   | Field               | Observed JSON type | Observed value   | Notes                                                            |
| --- | ------------------- | ------------------ | ---------------- | ---------------------------------------------------------------- |
| 1   | `action`            | string             | `"getBetReport"` | Only constant; the spec key is `action`, not `operation`         |
| 2   | `partnerUserId`     | string             | `""`             | Empty; hash URL passes raw login (`AF12`) — see §2.1             |
| 3   | `agent`             | string             | `""`             | Empty; scope semantics unknown                                   |
| 4   | `eventId`           | string             | `""`             | Empty                                                            |
| 5   | `freeBetId`         | string             | `""`             | Empty                                                            |
| 6   | `state`             | string             | `""`             | Opaque; only empty observed                                      |
| 7   | `sId`               | string             | `"2"`            | Opaque; string, not a number                                     |
| 8   | `minVolume`         | string             | `"0"`            | String, not a number                                             |
| 9   | `maxTimeUntilScore` | string             | `"0"`            | String, not a number                                             |
| 10  | `mId`               | string             | `""`             | Empty                                                            |
| 11  | `from`              | number             | `1793250000`     | Integer — **epoch seconds**; source timezone/inclusivity unknown |
| 12  | `fromTime`          | number             | `0`              | Integer; interaction with `from` unknown                         |
| 13  | `to`                | number             | `1793422799`     | Integer epoch seconds                                            |
| 14  | `toTime`            | number             | `86399`          | Integer; boundary precision unknown                              |
| 15  | `betId`             | string             | `""`             | Empty                                                            |
| 16  | `betGroupId`        | string             | `""`             | Empty — the earlier fabricated example used `908412`             |
| 17  | `group`             | null               | `null`           | Only `null` observed; do not broaden without evidence            |
| 18  | `dateFilterBy`      | string             | `"calcTime"`     | Opaque code; hash URL also shows `betTime` (§2.1)                |
| 19  | `partnerIds`        | string             | `""`             | Empty; **does not prove tenant 118**                             |
| 20  | `period`            | string             | `"s3"`           | Opaque source code                                               |

Unknown semantics that must be resolved by capture (`zip:contracts/contract-map.md:24`): `sId="2"`,
`period="s3"`, state codes, `calcTime` meaning, blank filters, zero-string filters, omitted vs `null`
`group`, `fromTime`/`toTime` interaction, source inclusivity/precision, row identity/grain, and
partner scope. Do not insert partner `118` into `partnerIds` without capture evidence; do not treat
UI route parameters (`bot`, `partnerId`, `searchBy`, ISO date strings) as the API query encoding
(`zip:contracts/report-surfaces.md:39`).

### 2.1 Observed hash URLs — browser route state, not the request body

Two live Manager URLs have been observed for Partner 118. Both are **SPA hash state**: they do not
change the `blocked_contract` status of §1, and they are not the encoding of the `getBetReport` body
in the table above. Evidence is separated per surface below.

**`#/reports/users` — account report (7 parameters).** Observed hash URL shape:

```text
https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=<ISO>&partnerId=118&searchBy=player&text=player_AF12&to=<ISO>
```

- `bot=true` — the SPA defaults the Bot switch off, which hides bot/syndicate accounts.
- `from` / `to` — explicit ISO-8601 UTC desk-day bounds (`00:00:00`–`23:59:59` in
  `America/Chicago`), not epoch seconds.
- `text=player_<LOGIN>` — the `player_` prefix belongs to **this** filter only.
- Evidence level: **hash URL observed**; the server-side effect of each parameter is **unverified**.

**`#/events/bet-history` — live sidecar.** Observed hash URL shape:

```text
https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=<epoch s>&to=<epoch s>&toTime=86399&dateFilterBy=calcTime&t=<epoch ms>&partnerUserId=AF12
```

- `dateFilterBy` — observed as `calcTime` (settling/populating) and `betTime` (placement). Whether
  other values are accepted is unverified.
- `partnerUserId` — the **raw login** (`AF12`), _not_ `player_AF12`. This does not imply the wire body
  carries the login: the captured body leaves the field empty (§2, row 2).
- `from` / `to` — epoch **seconds**; `toTime` is an offset within the desk day, so it is `86399` on a
  normal day and `89999` / `82799` on US DST transition days (derive it, never hardcode it).
- `t` — epoch-millisecond cache-buster that must be fresh on every open.
- Evidence level: **hash URL observed**; per-parameter server-side filtering is **unverified**; the
  request that populates the grid was **not captured**, so transport (URL, method, content type,
  auth) remains **blocked / unverified**.

Restating the caveat above: hash URL parameters are **not** the API query encoding
(`zip:contracts/report-surfaces.md:39`). Nothing in this section establishes an endpoint, a method,
a content type, an auth scheme or a response shape.

## 2.2 Observed transport surface (browser network log, 2026-11-02)

A second evidence level now exists: an operator's browser network log names the URLs the console
calls. **URLs only** — no methods, request bodies, headers, cookies or responses were captured, and
none are reproduced here.

| URL observed                                          | Appears to be                                       | Contract status                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/manager-tools/ajax.php` (4 calls)                   | Report/data transport                               | `blocked_contract` — action, method, auth, body, response all unknown                                                                                                                                                   |
| `/manager-tools/usersList/?t=<ms>`                    | Player/user list (JSON)                             | `blocked_contract`; unauthenticated `GET` → **401** (`text/html`, `no-store`) — see §2.7                                                                                                                                |
| `/api/v3/manager-tools/signin/`                       | Session sign-in / bootstrap                         | **observed 2026-11-05**: `POST {"username","password"}` → **403** + "Username or password are incorrect" for rejected credentials; `POST {"checkSession":true}` → `ganchrowSessionId` when a session exists — see §2.10 |
| `/api/v3/manager-tools/login/`                        | Legacy credential login                             | **observed 2026-11-05**: `POST {"username","password"}` → **403** for rejected credentials and only a pre-auth `GSID` cookie; the SPA uses `signin/` — see §2.10                                                        |
| `/api/v3/manager-tools/common/`                       | Session bootstrap                                   | **observed**: unauthenticated `GET` → `200` `{"FLAVOR":"live","partner":118}` — see §2.5                                                                                                                                |
| `/manager-tools/partnerConfig/`                       | Partner configuration                               | `blocked_contract`; responds **401** to an unauthenticated GET (verified 2026-11-02); one response body observed — see §2.3                                                                                             |
| `/manager-tools/groups/`                              | Group/agent hierarchy (the SPA preloads it as JSON) | `blocked_contract`; 401 unauthenticated GET; client builds `GET {group, withSle:true}` — §2.8                                                                                                                           |
| `/manager-tools/translations/v2/getI18nResources/...` | UI strings                                          | public, no report data                                                                                                                                                                                                  |
| `/manager-tools/assets/components/*/*.html`           | UI component templates (ag-Grid/React fragments)    | public static assets; no data contract                                                                                                                                                                                  |
| `/betLobbyV2/logic/`                                  | Bet lobby action dispatcher (`POST` + `{"a": …}`)   | **observed**: unauthenticated `POST {"a":"sportPeriods"}` → `200` JSON catalog — see §2.4                                                                                                                               |
| `/live/data?...`                                      | Sports/league/country catalog                       | **observed**: unauthenticated `GET` → `200` JSON, 80/29,938/383 entries — see §2.6; not a manager report surface                                                                                                        |

What this changes: the earlier statement that **no** URL had ever been observed is now too strong,
so it is corrected at the top of this document. What it does **not** change: `ajax.php` remains
`blocked_contract`. A URL is not a contract — without a method, a request body, an auth scheme and a
response schema, an adapter built on this table would be guessing, which is the failure this
document exists to prevent. Note in particular that the console is **React with ag-Grid**, so the
`assets/components/*.html` templates are UI markup with control labels only; they carry no column
keys, response shape or transport detail.

Still required, per §4: one redacted request **and** response per report kind, plus the auth/CSRF
behaviour described without credential values.

### Operator UI observations (2026-11-03)

A nine-image operator screenshot set adds UI-level observations, not contract evidence: Manage
Players has `Agent` and `Player` profile grids (190 and 2,964 records at that moment); Last Bets
exposes `State: All` and a **Grade time / Bet time** date-filter choice, with the grids `Bet Group`,
`Id`, `Player`, `Player Id`, `Profile`, `Agent`, `Ticket`, `If bet`, `Risk`, `To Win`, `Then bet`,
`Premium`, `Result`, `Free bet`, `Sport/League`, `Sport (SportId)`, `League (LeagueId)`, `Event Id`,
`Event Details`; the five Reports pages show `Leg Count`, `Wager Count`, `Avg Odds`, `To Excel` and
`To CSV`. All Last Bets and report grids returned "No data for current selection" for those
selections at 12:50–12:52 local, which is zero rows for that selection, not an absence of wagers.
The set carries no method, request body, header, auth or response, so it does **not** satisfy §4 and
does not move `ajax.php` off `blocked_contract`. Record and image hashes:
[evidence/manager-ui-observations-2026-11-03.md](./evidence/manager-ui-observations-2026-11-03.md).
One open question it raises: the supplied `getBetReport` body uses `dateFilterBy: "logTime"`, which
is not one of the visible date-filter choices (`Grade time`, `Bet time`).

### What the public i18n bundle shows

The console's public translation bundle
(`/manager-tools/translations/v2/getI18nResources/index.php?lng=en&ns=translation&appId=2`, fetched
2026-11-02) is UI text, but it constrains the _shape_ of a future adapter. It contains:

- report controls and columns: `Player`, `Player Name`, `Bet`, `To Win`, `Win`, `Loss`, `Pending`,
  `Graded total`, `Pending total`, `Wager Count`, `Hold`, `Vigorish`, `Ratio`, `Line`, `Side`,
  `Price`, `Event`, `League`, `Period`, `Market`, `Sports`, `Legs`, `Parlay`, `Teaser`,
  `Bet time`, `End time`, `Grade time`;
- generation states: `Generating report. Please wait...`, `Report has been generated successfully.`,
  `Report History`, `Error fetching report data.`, `Report generation failed.`;
- exports: `To CSV`, `To Excel`, `You can select the columns you want to download`;
- a scoping flag: `Reports Are by Risk` (`reportsAreByRisk`).

That reads as **asynchronous report generation plus a file export**, not a JSON grid endpoint, and it
suggests `ajax.php` may be the generation/download call rather than a rows API. It is a hypothesis,
not a contract, and it changes the eventual capture target: a generated CSV/XLS (with its request)
is more useful than a screenshot of the grid.

The column vocabulary is encoded in `lib/gslive_report_columns.ts` (labels → canonical keys, unknown
headers surfaced rather than guessed) so a future CSV export can be mapped positionally. The mapper
is display-label only; it asserts nothing about transport.

### 2.3 Partner-config response (operator-supplied, 2026-11-02)

One response body from an authenticated `GET /manager-tools/partnerConfig/` was supplied by an
operator on 2026-11-02. The request was **not stored**: no capture file, no cookies, no request
headers. It is recorded here only because it is small, carries no customer data, and names the
tenant. Unauthenticated `GET` returns **401**.

```json
[{ "id": "118", "name": "Buckeye 2", "allow": "1" }]
```

| Field   | Observed JSON type | Observed value | Notes                                                                     |
| ------- | ------------------ | -------------- | ------------------------------------------------------------------------- |
| `id`    | string             | `"118"`        | Same value the hash URLs carry as `partnerId`; string, not a number       |
| `name`  | string             | `"Buckeye 2"`  | Human label — not a wire identifier for any report call                   |
| `allow` | string             | `"1"`          | Flag semantics unverified; `"0"`, `false` and absence were never observed |

What this establishes: the path answers with a JSON **array** of partner records and Partner 118's
label. What it does **not**: the record set for any other session (one row is not "always one row"),
auth/CSRF behaviour, pagination, or whether `allow` gates the report surfaces in §1. A partner list is
not a report transport, so §1 stays `blocked_contract` unchanged.

### 2.4 `/betLobbyV2/logic/` — action dispatcher, captured 2026-11-02

The §2.2 row that called this a static asset was wrong: it is a `POST` action dispatcher. Captured
unauthenticated on 2026-11-02, so the response is reproducible without a session:

```http
POST https://plive.sportswidgets.pro/betLobbyV2/logic/
content-type: text/plain;charset=UTF-8

{"a":"sportPeriods"}
```

`200`, JSON body served as `content-type: text/html; charset=UTF-8` (the header lies — parse the body,
not the header). Top-level keys: `periods` (102 entries), `abbreviations` (10), `periodNames` (40).

| Object          | Shape                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `periods[<id>]` | `{ m, h1, h2, ht, s1…s10, L_h<n>?, L_s<n>? }` — `m` is the period class (`Game`, `Match`, `Tournament`, `Race`, `Prop`, …; 12 values observed), `h1`/`h2`/`ht` the half headers, `s*` the segment labels, `L_*` label overrides on either family |
| `periodNames`   | `<id> → name` (`Inning`, `Quarter`, `Half`, `Round`, `Set`, `Map`, `Period`, …)                                                                                                                                                                  |
| `abbreviations` | `name → short form` (`Quarter → Qtr`, `Inning → Inn`, `Extra Innings → Extra`)                                                                                                                                                                   |

Gotchas for any consumer:

- ids are **numeric strings, non-contiguous** (`1`–`11`, `13`, `16`, `27`, `33`, …). Never iterate a range.
- `s1…s10` are not uniform: 17 of 102 periods carry `L_` label overrides, on segments (`L_s5`,
  `L_s10`, `L_s1`) **and** on a header (`L_h1`) — the override family is not segment-only. Period `2`
  repeats `"Overtime"` across `s5`–`s10` with `L_s5: "Regulation Time"`, so the last non-empty segment
  is not reliably the period's terminal state.
- the console sends an `x-gs-session` header on this call, but it is **not required** for
  `sportPeriods` — the same body returned `200` with the header removed. Auth posture is per-action;
  do not assume the other `a` values are also open.

What this changes: the desk's period vocabulary is now captured rather than inferred, which constrains
any future report filter using period ids. What it does **not** change: this is GS console navigation
data, distinct from the Fantasy402 catalog (`surface.fantasy402-sport-catalog`), and it carries no
report rows, no customer data and no manager transport — §1 stays `blocked_contract`.

### 2.5 `/api/v3/manager-tools/common/` — session bootstrap (captured 2026-11-02)

`GET` with no cookies returns `200` and a two-key JSON object. This resolves the previously
unattributed `{"FLAVOR":"live","partner":118}`: it is this endpoint's **response**, not a request body.

```json
{ "FLAVOR": "live", "partner": 118 }
```

| Field     | Observed JSON type | Observed value | Notes                                                                                                          |
| --------- | ------------------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `FLAVOR`  | string             | `"live"`       | Uppercase config key; only `live` observed — a `mock`/`demo` value is inferred, not verified                   |
| `partner` | number             | `118`          | **number** here but `partnerConfig.id` is the **string** `"118"` (§2.3) — do not compare them without coercion |

What this establishes: the console's bootstrap config is readable without a session and pins Partner 118. What it does **not**: whether the value is tenant-pinned by host/origin or is simply a public
default for anonymous callers (both fit the same body), the accepted `FLAVOR` values, or any endpoint
behind it. The `partner`/`partnerConfig.id` type split is the kind of mismatch that breaks a join if it
is assumed away.

### 2.6 `/live/data` — sports/league/country catalog (captured 2026-11-02)

`GET` with no cookies or session header returns `200 application/json` (chunked, no `content-length`).
It is a global reference catalog, not a manager surface and not partner-scoped.

```http
GET https://plive.sportswidgets.pro/live/data?countries=true&leagues=true&sports=true
```

Three top-level objects, each keyed by numeric-string id:

| Key         | Entries (snapshot) | Record shape (observed)                                                                                   |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `sports`    | 80                 | `{n, in, o, po, mo, m, pn?, mn?}` — `n` name, `in` opaque, `o` sort/offset, `po`/`mo` ordering, `m` flags |
| `leagues`   | 29,938             | `{n, o, s, po, mo, m?, mn?, pn?, p?, platformSport?, sn?, si?}` — `s` is the **sport id**                 |
| `countries` | 383                | `{n, code, o, po, mo}` — `code` plus the same ordering pair                                               |

The counts are a **snapshot of a live feed**, not constants: a re-probe minutes later returned a
different league total and then the original again. Assert the shape and the join, never equality with
these numbers.

Gotchas:

- `po` and `mo` are **CSV strings**, not arrays (`po: "m,h1,s12,s11,s2…"`, `mo: "286, 285, 282, 280"`).
  `po` lists period keys, `mo` lists market ids, and the two do not share spacing conventions.
- `sports[<id>].m` mixes value types in one object (`{"3":"primary","5":"secondary","6":true}`) —
  string and boolean. A `Record<string, string>` fails on real data.
- `pn` (period-name overrides) appears on only **3** of 80 sports and `mn` (market names) on **13**, so
  absence is normal, not an error.
- leagues use `s` as a **number**; 53 distinct sport ids appear and all resolve into `sports`
  (verified, e.g. `NBA Props`→`s:24`→`"Basketball Props"`). The join holds today, but ids are strings
  on the `sports` side — coerce once at the boundary.

What this establishes: the desk's sport/league/country vocabulary and the sport join, unauthenticated.
What it does **not**: per-partner league visibility (nothing here is scoped), which sport ids a report
filter accepts, or any manager transport.

### 2.7 `/manager-tools/usersList/` — candidate `player`-report transport (401 only)

The console calls `GET /manager-tools/usersList/?t=<epoch ms>` and expects JSON. Probed
unauthenticated on 2026-11-02 with the body deliberately **not read** (a `200` here would be customer
data):

```text
401  content-type: text/html; charset=UTF-8  cache-control: no-store, no-cache, must-revalidate
```

So the path is session-gated and never cached. Replaying a captured `t` (`1793679877750`, i.e.
2026-11-02 22:24:37 CST) unauthenticated returns the same `401`, so `t` carries no authority — it is a
cache-buster, not a token. What that does **not** give us: the method it accepts
(a `401` may precede method validation), the auth scheme, any query encoding, or the response shape.
It is a **candidate** for the `player` report grid in §1 — the name and the millisecond cache-buster
both point that way — but a candidate is not a contract, and §1 stays `blocked_contract` until a
redacted request+response pair exists. Note the path is not a literal in the main bundle (§2.8), so it
is built in a lazy chunk or by concatenation; the bundle's player template id is `users-list`, and
report ids are **not** uniformly suffixed (`last-bets-report` has it, `users-list` does not).

### 2.8 The client bundle names the report transport (source-observed, 2026-11-02)

The console is a Vite/React bundle: `GET /manager-tools/assets/index-DB17VVxN.js` → `200`,
`application/javascript`, 5.29 MB, **no session required** (fetched 2026-11-02). Reading it is **source
observation**, not a wire capture — it shows what the client sends, never what the server accepts. No
row in §1 changes tier because of this section.

**Request layer.** One axios instance, `baseURL: ""`, `paramsSerializer` set to a query `stringify`
helper, plus a request interceptor that sets, on every call:

- `Accept: "application/json, gzip, deflate, br"` — the console sets this itself. The odd mixed
  media-type/content-coding value that appears in every operator `curl` is the app's header, not a
  transcription error.
- `x-gs-session: <ganchrowSessionId>` — read from React context, so the session token is a
  JS-readable header, not an HttpOnly cookie.
- `withCredentials` only when the URL is absolute (`startsWith("http")`), which is never true for the
  `/manager-tools/…` paths.

**Session.** `POST /api/v3/manager-tools/signin/` serves both flows: `{"checkSession":true}`
returns `ganchrowSessionId` plus `adminUserName`/`agentName` when a session exists, and
`{"username","password"}` is the credential login the SPA uses (request-body keys observed from
`assets/index-DB17VVxN.js` and a CDP trace, 2026-11-05). A rejected credential login returns
**403** with the login page text "Username or password are incorrect." No credential or cookie
value is recorded here. Logout is `POST /manager-tools/ajax.php` with `{"action":"logout"}` — so
`ajax.php` is an action dispatcher keyed on `action`, consistent with the earlier hypothesis that
it was not a rows API.

**The report request.** `kind` is the report id and everything else is a query string:

```http
GET /manager-tools/reports/?from=<date>&to=<date>&kind=<id>-report&partnerId=<id>&leaguesOrSports=<names>&wagerTypes=<names>&marketTypeCategories=<csv>&periodTypes=<csv>&eventId=<id>&agent=<login>&player=<csv>
```

| Param                  | Built from                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| `from` / `to`          | report date bounds (`String(...)`)                               |
| `kind`                 | report id; suffix is **not** uniform — see below                 |
| `partnerId`            | literal `ALL` becomes the empty string                           |
| `leaguesOrSports`      | selected ids resolved to **names** via the §2.6 catalogs         |
| `wagerTypes`           | selected market ids resolved to names                            |
| `marketTypeCategories` | array `.toString()` (comma-joined)                               |
| `periodTypes`          | array `.toString()`, `undefined` guarded                         |
| `agent`                | only when `searchBy === "agent"`                                 |
| `player`               | `[bot && "*BOTS*", searchBy === "player" && text]`, comma-joined |

Client-side rules that matter for any adapter:

- `kind` suffixes are mixed: `users-list` has none, `last-bets-report` and `vigs-report` do. The SPA
  applies `.replace("-report","")` only when building the hash route, so a `kind` value must be taken
  from the template map verbatim, not derived;
- empty, `"undefined"` and `"null"` params are **dropped** before the request, so their absence is
  normal and must not be read as "not supported";
- the bot/syndicate flag is not a `bot=true` param on the wire — it is the literal token `*BOTS*`
  inside `player`, e.g. `player=*BOTS*,player_AF12`;
- a non-array response is an error: the code throws `d` from the body (or the body itself, or
  `"Invalid server response"`), so a report failure can arrive as `200` with a non-array body.

**Other routes read from the same bundle** — uncaptured, listed only to name capture targets:
`GET /manager-tools/groups/` (`{group, withSle:true}`) · `GET /manager-tools/groups/settings/` ·
`GET /manager-tools/vigs/` (`{groupId}`) · `GET /manager-tools/reports/periods/index.php` ·
`POST /manager-tools/partnerPreferences/types` · `POST /manager-tools/ajax.php` (`{action}`).

**Probes (unauthenticated, 2026-11-02).** `GET /manager-tools/reports/?from=…&to=…&kind=users-list&partnerId=118`
→ **401** (`text/html`, `no-store`); `GET /manager-tools/reports/periods/index.php` → **401**. Both are
session-gated, so nothing in this section was obtained with a session — and nothing here proves the
server applies the same encoding the client builds.

### 2.9 How §2.3–§2.8 were verified, and what that does not mean

Every claim above was produced by **one author with one method**: unauthenticated HTTP probes against
the live console, plus reading one public JS bundle. Re-running the probes by script is
**corroboration, not independent confirmation** — the doc and the checker were written by the same
effort, so a shared blind spot survives both. That is not hypothetical: the first pass of this section
omitted seven real fields (period `L_h1`; sport `in`; league `pn` and `mn`; country `code`, `po` and
`mo`) and the self-check passed anyway, because it only asserted what the prose already said.

The one control against that failure mode is a **key-enumeration diff**: `scratch/verify_gs_contracts.ts`
compares the live key union of each object with the documented shape and fails on a key that appears in
one and not the other. That catches a dropped field or a server-side addition; it does not make the
author independent.

What would: a second operator replaying the probe set from this document alone, or a wire capture
produced by tooling this author did not write. Neither exists. Treat the §2.3/§2.5/§2.6 bodies as
single-source observations, §2.4 as single-source, twice, §2.7 as a status code and nothing more, and
§2.8 as static source rather than a captured exchange.

### 2.10 Sign-in flow — source plus one CDP trace (2026-11-05)

The public SPA bundle `assets/index-DB17VVxN.js` defines both flows on the same endpoint:
`POST /api/v3/manager-tools/signin/` with `{checkSession:true}` for bootstrap and
`{username,password}` for the credential login. A CDP trace of the login page confirmed the
credential request-body keys (`password`, `username`), a **403** response for the keychain
credentials in this checkout, and the rendered error "Username or password are incorrect."

That 403 is a credential verdict, not an empty report. `lib/gslive_auto_session.ts` now posts to
this endpoint, sends `x-gs-session` on the verification probe, and persists a GSID only after the
session verifies; it never installs a pre-auth cookie. No username, password, cookie or session id
is recorded here.

**Content-type trap:** the live console labels both the `signin` JSON and the `getBetReport` JSON as
`text/html`. The body, not the header, is the contract; parsing by `content-type` alone reports a
valid session as expired. `scripts/fetch-bet-tally.ts` now parses the body and treats only a
leading `<` (or a non-JSON body) as the login page.

**Second login route.** The legacy manager-tools bundle
(`assets/JsModules-BiJR7A5n.js`) still posts credentials to
`/api/v3/manager-tools/login/`, not `signin/`. That route also returned **403** for the keychain
credentials in this checkout and set only a pre-auth `GSID`; it is not a session-establishing
success. The bundle's `doServerRequest` also confirms `ajax.php` is the action dispatcher and that
`window.managerTools.ganchrowSessionId` is required for it.

Limits: one operator, one trace, one invalid-credential attempt per route. A successful credential
login was not observed in this checkout, so the 200 response shape remains unconfirmed.

## 3. CLI interfaces — local orchestration, not HTTP endpoints

The CLI is real and tested: six Node tests cover DST bounds, invalid scope/date input, schedule
deduplication, blocked live behaviour, lock exclusion and cron quoting (`zip:README.md:33-35`). It
makes **no network calls and sends no notifications**; retrieval, parsing, pagination, retry,
reconciliation and correction ingestion are not implemented (`zip:README.md:37`).

**Top-level interfaces** (`zip:src/cli.js:7-20`, `:24-58`):

| Interface                                                  | What it does                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `capabilities`                                             | Prints report IDs with `{live: false, status: "blocked_contract"}`, `apiImplemented: false` (`src/cli.js:36`) |
| `report <kind> --partner ID --date … [--mode mock]`        | Runs a report; live mode exits **2** with `blocked_contract` (`src/cli.js:37`, `README.md:23`)                |
| `jobs add/list/run/logs/enable/disable/remove/tick/unlock` | Local job store: cron template, locking, per-job logs                                                         |
| `serve`                                                    | In-process minute dispatcher using `Bun.cron`; keeps live collection blocked (`src/cli.js:27-35`)             |
| `docs`                                                     | Renders the bundled specification as terminal Markdown (`src/cli.js:26`)                                      |
| `cron print --bun <path>`                                  | Prints a cron **template**; installs nothing (`src/cli.js:38`, `README.md:27`)                                |

**Nine `jobs` subcommands** (`zip:templates/endpoint-registry.json:306-313`; dispatch at
`zip:src/cli.js:39-58`): `add`, `list`, `run`, `logs`, `enable`, `disable`, `remove`, `tick`,
`unlock`. These are local store operations. The registry marks the local interfaces
`notUpstreamEndpoints: true` (`:303-305`) and lists `capabilities()` / `acquire()` as **proposed
adapter methods**, not HTTP routes (`:314-317`).

Report IDs are kebab-case at the CLI boundary (`open-bet`, `last-bets`); earlier design documents
used underscores. Map explicitly at any future adapter boundary (`zip:contracts/contract-map.md:28`,
`zip:templates/endpoint-registry.json:318`).

## 4. What a live adapter would need before it can exist

`zip:templates/contract-verification.md:11-29` is the checklist. In short, each report must be
captured independently before acquisition is enabled:

- actual request **URL, HTTP method, content type**, provenance;
- auth/CSRF/refresh behaviour **without saving credential values**;
- response envelope, rows path, field types/nullability, unknown-field policy;
- aggregate/bet/group/leg grain, row identity, correction/regrade behaviour;
- pagination/cursor, exhaustion signal, totals and repeated-page behaviour;
- date basis, source timezone, precision, inclusivity, `fromTime`/`toTime` interaction;
- monetary precision, profit sign, hold formula, zero-denominator behaviour;
- export completeness (grouping/subtotals/selected columns) from a **nonempty** export.

The extract also fixes the security posture for any future adapter: read-only scoped credentials,
no tokens in URLs/flags/report JSON/fixtures/cron entries, no browser cookie/storage scraping,
allow-listed HTTPS origins and report actions, no auth failure turned into an empty report, and
loopback-only if a local HTTP API is ever added (`zip:contracts/api-security-spec.md:15-29`):

> "Keep live acquisition blocked until contract and critical authorization controls are verified."
> — `zip:contracts/api-security-spec.md:29`

## 5. Non-claims

- No GS endpoint, method, content type, auth scheme, pagination rule or response schema is invented
  or implied here.
- The `$`-prefixed display values on the Summary screen are **UI labels**, not evidence of currency
  precision or sign; the existing zero state is not a verified empty acquisition
  (`zip:contracts/report-surfaces.md:41-65`).
- The CLI's manifest ledger is not an ingestion checkpoint system (`zip:README.md:37`).
- No mock output contains customer data, and no live call was ever made (`zip:README.md:3`,
  `zip:README.md:37`).

## Last Bets — 53-column UI catalog and 15 filters (observed 2026-11-03)

The live **Events → Bet History → Table settings** shows **53 / 53**. Reconciled against the
2026-11-03 browser extraction: **52 named columns plus the row-selection checkbox**. The catalog is
encoded in `lib/gslive_report_columns.ts`:

- `UI_LAST_BETS_SLOT_COUNT = 53`, `UI_LAST_BETS_NAMED_COLUMN_COUNT = 52`
- `LAST_BETS_COLUMNS` (52 entries, in UI order) and `ROW_SELECTION_COLUMN` (slot 53, modeled
  separately; it is not treated as a wire field until a table-schema capture confirms it)
- `LAST_BETS_FILTERS` — **15** filter controls, each with the `getBetReport` body key(s) it reaches

Columns: Bet Group, Id, Player, Player Id, Profile, Agent, Ticket, If bet, Risk, To Win, Then bet,
Premium, Result, Free bet, Sport / League, Sport (SportId), League (LeagueId), Event Id, Event
Details, Bet price, Period, Market, Market Id, Side, Open Spots, Prop figure, Contestant, Figure,
Wager Type Category, Logs, Time Until Score, Bet Time, Bet Time (Day), Bet Time (Month), Bet Time
(Hour), Bet Time (Minutes), Bet Time (Seconds), Grade Time, State, Accept Type, Actions, Type,
IP Address, Featured Bet Id, Featured Bet Price, Disclaimer, Teaser Name, Admin User, Uncorrelated
Odds, Partner, User Group Id, Delay (+ row selection = 53).

Filters (15): **Date range** with **Grade time / Bet time** basis (`from`, `to`, `dateFilterBy`),
Player (`partnerUserId`), Agent (`agent`), Event Id (`eventId`), Bet Id (`betId`), Bet Group Id
(`betGroupId`), Group Kind (`group`), Group Name (`group`; same body key, unverified split), Free Bet
Id (`freeBetId`), State (`state`), Sport (`sId`), Period (`period`), Min Wager (`minVolume`),
**Max Time Until Score** (`maxTimeUntilScore`), Market (`mId`).

Wire reconciliation: `scratch/betReport-all.json` has **69** raw row keys; 38 of the 52 columns map
to a single wire key, 14 are UI-only/derived/nested (`betDetails.m`, Logs, Actions, Time Until Score,
Bet Time parts, Featured Bet fields, Prop figure, Figure, Sport / League, Wager Type Category). `scratch/ajax-getBetReport-body.json` has
**20** body keys and contains every mapped filter key. `scratch/gslive-wagers-by-state.csv` has **18**
columns; all 18 canonicalize through the label map. This catalog is UI vocabulary, not a transport
contract: every report kind remains `blocked_contract` until a redacted request/response pair lands.
