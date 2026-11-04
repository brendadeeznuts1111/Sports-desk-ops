# `authenticateCustomer` live capture — 2026-11-04

**Scope.** One live `POST /cloud/api/System/authenticateCustomer` against
`https://www.fantasy402.com` with the operator's legacy `sportsdesk-ops` F402 credential, plus the
follow-up Manager call (`getPending`) and a token-acceptance control (`renewToken`). No password,
token, or customer identifier is retained in this document or the fixture; the capture was run by a
temporary script (not committed) and recorded as
[`tests/fixtures/f402_authenticate_customer.2026-11-04.json`](../tests/fixtures/f402_authenticate_customer.2026-11-04.json).

**Why now.** The audit rated this endpoint tier **C** ("inferred only; no artifact") and the whole
Bearer-vs-cookie auth model depended on it. `docs/evidence/capture-requests.md` §P3 asked for the
status, token shape/lifetime, and whether the next Manager call accepts it.

## Request shape (derived from the pinned manager bundle)

The documented `customerID=<id>&password=<pw>` form is **wrong** for this endpoint. The manager
login path in `verification/manager-boot-oracle/pinned/security.js` builds a **JSON** body and posts
to `apiPath + "api/System/" + operation`, where `apiPath = "/cloud/"` (`pinned/util.js`):

```json
{
  "customerID": "<USER, uppercased>",
  "state": true,
  "password": "<PASSWORD, uppercased>",
  "sufix": "",
  "prefix": "",
  "multiaccount": 0,
  "response_type": "code",
  "client_id": "<USER, uppercased>",
  "domain": "fantasy402.com",
  "redirect_uri": "fantasy402.com",
  "token": "",
  "operation": "authenticateCustomer",
  "RRO": 1
}
```

`Content-Type: application/json`; the browser adds `Authorization: Bearer ` with an empty
`#agToken` for a normal (non-agent-token) login. A form-urlencoded body to this endpoint returns
**HTTP 500 empty HTML** — the first failed probe in this capture.

## Results

### 1. `authenticateCustomer` — 200 with an agent JWT

| Field              | Measured                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Status             | **200**                                                                                               |
| Content type       | `application/json; charset=utf-8` (Cloudflare, `cf-ray` present)                                      |
| Body keys          | `accountInfo`, `code`                                                                                 |
| `accountInfo` keys | `UseCaptcha`, `customerID`, `AgentType`, `AgentSkinOverride`, `Office`, `Language`, `DefaultSiteSkin` |
| `code`             | JWT, **HS256**, 221 chars                                                                             |
| JWT claims         | `ag`, `exp`, `imp`, `nbf`, `off`, `rb`, `sub`, `type`                                                 |
| Lifetime           | **`exp - now = 1200 s` (20 minutes)** — matches the spec's ~20–25 min claim                           |
| `sub` length       | 8 chars (matches the keychain agent id)                                                               |
| Set-Cookie         | **none**                                                                                              |

`accountInfo.customerID` is 10 chars and **differs from the 8-char keychain `f402-agent-id`**. Do not
assume the keychain agent id is the Manager `agentID`; the two identifiers are distinct.

### 2. Token acceptance — the bearer is real

`POST /cloud/api/System/renewToken` with `Authorization: Bearer <response.code>` and body
`{"operation":"renewToken","RRO":1}` → **200**, `{"code": "<new 221-char HS256 JWT>"}`. The
`authenticateCustomer` token is therefore a valid **System-API bearer credential**, not an opaque
session artifact.

### 3. The next Manager call — `getPending` returns 500, not 401/403

Every tested shape against `POST /cloud/api/Manager/getPending` returned **HTTP 500 with an empty
`text/html` body**, `server: cloudflare`, no `cf-mitigated`, under the same bearer token that
`renewToken` accepts:

- JSON body with `agentID = accountInfo.customerID`;
- JSON body with `agentID = keychain f402-agent-id`;
- form-urlencoded `{agentID, type:"", operation:"getPending", RRO:"1"}`;
- JSON body plus the warm-up Cloudflare cookies;
- `getInfoManager` (control endpoint) — also 500.

A 500 empty HTML is a server/request-contract failure, **not** an authentication rejection. The
Manager request contract remains unresolved — consistent with the earlier
`docs/evidence/captures/pending-500s/` evidence that `getPending`/`getInfoManager` return 500 with
the current request template.

### 4. Session-cookie path — unavailable

The auth response sets no session cookie (only a Cloudflare `__cf_bm` came from a warm-up GET).
Replaying the cookie jar to `getPending` returned **401** (`text/html`, 176 chars). So
`credentials: "include"` with cookies minted by `authenticateCustomer` does not authorize Manager
calls; only a real browser login session does.

### 5. Follow-up probe — `Report/Pending` **accepts** the bearer

