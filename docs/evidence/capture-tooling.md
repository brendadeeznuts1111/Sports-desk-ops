# Evidence capture tooling

How the docs release turns a real wire exchange into ledger evidence, and why most
of it still cannot be applied to this release.

- **Status:** the capture core (`scripts/capture/`), the capture CLI
  (`scripts/evidence_capture.ts`), the apply tool (`scripts/apply_captures.ts`) and the
  portal/crawl audit scripts are present on `feat/evidence-capture-automation`, with package
  scripts wired and mock fixtures under `tests/fixtures/captures/`. The **live** capture store
  (`docs/evidence/captures/`) is created by the first live run, which has **not** happened for
  this release — so tier A remains **0**. See
  [Applying captures to this release](#applying-captures-to-this-release) for the
  release-baseline dependency that blocks `--write` today.
- **Related docs:** [EVIDENCE.md](../EVIDENCE.md) (tier model) ·
  [capture-requests.md](./capture-requests.md) (what to capture) ·
  [manager-boot-hierarchy.md](./manager-boot-hierarchy.md) · [manager-boot-primary-sources.md](./manager-boot-primary-sources.md) ·
  [ledger.json](./ledger.json) (machine-readable evidence).

---

## Architecture

Three cooperating paths; each is used for exactly one job.

```
              ┌────────────────────────────────────────────────────────────┐
  auth + DOM  │ Bun.WebView (chrome backend)                               │
              │  navigate → portal login → DOM settle                       │
              │  cdp("Network.getAllCookies") → HttpOnly session cookies    │
              └───────────────────────────┬────────────────────────────────┘
                                          │ cookie replay (never persisted)
              ┌───────────────────────────▼────────────────────────────────┐
  wire bytes  │ Bun.FetchSession.fetch(allowlisted request, cookies)        │
              │  HTTP_PROXY / HTTPS_PROXY / NO_PROXY honored (env only)     │
              │  response bytes → sha256 + schema skeleton                  │
              └───────────────────────────┬────────────────────────────────┘
                                          │
              ┌───────────────────────────▼────────────────────────────────┐
  evidence    │ redaction (policy v1) → capture record v1 + manifest.json   │
              │ docs/evidence/captures/<date>/<slug>.<method>.json          │
              └───────────────────────────┬────────────────────────────────┘
                                          │
              ┌───────────────────────────▼────────────────────────────────┐
  ledger      │ scripts/apply_captures.ts (dry-run first)                    │
              │  validate → plan B/C→A → --write → regenerate → verify → audit │
              └────────────────────────────────────────────────────────────┘
```

**Auth handoff.** The WebView logs in like an operator and `cdp("Network.getAllCookies")`
returns the HttpOnly session cookies. Those cookies are replayed into `FetchSession`; they
are never written to disk, logs, the capture record or argv.

**Why a replay instead of intercepting the browser.** `cdp()` itself is a command sender, but
CDP **events** arrive through `Bun.WebView`'s `EventTarget` surface: the view dispatches each
event with the CDP method name as `type` and the parsed `params` as `event.data`, and
`scripts/capture/webview.ts` wraps that in `onCdpEvent()`. The repo already subscribes this
way — the `Network.responseReceived` listener in
`scripts/capture/f402_manager_boot_har.ts` and the `Network.requestWillBeSent` listener in
`scripts/capture/f402_probe.ts`. Measured 2026-11-02 on Bun 1.4.4 (Chrome backend,
`Network.enable`, a local `Bun.serve` page that makes one `fetch`): 3 `requestWillBeSent` and
3 `responseReceived` events arrived through `onCdpEvent()`. So response interception is
available; the replay design is chosen for a different reason.
The capture has to record the **request** bytes, and a CDP event hands back the request a
page happened to send, not a request the capture can issue and re-issue reproducibly. The
capture therefore _issues_ the request with `FetchSession` and records the real response.
Consequence, stated plainly: the recorded **request bytes are the replay's request**, not the
portal's own JS request; the recorded **response bytes are the live service's response** to
that authenticated request. Both go to the real upstream endpoint.
A capture proves the endpoint, auth mode and response shape — it does not prove that the
portal's own UI sends byte-identical parameters.

**Proxy path.** `Bun.fetch`/`FetchSession.fetch` honor `HTTP_PROXY`, `HTTPS_PROXY` and
`NO_PROXY` (a Bun extension); an explicit `proxy:` init option is ignored in 1.4.4, so the
run configures **environment variables only**. WebView does **not** honor those variables
(Chrome/system proxy only), so the auth/DOM leg is out of proxy scope. A local forward
proxy must forward with `proxy: false` or it loops; HTTPS targets need a CONNECT-capable
external proxy.

**Capture core modules** (`scripts/capture/`): `allowlist.ts` (read-only gate),
`session.ts` (transports), `schema.ts` (skeletons), `redact.ts` (PII policy),
`json.ts` (canonical JSON + sha256), `cookies.ts`, `proxy.ts`, `types.ts` (record v1).

---

## Capture store (schemaVersion 1)

```
docs/evidence/captures/               # LIVE-ONLY store (empty until the first live run)
  README.md                           # layout + live-only policy
  .gitkeep
  manifest.json                       # created by the first live run: captureHash per file
  <YYYY-MM-DD>/
    <slug>.<method>.json              # one capture record per operation
  applied-<YYYY-MM-DD>.json           # written by apply_captures --write only
```

The store is **live-only**: mock/offline records must never be committed here (they live
under `tests/fixtures/captures/`, owned by the capture tooling), and `apply_captures`
refuses them with `E_MODE_NOT_LIVE`. `docs/evidence/captures/README.md` documents the
layout, the live generation command and the apply workflow.

Record shape (value-free by construction):

```json
{
  "schemaVersion": 1,
  "mode": "live",
  "capturedAt": "<ISO-8601>",
  "operation": { "path": "/cloud/api/Manager/getWebLog", "method": "POST" },
  "request": {
    "url": "…",
    "method": "POST",
    "headers": { "cookie": "<redacted>" },
    "contentType": "…",
    "bodySha256": "<64-hex>",
    "bodySkeleton": {}
  },
  "response": {
    "status": 200,
    "contentType": "…",
    "bodySha256": "<64-hex>",
    "bodySkeleton": { "type": "object", "fields": {} },
    "bytes": 1234
  },
  "redaction": {
    "policyVersion": 1,
    "clean": true,
    "fieldsRedacted": ["request.headers.cookie"],
    "piiRedacted": ["ip"]
  },
  "provenance": {
    "portalHost": "www.fantasy402.com",
    "proxy": "env",
    "auth": "cookie",
    "bunVersion": "1.4.4"
  },
  "samples": 1
}
```

- `bodySha256` is the sha256 of the exact bytes; bodies themselves are never stored.
- `bodySkeleton` keeps field names, JSON types, nullability, array item shape and
  enum-shaped literals for a short key allowlist — never values, IDs, IPs or emails.
- `manifest.json` indexes each file by `captureHash` = sha256 of the **canonical record
  JSON** (sorted keys, compact). `apply_captures` uses the same hash for the ledger
  evidence id, so re-serializing a record cannot change its evidence identity.
- `apply_captures` **imports** `canonicalJson`/`sha256Hex` from `scripts/capture/json.ts`
  (it does not reimplement the hash), and `tests/capture_apply.test.ts` pins the ledger
  evidence id to the tooling's `captureHash` by building a record with
  `buildCaptureRecord`. A change to either side fails that test instead of silently
  minting a different id.
- The capture CLI's `readCaptureManifest`/`loadCaptureStore` are the authoritative readers
  for the capture side. `apply_captures` keeps a tolerant index so a foreign or stale
  `manifest.json` is reported as `E_MANIFEST` (with the offending file) instead of crashing
  the plan.

---

## Commands

Package scripts (owned by the capture branch):

| Command                             | Runs                                                          | Purpose                                                                     |
| ----------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `bun run capture:evidence`          | `scripts/evidence_capture.ts --mode mock`                     | Offline/mock capture run; never upgrades evidence. Default, CI-safe.        |
| `bun run capture:evidence:live`     | `scripts/evidence_capture.ts --mode live`                     | Live gated capture (see below); writes into the capture store.              |
| `bun run apply:captures`            | `scripts/apply_captures.ts`                                   | Validate the store and print the B/C→A plan (dry-run default).              |
| `bun run apply:captures -- --write` | same, `--write`                                               | Apply upgrades, regenerate spec + markdown, run the docs gate, write audit. |
| `bun run docs:audit:portal`         | `scripts/audit_docs_portal.ts --once`                         | One docs-portal console/DOM audit of the deployed Scalar page.              |
| `bun run docs:audit:portal:watch`   | `scripts/audit_docs_portal.ts --watch`                        | In-process `Bun.cron` watcher for the docs portal.                          |
| `bun run crawl:tiles`               | `scripts/portal_tile_crawler.ts --offline`                    | Offline launcher-tile discovery/audit; candidates only, no wire claims.     |
| `bun run test:capture`              | `bun test tests/capture_*.test.ts tests/portal_audit.test.ts` | Hermetic capture/apply tests (no network, no WebView).                      |

`apply:captures` accepts `--captures <dir>`, `--dry-run`, `--write`, `--json` and
`--root <dir>` (temp copy / tests):

```bash
# plan only, machine-readable
bun run scripts/apply_captures.ts --dry-run --captures /tmp/cap-fixtures --json
# apply against a fresh copy of the docs tree
bun run scripts/apply_captures.ts --root /tmp/docs-copy --write
```

Exit codes: `0` plan computed / applied / nothing to do; `1` write failed and the
ledger/spec/markdown were restored; `2` input error (bad args, missing store, corrupt
ledger, stale manifest, lock held). `bun run apply:captures --write` and
`bun run apply:captures -- --write` are both accepted. The default store directory is
created by the first capture run; before that, `apply:captures` exits 2 with
`E_STORE_MISSING` and tells you which directory it expected.

---

## Live gating

Live capture is **opt-in and two-key**:

1. `F402_LIVE_CAPTURE=1` must be set for the run.
2. Credentials come from the environment / `.env` (loaded by the runtime):
   `F402_BASE_URL`, `F402_AGENT_ID`, `F402_PASSWORD`.

Never pass credentials as argv, never log them, never put them in capture files, the
manifest, the ledger, the audit record or error messages. Without the gate the CLI exits
before opening a browser or a socket. Tests and CI run only the mock/offline path.

## Read-only allowlist

Capture and apply accept exactly these eight Manager reads:

`getWebLog`, `getInfoPlayer`, `getBetTicker`, `getBetTickerConfig`, `getPending`,
`getSportsVigSetup`, `getInfoManager`, `getCustomerNotes`.

Mutations are refused in code: `updateByColumn`, `vigSetupInsert`, `deleteSportsVigSetup`,
`createPlayer`, `adjustBalance`, `deleteWager`, `updateCustomerNotes`, `delete-wager`,
`gameAdmin`. The authentication exchange is performed by the WebView login and is not a
capturable read operation.

## Redaction policy

- Before persist: `Authorization`, `Cookie`, `Set-Cookie`, CSRF/session tokens, passwords,
  customer logins/IDs, IP addresses and emails are replaced or hashed.
- Only skeletons and hashes are committed; raw bodies are discarded.
- Every record carries a `redaction` report with `policyVersion: 1` and `clean`.
  `apply_captures` refuses any record whose `redaction.clean` is not `true`.
- Header names are kept; values are `<redacted>`. A manifest sibling records counts, not
  values.

---

## Tier-upgrade rules (what `apply_captures` will and will not do)

A capture upgrades a ledger row **B → A** only when all of these hold:

1. `mode === "live"` — mock/offline captures are **refused**, never silently skipped.
2. `redaction.clean === true` and `redaction.policyVersion === 1`.
3. `request` is present with an absolute URL, its method and `bodySha256`.
4. `response` is present, `2xx`, and has a `bodySkeleton`.
5. The operation is on the read-only allowlist and is `POST`.
6. The ledger has a row for that path+method and the spec has the operation.
7. The row is tier **B**, not contradicted, and not already captured.

**Contradicted rows are resolved by evidence, not hand-editing.** A contradicted **B** row
can be upgraded by a valid live capture (this is how `getWebLog` and `getInfoPlayer` become
tier A). The upgrade sets `tier: "A"`, `capturedResponse: true`, `contradicted: false`,
clears `contradictedReason`, appends the capture evidence entry, and records the history:

```json
"resolution": {
  "resolvedBy": "capture:2026-10-31/getWebLog.post.json",
  "resolvedAt": "<apply time, ISO-8601>",
  "previousReason": "<the old contradictedReason, moved not deleted>"
}
```

A contradicted row **without** a valid live capture stays exactly as it is — mock, dirty,
response-less or off-allowlist captures are refused and change nothing. A contradicted row
at any tier other than B is skipped.

It will **not**:

- promote tier **C** rows (a live capture can still be recorded, but re-tiering an inferred
  row is a human evidence decision);
- resolve a contradiction by any other means (no manual flag flipping, no partial capture);
- create ledger rows for operations that do not exist;
- run twice with a different result: the evidence id is
  `capture:<capturedAt date>:<captureHash>`, and the same hash on an already-upgraded row
  is an idempotent no-op;
- upgrade more than one row per capture, or more than one capture per row per run.

On upgrade it appends one `evidence[]` entry (`source: "capture:<date>:<sha256>"`,
`kind: "capture"`), sets `capturedResponse: true`, clears the now-stale
`requiredCapture`, and recomputes `counts`, `surfaceCounts` and `countsByTag` from the rows.
It never edits `docs/EVIDENCE.md` — the authored counts there are updated by hand in the
same commit when a release actually lands captures.

---

## Applying captures to this release

`scripts/generate_openapi.ts` is now **capture-ready**: counts are derived from the ledger
rows (no pinned baseline), and each tier-A row is rendered from a validated live capture in
the store (schemaVersion 1, `mode: "live"`, clean redaction, policy v1, 2xx with
`response.bodySkeleton`; latest `capturedAt` wins). The generated operation carries
`x-evidence {tier: "A", sources: ["capture:<date>/<slug>.<method>.json", "sha256:<canonical
digest>"], capturedResponse: true}` plus `x-capture {file, sha256, capturedAt, status,
samples}` and a response schema converted from the captured body skeleton (types, fields,
nullability and enum candidates only — never values). A tier-A row with a missing or invalid
capture makes the generator exit non-zero with the rejected-record reasons; it never falls
back to an invented schema.

Current state of the apply path:

1. **The only missing input is a live capture run.** `docs/evidence/captures/` is empty;
   live capture needs `F402_LIVE_CAPTURE=1` plus `.env` credentials and has not been run for
   this release, so tier A stays 0.
2. **The generator and gate are capture-ready.** Tier-A rows render from the store, and
   `scripts/verify_docs.ts` accepts a getWebLog 200 content schema only when
   `x-evidence.tier === "A"`, `capturedResponse === true` and `x-capture` validates
   (`.json` record under the capture store, 64-hex sha256, ISO `capturedAt`, 2xx `status`,
   `samples >= 1`). A tier-B getWebLog with content still fails
   `E_GETWEBLOG_RESPONSE_CONTENT`; a tier-A op with a missing/invalid `x-capture` fails
   `E_GETWEBLOG_TIER_A_CAPTURE_INVALID`.
3. Both Manager B rows are the two contradicted ones, so today's dry-run plan upgrades
   nothing: a valid live capture is exactly what resolves them (see the resolution rule
   above), after which `--write` applies, regenerates and verifies end to end.

Do not run `--write` against the real ledger without Lead approval.

## Live capture session (2026-10-31)

The first authenticated live run captured five read-only Manager responses — `getWebLog`,
`getInfoPlayer`, `getBetTicker`, `getBetTickerConfig`, `getSportsVigSetup` — and the capture store
contains their redacted records under `captures/2026-10-31/`. `apply:captures --write` upgraded
those ledger rows to tier A, regenerated the spec/markdown, and the docs gate passed. Three requests
(`getPending`, `getInfoManager`, `getCustomerNotes`) returned HTTP 500 with the current request
template, so they stay tier C and are listed in `capture-requests.md`.

The live **pregame sports list** is probed separately with `bun run catalog:probe` (authenticated
`getSportsType`); it reports 19/19 sports identical to the committed catalog fixture and writes
`captures/catalog/<date>/` + `docs/evidence/pregame-catalog.md`. Sub-sport lanes and period menus are
desk-navigation catalog data; their live capture still requires the Ticketwriter/board surface.

## Limitations (do not paper over these)

- **WebView ignores `HTTP(S)_PROXY`.** Proxy support exists only on the FetchSession data
  path; the login/DOM leg cannot be proxied through env vars.
- **CDP events need an explicit listener.** `Network.*` events are observable through
  `Bun.WebView`'s `EventTarget` only after `Network.enable`; the capture still records an
  authenticated replay, not the portal's own browser request, with the request-fidelity
  caveat above.
- **HTTPS proxying needs CONNECT.** A simple in-process forward proxy cannot tunnel TLS.
- **No bodies in the store.** Only skeletons and hashes; debugging a bad capture means
  re-capturing, not inspecting stored payloads.
- **No mutation capture.** Write-path evidence still requires an operator-approved test
  account and a separate capture path outside this tooling.
- **No captured auth exchange.** `authenticateCustomer` is not a capturable read; the
  cookie session is inferred from the WebView login, not from a minted-token capture.

## CI vs live separation

- CI and `bun run test:capture` run hermetic tests only: temp fixtures, injected deps,
  no WebView, no sockets.
- `bun run apply:captures` (dry-run) is safe in CI: it reads the store and prints a plan.
- Live capture runs are operator-initiated and env-gated; they never run in CI.
- The docs gate (`verify:docs`) and generators are deterministic and never touch the
  network.

## Cron, daemon and locking

- `docs:audit:portal:watch` uses in-process `Bun.cron`; keep it supervised and do not run
  two watchers for the same checkout.
- `apply_captures --write` takes an exclusive lock at
  `docs/evidence/captures/.apply.lock` and removes it on exit. If the lock exists, inspect
  running processes before removing it — do not delete a live lock by hand.
- Run `--write` when the capture daemon is not writing the store (a store that changes
  mid-apply is reported, not silently re-read).

## Error codes → action

| Code                                                               | Meaning                                    | Action                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `E_MODE_NOT_LIVE`                                                  | mock/offline capture                       | re-capture with `capture:evidence:live`                                      |
| `E_RESPONSE_MISSING` / `E_RESPONSE_STATUS` / `E_RESPONSE_SKELETON` | no usable response                         | re-capture; a status without a shape cannot replace an inferred schema       |
| `E_REDACTION` / `E_REDACTION_POLICY`                               | redaction report not clean/current         | fix redaction policy and re-capture; never bypass                            |
| `E_OP_NOT_ALLOWED`                                                 | mutation or unknown operation              | not capturable/upgradable; mutations need a separate approved path           |
| `E_REQUEST_MISSING`                                                | no request side                            | re-capture with the request recorded                                         |
| `E_LEDGER_ROW_MISSING` / `E_SPEC_OP_MISSING`                       | no ledger/spec row                         | add the operation first / regenerate the spec                                |
| `E_LEDGER_COUNTS`                                                  | ledger counts disagree with its rows       | repair the ledger before applying                                            |
| `E_MANIFEST`                                                       | missing listed file or stale `captureHash` | refresh/re-run the capture; never trust a stale index                        |
| `E_LOCK_HELD`                                                      | another apply is running                   | inspect processes; remove the lock only if none is live                      |
| `E_WRITE_FAILED`                                                   | generation/gate rejected the upgrade       | files were restored; fix the generator/baseline or the evidence, then re-run |
