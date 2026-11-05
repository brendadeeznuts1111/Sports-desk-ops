# Capture requests — SportsDesk / Fantasy402 docs release

Companion to [ledger.json](./ledger.json). Every item below states exactly what to capture, what is
currently claimed, and which ledger rows it would upgrade. Nothing here authorizes a live mutation:
capture read paths first, and treat every write capture as an operator-approved change on a controlled
account.

**Status of the release:** no operation has a captured response body. The only real wire artifact is the
2026-10-28 Manager HAR (portal `v1.0.279`), which recorded request headers and bodies for the Manager
calls but no response bodies. See `docs/runbooks/operational_guardrails_runbook.md:127-153`.

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

- modes A / C / I are inferred from the form (`docs/runbooks/operational_guardrails_runbook.md:131`);
- the response row schema is unpublished (`docs/runbooks/operational_guardrails_runbook.md:153`);
- the spec requires an `Authorization` header the capture never had. **Contradicted, re-read 2026-11-02:** `docs/openapi.json` now gives this operation `fantasy402Cookie` security and only the `XRequestedWith` parameter, so the spec no longer requires `Authorization`.

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
`path` field appears (it is deliberately omitted per `services/simulate_bettor_churn_suite.ts:135`), and whether
`Authorization` is accepted at all.

**Upgrades:** modes A/C/I from C→A; the response schema and auth claim move from _contradicted_ to
verified (or the spec is corrected). This is the single highest-value capture because it is the only
forensic endpoint the runbooks, the code and the spec all point at.

---

## P2 — `updateByColumn` mutation + `getInfoPlayer` read-back

Ledger rows: `POST /cloud/api/Manager/updateByColumn` (C), `POST /cloud/api/Manager/getInfoPlayer` (B,
tier A since 2026-10-31, so the example is superseded rather than contradictory). `docs/runbooks/operational_guardrails_runbook.md:215` states the only HAR does **not**
include `updateByColumn`, that the only observed padded ID is `Log/write`'s at **10** characters, and that
the **11**-character width must be confirmed by capture before anyone relies on it. The spec
publishes a 9-field body and `Result` 1/0/-1 semantics on no evidence. **Contradicted, re-read 2026-11-02:** `docs/openapi.json` now publishes no request body and only a `default` response for `updateByColumn`.

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
`docs/runbooks/operational_guardrails_runbook.md:153`) — record the actual `Cookie` header names plus the
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

**Two more feeds have repo wire types** — lower priority. `getPending` has no capture; `getBetTicker`
has a tier-A capture but no artifact of its cursor walk:

| #   | Operation      | Candidate URL / content type                                                                                                                                                                                                                                                                                                                      | What to capture                                                                                                                                                                                                                                              | Upgrades                                                         |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 13  | `getBetTicker` | `POST /cloud/api/Manager/getBetTicker`, form-urlencoded — the tier-A capture `docs/evidence/captures/2026-10-31/getBetTicker.post.json` records `application/x-www-form-urlencoded; charset=UTF-8` with `{agentID, agentOwner, wagerNumber, operation, RRO}`. A 2026-11-02 operator transcript claims `application/json`; unverified, no artifact | two consecutive nonzero-cursor pages (the cursor walk); the `INFO` object; whether the server accepts `wagerType=M` as a filter. The `wagerNumber=0` initial call is already covered: six discover runs (2026-11-01 01:53–04:19 UTC) returned the whole list | A (captured); the cursor walk is still unobserved as an artifact |
| 14  | `getPending`   | `POST /cloud/api/Manager/getPending` — **content type contested**: the spec says `application/json`, every other Manager call is form-urlencoded                                                                                                                                                                                                  | exact content type + one non-empty response; confirm `BLOCKED`/zero-stake sentinel rows actually appear                                                                                                                                                      | C→A                                                              |

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
`/cloud/api/Report/getAgentPerformance` (`docs/evidence/ledger.json:557-580`).

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
(`docs/evidence/ledger.json:575,2363`). The module deliberately describes no response either.