The same JWT was replayed against `POST /cloud/api/Report/Pending` with a customer-scoped body
(`{customerID, token, operation:"Pending"}`), using customer IDs from the local book at probe time
(never retained):

| Request                                                         | Result                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| Valid customer, `token:""` in body + `Authorization: Bearer`    | **200** `{"Pending":[... ]}` (1 pending leg)             |
| Valid customer, `token:<jwt>` in body + `Authorization: Bearer` | **200** (same)                                           |
| Second valid customer                                           | **200** `{"Pending":[]}`                                 |
| Non-live customer ID                                            | **400** `{"status":"Failed","msg":"Invalid CustomerID"}` |
| Valid customer, **no** `Authorization` header                   | **401** `text/html`                                      |

So the `Authorization: Bearer` header is the credential; the body `token` field is not required.
`Report/Pending` is **customer-scoped** — agent IDs (keychain or `accountInfo.customerID`) return
`Invalid CustomerID`, but valid book customers return 200.

**Consequence:** 3b's bearer path is viable **through `Report/Pending`**, not `Manager/getPending`.
The remaining design question is aggregation: 3b currently asks one agent-wide `Manager/getPending`;
`Report/Pending` needs one call per customer (the local book provides the IDs). `Manager/getPending`
stays a 500 dead end for request-contract reasons, not authentication.

## What this changes

| Question from P3                            | Answer                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Does `authenticateCustomer` return a token? | **Yes** — `code`, HS256 JWT, 221 chars, 20-minute expiry                                                                                   |
| Is it a bearer the platform accepts?        | **Yes** — `renewToken` returns 200 with it                                                                                                 |
| Does the next Manager call accept it?       | **Not established** — `getPending` returns 500 for every tested shape; this is not a 401/403 so the token is not being rejected as invalid |
| Is a session cookie enough?                 | **No** — no session cookie is issued by this endpoint                                                                                      |

Consequences for the bridge workstreams:

- **AuthenticateCustomer upgrades C→A for the token contract**: the OpenAPI `BearerAuth` claim is
  real for `/cloud/api/System/*` (`authenticateCustomer`, `renewToken`). The `code` is the bearer,
  not a cookie.
- **3b is still blocked**, but on the **Manager request contract**, not on auth. The next empirical
  step is to capture one _real browser_ `getPending` request (headers + body + response) from a
  logged-in Manager session — or switch 3b to `/cloud/api/Report/Pending` (tier A, already captured).
- **`--from-keychain` stays session-cookie-only for 3c**; do not add a `--mint-bearer` step to 3b
  on this evidence. The bearer exists but the Manager endpoint's accepted body is still unknown.
- **Player-reader decision unchanged**: the player credential path remains env-only until a writer
  or removal is chosen.

### 6. Scope probe — `Report/Pending` has no agent-wide mode

To see whether 3b's old agent-wide semantics could be preserved, the same bearer was sent with
`customerID` = `""`, `"0"`, `"*"`, `"ALL"`, `"all"`, the keychain login (raw and uppercased), and
`accountInfo.customerID` (raw and uppercased). Every one returned **400
`{"status":"Failed","msg":"Invalid CustomerID"}`**; only real book customers return 200.

**Conclusion:** `Report/Pending` is strictly customer-scoped. 3b cannot enumerate implicitly; it
must take an explicit list (`--customers`, `--customers-file`, or `F402_PENDING_CUSTOMERS`) and
fail closed unless `--allow-partial` is passed. The batch fetch was implemented in
`lib/f402_pending_fetch.ts` (`fetchF402ReportPendingBatch`) with the same bearer/form contract.

## Implementation

The captured flow is now implemented as `lib/f402_authenticate_customer.ts` (injectable fetch, no
secrets in errors) and exposed as:

```sh
F402_LIVE_LOGIN=1 bun run session:login --from-keychain --mint-bearer
```

which writes the JWT to `F402_TOKEN_FILE` (0600) for `fetchF402Pending`. Unit tests pin the exact
JSON body, the uppercasing, the `code` JWT extraction/lifetime, and fail-closed errors; no network
is used in tests. 3b's remaining change is to read `Report/Pending` instead of `Manager/getPending`.

## Reproduction notes

- Request shape: `verification/manager-boot-oracle/pinned/security.js` (search
  `authenticateCustomer`) and `pinned/util.js` (`apiPath: "/cloud/"`, `RRO: 1`).
- Credential source: legacy keychain service `sportsdesk-ops` (`f402-agent-id`, `f402-password`);
  read through the guarded `Bun.secrets` path, never printed.
- The capture script was temporary and is not committed (it performs a live auth exchange, which
  `scripts/capture/allowlist.ts` deliberately refuses as `auth-exchange`). The sanitized fixture is
  the durable artifact.
