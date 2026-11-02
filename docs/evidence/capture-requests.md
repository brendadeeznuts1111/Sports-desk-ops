# Capture requests — SportsDesk / Fantasy402 docs release

Companion to [ledger.json](./ledger.json). Every item below states exactly what to capture, what is
currently claimed, and which ledger rows it would upgrade. Nothing here authorizes a live mutation:
capture read paths first, and treat every write capture as an operator-approved change on a controlled
account.

**Status of the release:** no operation has a captured response body. The only real wire artifact is the
2026-10-28 Manager HAR (portal `v1.0.279`), which recorded request headers and bodies for the Manager
calls but no response bodies. See `operational_guardrails_runbook.md:127-153`.

**Redaction rules (apply to every capture):** keep request/response _shape_; replace credentials, tokens,
cookies, IPs and customer IDs with stable placeholders. Never store `Authorization`, `Cookie`,
`Set-Cookie`, CSRF values, passwords or raw JWTs. Record header _names_ and auth _scheme_, not values.
Preserve scalar types when redaction changes a value (write `"customerID": "<PLACEHOLDER>"`, not `0`).

**Capture record format** (use for every artifact added to the repo):

```json
{
  "capturedAt": "YYYY-MM-DDTHH:MM:SSZ",
  "operator": "<role>",
  "portalVersion": "vX.Y.Z",
  "endpoint": "<exact URL as seen on the wire>",
  "method": "POST",
  "contentType": "<exact request Content-Type>",
  "requestHeaders": [
    "X-Requested-With: XMLHttpRequest",
    "Authorization: Bearer <REDACTED>"
  ],
  "requestBody": "<redacted, exact field order if it matters>",
  "status": 200,
  "responseContentType": "<exact>",
  "responseBody": "<redacted body or 'not captured'>",
  "redaction": "<what was replaced and how>"
}
```

---

## P1 — `getWebLog` modes A, C, I and any response body (highest value)

Ledger row: `POST /cloud/api/Manager/getWebLog` (tier B, **contradicted**). Mode B is the only mode ever
observed, and no response was captured, so:

- modes A / C / I are inferred from the form (`operational_guardrails_runbook.md:131`);
- the response row schema is unpublished (`operational_guardrails_runbook.md:153`);
- the spec requires an `Authorization` header the capture never had (`docs/openapi.json:386`).

**Observed mode-B request (baseline that is verified — do not re-derive it):**

```http
POST https://www.fantasy402.com/cloud/api/Manager/getWebLog
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Cookie: <REDACTED session cookie>

agentID=<sessionAgent>&customerID=0&start=10%2F28%2F2026&end=10%2F28%2F2026&type=B
&actions=ALL&ip=&operation=getWebLog&RRO=1&agentOwner=<sessionAgent>
```

**What to capture:**

| Mode               | Request changes vs the mode-B baseline                                              | Capture                                       |
| ------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| A — Web Access Log | `type=A`, same `MM/DD/YYYY` dates, `customerID=0`                                   | full 200 body                                 |
| C — Acct IP Match  | `type=C`, **both dates `YYYY-MM-DD`** (`runbook:129`), `customerID=<target bettor>` | full 200 body, both a hit and a zero-hit case |
| I — Users by IP    | `type=I`, `ip=<IPv4 or /24>`, `customerID` behavior unknown                         | full 200 body                                 |
| any                | exact request headers and cookies used                                              | status + response headers + body              |

Also record: `Content-Type` of the response, whether the body is an array or an envelope, whether the
four published fields (`customerID`, `ipAddress`, `timestamp`, `agentOwner`) actually appear, whether a
`path` field appears (it is deliberately omitted per `simulate_bettor_churn_suite.ts:122`), and whether
`Authorization` is accepted at all.

**Upgrades:** modes A/C/I from C→A; the response schema and auth claim move from _contradicted_ to
verified (or the spec is corrected). This is the single highest-value capture because it is the only
forensic endpoint the runbooks, the code and the spec all point at.

---

## P2 — `updateByColumn` mutation + `getInfoPlayer` read-back

Ledger rows: `POST /cloud/api/Manager/updateByColumn` (C), `POST /cloud/api/Manager/getInfoPlayer` (B,
tier A since 2026-10-31, so the example is superseded rather than contradictory). `operational_guardrails_runbook.md:215` states the only HAR does **not**
include `updateByColumn`, that the only observed padded ID is `Log/write`'s at **10** characters, and that
the **11**-character width must be confirmed by capture before anyone relies on it. The spec
(`docs/openapi.json:609-754`) publishes a 9-field body and `Result` 1/0/-1 semantics on no evidence.

**Padding note, corrected 2026-11-01.** `Log/writeDetail`, `Log/write` and `vipListInsert` were observed
sending `customerID`/`agentID`/`agentOwner` as the bare 7-character login, so the "padded to 10
characters" reading of `Log/write` above does not hold for those calls. The 11-character width in the
spec is still unconfirmed; what is now ruled out is assuming padding from this operation family.