**What to capture.** One CP call and one CPS call with the fixtures' agent and date range, recording the
full response (status, content type, body), plus a zero-row case if the filter can produce one. Reconcile
against the screen's own grid header, not against a guess:
`tests/fixtures/portal-agent-performance-filterbar-2026-11-01.html:282-300` names **All Players and
Agents · Won · Lost · # of Bets · Risk · Net · Hold %age**. Those seven labels are markup, not a schema:
the JSON keys, their nesting, whether `holdPct` is computed server-side and how `BranchGrade` is applied
are all unknown until a body exists (`docs/evidence/ledger.json:575`). The 2026-11-01 workbook export is
not a substitute — it is wager-level with five columns (`data/graded-wagers-export-2026-11-01.json`).

**Upgrades:** B→A. Until then no markdown may publish a result column set for this report.

## P5b — observed writes: the Vip List save and the ticker config save

Neither write surface has a ledger row. Both were observed on 2026-11-01, neither has a response schema,
and both mutate live state — one VIP-list entry on a customer, one desk setting. They are recorded so the
wire shape is not lost and a future capture has a target; they are not calls this repo makes.

**A Vip List save is three requests, and all three are mutations.** The `show-vip` panel
(`docs/evidence/surfaces.md:410-417`) sends, in order:

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

The sequence is pinned in `tests/f402_observed_requests.test.ts:401-501`. Its point is that one save uses
two encodings — JSON, form, JSON — so a client assuming one content type breaks on the middle call.

**None of the three is replayed in this repo.** No code path sends the recorded bodies: production is
read-only unless the task is explicitly a deploy, and a VIP entry is live customer state
(`tests/f402_observed_requests.test.ts:402-408`,
`tests/fixtures/f402-report-requests-observed-2026-11-01.json:188`). One caveat keeps that claim exact:
`lib/f402_probe.ts:400-414` registers `Log/write` as a non-read-only probe, selected only under
`--include-unconfirmed`, which the capture CLI also gates behind `--i-understand-mutations`
(`scripts/capture/f402_probe.ts:370-375`). That probe builds its own body; it never replays the observed
one.

**The acknowledgement `{"INFO":""}` was observed, and it is an empty string.** The paste recorded the
body but not which of the three calls answered it, so all three remain candidates. An empty `INFO` proves
only that the write ack carries no payload; it is **not evidence of success**. The portal acknowledges
writes without inspecting results elsewhere (`updateBasicSettings` assigns local state from the values it
sent), and this is a different envelope from the ticker config's `INFO` object under the same key
(`docs/evidence/surfaces.md:425-432`). Success semantics are unestablished — a capture that shows a
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
(`tests/fixtures/f402-bet-ticker-config-2026-11-01.json`; `lib/f402_bet_ticker_config.ts:2-20`). The read
is the tier-A row #1 in §P5; the `INFO:false` misconfigured variant is still unobserved, and a write
capture is not that. Sending this write changes the desk's ticker, so it needs an operator-approved
change on a controlled account — the repo's builder deliberately never calls it
(`lib/f402_bet_ticker_config.ts:18-19`).

## P6 — the 11 "Tracked Operational Domains" candidates

Ledger rows: the 11 `POST /cloud/api/...` operations tagged `Tracked Operational Domains` (all tier C,
`candidate_url: true`, `ui_observed: true`). Their path+method come from hand-authored constants in
`scripts/portal_tile_crawler.ts:55-206`; the crawler's CLI
entry runs the `offline` branch (`scripts/portal_tile_crawler.ts:693,777`) and never records network traffic.
The former post-processor draft (`append_tracked_domains.mjs`) was removed: it mutated the generated
spec and reference outside the ledger, duplicated this table, and failed the docs gate.
The markdown table calls them "Target Wire Endpoint", which is an overclaim. **Contradicted, re-read 2026-11-02:** `docs/api-reference.md` no longer contains that label.

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

### `getBetTicker`: paginated by cursor, and the type filter misses most of it

Observed 2026-11-02 (operator transcript — one 100-row page, no artifact):

