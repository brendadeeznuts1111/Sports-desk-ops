# Evidence standard — SportsDesk & Fantasy402 docs release

Machine-readable source of truth: [evidence/ledger.json](./evidence/ledger.json). Capture plan:
[evidence/capture-requests.md](./evidence/capture-requests.md). Surface inventory:
[evidence/surfaces.md](./evidence/surfaces.md).

This file exists because a prior audit found fabricated and overclaimed contracts in the published docs.
The rule for this release is simple: **a claim is only presented as a contract when an artifact supports
it.** Everything else is labelled as observed, inferred or unimplemented — in the spec and in the markdown.

---

## Legend

| Tier  | Meaning                                                                                                                                                                                                      | Count       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| **A** | Captured wire contract: a real request **and** a real response capture exist.                                                                                                                                | 11          |
| **B** | Observed first-party evidence: a captured or operator-recorded wire request, an observed request payload, or a route this repo serves verified against its handler source. Response may still be uncaptured. | 15          |
| **C** | Inferred only: authored in the spec/generators, a repo TypeScript wire type, or a UI/DOM observation whose URL+method is a candidate. No request or response observed.                                       | 29          |
| **D** | A real surface recorded in `surfaces[]`, never in `operations[]`. Most of its routes are now published in the spec.                                                                                          | 20 surfaces |
| **E** | Documented operation with no implementation in this repository.                                                                                                                                              | 10          |

**Operations:** the ledger has 65 rows = 62 paths (`/api/desk/auth/session` carries both `POST` and
`DELETE`): A 11 + B 15 + C 29 + D 0 + E 10 = 65. The published spec has **87 paths / 89 operations**
(`scripts/audit_docs_webview_cron.ts`): the 52 ledger paths that are not reserved — 65 rows minus the
10 tier-E rows and the blocked `/manager-tools/ajax.php` row — plus the 35 routes recorded only as
`surfaces[]` members (34 daemon routes and `POST /cloud/api/Manager/getHistory`).
**Surfaces:** 21 rows (D 20, E 1). Surface counts are kept separate from operation counts.

**Tier A comes from two live sessions.** The 2026-10-31 run (Bun.WebView login → portal JWT handoff →
Bun.FetchSession replay) captured five Manager responses: `getWebLog`, `getInfoPlayer`, `getBetTicker`,
`getBetTickerConfig`, `getSportsVigSetup`. The 2026-11-01 probes added three:
`POST /cloud/api/Report/Pending` (41 KB), `POST /cloud/api/Manager/getTransactions` and
`POST /cloud/api/Report/getGrading`. `docs/evidence/captures/manifest.json` records 15 live captures:
11 with a 2xx status and 4 with an empty 500.

**A 200 is not a payload.** Four of those bodies are empty envelopes: `getWebLog` returned an `INFO`
string with an empty `LIST`, `getInfoPlayer` returned `{"INFO": null}`, and `getTransactions` and
`getGrading` returned `{"LIST": ""}`. The generated schemas describe exactly that envelope, so no row
field and no `Result` body has been seen for those rows. Tier A means the response was captured, not
that it was populated.

**Three requests still have no response.** `getPending`, `getInfoManager` and `getCustomerNotes`
returned HTTP 500 with the 2026-10-31 request template (the requests themselves were recorded), so they
stay tier C. The live pregame sports list is separately probed (`getSportsType`, 19/19 sports identical
to the fixture) — see [evidence/pregame-catalog.md](./evidence/pregame-catalog.md).

**B-vs-C rule for the 11 "Tracked Operational Domains" candidates.** A launcher tile is not enough for B.
B requires a URL+method observed on the wire (or a handler that serves it). The 11 candidates take their
path+method from hand-authored `candidateEndpoint`/`candidateMethod` constants
(`scripts/portal_tile_crawler.ts:40-162`); the crawler CLI entry runs its `offline` branch
(`portal_tile_crawler.ts:670,680`) and its live branch only replaces extracted inputs/L-keys, never the URL or
method; no audit JSON or screenshot proof exists in the tree. They are therefore **C with
`candidate_url: true`**, not B. `getAnalysis` and `getFinancialReport` also have independent UI action-name
evidence (`runbook:166-167`), but the URL is still unobserved.