**Capture on a controlled test account only.**

```http
POST https://www.fantasy402.com/cloud/api/Manager/updateByColumn
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Cookie: <REDACTED session cookie>

operation=updateByColumn&customerID=<11-char padded>&agentID=<direct sub-agent>&agentOwner=<direct sub-agent>
&columnName=confirmationDelaySeconds&type=0&value=6&title=confirmationDelaySeconds&information=&special=&RRO=1
```

Then immediately:

```http
POST https://www.fantasy402.com/cloud/api/Manager/getInfoPlayer
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

customerID=<same ID, try trimmed first>&agentID=<direct sub-agent>
```

Record: (a) whether the padded **11**-char ID is accepted, the **10**-char form, or the trimmed 7-char
form; (b) the exact `Result` envelope; (c) a wrong-scope attempt (master `BILLY666`) if safe on a test
account, to confirm `-1`; (d) the before/after `getInfoPlayer` body — `runbook:213` observed reads sending a
**trimmed** 7-char ID while the spec example sends the padded form; (e) whether a `path` field really
produces the empty-body 500 the spec claims.

**Upgrades:** `updateByColumn` C→A and confirms/refutes `PaddedCustomerId` width, `SILENT_NO_OP`,
`REJECTED_SCOPE`, `POISONED_PATH_500`; `getInfoPlayer` B→A and resolves its padded-vs-trimmed example
contradiction.

---

## P3 — `authenticateCustomer` (the whole auth model rests on it)

Ledger row: `POST /cloud/api/System/authenticateCustomer` (C). The spec claims a scoped Bearer JWT with a
~20–25 minute lifetime; the one observed Manager session is cookie-based and sends no `Authorization`
header (`runbook:153`). Neither claim is evidenced.

```http
POST https://www.fantasy402.com/cloud/api/System/authenticateCustomer
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

customerID=<agent or bettor ID>&password=<REDACTED>
```

Capture: HTTP status, `Set-Cookie` names/attributes (redacted values), response body keys (`code`?
`accountInfo`?), token prefix/length and expiry, and **the headers of the very next Manager call** — that
last part is what decides cookie vs Bearer. Also capture the failure case (bad password) and any
Cloudflare/HTML challenge page.

**Upgrades:** C→A; determines whether `BearerAuth`/`AuthBearer` in `docs/openapi.json` (and the 24
operations that reference `BearerAuth` without a `securitySchemes` entry) is correct or must be replaced
with a cookie scheme.

---

## P4 — GS `getBetReport`: transport, content type, response (the biggest upstream gap)

Ledger row: `POST /manager-tools/ajax.php` (tier B, **contradicted**). The GS extract forbids exactly what
the spec publishes:

- `zip:README.md:3` — "Live acquisition is intentionally blocked: no GS endpoint/authentication/response contract is verified."
- `zip:contracts/contract-map.md:14` — "No endpoint URL, method, auth scheme, Summary action, pagination, or upstream response schema is fabricated here."
- `zip:contracts/gs-manager.ts:29-30` — "No response capture exists: assigning invented response properties is prohibited."
- `zip:templates/endpoint-registry.json:281-288` — last-bets upstream `url`, `method`, `contentType`, `responseSchema`, `authentication` are all `null`.
- `zip:templates/contract-verification.md:3` — "no transport URL, method, response shape, or auth mechanism has been established for any report."

The only observed artifact is a user-supplied request payload (`zip:contracts/get-bet-report.observed.json`):

```json
{
  "action": "getBetReport",
  "partnerUserId": "",
  "agent": "",
  "eventId": "",
  "freeBetId": "",
  "state": "",
  "sId": "2",
  "minVolume": "0",
  "maxTimeUntilScore": "0",
  "mId": "",
  "from": 1793250000,
  "fromTime": 0,
  "to": 1793422799,
  "toTime": 86399,
  "betId": "",
  "betGroupId": "",
  "group": null,
  "dateFilterBy": "calcTime",
  "partnerIds": "",
  "period": "s3"
}
```

**What to capture.** In the GS manager-tools UI (`https://plive.sportswidgets.pro/manager-tools/#/events/bet-history`),
open browser devtools Network, submit the Last Bets report for a short authorized window, and export the
one reporting request + response as HAR (redacted). Do **not** guess `/manager-tools/ajax.php`; record the
URL that actually fires. Record:

1. actual transport URL and path prefix;
2. HTTP method;
3. exact request `Content-Type` (JSON vs `application/x-www-form-urlencoded`);
4. full redacted request body — observe `action` vs `operation`, whether `partnerIds` carries tenant 118,
   `sId`/`period`/`state` semantics, `from`/`to`/`fromTime`/`toTime` interaction, `group` null vs omitted;