- **Pagination is backward from a cursor.** `LIST` holds 100 rows in ascending `WagerNumber` order
  (`767174209 … 767174452`) while the request carried `wagerNumber=767177348`, a number above every
  row in the response. So the cursor means "the 100 wagers before this one", not "after". Ingest is
  therefore at least two passes — walk back from the highest known cursor, then forward from the
  last row — not one request per scope. The initial `wagerNumber=0` call is not one of those pages:
  six `scripts/capture/discover_customers.ts` runs (2026-11-01, 01:53–04:19 UTC; gitignored
  summaries under `scratch/f402-discover/*/getBetTicker.json`) returned 449–955 rows each, never
  100, so it answers with the whole current list and only nonzero cursors page. `/api/live-wagers`
  serves the newest valid saved list (`data/bet-ticker.json` or `data/live-wagers.json`), so it
  inherits whatever that file captured.
- **`L` is not "live", and neither is `M`.** A later page (2026-11-02) carries `M.LIVE #9263
Eagles (Live) -160 - For Game`, `S:LIVE #9540 Warriors (Live) -2½ -115` and
  `L:LIVE #9263 … O 42½ -110`, plus `L.Soccer #209857 … - For Game` with no live marker at all. So
  the type code is a bet shape (`S`/`P`/`M`/`L`) and the live/pregame split lives in the
  `LIVE`/`(Live)` token of `ShortDesc`. `parseShortDesc` now returns `isLive` per leg and per wager,
  and `summarizeLiveWagers` reports `live`/`pregame` counts and risk. Before that, the live shorthand
  did not parse at all — the whole string landed in `sport`.
- **Alert rows shadow real rows.** Every `TicketWriter: "ALERT"` row observed carries
  `VolumeAmount: 0`, and each has a near-twin moments later on `Internet`/`GSLIVE` with the same
  customer and the same selection (`767173499` ALERT `S:LIVE #9264 Commanders -2½ -140` beside
  `767173506` Internet, same market; likewise `767173587`/`767173589`, `767173632`/`767173635`). They
  are distinct `WagerNumber`s, so summing both double-counts stake. One pair even changes type
  (`767173600` is `P`, its Internet twin `767173602` is `M`), so the type is not stable across a
  pair either.
- **`ShortDesc` carries the game id.** `G319807248` on the code line, `#9263`/`#209857` inline for
  live and compact lines; both are now `gameNumber`, which is what a score join would need when the
  league is absent.
- **`WagerType` includes `M` and `L`, which the portal's own filter does not offer** (`S`, `P`, `I`,
  `T`, `G`, `A`, `C`, `N`). In the page: `M` ~11, `L` ~7, `S` ~5, `P` ~1 — so the UI's "Straights"
  filter hides roughly 70% of the rows. `M` is carried as a raw code here (`lib/live_wagers.ts:12-14`,
  "no documented meaning… carried as a raw code rather than guessed"); `L` was not in the committed
  17-row artifact at all. The coverage gap is upstream, not in this repo: `/api/live-wagers?type=M`
  filters exactly, and the dashboard builds its type chips from `summary.byType`, so `M` appears
  there without a code change.
- **One `ShortDesc` carries three line-break encodings**: `\r\n` after the game id, `&#x0D;` after the
  odds, `\n` at the end. `parseShortDesc` already normalises all three (`.replace(/&#x0D;?/gi, "\n")`)
  and returns one leg with `descCode: "M.G319813019"`; the committed artifact exercises it —
  14 of its 17 rows contain `&#x0D;`.
- **Padding is per field**: `AgentLogin`/`CustomerID`/`VIP`/`TicketWriter` are space-padded,
  `AgentID` and `Login` are not; `AgentID` also carries trailing periods (`GB3500.`) where the login
  does not. So the join key is the trimmed **login**, never `AgentID`.
- **Trailing punctuation is real.** `RM11.` and `CONNOR.HAD` are tree keys; a normaliser that strips
  trailing dots mangles them. `agentLoginKey` only trims, which is why the tree keeps both.
- `CustomerID` and `Login` are not interchangeable: `MM1023_0` marks a child account of `MM1023`
  (`_0` suffix), and one row shows `CustomerID: "GB57 "` with `Login: "GB57 "` (space kept) while
  another strips an `_0`. Treating the two as one key collapses sub-accounts into their parents.

### `getAccountInfoOwner`: the enrichment payload, and what it says about identity

Observed 2026-11-02 for `BILLY666` (operator transcript; no secrets — `Password` is empty):