---

## Claim categories (reviews and docs)

Every claim in a review, a runbook or a doc names its basis. Only the first two may support a bug claim.

| Label          | Basis                                                                                                                | Can support a bug claim?                    |
| :------------- | :------------------------------------------------------------------------------------------------------------------- | :------------------------------------------ |
| `[CODE]`       | Reproducible from source in this repository.                                                                         | Yes                                         |
| `[OBSERVED]`   | A capture or artifact with a date and a path.                                                                        | Yes                                         |
| `[UNVERIFIED]` | External-system behaviour inferred from docs, deobfuscated client JS, a third-party toolkit, or absence of evidence. | **No.** Label it "unverified — check this". |
| `[ASSUMPTION]` | A modelling choice about data (sign convention, ownership, window).                                                  | **No.** State it next to the formula.       |

Two rules follow:

1. **An API shape is not a fact because several secondary sources agree.** Without a capture it is
   `[UNVERIFIED]`, even when three toolkits describe it the same way.
2. **Separate the bug from the theory.** "This code path divides by `lifetime_net_usd` without a zero
   guard" is `[CODE]`. "The upstream returns `net` from the desk's perspective" is `[ASSUMPTION]` and
   belongs in a doc note, not in a bug report.

---

## What is actually verified

**Captured on the wire (request side only), 2026-10-28 Manager HAR, portal `v1.0.279`:**