5. full redacted response — envelope, rows path, field names/types, pagination/totals, empty case;
6. auth/CSRF mechanism and tenant enforcement without storing values.

**Upgrades:** resolves the `manager-tools` contradiction and moves that row B→A; closes the biggest
unknown in the release. Until this exists, no markdown may present `getBetReport` as an HTTP contract.

---

## P5 — the unbacked cloud operations

**12 operations are fully unbacked:** no capture, no observed request, and no repo TypeScript wire type —
their spec bodies exist only because the spec or `scripts/enhance_docs.mjs` authored them. Capture each
once read-only where possible; the mutations need a controlled test account.

Expected auth: the Manager portal session cookie observed in the 2026-10-28 HAR (no `Authorization` header;
`operational_guardrails_runbook.md:153`) — record the actual `Cookie` header names plus the
`X-Requested-With` / `Referer` values (redacted), and note if any call accepts Bearer instead.

| #   | Operation               | Candidate URL / content type                                                                           | What to capture                                                                                                                                                                                                                                                         | Upgrades                              |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | `getBetTickerConfig`    | `POST /cloud/api/Manager/getBetTickerConfig`, form-urlencoded                                          | the `INFO:false` misconfigured shape. **2026-11-01:** the healthy `INFO` object was pasted (buckets, flags, colours) and the store already holds a tier-A record, so what is still missing is the _misconfigured_ variant — the two must not be conflated               | A (captured)                          |
| 2   | `vigSetupInsert`        | `POST /cloud/api/Manager/vigSetupInsert`, spec says `application/json` with 20-char padded `sportType` | one insert + `getSportsVigSetup` read-back on a test account                                                                                                                                                                                                            | C→A; validates the JSON-vs-form claim |
| 3   | `getSportsVigSetup`     | `POST /cloud/api/Manager/getSportsVigSetup`, form-urlencoded                                           | paired read-back with #2                                                                                                                                                                                                                                                | C→A                                   |
| 4   | `getInfoManager`        | `POST /cloud/api/Manager/getInfoManager`, form-urlencoded                                              | dashboard header call; exact JSON keys (spec's hyphenated `grand-total-weekly` is unusual)                                                                                                                                                                              | C→A                                   |
| 5   | `getWeeklyFigure`       | `POST /cloud/api/Report/getWeeklyFigure`                                                               | one Reporting weekly-figure capture. `data-action="get-weekly-figure"` **is** real (portal left-menu markup, `tests/fixtures/portal-left-menu-actions.html`); whether that action calls this path rather than `Manager/getWeeklyFigureByAgentLite` is the open question | C→A                                   |
| 6   | `verifySession`         | `POST /cloud/api/System/verifySession`                                                                 | live token + expired token; response shape and the 401 re-mint behavior                                                                                                                                                                                                 | C→A                                   |
| 7   | `getCustomerNotes`      | `POST /cloud/api/Manager/getCustomerNotes`, form-urlencoded                                            | one read; note row fields, author/timestamp semantics                                                                                                                                                                                                                   | C→A                                   |
| 8   | `updateCustomerNotes`   | `POST /cloud/api/Manager/updateCustomerNotes`, form-urlencoded                                         | one append + read-back on a test customer; Result envelope; immutability                                                                                                                                                                                                | C→A                                   |
| 9   | `deleteSportsVigSetup`  | `POST /cloud/api/Manager/deleteSportsVigSetup`, form-urlencoded                                        | delete + `getSportsVigSetup` read-back on a test account                                                                                                                                                                                                                | C→A                                   |
| 10  | `deleteWager`           | `POST /cloud/api/Manager/deleteWager`, form-urlencoded                                                 | void/cancel + audit-log read-back on a test ticket; exact required fields (only `wagerNumber`/`reason` are documented)                                                                                                                                                  | C→A                                   |
| 11  | `getDeletedWagerReport` | `POST /cloud/api/Report/getDeletedWagerReport`                                                         | one Reporting capture; resolve whether it is distinct from `delete-wager`                                                                                                                                                                                               | C→A                                   |
| 12  | `getDailyFigure`        | `POST /cloud/api/Report/getDailyFigure`                                                                | one capture; confirm whether it takes a request body at all                                                                                                                                                                                                             | C→A                                   |

**Two more feeds have repo wire types but no capture** — lower priority, still unverified:

| #   | Operation      | Candidate URL / content type                                                                                                                     | What to capture                                                                                                            | Upgrades                                  |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 13  | `getBetTicker` | `POST /cloud/api/Manager/getBetTicker`, form-urlencoded                                                                                          | an initial call (`wagerNumber=0`) and a delta call; exact body; `INFO`/`LIST` envelope; row keys/types; watermark behavior | C→A; validates the delta-watermark design |
| 14  | `getPending`   | `POST /cloud/api/Manager/getPending` — **content type contested**: the spec says `application/json`, every other Manager call is form-urlencoded | exact content type + one non-empty response; confirm `BLOCKED`/zero-stake sentinel rows actually appear                    | C→A                                       |

`authenticateCustomer` is deliberately not in this table — the whole auth model needs its own capture and
is §P3. Rows with partial observation are tracked elsewhere: `updateByColumn` (§P2) and
`search`/`getSettledFigure`/`delete-wager`/`getAnalysis`/`getFinancialReport` (§P6 — UI action names
observed, URLs not). `getAgentPerformance` has left that group: its request is fully observed and only
its response is missing (§P5a). A 2026-11-01 export run also produced the graded workbook, reduced to
`data/graded-wagers-export-2026-11-01.json` (shape only; the rows stay out of the repo), and showed
that `getGrading` sends ISO dates and a self-referential `path` field where `getAgentPerformance`
sends M/D/YYYY.

**Observed request, still unledgered: `getSubSportByReport`.** A 2026-11-01 operator paste shows
`POST /cloud/api/Manager/getSubSportByReport`, form-urlencoded, with
`customerID`, `sport` (padded to 20 characters — `Football` plus 12 spaces), `operation`, `RRO=1`,
`agentID`, `agentOwner`. Two further observations send `sport=Auto+Racing+++++++++` and
`sport=Tennis++++++++++++++` — a two-word sport and a short one, both padded to the same 20
characters — so the field width is pinned across name lengths rather than from one sample. A browser
stack trace from the same session names the caller:
`getSubsport()` in `app/manager/module/agent-performance.js?bust=1.0.280`, through jQuery `$.ajax` —
which is also why the request is form-encoded with `X-Requested-With`. That module is the screen whose
report is `getAgentPerformance`, so the two observed requests belong to one page. It is the call that
fills the report's sub-sport picker, the wire counterpart of `lib/sport_catalog.ts`. It has
**no ledger row and no spec path on purpose**: a ledger `path` is an exact `docs/openapi.json` path
(`docs/evidence/ledger.json:9-21`) and nobody has seen the response, so there is no schema to publish.
Capture it (URL, body, rows) and it becomes a real operation with a real schema rather than an authored
one.

## P5a — the `getAgentPerformance` response gap (request fully observed)

Ledger row: `POST /cloud/api/Manager/getAgentPerformance` (tier B — request observed, **response never**).
The 2026-11-01 observation also contradicts the repo's earlier inferred path
`/cloud/api/Report/getAgentPerformance` (`docs/evidence/ledger.json:556-579`).

**The request side is closed.** Three bodies are recorded in
`tests/fixtures/f402-report-requests-observed-2026-11-01.json`: the all-periods CP call, the same call
with the sport filter row filled, and a CPS (sport performance) call. Only four fields differ between the
two CP bodies — `subsport`, `period`, `wagerType`, `betType`. `tipo` is `0` for CP and `-1` for CPS, so it
belongs to the selection rather than being a constant. `sport` is padded to 20 characters, and `period`
is the catalog's number for the chosen sport (`1` under Football is `1st Half`, not "first period"). The
CPS call was also observed a second time with `period=0` and everything else equal.

| Observed body        | `type` | `sport` / `subsport`        | `period`  | `tipo` |
| -------------------- | ------ | --------------------------- | --------- | ------ |
| CP, all periods      | `CP`   | `Football` (padded) / empty | `-1`      | `0`    |
| CP, sport filter row | `CP`   | `Football` / `NFL`          | `1`       | `0`    |
| CPS                  | `CPS`  | `LIVE` / `NCAAF Live`       | `-1`, `0` | `-1`   |

`lib/f402_agent_performance_request.ts` rebuilds every one of those bodies from a typed selection,
byte-exact and catalog-validated (`lib/f402_agent_performance_request.test.ts:61-87,275-282`), so the
capture operator can generate the request instead of hand-building a curl. Field order is pinned too:
`start`, `end`, `agentID`, `type`, `freePlay`, `store`, `sport`, `subsport`, `period`, `wagerType`,
`betType`, `tipo`, `debug`, `operation`, `RRO`, `agentOwner`.

**The response side is empty.** No response body has ever been seen — not a status, response
`Content-Type`, envelope or row — so no column set is documented, which is what the ledger row says too
(`docs/evidence/ledger.json:574,2118`). The module deliberately describes no response either.

**What to capture.** One CP call and one CPS call with the fixtures' agent and date range, recording the
full response (status, content type, body), plus a zero-row case if the filter can produce one. Reconcile
against the screen's own grid header, not against a guess:
`tests/fixtures/portal-agent-performance-filterbar-2026-11-01.html:282-300` names **All Players and
Agents · Won · Lost · # of Bets · Risk · Net · Hold %age**. Those seven labels are markup, not a schema:
the JSON keys, their nesting, whether `holdPct` is computed server-side and how `BranchGrade` is applied
are all unknown until a body exists (`docs/evidence/ledger.json:574`). The 2026-11-01 workbook export is
not a substitute — it is wager-level with five columns (`data/graded-wagers-export-2026-11-01.json`).

**Upgrades:** B→A. Until then no markdown may publish a result column set for this report.

## P5b — observed writes: the Vip List save and the ticker config save

Neither write surface has a ledger row. Both were observed on 2026-11-01, neither has a response schema,
and both mutate live state — one VIP-list entry on a customer, one desk setting. They are recorded so the
wire shape is not lost and a future capture has a target; they are not calls this repo makes.

**A Vip List save is three requests, and all three are mutations.** The `show-vip` panel
(`docs/evidence/surfaces.md:303-326`) sends, in order:

1. **`vipListInsert`** — `POST /cloud/api/Manager/vipListInsert`, `application/json`:
   `{"list":[{"agentID":"<agent>","player":"<player>"}],"operation":"vipListInsert","agentID":"<agent>","agentOwner":"<agent>"}`.
   A `list` array even for one player, so a single save is a batch from the API's point of view.
2. **`Log/writeDetail`** — `POST /cloud/api/Log/writeDetail`, `application/x-www-form-urlencoded`: the
   same list as JSON text urlencoded into `data`, plus `ticket=0` (not attached to a wager),
   `info=" [SITE : fantasy402.com v1.0.280] "`, `customerID`, `operation`, `agentID`, `agentOwner`.
3. **`Log/write`** — `POST /cloud/api/Log/write`, `application/json`: `customerID`, `additional` (empty),
   `description="Save Action / Vip List [ v1.0.280 | fantasy402.com ]"`, `operation`, `agentID`,
   `agentOwner`. The description arrives in the request body and names both the screen and the portal
   version, so an audit row records what the UI called the action.

The sequence is pinned in `tests/f402_observed_requests.test.ts:401-468`. Its point is that one save uses
two encodings — JSON, form, JSON — so a client assuming one content type breaks on the middle call.

**None of the three is replayed in this repo.** No code path sends the recorded bodies: production is
read-only unless the task is explicitly a deploy, and a VIP entry is live customer state
(`tests/f402_observed_requests.test.ts:402-408`,
`tests/fixtures/f402-report-requests-observed-2026-11-01.json:188`). One caveat keeps that claim exact:
`lib/f402_probe.ts:371-386` registers `Log/write` as a non-read-only probe, selected only under
`--include-unconfirmed`, which the capture CLI also gates behind `--i-understand-mutations`
(`scripts/capture/f402_probe.ts:369-371`). That probe builds its own body; it never replays the observed
one.

**The acknowledgement `{"INFO":""}` was observed, and it is an empty string.** The paste recorded the
body but not which of the three calls answered it, so all three remain candidates. An empty `INFO` proves
only that the write ack carries no payload; it is **not evidence of success**. The portal acknowledges
writes without inspecting results elsewhere (`updateBasicSettings` assigns local state from the values it
sent), and this is a different envelope from the ticker config's `INFO` object under the same key
(`docs/evidence/surfaces.md:319-326`). Success semantics are unestablished — a capture that shows a
_rejected_ save is what would separate the two.

**Unledgered but observed: four operations, each a write on live customer or desk state.** None has a
ledger row yet, because a row without a response would restate the request; what a capture would add is
the response body and the success/failure signal.

| #   | Operation               | Observed wire                                                                             | What a capture would add                                                                                                         |
| --- | ----------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `vipListInsert`         | `POST /cloud/api/Manager/vipListInsert`, JSON, `list` array                               | the accepted ack for an insert, and whether a duplicate or unknown `player` is rejected, coalesced or silently accepted          |
| 2   | `Log/writeDetail`       | `POST /cloud/api/Log/writeDetail`, form, JSON-in-`data`, `ticket=0`                       | whether the server validates `data` as JSON, and what a malformed or oversized detail returns                                    |
| 3   | `Log/write`             | `POST /cloud/api/Log/write`, JSON, `description` names screen + version                   | the audit headline's response body, and whether a rejected write has a distinguishable shape                                     |
| 4   | `updateBetTickerConfig` | `POST /cloud/api/Manager/updateBetTickerConfig`, form, `play499`-style upper-bound fields | the save's response envelope (the read's is the healthy `INFO` object), and whether a rejected save differs from an accepted one |