- **`AgentID` is `null` on a master account.** `AgentType: "M"`, `customerID: "BILLY666"`,
  `AgentID: null`, `Office: "NOLAROSE"`. So the agent id is not the identity of a top-level account:
  anything that keys on `AgentID` drops it, and the login is the only join key. This is the same
  conclusion the ticker reached from the other side (`AgentID` carries trailing periods the login
  does not).
- **Padding, again**: `Login: "BILLY666  "` (padded to 10) while `customerID` is not padded;
  `Store`, `CustProfile`, `ParlayName`, `NameFirst` and `PlayerName` are space-padded too.
  `Password: ""` and `PasswordFix: "‡"`.
- **`AgentMenuStyle: "Tile Menu"`** is the value that selects the deferred hierarchy load in
  `settings()` (`setTimeout(getCompleteHeriarchy, 500)`), so it is the switch that decides when the
  tree is fetched at all.
- **The live flags disagree with each other**: `DenyLiveBetting: "Y"`, `AllowNewLiveBetting: "N"`,
  `AllowUltraLive: "Y"`, `WSBettingType: 1`, `WSBettingTypeMobile: 1`. Whether a ticker row's `L`
  type is "live" in the sense these flags govern is unresolved — do not read `L` as live betting
  until one page is checked against this account's flags.
- `site: []`, `preferenceDate[0].isTickerDisplayAlready: "true"`, `SERVER.date` in the portal's
  `YYYY-MM-DD HH:mm:ss.SSS` form. The `test` field is an epoch-second counter, not a status field.

**Padding is not consistent per endpoint, so trim both sides.** Measured on the 17-row ticker
artifact: `CustomerID` is padded in 15 rows and clean in 2; `Login` is padded in 6 and clean in 11;
`AgentID` is never padded but can carry a trailing period (`GB3500.`); `AgentLogin` is padded in 7.
In the account-info response it is the other way round — `customerID` is clean and `Login` is padded
to 10. So "join on Login in the ticker, customerID in accountInfo" is wrong as a rule: the same
column is padded in some rows and clean in others on _both_ endpoints. `trim()` on both sides, and
`AgentID` needs period tolerance rather than trimming.

**The anchor is a fixture now, and its timestamps are Eastern.** `tests/fixtures/f402-account-info-billy666-2026-11-02.json`
carries the observed fields plus the timestamp trio, so the pipeline can import it instead of
quoting prose. The trio settles the timezone: `test` is `1793589916` = `2026-11-02T03:25:16Z`, and
`SERVER.date` is `2026-11-01 22:25:16.233` — exactly five hours earlier, i.e. the same instant at
UTC−5. So **server timestamps are Eastern and printed without a zone**, and `TimeZone: 1` applies to
them as well as to `GameDateTime`; reading either as UTC shifts every row by five hours.

**`Spread` belongs to `Team2ID`, and `Favorito` is the cross-check.** Both observed score games fit
that: Clippers vs Warriors `Spread -2` with `Favorito` the Warriors (Team2), and Eagles vs
Commanders `Spread -5.5` with `Favorito` the Commanders (Team2). A "Favorito decides the sign" rule
also fits those two rows, and the two rules agree — but they would diverge if Team2 were the
underdog, so `lib/game_line.ts` takes the one-field reading and returns `agrees` so a disagreement
surfaces instead of being resolved by whichever rule ran first.

**`lineValue` is `wagerLine − currentSpread`, positive = the bettor got the better number.** The
example row is the negative case on purpose: Eagles +3.5 held, market at +5.5, so `lineValue = -2`.

**Scope checks the enrichment pass can run without a probe.** From the anchor account
(`Office: NOLAROSE`, `Store: PPHINSIDER`, `customerID: BILLY666`, `AgentID: null`):

- _out of scope_ — an agent whose (Office, Store) differs from the anchor's is a cross-office row in
  the ticker, which is a finding; it is annotated, never filtered.
- _second root_ — `AgentID: null` on an account that is not the anchor means the session is reading
  another subtree, not a child record. The three tree roots would look the same if they ever appeared.
- _root wager_ — a wager filed under the anchor's own login is either mislabelled or placed from a
  channel an agent account does not have.
- _live flag_ — `WagerType: L` must be checked against the **customer's** `DenyLiveBetting`, not the
  agent's: the flag governs the account it is set on, so comparing it to a player's wager is a
  category error. `lib/scope_checks.ts` takes the customer's account info and returns nothing when
  only the agent was enriched, rather than inventing a finding.

