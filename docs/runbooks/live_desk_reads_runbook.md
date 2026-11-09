# Live desk reads — ticker and Pending

Operator and engineering guide for the desk's **live-first** data reads: the `Manager/getBetTicker`
ticker consumed by `/api/live-wagers` and `/api/kpis`, and the customer-scoped
`Report/Pending` book consumed by `/api/live-bets` and the `/api/kpis` pending block. Both reads go
through `createF402ReplayTransport()` (session file, `F402_REPLAY_PROXY_URL`, or a WebView
profile exported to a session file); no token or cookie ever appears on a command line, in an
artifact, or in a response.

---

## 1. What "live" means here

| Data         | Route(s)                            | Live read                     | Fallback                                        |
| ------------ | ----------------------------------- | ----------------------------- | ----------------------------------------------- |
| Bet ticker   | `GET /api/live-wagers`, `/api/kpis` | `Manager/getBetTicker` POST   | `data/bet-ticker.json`, `data/live-wagers.json` |
| Pending book | `GET /api/live-bets*`, `/api/kpis`  | `Report/Pending` per customer | `data/live-bets.json` (or sample fixture)       |

A live response carries provenance `source: live:<operation>@<observedAt>` and a top-level `live`
object:

```json
{
  "mode": "auto | live | file",
  "status": "live | unavailable | disabled",
  "ok": true,
  "fetchedAt": "2026-11-08T22:26:52.976Z",
  "servedFromCache": false,
  "transport": "session-file | proxy | injected-fetch",
  "diagnostic": null,
  "customersAttempted": 2,
  "customersFailed": 0,
  "ttlMs": 60000
}
```

A fallback response keeps the artifact's own `capture:…` / `paste:…` provenance and explains the
live outcome in `live.diagnostic`. A capture is never labelled live, and a partial customer fan-out
(`customersFailed > 0`) is marked partial, never presented as the whole book.

---

## 2. Activating live reads

```sh
# One WebView login, cached 0600 under ~/.cache/sportsdesk/f402-session.json
F402_LIVE_LOGIN=1 bun run session:login --from-keychain --ttl-min 1440

# Agent id: F402_AGENT_ID in the environment or the f402-agent-id keychain entry.
# Pending is per customer; scope it explicitly or let it derive from the live ticker rows:
export SPORTSDESK_LIVE_PENDING_CUSTOMERS=H1716,CC364   # optional, comma-separated

PORT=4020 bun run serve
```

`bun run session:login` needs a normal terminal (Chrome cannot launch inside the agent sandbox; do
not add `--no-sandbox`). A replay proxy is the alternative when no local session is possible:
`F402_REPLAY_PROXY_URL=http://127.0.0.1:<port>`.

No restart is needed after a session refresh: the server reads the session per fetch, so the next
TTL expiry (the defaults are the values in the table below) serves live rows.

### Gates and knobs

| Variable                                | Default         | Meaning                                                |
| --------------------------------------- | --------------- | ------------------------------------------------------ |
| `SPORTSDESK_LIVE_TICKER`                | on outside test | `0/false/off/no` disables the live ticker read         |
| `SPORTSDESK_LIVE_TICKER_TTL_MS`         | `10000`         | Shared ticker snapshot TTL (0–300000)                  |
| `SPORTSDESK_LIVE_TICKER_TIMEOUT_MS`     | `4000`          | Per-attempt timeout (250–30000)                        |
| `SPORTSDESK_LIVE_PENDING`               | on outside test | Disables the live Pending read                         |
| `SPORTSDESK_LIVE_PENDING_CUSTOMERS`     | ticker-derived  | Explicit comma-separated customer scope                |
| `SPORTSDESK_LIVE_PENDING_MAX_CUSTOMERS` | `25`            | Fan-out cap (1–50)                                     |
| `SPORTSDESK_LIVE_PENDING_TTL_MS`        | `60000`         | Pending snapshot TTL (0–300000)                        |
| `SPORTSDESK_LIVE_PENDING_TIMEOUT_MS`    | `3000`          | Per-customer timeout (250–15000)                       |
| `SPORTSDESK_LIVE_PERSIST`               | on outside test | Disables writing live artifacts + capture-health       |
| `SPORTSDESK_LIVE_PERSIST_MS`            | `60000`         | Write throttle; unchanged bytes inside it are skipped  |
| `SPORTSDESK_LIVE_PERSIST_ROOT`          | repo root       | Where `data/` artifacts and capture-health are written |
| `SPORTSDESK_LIVE_REFRESH_MS`            | `60000`         | Daemon refresh cadence; `0` disables the loop          |