**The ticker config save is the write half of a tier-A read.** Six buckets, named by upper bound in the
write (`play499`, `color499`) and by range in the read (`play1-499`, `color1-499`); an enabled flag reads
`"on "` with a trailing space while a disabled one reads `"off"` without; `AgentID` is unpadded in the
request and padded to 50 characters in the response
(`tests/fixtures/f402-bet-ticker-config-2026-11-01.json`; `lib/f402_bet_ticker_config.ts:1-20`). The read
is the tier-A row #1 in §P5; the `INFO:false` misconfigured variant is still unobserved, and a write
capture is not that. Sending this write changes the desk's ticker, so it needs an operator-approved
change on a controlled account — the repo's builder deliberately never calls it
(`lib/f402_bet_ticker_config.ts:18-19`).

## P6 — the 11 "Tracked Operational Domains" candidates

Ledger rows: the 11 `POST /cloud/api/...` operations tagged `Tracked Operational Domains` (all tier C,
`candidate_url: true`, `ui_observed: true`). Their path+method come from hand-authored constants in
`scripts/portal_tile_crawler.ts:40-162`; the crawler's CLI
entry runs the `offline` branch (`portal_tile_crawler.ts:670,680`) and never records network traffic.
The former post-processor draft (`append_tracked_domains.mjs`) was removed: it mutated the generated
spec and reference outside the ledger, duplicated this table, and failed the docs gate.
The markdown table calls them "Target Wire Endpoint" (`docs/api-reference.md:693`), which is an overclaim.