One enrichment call serves every wager from the same agent — 22 distinct agents in the 100-row page,
not 100 calls.

**A WebView profile is not a session.** This machine has neither, so nothing portal-facing can run —
but the distinction matters for the next one. `F402_WEBVIEW_PROFILE` names a `Bun.WebView` `dataStore`
directory, and after a sign-in it does hold the cookies; `createF402ReplayTransport()` still never
reads it (`lib/f402_replay_transport.ts:2-3`), because `Bun.FetchSession` has no dataStore. So a
profile alone sends a cookie-less request, and `capture_pending_full.ts` used to count it as
configured — silencing its own "no session" guard and then 401ing upstream. That guard now requires a
session file or the replay proxy.

The bridge now exists as **`bun run session:login --from-profile <dir>`**: it opens that profile in a
headless WebView, reads the cookies over CDP (`Network.getAllCookies`), and writes the 0600 session
file the transport reads (`lib/f402_profile_session.ts`). A credential login (`F402_LIVE_LOGIN=1`,
`F402_AGENT_ID`, `F402_PASSWORD`) still works for a profile-less machine, and `bun run session:status`
reports what the transport would use without printing a cookie value. The hierarchy CLIs' `--profile`
is now deprecated and ignored — they warn and name the bridge instead — and their 401 hint points at
`session:login --from-profile <dir>` rather than at `F402_WEBVIEW_PROFILE`. That is the step that turns
a signed-in WebView into the auth every capture and crawl needs.

**Provenance: this account is not in the tree.** `BILLY666` is absent from `data/agent-tree.json`
entirely, and so is its office `NOLAROSE`; the tree's roots are `BILLY667`, `NOLAWOLF`, `RTEST5`
and `SAINTS2009`, and it carries `NOLAROB`/`NOLAROBPPH` but no `NOLAROSE`. The tree was therefore
built from a different login than the one behind these request captures, and every cross-endpoint
join done against it describes a different downline. That does not invalidate the tree — it makes
"which session produced this artifact" a required field on any comparison between the two.

**The ticker is a second witness to who exists, and it disagrees with the tree.** Of 25 distinct
`AgentLogin` values in the page, 22 are tree keys; `GB3500.` is the trailing-period variant of
`GB3500`; **`KOBE8` and `CUB22A` are absent** (`CUB22` exists, so `CUB22A` looks like an uncaptured
child). Two missing of 25 sampled is 8%, against 9.2% of tree edges skipping a level — the same
order, from two independent directions, which is why the `+2` edges read as missing nodes rather
than a stale level field. `bun run ticker:coverage <page.json>` diffs any page against the tree and
reports nearest keys as hints (never as a join — `CUB22A` is not `CUB22`).

**Reading the pinned bundles.** `manager.js`, `security.js` and `util.js` are single-line minified
files (`wc -l` = 1), so there is no line number to cite: every `file:NNNNN` reference to them —
including the ones in this repository's own ledger — is a **byte offset**, not a line. Cite them as
`file#symbol @offset`; the symbol is the part that survives a version bump.

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

**What `MASTER_ID` and `agentType` actually are** (same pinned read, 2026-11-02). The body gate is a
login-state gate, and both of its operands have a writer:

- `sessionStorage.agentType` is set in `security.js` at the master/agent branch of
  `authenticate_normal` (`sessionStorage.agentType = e.accountInfo.AgentType`), i.e. to `"M"` or
  `"A"` for exactly those accounts; the `default:` branch sets `customerID`, `playerID`, `token`,
  `office`, `language`, `skin` **and** writes `MASTER_ID = ""` / `agentType = ""`. So the `""` pair
  is the **player-login** state, not a logged-out one: it is written by that branch, not inherited
  from a logout. Logout is a full `sessionStorage.clear()` (`security.sessionDestroy`, called by
  `manager.logOut`), which removes every key rather than resetting three. The gate is therefore
  live for master/agent logins, and both of its operands are false for a player login.