`bun test` disables both live reads and persistence by default; the route/server tests inject a
fetch seam and a temp persistence root, so no suite touches the network or the real `data/`.

---

## 3. Daemon refresh loop

The long-lived webview daemon re-reads both live sources on a cadence so operators who never open
the dashboard still get fresh `data/live-wagers.json`, `data/live-bets.json` and
`data/capture-health.json`. The loop is enabled by the daemon entrypoint (`import.meta.main`) and
disabled for programmatic `startServer()` callers; `SPORTSDESK_LIVE_REFRESH_MS=0` turns it off.
Each tick force-reads past the route TTL caches, refreshes the Pending customer scope from the live
ticker rows when no explicit scope is configured, and records telemetry exposed on
`GET /api/status`:

```json
"live": {
  "ticker": { "status": "live", "...": "…" },
  "pending": { "status": "unavailable", "diagnostic": { "code": "no_customer_scope" } },
  "refresh": { "enabled": true, "intervalMs": 60000, "ticks": 42,
               "lastTickAt": "2026-11-08T22:26:52.976Z", "lastTickOk": true, "lastError": null },
  "persistence": { "enabled": true, "artifactRoot": "repo", "throttleMs": 60000 }
}
```

A failed tick never stops the loop and never changes the service `ok` status; the next tick retries.

---

## 4. Persistence and provenance

After every **fresh** (not cache-hit) successful live read the server atomically writes the artifact
it just served and merges an `api` record into `data/capture-health.json`
(`artifactWritten: true`, transport label, row count, sha256). That is what lets CLIs, fraud tools
and the static pages see live data without a browser open. Writes are throttled by
`SPORTSDESK_LIVE_PERSIST_MS`; persistence failure never fails the HTTP response.

A server constructed with an **injected fetch** is a test/development seam, not the production
daemon. Such a server defaults its persistence root to the OS temp directory unless a root is named
explicitly, so a probe with a stubbed ticker cannot overwrite the operator's `data/` (this guard was
added after an injected-fetch probe overwrote `data/live-bets.json` on 2026-11-08; the regression
test asserts the repo `data/` hashes are unchanged).

---

## 5. Reading and debugging the state

```sh
curl -s localhost:4020/api/status | jq '.live'
curl -s localhost:4020/api/live-wagers | jq '{source:.provenance.source, live:.live}'
curl -s localhost:4020/api/live-bets   | jq '{source:.summary.dataSource, stale:.freshness.stale, live:.live}'
curl -s localhost:4020/api/kpis        | jq '{live:.live, livePending:.livePending}'

# Live-only probe (503 when the live read is unavailable, never a fallback):
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:4020/api/live-wagers?source=live'

# Never touch the network, serve the captured artifact only:
curl -s 'localhost:4020/api/live-wagers?source=file'
```

| Symptom                                    | Meaning / fix                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `diagnostic.code: "transport_unavailable"` | No session file and no proxy: run `bun run session:login` (normal terminal) |
| `diagnostic.code: "unauthorized"`          | Session rejected/expired: re-run `bun run session:login`                    |
| `diagnostic.code: "no_customer_scope"`     | Set `SPORTSDESK_LIVE_PENDING_CUSTOMERS`, or fix the live ticker read first  |
| `diagnostic.code: "agent_required"`        | Set `F402_AGENT_ID` or seed the `f402-agent-id` keychain entry              |
| `live.status: "disabled"`                  | Gate is off (`SPORTSDESK_LIVE_*` / `bun test` / `?source=file`)             |
| `servedFromCache: true`                    | Within TTL; the value is the last observation, not a new POST               |

The dashboard mirrors these diagnostics: the KPI tiles carry a compact note and the Live Desk
section carries the full message and hint; fallback data keeps its CAPTURE/PASTE/STALE labels.

---

## 6. Evidence status

The live-first behaviour is handler-verified and covered by hermetic tests against an injected
fetch and a mock replay proxy; no HTTP capture of a production live response exists yet, so the
OpenAPI surface rows remain tier D. Required capture: `GET /api/live-wagers` and `GET /api/live-bets`
with a valid F402 session, showing `live:` provenance and `live.status: "live"` (or the fallback
response with `live.ok: false` and its diagnostic). Update
[`../evidence/ledger.json`](../evidence/ledger.json) and the API descriptions when that capture is
recorded.