For each tile: open the Manager dashboard, click the tile, and capture the network request it actually
fires (URL incl. `/Manager` vs `/Report` vs another model prefix, method, content type, body, auth) plus a
response. Then correct the path/method in the spec if they differ. Expected auth is the same Manager session
cookie; the `/cloud/api/<Model>/<method>` shape means the _model prefix_ is the least certain part of each
candidate and must be read off the wire, not inferred from the tile name.

| Tile                 | Candidate path + method                       | DOM selector (declared)                     | Declared inputs                                          | Upgrade if captured                                    |
| -------------------- | --------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Game Admin           | `POST /cloud/api/Manager/gameAdmin`           | `div.tile:has-text('Game Admin')`           | rotationNumber, sportType, circleLimit, isLocked         | C→A                                                    |
| Messaging            | `POST /cloud/api/System/getMessages`          | `div.tile:has-text('Messaging')`            | recipientScope, subject, messageBody, priority           | C→A                                                    |
| Cashier              | `POST /cloud/api/Manager/adjustBalance`       | `div.tile:has-text('Cashier')`              | customerID, amountCents, transactionType, notes          | C→A (write: test account only)                         |
| Add Customer         | `POST /cloud/api/Manager/createPlayer`        | `div.tile:has-text('Add Customer')`         | customerID, agentID, password, creditLimit, delaySeconds | C→A (write: test account only)                         |
| 3rd Party Limits     | `POST /cloud/api/Manager/get3rdPartyLimits`   | `div.tile:has-text('3rd Party Limits')`     | providerID, sportCategory, maxLimitCents                 | C→A                                                    |
| Analysis             | `POST /cloud/api/Report/getAnalysis`          | `div.tile:has-text('Analysis')`             | period, sport, marketCategory, agentID                   | C→A — also has UI action-name evidence (`runbook:166`) |
| Scores               | `POST /cloud/api/Report/getScoresLiveDynamic` | `div.tile:has-text('Scores')`               | gameID, periodIndex, homeScore, awayScore, isFinal       | B→A — request observed 2026-11-02 (see below)          |
| Agent Admin          | `POST /cloud/api/Manager/getAgentTree`        | `div.tile:has-text('Agent Admin')`          | masterAgent, commissionSplitPercent, creditCeiling       | C→A                                                    |
| Billing              | `POST /cloud/api/Manager/getBilling`          | `div.tile:has-text('Billing')`              | billingWeek, ratePerActiveHead, activeAccountCount       | C→A                                                    |
| Settings & Rules     | `POST /cloud/api/Manager/getRules`            | `div.tile:has-text('Rules')`                | parlayMaxPayout, teaserTieRule, defaultDelaySeconds      | C→A                                                    |
| Transactions History | `POST /cloud/api/Report/getFinancialReport`   | `div.tile:has-text('Transactions History')` | customerID, startDate, endDate, transactionFilter        | C→A — also has UI action-name evidence (`runbook:167`) |