- `e.ID` is not an account field. The module prototype defaults `ID: 0, MASTER_ID: 0`;
  `init` fills `ID` from `sessionStorage.customerID` only when it is still `0`; `setAccountInfo`
  writes `ID` from its **caller** (`getAccountInfo` passes `ID: o.id`, the requested id — the
  response carries `customerID` and `Login` and has no `ID` at all, so the value round-trips rather
  than being derived); and selecting an agent in the hierarchy reassigns it (`ID` ≠ `MASTER_ID` is
  how the UI knows it is viewing a sub-agent). `MASTER_ID` is a **snapshot** of `ID` taken when the
  menu is built, written to the instance and to sessionStorage in the same statement.
- So `sessionStorage.MASTER_ID === "0"` means "identity not resolved yet", not "account 0", and it
  is reachable only if the snapshot runs before `init`/`setAccountInfo` has filled `ID`. In that
  window the prefilter writes `agentID: "0"` and the dead `0 === r` fallback does not rescue it.
  It is an ordering window, not the steady state.
- The two copies (`__proto__.MASTER_ID` and `sessionStorage.MASTER_ID`) are written together from
  the same value and no pinned code writes one without the other; the drift that matters is `ID`
  versus `MASTER_ID`, which is intentional. Logout (`sessionStorage.clear()` from `sessionDestroy`)
  empties storage but cannot reach the module instance, which is discarded with the page.
- `customerID: "0"` in a Pending body is a separate sentinel: `customerID` is never written by the
  prefilter, and nothing links it to `MASTER_ID`.

**Two windows where identity is present in one form and absent in the other.** Both are reachable
without a hostile client, and both are unresolved server-side:

1. _Menu built before identity resolves._ `MASTER_ID` is snapshotted from `ID` (`manager.js#settings @28850`),
   and the prototype default is the number `0`; `init` and `setAccountInfo` fill `ID` afterwards.
   If the snapshot wins the race, storage holds `"0"` and the prefilter emits `agentID: "0"` /
   `agentOwner: "0"` for that request. The module knows this state exists — the icon check at
   `manager.js#settings @28200` compares against the numeric default (`0 !== e.MASTER_ID`) and renders
   correctly — but the prefilter's `0 === r` compares a number to the string `sessionStorage` hands
   back, so its fallback does not fire. Same scenario, two readers, one correct.
2. _A session with no master, and the 300 ms after logout._ The body gate is `"" !=
sessionStorage.MASTER_ID && agentType ∈ {M, A}`, while `Authorization` is set by the
   `/cloud/api` branch _before_ that gate. Two ways to be in it:
   - **Player login.** `authenticate_normal`'s `default:` branch writes `MASTER_ID = ""` and
     `agentType = ""` (`security.js#authenticate_normal @18164`) and still sets a token, so every
     `/cloud/api` request from that session is authenticated with no agent scope. This is a
     steady, designed state, not a race — and it means the server must already have a policy for
     an un-scoped bearer, which is why "defaults to the bearer's owner" is the likely outcome.
   - **Logout.** `manager.logOut` calls `sessionDestroy()` (`sessionStorage.clear()`) and then
     redirects after `setTimeout(…, 300)`. `clear()` removes `sessionStorage.token`, but the
     prefilter closes over the module instance and reads `e.token` from memory, which
     `sessionDestroy` does not reset — so a request in that 300 ms carries the previous bearer
     with storage already empty. The width of the logout window is that `setTimeout` delay; the
     player state has no width.

**The hierarchy drill-down is the window, and it is entered on every selection.** The mechanism,
from the pinned reads (offsets, since the file is one line):

1. A tree node is clicked: `r.write({customerID: t.ID, description: "Select agent / Hierarchy Tree /
Account : " + e}), … t.getAccountInfo({ id: e }), t.__proto__.ID = e` (`manager.js @65556`,
   `@73488`, `@75445`). `ID` becomes the selection immediately, and the audit entry names the
   **previous** agent as actor with the selection in the description — actor semantics, not a bug.
2. `getAccountInfo` posts `{agentID: o.id, operation: "getAccountInfoOwner"}` (`@~23600…`), so the
   prefilter rewrites that request to `agentID = MASTER_ID` (the account), `agentOwner = <selection>`.
   **The drill-down's own account-info fetch therefore depends on the server honouring
   `agentOwner`.** If the server keyed on `agentID` alone, selecting a node could never fetch that
   node's account info, and the tree would not work at all. That is a consistency argument from the
   client, not an observation of the server — but it narrows the server question to "does it
   authorise the pair, or just use `agentOwner`".