1. `POST /cloud/api/Manager/getWebLog`, mode B. Exact request line, headers, and form body:
   `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, `X-Requested-With: XMLHttpRequest`,
   `agentID=<session>&customerID=0&start=10%2F28%2F2026&end=10%2F28%2F2026&type=B&actions=ALL&ip=&operation=getWebLog&RRO=1&agentOwner=<session>`
   (`operational_guardrails_runbook.md:129-140`). **No response body.**
2. `POST /cloud/api/Manager/getInfoPlayer`: the read sent a **7-character trimmed** `customerID`, and
   `agentID`/`agentOwner` were the logged-in master on all 19 Manager calls in the capture
   (`operational_guardrails_runbook.md:213-214`). **No response body.**

**Verified against implementation** (the route exists and its handler defines the contract — no HTTP
capture needed): `GET /health`, `GET /api/watchlist`, `POST /api/telegram/alert`,
`POST /api/telegram/report`. The handler source is `sportsdesk_webview_server.ts`; see
[surfaces.md](./evidence/surfaces.md) for the daemon routes and the evidence behind them.

**Observed, not verified:** the Manager search UI component (`runbook:205-209`); the Reporting action names
`get-agent-performance` with `data-type="C"`, `get-settled-figure`, `delete-wager`, `get-analysis`,
`get-transaction-history` (`runbook:157-168`); the GS `getBetReport` request payload
(`zip:contracts/get-bet-report.observed.json`); the 11 launcher tiles.

**Observed on the wire, 2026-11-01 (requests only):** six requests kept in
`tests/fixtures/f402-report-requests-observed-2026-11-01.json` — `getAgentPerformance`, `getGrading`,
`getSubSportByReport`, and the three writes behind a Vip List save (`vipListInsert`, `Log/writeDetail`,
`Log/write`). The paste records no response for `getAgentPerformance` or `getSubSportByReport`; its only
response body is the `{"INFO": ""}` ack for one of the three writes, and it does not say which.
`getGrading` has a separate capture, and the writes are never replayed. The Analysis report is
`POST /cloud/api/Manager/getAgentPerformance`: three calls observed (two CP, one CPS), form-urlencoded,
`type=CP` or `type=CPS`, with `tipo` 0 for CP and -1 for CPS.
`lib/f402_agent_performance_request.ts` rebuilds every recorded body byte-for-byte (all-periods,
filtered CP, CPS) and deliberately describes no response, because none was ever seen. That removes the
old "the report path is inferred from the action name" caveat: only the response is missing now.

**Other artifacts in the tree (shape samples and pastes, not captures):**

- `data/graded-wagers-export-2026-11-01.json` — the shape of a Graded Wagers Excel export: five columns
  (Customer, Ticket Number, Accepted, Description, Amount) and 9,387 rows. The workbook itself is not
  committed, because every row carries a login and a ticket number.
- `tests/fixtures/f402-bet-ticker-config-2026-11-01.json` — one `updateBetTickerConfig` write (never
  replayed) plus the `getBetTickerConfig` read-back. Records that the wire names buckets by upper bound
  (`play499`) while the response names ranges (`play1-499`), that the response pads `AgentID` to 50
  characters where the request sends it unpadded, and that an enabled bucket reads `"on "` with a
  trailing space.
- `tests/fixtures/portal-agent-performance-filterbar-2026-11-01.html` — the Analysis filter bar and
  results header as rendered; the artifact `lib/analysis_filters.ts` is checked against.
- `tests/fixtures/portal-agent-tree-sidebar-2026-11-01.html` — the rendered Agent Tree sidebar: one
  root injected from the session and four children at `data-level="1"`.
- `tests/fixtures/f402-report-requests-observed-2026-11-01.json` — the six requests above, three of them
  writes, plus the `{"INFO": ""}` write acknowledgement.

Each is an operator paste or a transcribed shape: none carries a status code, and the only response bodies
in the set are the ticker config the read returned and the `{"INFO": ""}` write ack. `bun fmt` normalises
their whitespace, so their line breaks and indentation are not evidence.

**Inferred — everything else:** any request body the captures and pastes never sent, any response field
the captured skeletons never exercised (row payloads inside an empty envelope, every `Result` body),
every status code other than the recorded 200s and 500s, auth beyond "the observed Manager requests
carry a cookie and a redacted `authorization` header", and the entire `/api/desk/*` surface (which has no
implementation at all).

---

## Capture tooling (live runs 2026-10-31 and 2026-11-01)

Live capture is implemented and gated behind `F402_LIVE_CAPTURE=1` plus credentials in `.env` (never argv).
It records an authenticated request and the live response as a value-free capture record — sha256 plus a
schema skeleton, a redaction report and provenance — under the live-only store
`docs/evidence/captures/` (mock fixtures stay in `tests/fixtures/captures/`). The 2026-10-31 run captured
six read-only Manager responses on 2026-10-31 and five more on 2026-11-01, which is why tier A is 11. The store
holds 15 live captures (`docs/evidence/captures/manifest.json`); a 2xx with an empty envelope still counts
as a captured response, which is why six tier-A rows publish no row schema. `scripts/apply_captures.ts` is the
only sanctioned upgrade path: dry-run by default, B/C→A, and it refuses mock, redaction-dirty,
response-less and mutation captures. A contradicted B row is resolved only through a valid live capture
(previous reason preserved), the same capture hash is an idempotent no-op, and `--write` regenerates the
spec and markdown, re-stages dist, runs the docs gate, and restores ledger/spec/markdown on any failure. The
`counts.withResponse` means a response status was recorded, including HTTP 500 with an empty body;
the authoritative tier-A accounting is `captures/applied-*.json` → `rejections[]`.

architecture, commands, read-only allowlist, redaction policy, tier-upgrade rules, release-baseline
blocker and limitations are in [evidence/capture-tooling.md](./evidence/capture-tooling.md).

---

## Contradictions (claim vs. concrete artifact)

Three operations carry `contradicted: true` in the ledger: `/manager-tools/ajax.php`, `getPending` and
`getAgentPerformance`. The `getWebLog` and `getInfoPlayer` rows are marked resolved by the 2026-10-31
captures, but the resolution is narrower than "the response is known", so their history stays below.
Items 6-8 are claims outside the spec that a 2026-11-01 artifact corrected.

### 1. `POST /cloud/api/Manager/getWebLog` — response schema and auth (resolved at the envelope)

The spec previously required an `Authorization` Bearer header and published a four-field row schema
(`customerID`, `ipAddress`, `timestamp`, `agentOwner`). The 2026-10-31 capture records a 200 whose
body is 21 bytes — an `INFO` string with an empty `LIST` — and a request carrying both a cookie and an
`authorization` header (value redacted) (`docs/evidence/captures/2026-10-31/getWebLog.post.json`). The spec
now publishes that envelope and references only `fantasy402Cookie`, so the contradiction is gone. What the
capture does not prove: the four row fields (the list was empty) and whether a bearer value is required
(only its presence was recorded). Modes A, C and I remain unobserved — only mode B was captured
(`runbook:131`).

> "The session is cookie-based (the capture has no `Authorization` header), and the response body was not
> captured, so the row schema is still undocumented."
> — `operational_guardrails_runbook.md:153` (the 2026-10-28 state)

### 2. `POST /manager-tools/ajax.php` — the entire GS contract (removed, still contradicted)

An earlier spec revision published a POST endpoint for this path, a form-urlencoded body requiring
`operation`/`betGroupId` (example `908412`), and a four-property response
`{betGroupId, market, steamLagMs, pinnacleReferencePrice}`. The current `docs/openapi.json` has no such
path, and the ledger still carries the row as `contradicted: true`. The GS extract forbids the old shape
exactly:

> "Live acquisition is intentionally blocked: no GS endpoint/authentication/response contract is verified."
> — `zip:README.md:3`

> "No endpoint URL, method, auth scheme, Summary action, pagination, or upstream response schema is
> fabricated here." — `zip:contracts/contract-map.md:14`

> "No response capture exists: assigning invented response properties is prohibited." — `zip:contracts/gs-manager.ts:29-30`

> Last Bets upstream block: `status: blocked_contract`, `url: null`, `method: null`, `contentType: null`,
> `responseSchema: null`, `authentication: null`. — `zip:templates/endpoint-registry.json:281-288`

> "Only Last Bets has an observed action (`getBetReport`); no transport URL, method, response shape, or auth
> mechanism has been established for any report." — `zip:templates/contract-verification.md:3`

The only observed artifact is a user-supplied request payload (`zip:contracts/get-bet-report.observed.json`)
whose key is `action` (not `operation`), whose `betGroupId` is empty (not `908412`), and which carries 20
fields rather than 2.

### 3. `POST /cloud/api/Manager/getInfoPlayer` — padded-ID example (resolved by removing the example)

The spec's request example was the 11-character padded ID, while the observed read sent a 7-character
trimmed one (`operational_guardrails_runbook.md:213`). The published example is gone, so the row is no
longer contradicted — but the capture cannot demonstrate the width either: its redaction report lists
`request.body.customerID` among the redacted fields. The response is still unobserved in substance: the
captured body is `{"INFO": null}` (13 bytes), so no `Result` field has been seen.

### 4. `POST /cloud/api/Manager/getPending` — an empty form body and a 500

The 2026-10-31 capture sent `application/x-www-form-urlencoded` with an empty body and received HTTP 500
with 0 bytes (`docs/evidence/captures/2026-10-31/getPending.post.json`,
`docs/evidence/captures/pending-500s/diagnostics.json`). The ledger's `contradictedReason` records that
this refutes the `application/json` body an earlier spec revision declared; the current spec publishes no
request body for the row. The same report under the other prefix, `POST /cloud/api/Report/Pending`,
returned 200 with a 41 KB body on 2026-11-01, which is why that row is tier A and this one is not. The
ledger keeps the row contradicted rather than retired; its `requiredCapture` proposes re-probing with a
form body.

### 5. `POST /cloud/api/Manager/getAgentPerformance` — `Manager/`, not `Report/`

The repo listed `POST /cloud/api/Report/getAgentPerformance`, inferred from the `get-agent-performance`
action name. An operator paste of 2026-11-01 shows the report is served by the Manager prefix; the ledger
row moved to `/cloud/api/Manager/getAgentPerformance` and from C to B
(`tests/fixtures/f402-report-requests-observed-2026-11-01.json`). Three requests were observed: two CP
(all periods, then `subsport=NFL period=1 wagerType=M betType=S`) and one CPS (`sport=LIVE`,
`subsport=NCAAF Live`). URL, method, content type and field order are therefore observed, and
`lib/f402_agent_performance_request.ts` reproduces the bodies byte-for-byte. Only the response is
inferred — no response was ever observed.

### 6. `Log/write`'s `customerID` — "padded to 10" does not hold

`runbook:215` says the only padded ID observed is `Log/write`'s `customerID`, padded to 10 characters, and
asks for an `updateByColumn` capture before relying on 11. The 2026-11-01 writes contradict the first half:
`vipListInsert`, `Log/writeDetail` and `Log/write` all sent `customerID`/`agentID`/`agentOwner` as the bare
7-character login (`tests/fixtures/f402-report-requests-observed-2026-11-01.json`;
`docs/evidence/capture-requests.md` §P2 records the same correction). The 11-character width is still
unconfirmed, but padding cannot be assumed from this operation family.

### 7. `tipo` is not a constant

`lib/f402_agent_performance_request.ts` defaults `tipo` to 0 (`DEFAULT_TIPO`) because CP sent 0; CPS sent
-1. A builder that hard-codes 0 for every report kind sends a CPS request the portal never sent. `period`
is not constant either: the same CPS call was observed with -1 and with 0, which are "all periods" and the
single period LIVE's catalog defines.

### 8. `data/agent-tree.json` `roots` — "no parent in this capture"

The four entries in `roots` are not the top of the portal's hierarchy. The rendered sidebar
(`tests/fixtures/portal-agent-tree-sidebar-2026-11-01.html`) shows one root — the session's own master —
with those four at `data-level="1"`. The `listAgenstByAgent` response is a downline, so the master is not
in it at all; the page injects the master from the session. Reading `roots` as "the top-level agents"
over-counts the hierarchy and looks in the tree for an account that was never returned.

---

## Writes are recorded, never replayed

Three of the six requests in `tests/fixtures/f402-report-requests-observed-2026-11-01.json` are mutations:
`POST /cloud/api/Manager/vipListInsert` (JSON), then `POST /cloud/api/Log/writeDetail` (form-encoded) and
`POST /cloud/api/Log/write` (JSON). `tests/fixtures/f402-bet-ticker-config-2026-11-01.json` records a
fourth, `POST /cloud/api/Manager/updateBetTickerConfig`. Nothing in this repository calls any of them, and
`tests/f402_observed_requests.test.ts` pins the recorded shapes without sending them: production is
read-only unless the task is explicitly a deploy.

1. **`{"INFO":""}` is an empty string, not proof of success.** It is not `true` and not `{}`; the ticker
   config's `INFO` is an object, so a parser that assumes the object form reads a write ack as an empty
   config. An empty ack is consistent with a saved write, but the fixture also records that the portal
   acknowledges without inspecting results (`updateBasicSettings` assigns local state from the values it
   sent), and the paste does not say which of the three calls the ack answered. Record it as "no payload".
2. **A recorded write is not a contract to replay.** Every identifier in these pastes is the bare
   7-character login (placeholders here; `docs/evidence/capture-requests.md` §P2), and the writes change
   live customer state.

---

## GS live acquisition is blocked

The GS Buckeye 2 Partner 118 deliverable does not have a wire contract, by design. No endpoint, method,
content type, authentication mechanism, pagination or response schema for any GS report has been verified.
The CLI is real (orchestration, job store, cron template, 6 passing Node tests); the live adapter is not.
Any docs text that presents a GS HTTP contract — including `POST /manager-tools/ajax.php` — must be removed
or rewritten as "blocked, capture required". See [evidence/capture-requests.md](./evidence/capture-requests.md) §P4.

---

## Operator UI observations (2026-11-03)

Nine operator-supplied screenshots of the Manager Tools console (Manage Players agent/player
profile grids, Find Player, Events → Last Bets, and the five Reports pages) are filed as **UI
observation only**, with sha256 and dimensions per image, in
[evidence/manager-ui-observations-2026-11-03.md](./evidence/manager-ui-observations-2026-11-03.md)
(images under `docs/evidence/screenshots/manager-ui-2026-11-03/`). They record the console's control
vocabulary — including `State: All` on Last Bets and the `Grade time / Bet time` date-filter choice —
and the profile totals shown at that moment (190 agent profiles, 2,964 player profiles). They do not
carry a method, request, headers, auth or response, so they do **not** change the `ajax.php`
`blocked_contract` status above; all Last Bets and report grids were empty for the selected filters,
which is zero rows for that selection, not evidence that no wagers exist.

## Surfaces recorded outside `operations[]` (D/E)

Twenty-one rows: D 20, E 1. Most local daemon routes are now published in `docs/openapi.json`, so this
table is the inventory of surfaces, not a list of spec omissions; none of them appears in `operations[]`.
Rows still without a spec path of their own: the sport-catalog data file, `Manager/getGrading` (only the
`Report/` path is published), `POST /telegram/webhook` and the `OPTIONS` preflight on the admin surface,
the graph data plane's companion JSON and `docs/assets/*`, and the blocked GS CLI. The `/api/desk/*` group
(E) is documented and unimplemented.

| Id                                     | Tier | What it is                                                                                                    |
| -------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `surface.fantasy402-sport-catalog`     | D    | 19 sports / 230 sub-sports / 42 period menus / 2 desk-link collision ids / 4 digests, `capturedAt 2026-10-21` |
| `surface.manager-getHistory`           | D    | Wired settlement-history poll: `POST {base}/cloud/api/Manager/getHistory`                                     |
| `surface.manager-getGrading`           | D    | Declared settlement feed; no fetch client exists ("wired" is a type/config claim only)                        |
| `surface.daemon-dashboard`             | D    | `GET /` and `GET /dashboard` dashboard HTML                                                                   |
| `surface.daemon-miniapp`               | D    | `GET /miniapp` Telegram Mini App HTML                                                                         |
| `surface.daemon-telegram-admin-routes` | D    | Webhook, telegram status/activity, preflight, error trigger                                                   |
| `surface.daemon-live-bets`             | D    | `GET /api/live-bets` + `/summary`; derives games and aggregates from captured rows (PII stripped)             |
| `surface.daemon-agent-tree`            | D    | `GET /api/agent-tree`; canonical agent-keyed forest joined with per-agent exposure                            |
| `surface.daemon-scoreboard`            | D    | `GET /api/scoreboard`; 22 transcribed games with scores/status, no API capture                                |
| `surface.daemon-sports-taxonomy`       | D    | `GET /api/sports`; 18 portal categories with counts; All Sports and LIVE are not categories                   |
| `surface.daemon-game-admin`            | D    | `GET /api/game-admin`; exposure per fixture split Straight/Parlay/Teaser (manual F.A.Q. #4)                   |
| `surface.daemon-analysis`              | D    | `GET /api/analysis` (+ `/filters`, `/reports`); one transcribed CP result, 501 otherwise                      |
| `surface.daemon-agent-search`          | D    | `GET /api/agents/search`; tree-backed agent suggestions for the Analysis form                                 |
| `surface.daemon-game-admin-board`      | D    | `GET /api/game-admin/board`; per-side exposure, abbreviations kept approximate                                |
| `surface.daemon-sport-catalog`         | D    | `GET /api/sports/catalog`; 19 sports / 230 sub-sports / 42 period entries with sport-specific types           |
| `surface.daemon-contests`              | D    | `GET /api/contests`; 227 futures extracted from the sports nav markup                                         |
| `surface.daemon-live-wagers`           | D    | `GET /api/live-wagers`; `{LIST: [...]}` ticker feed with parsed ShortDesc legs                                |
| `surface.daemon-logo-proxy`            | D    | `GET /api/logo/{name}`; team-logo proxy to `cdn.fastassets.io`, name-validated, image bytes only              |
| `surface.daemon-graph-data-plane`      | D    | Graph feed, two companion JSON files and `docs/assets/*` that the generated graph page fetches                |
| `surface.gs-manager-cli`               | D    | 6 report kinds + 9 `jobs` subcommands + CLI orchestration, all `blocked_contract`                             |
| `surface.desk-api-unimplemented`       | E    | 9 paths / 10 operations under `/api/desk/*` with no handler anywhere                                          |

Full inventory with evidence: [evidence/surfaces.md](./evidence/surfaces.md).

---

## Spec integrity notes for the generator

1. **Security schemes are declared, but auth is still `[UNVERIFIED]`.** The spec uses
   `fantasy402Cookie` (session cookie) and `daemonBearer` (local daemon); no operation references a
   `BearerAuth` scheme. The 2026-10-28 HAR carried no `Authorization` header, while the 2026-10-31 captures
   record an `authorization` key with a redacted value. Presence of the key is `[OBSERVED]`; whether the
   Manager session sends a bearer token is `[UNVERIFIED]` — check a capture with an unredacted header before
   publishing that claim.
2. **The 11 `Tracked Operational Domains` rows publish no `requestBody`.** Their `x-extracted-inputs` are DOM
   form-field names, not wire parameters. Do not render them as request schemas.
3. **The removed post-processor is not evidence.** The old `append_tracked_domains.mjs` table called the
   candidates "Target Wire Endpoint"; it was removed. The crawler defaults to its `offline` branch and no
   crawl artifacts exist, so the rows stay tier C.
4. **`getWebLog` title.** The spec now says "mode B request observed; request + response captured", which
   is true, but the captured response is an empty `LIST` — the title must not be read as "rows captured".
5. **An observed request can be absent from the ledger.** `getSubSportByReport`, `vipListInsert`,
   `Log/writeDetail`, `Log/write` and `updateBetTickerConfig` are recorded in the 2026-11-01 pastes but have
   no ledger row and no spec path. The ledger's 55 rows are its scope, not a census of every request this
   repo has seen; absence from it is not evidence that an operation does not exist.

---

## Limitations (quotable paragraph for the docs generator)

> The ledger distinguishes captured wire evidence from observation and inference: eight operations have live
> request+response captures — `getWebLog`, `getInfoPlayer`, `getBetTicker`, `getBetTickerConfig` and
> `getSportsVigSetup` from 2026-10-31, plus `Report/Pending`, `getTransactions` and `getGrading` from
> 2026-11-01 — and publish capture-derived response schemas. For four of them the captured body is an empty
> envelope, so the schema describes the envelope and nothing inside it. The Analysis report,
> `POST /cloud/api/Manager/getAgentPerformance`, has its request observed in full (three calls, 2026-11-01)
> but no response, and remains tier B. Every other response schema is authored unless its row says
> otherwise. Earlier wire artifacts are the 2026-10-28 Manager HAR (mode-B request only) and the 2026-10-31
> live run, whose three remaining requests (`getPending`, `getInfoManager`, `getCustomerNotes`) returned
> HTTP 500 with the current request template. Sub-sport lanes and period menus are desk-navigation catalog
> data, not yet captured live; live pregame sports parity is verified separately (19/19 sports,
> `getSportsType`). GS Buckeye 2 Partner 118 live acquisition is blocked by design — no endpoint, method,
> authentication mechanism or response contract for any GS report has been verified, and the observed
> `getBetReport` payload does not establish a transport. The 11 "Tracked Operational Domains" entries are
> UI/DOM declarations with candidate URLs and methods, not wire contracts, and the `/api/desk/*` routes are
> documented without any implementation. Treat any schema or behaviour not backed by a cited capture as a
> proposal to be confirmed, not as a contract.