The declared inputs are **form-field names seen in the DOM**, not request-body fields. Capture must
establish whether they are POSTed under those names, under a wrapper, or not at all.

### Scores: the observed request and response shape (2026-11-02)

The Scores panel does not use the tile's candidate path, and it does not send a form:

```json
{
  "customerID": "<logged-in account>",
  "operation": "getScoresLiveDynamic",
  "RRO": 1,
  "agentID": "<logged-in agent>",
  "agentOwner": "<logged-in agent>"
}
```

sent as `content-type: application/json` to `POST /cloud/api/Report/getScoresLiveDynamic`. The
response was an object with a `Scores` array; three field names were seen — `LogoTeam1`,
`LogoTeam2` and `BroadcastInfo`. The logo fields are the portal's **image file names**, not team
names (`Boston-Celtics.png`, `Notre Dame Fighting Irish.png`, `miami_dolphins_logo.png`,
`toronto.png`, and `NHL.png` in a team slot), which is what `/api/logo/{name}` resolves.

This is an operator transcript, not a capture: no artifact, no body hash, and the remaining response
fields are unknown. The row moved C→B on the strength of the observed request; **A still needs the
redacted capture**, and that capture is also what would settle whether the tile-candidate path
(`Manager/getScores`) is a second endpoint or a stale name.