3. The response calls `setAccountInfo({info, ID: o.id, …})`, which sets `ID` again and then calls
   `settings()` (the call site is inside `setAccountInfo`, `@24699`); `settings` writes
   `MASTER_ID := ID` and mirrors it to sessionStorage (`@28850`).

So `MASTER_ID` lags `ID` for exactly one `getAccountInfoOwner` round-trip after **every** drill-down,
not only at login. During that round-trip the 30 s poll and any click-driven request are scoped to
the previous agent. Two things bound the damage and neither is a guarantee: the poll period (up to
30 s of stale next to a fresh header), and the agent-management icon, which is **hidden while the
two differ** (`@28200`: differ → `hide()`, equal → `show()`) — visible as a flicker for one
round-trip, useless as a warning.

Server behaviour for either window is unverified: reject, default-to-the-bearer's-owner, or a
wildcard are all compatible with the code. One live session, three requests, one diff each:

|     | request                                                                                                             | distinguishes                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| R1  | `{operation}`                                                                                                       | baseline                                                        |
| R2  | `{operation}` + `agentID`/`agentOwner` pair (both are required for the override; `agentOwner` alone is overwritten) | whether the server binds on `agentOwner` or on the bearer       |
| R3  | `{operation}` fired between login and account-info render                                                           | whether `agentID: "0"` is a wildcard, a rejection, or a default |

R2 and R3 are independent — a server can bind on `agentID` and still treat `"0"` as a wildcard if it
only checks for non-null, which is the worst combination: override closed, window open.

**Open: which field each endpoint scopes on.** Nothing above records whether `Report/Pending`,
`getScoresLiveDynamic` or the drill-down's `getAccountInfoOwner` binds on `customerID`, on the
prefilter's `agentID`/`agentOwner`, or on both. The drill-down is the constraint: its request is
rewritten to `agentID = <account>, agentOwner = <selection>`, so any endpoint that must return the
selection's rows has to honour `agentOwner`. That makes "the tree works" and "the `agentOwner`
override is honoured" the same observation — one request settles both — and it is the first row of
the probe below for every endpoint the tree drives.

---

## P7 — captures that are not needed (reconcile spec to code instead)

These local daemon routes are served by `sportsdesk_webview_server.ts`; the handler is the contract. The
spec is missing parameters/response fields and should be corrected from source:

| Operation                   | Handler                                                              | Spec drift to fix                                                         |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /health`               | `services/sportsdesk_webview_server.ts:1483-1502`                    | add `url`, `timestamp` to the response                                    |
| `GET /api/watchlist`        | `sportsdesk_webview_server.ts#GET /api/watchlist` + `adminRejection` | add 401/503 responses from `adminRejection`                               |
| `POST /api/telegram/alert`  | `services/sportsdesk_webview_server.ts:3199-3224`                    | document the admin-token gate                                             |
| `POST /api/telegram/report` | `services/sportsdesk_webview_server.ts:3227-3247`                    | add the `?type=` query parameter (enum `REPORT_TYPES`) and the `ok` field |

Also absent from the spec and documented from source only: `GET /`, `GET /dashboard`, `GET /miniapp`,
`POST /telegram/webhook`, `GET /api/telegram/status`, `GET /api/telegram/activity`,
`POST /api/telegram/webhook`, `OPTIONS` preflight and `GET /api/test/error` (see
[surfaces.md](./surfaces.md)).

The `/api/desk/*` routes cannot be captured: no implementation exists anywhere in the repo. They need
implementation first (`services/sportsdesk_webview_server.ts` has no `/api/desk` handler and 404s at `services/sportsdesk_webview_server.ts:3279-3287`).

## P7 — the customer report surface (7 candidates)

`lib/combo_identity.ts:30-48` names these from the deobfuscated `customer/report/report.js`. None has a
capture; they are published as tier C with no request or response content. **Contradicted, re-read
2026-11-02:** `Report/Pending`, `Report/getGrading` and `Manager/getTransactions` are now tier A on
committed captures; the other four are still tier C.

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