One entry was read in full on 2026-11-02, which is enough to publish the field list but not the
contract. The quirks a parser has to survive:

- **Padding.** `SportSubType` (`"NBA         "`), `SportType` (`"Basketball          "`), `Grouping`
  and `CorrelationID` carry trailing spaces to a fixed width. Trim before comparing or joining.
- **Numbers as text.** `Team1Score`/`Team2Score` (`"57"`, `"63"`) and `Total` (`"220.5"`) are
  strings, while `Spread`, `SpreadAdj1/2`, `MoneyLine1/2`, `GameNum` and the rotations are numbers.
- **Nulls and empties.** `MoneyLineDraw` and `TotalPoints` were `null`; `Record`, `Rank`, `Record2`,
  `Rank2` were `""`; `BroadcastInfo` was whitespace.
- **Not ISO time.** `GameDateTime` is `"2026-11-01 20:40:00.000"`.
- **Two id vocabularies.** `Team1ID` is the full name (`"Los Angeles Clippers"`), `STeam1ID` the
  short one (`"Clippers"`); `Favorito` is a full team _name_, not an id.
- **`CorrelationID` is `"<Team1RotNum>-g"` plus padding** (`539-g`), so it joins to the rotation and
  not to a game id.
- **Status is three fields.** `STATUS` was `"O"`; `StatusAway`/`StatusHome` were `"Time"`/`"Half"`.
  Whether "live" is `STATUS`, the per-side strings, or `Final` is unresolved — the operator's
  working filter is `StatusAway.trim() === "Time" || StatusHome.trim() === "Half"`, recorded here as a
  hypothesis, not a contract.

Rotation numbers should be stable per team; `bun run check:rotations <scores.json>` reports a team
that appears with more than one, and counts rotation rows whose `Team*ID` is missing instead of
grouping them under `undefined` (which is what the ad-hoc one-liner did, reporting "clean" on a
payload where the ids were never present).

**How the panel drives it** (pinned `verification/manager-boot-oracle/pinned/manager.js`, read
2026-11-02): the first open of the Scores panel calls `getScoresDynamic()` and then
`$.scoreInterval = setInterval(() => getScoresDynamic(), 30000)`. The four `setTimeout` calls in the
same module are one-shot UI delays (50, 300, 500 and 1500 ms) and none re-arms, so this is an
interval, not a chained-timeout loop. Two consequences for anyone mirroring the cadence:

- `clearInterval` does not appear anywhere in the pinned bundle, and `$.scoreInterval` is written
  once and never read, so the 30 s poll never stops — it keeps running with the panel closed.
- `getScoresDynamic()` itself posts only `{operation: "getScoresLiveDynamic"}`.

**The wire body is the caller's body ∪ the prefilter's body.** Do not read a captured body as
authored by the method, and do not read a difference between two captures as a prefilter override.

`presetParam` (the only `$.ajaxPrefilter` in the pinned set, installed once from `verifySession`)
writes exactly three things, per request: `Authorization: Bearer <session token>` (only when the
caller did not set one), `agentID`, and `agentOwner`. It never writes `customerID`, `RRO` or
`operation` — those are caller-owned on every endpoint, so a `customerID` of `0` in one call and an
agent login in another is two callers, not two prefilter paths. The prefilter's rule, exactly:

- gate: `t.url.slice(0, 10) === "/cloud/api"`, evaluated **after** `t.url.replace("qubic", "cloud")`
  (`apiPath` is `/cloud/`, so the rewrite is what makes legacy `/qubic/api/…` URLs pass);
- body injection needs `sessionStorage.MASTER_ID !== ""` **and** `agentType ∈ {M, A}`; a player
  session gets the bearer and no body fields;
- `agentID := MASTER_ID`, always;
- `agentOwner := MASTER_ID`, replaced by the body's `agentID` when present, and replaced again by
  the body's `agentOwner` **only when the body also carries an `agentID` that it differs from**. A
  caller that sends `agentOwner` alone has it overwritten with `MASTER_ID`; to make the wire carry a
  different `agentOwner` the caller must send both fields, and its `agentID` is then replaced with
  `MASTER_ID` while `agentOwner` survives.
- `0 === r` (the "master is 0, adopt the caller's agentID" fallback) never fires: `r` comes from
  `sessionStorage`, always a string, so `0 === "0"` is false. The intended check is
  `!r || r === "0"`. `MASTER_ID` is written from the login payload (`sessionStorage.MASTER_ID =
e.ID`) or set to `""` for a player session, so `"0"` is reachable only if the portal issues `0`
  as an account id — and then it flows into `agentID` unmodified.

Consequence for a proxy: the gate is a ten-character **prefix**, not a parsed origin or an endpoint
allowlist, so a request re-pointed at `/api/…` loses the bearer as well as the body fields, and it
loses them silently. Keep the `/cloud/api` prefix, or compose the headers and body client-side — and
note that "compose client-side" is a second implementation of security-relevant injection, which is
the risk to weigh. A prefilter installed after `presetParam` runs after it (both live in jQuery's `*`
bucket, which is registration-ordered) and can redirect while keeping the injected body; the proxy
target must stay same-origin for that to be the same request.

What this does not answer, and the pins that would: `app/sports/score/score.js` and
`app/sports/report/pending.js` are not in the pinned set, so (a) what `score.js` does with the
`{accountInfo}` argument it is given, and (b) who writes `customerID` in the Pending caller, are
open. Both are now in `pinned/fetch-pinned-bundles.sh` and `fetch:pinned-portal`; a run prints their
hashes to pin, and the reads then answer those two questions the same way.

---

## P7 — captures that are not needed (reconcile spec to code instead)

These local daemon routes are served by `sportsdesk_webview_server.ts`; the handler is the contract. The
spec is missing parameters/response fields and should be corrected from source:

| Operation                   | Handler                                               | Spec drift to fix                                                         |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /health`               | `sportsdesk_webview_server.ts:810-830`                | add `url`, `timestamp` to the response                                    |
| `GET /api/watchlist`        | `sportsdesk_webview_server.ts:1674-1684` + `:156-175` | add 401/503 responses from `adminRejection`                               |
| `POST /api/telegram/alert`  | `sportsdesk_webview_server.ts:1687-1712`              | document the admin-token gate                                             |
| `POST /api/telegram/report` | `sportsdesk_webview_server.ts:1715-1735`              | add the `?type=` query parameter (enum `REPORT_TYPES`) and the `ok` field |

Also absent from the spec and documented from source only: `GET /`, `GET /dashboard`, `GET /miniapp`,
`POST /telegram/webhook`, `GET /api/telegram/status`, `GET /api/telegram/activity`,
`POST /api/telegram/webhook`, `OPTIONS` preflight and `GET /api/test/error` (see
[surfaces.md](./surfaces.md)).

The `/api/desk/*` routes cannot be captured: no implementation exists anywhere in the repo. They need
implementation first (`sportsdesk_webview_server.ts` has no `/api/desk` handler and 404s at `:299-307`).

## P7 — the customer report surface (7 candidates)

`lib/combo_identity.ts:24-40` names these from the deobfuscated `customer/report/report.js`. None has a
capture; they are published as tier C with no request or response content.

| Endpoint                                           | Used by                  | Required capture                                         |
| :------------------------------------------------- | :----------------------- | :------------------------------------------------------- |
| `POST /cloud/api/Report/Pending`                   | pending-bet modes        | one authenticated call + leg rows; confirm contentType   |
| `POST /cloud/api/Report/PendingDelete`             | ticket deletion          | one call on a test ticket; confirm the response envelope |
| `POST /cloud/api/Report/getDailyFiguresByCustomer` | 7-day P/L                | one call; confirm the figure row fields                  |
| `POST /cloud/api/Report/getGradedWagerByCustomer`  | Modes 8/10 (settled net) | one call + graded rows                                   |
| `POST /cloud/api/Report/getTransactions`           | Modes 8/10 (ledger)      | one call + ledger rows                                   |
| `POST /cloud/api/Report/getGrading`                | figure-date grading      | one call with a date filter + rows                       |
| `POST /cloud/api/Report/getTicketDetailPrint`      | ticket detail            | one call; confirm whether the response is HTML           |

`getGradedWagerByCustomer`, `getGrading`, `getTransactions` and `getDailyFiguresByCustomer` are the
settlement plane the operator runbook advertises; treat their current spec entries as candidates.

## Status after the 2026-10-31 live run

Captured live (tier A): `getWebLog`, `getInfoPlayer`, `getBetTicker`, `getBetTickerConfig`,
`getSportsVigSetup` — records in `captures/2026-10-31/`.

Still needed: `getPending` / `getInfoManager` / `getCustomerNotes` request templates (HTTP 500 with the
current envelope); a live **sub-sport/period** capture from the Ticketwriter/board surface; and the
remaining cloud operations (authenticateCustomer, updateByColumn, etc.). Live sports parity is checked
by `catalog:probe` (`getSportsType`, 19/19 identical to the fixture).
